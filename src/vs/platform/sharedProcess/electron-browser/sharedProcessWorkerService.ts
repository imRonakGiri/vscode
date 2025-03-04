/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcRenderer } from 'electron';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { Emitter } from 'vs/base/common/event';
import { Disposable, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { FileAccess } from 'vs/base/common/network';
import { generateUuid } from 'vs/base/common/uuid';
import { ILogService } from 'vs/platform/log/common/log';
import { hash, ISharedProcessWorkerConfiguration, ISharedProcessWorkerService } from 'vs/platform/sharedProcess/common/sharedProcessWorkerService';
import { SharedProcessWorkerMessages, ISharedProcessToWorkerMessage, IWorkerToSharedProcessMessage } from 'vs/platform/sharedProcess/electron-browser/sharedProcessWorker';

export class SharedProcessWorkerService implements ISharedProcessWorkerService {

	declare readonly _serviceBrand: undefined;

	private readonly workers = new Map<string /* process module ID */, Promise<SharedProcessWebWorker>>();
	private readonly processes = new Map<number /* process configuration hash */, IDisposable>();

	constructor(
		@ILogService private readonly logService: ILogService
	) {
	}

	async createWorker(configuration: ISharedProcessWorkerConfiguration): Promise<void> {
		const workerLogId = `window: ${configuration.reply.windowId}, moduleId: ${configuration.process.moduleId}`;
		this.logService.trace(`SharedProcess: createWorker (${workerLogId})`);

		// Ensure to dispose any existing process for config
		const configurationHash = hash(configuration);
		if (this.processes.has(configurationHash)) {
			this.logService.warn(`SharedProcess: createWorker found an existing worker that will be terminated (${workerLogId})`);

			this.disposeWorker(configuration);
		}

		const cts = new CancellationTokenSource();

		let worker: SharedProcessWebWorker | undefined = undefined;
		let windowPort: MessagePort | undefined = undefined;
		let workerPort: MessagePort | undefined = undefined;

		// Store as process for later disposal
		this.processes.set(configurationHash, toDisposable(() => {

			// Signal to token
			cts.dispose(true);

			// Terminate process
			worker?.terminate(configuration, CancellationToken.None /* we want to deliver this message */);

			// Close ports
			windowPort?.close();
			workerPort?.close();

			// Remove from processes
			this.processes.delete(configurationHash);
		}));

		// Acquire a worker for the configuration
		worker = await this.getOrCreateWebWorker(configuration);

		if (cts.token.isCancellationRequested) {
			return;
		}

		// Create a `MessageChannel` with 2 ports:
		// `windowPort`: send back to the requesting window
		// `workerPort`: send into a new worker to use
		const { port1, port2 } = new MessageChannel();
		windowPort = port1;
		workerPort = port2;

		// Spawn in worker and pass over port
		await worker.spawn(configuration, workerPort, cts.token);

		if (cts.token.isCancellationRequested) {
			return;
		}

		// We cannot just send the `MessagePort` through our protocol back
		// because the port can only be sent via `postMessage`. So we need
		// to send it through the main process back to the window.
		this.logService.trace(`SharedProcess: createWorker sending message port back to window (${workerLogId})`);
		ipcRenderer.postMessage('vscode:relaySharedProcessWorkerMessageChannel', configuration, [windowPort]);
	}

	private getOrCreateWebWorker(configuration: ISharedProcessWorkerConfiguration): Promise<SharedProcessWebWorker> {

		// keep 1 web-worker per process module id to reduce
		// the overall number of web workers while still
		// keeping workers for separate processes around.
		let webWorkerPromise = this.workers.get(configuration.process.moduleId);

		// create a new web worker if this is the first time
		// for the given process
		if (!webWorkerPromise) {
			this.logService.trace(`SharedProcess: creating new web worker (${configuration.process.moduleId})`);

			const sharedProcessWorker = new SharedProcessWebWorker(configuration.process.type, this.logService);
			webWorkerPromise = sharedProcessWorker.init();

			// Make sure to run through our normal
			// `disposeWorker` call when the process
			// terminates by itself.
			sharedProcessWorker.onDidProcessSelfTerminate(configuration => {
				this.disposeWorker(configuration);
			});

			this.workers.set(configuration.process.moduleId, webWorkerPromise);
		}

		return webWorkerPromise;
	}

	async disposeWorker(configuration: ISharedProcessWorkerConfiguration): Promise<void> {
		const processDisposable = this.processes.get(hash(configuration));
		if (processDisposable) {
			this.logService.trace(`SharedProcess: disposeWorker (window: ${configuration.reply.windowId}, moduleId: ${configuration.process.moduleId})`);

			processDisposable.dispose();
		}
	}
}

class SharedProcessWebWorker extends Disposable {

	private readonly _onDidProcessSelfTerminate = this._register(new Emitter<ISharedProcessWorkerConfiguration>());
	readonly onDidProcessSelfTerminate = this._onDidProcessSelfTerminate.event;

	private readonly workerReady: Promise<Worker> = this.doInit();
	private readonly mapMessageNonceToPendingMessageResolve = new Map<string, () => void>();

	constructor(
		private readonly type: string,
		private readonly logService: ILogService
	) {
		super();
	}

	async init(): Promise<SharedProcessWebWorker> {
		await this.workerReady;

		return this;
	}

	private doInit(): Promise<Worker> {
		let readyResolve: (result: Worker) => void;
		const readyPromise = new Promise<Worker>(resolve => readyResolve = resolve);

		const worker = new Worker('../../../base/worker/workerMain.js', {
			name: `Shared Process Worker (${this.type})`
		});

		worker.onerror = event => {
			this.logService.error(`SharedProcess: worker error (${this.type})`, event.message);
		};

		worker.onmessageerror = event => {
			this.logService.error(`SharedProcess: worker message error (${this.type})`, event);
		};

		worker.onmessage = event => {
			const { id, message, configuration, nonce } = event.data as IWorkerToSharedProcessMessage;

			switch (id) {

				// Lifecycle: Ready
				case SharedProcessWorkerMessages.Ready:
					readyResolve(worker);
					break;

				// Lifecycle: Ack
				case SharedProcessWorkerMessages.Ack:
					if (nonce) {
						const messageAwaiter = this.mapMessageNonceToPendingMessageResolve.get(nonce);
						if (messageAwaiter) {
							this.mapMessageNonceToPendingMessageResolve.delete(nonce);
							messageAwaiter();
						}
					}
					break;

				// Lifecycle: self termination
				case SharedProcessWorkerMessages.SelfTerminated:
					if (configuration) {
						this._onDidProcessSelfTerminate.fire(configuration);
					}
					break;

				// Diagostics: trace
				case SharedProcessWorkerMessages.Trace:
					this.logService.trace(`SharedProcess (worker, ${this.type}):`, message);
					break;

				// Diagostics: info
				case SharedProcessWorkerMessages.Info:
					if (message) {
						this.logService.info(message); // take as is
					}
					break;

				// Diagostics: warn
				case SharedProcessWorkerMessages.Warn:
					this.logService.warn(`SharedProcess (worker, ${this.type}):`, message);
					break;

				// Diagnostics: error
				case SharedProcessWorkerMessages.Error:
					this.logService.error(`SharedProcess (worker, ${this.type}):`, message);
					break;

				// Any other message
				default:
					this.logService.warn(`SharedProcess: unexpected worker message (${this.type})`, event);
			}
		};

		// First message triggers the load of the worker
		worker.postMessage('vs/platform/sharedProcess/electron-browser/sharedProcessWorkerMain');

		return readyPromise;
	}

	private async send(message: ISharedProcessToWorkerMessage, token: CancellationToken, port?: MessagePort): Promise<void> {
		const worker = await this.workerReady;

		if (token.isCancellationRequested) {
			return;
		}

		return new Promise<void>(resolve => {

			// Store the awaiter for resolving when message
			// is received with the given nonce
			const nonce = generateUuid();
			this.mapMessageNonceToPendingMessageResolve.set(nonce, resolve);

			// Post message into worker
			const workerMessage: ISharedProcessToWorkerMessage = { ...message, nonce };
			if (port) {
				worker.postMessage(workerMessage, [port]);
			} else {
				worker.postMessage(workerMessage);
			}

			// Release on cancellation if still pending
			token.onCancellationRequested(() => {
				if (this.mapMessageNonceToPendingMessageResolve.delete(nonce)) {
					resolve();
				}
			});
		});
	}

	spawn(configuration: ISharedProcessWorkerConfiguration, port: MessagePort, token: CancellationToken): Promise<void> {
		const workerMessage: ISharedProcessToWorkerMessage = {
			id: SharedProcessWorkerMessages.Spawn,
			configuration,
			environment: {
				bootstrapPath: FileAccess.asFileUri('bootstrap-fork', require).fsPath
			}
		};

		return this.send(workerMessage, token, port);
	}

	terminate(configuration: ISharedProcessWorkerConfiguration, token: CancellationToken): Promise<void> {
		const workerMessage: ISharedProcessToWorkerMessage = {
			id: SharedProcessWorkerMessages.Terminate,
			configuration
		};

		return this.send(workerMessage, token);
	}
}
