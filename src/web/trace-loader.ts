import type { ParsedTrace } from '../core/types.js';
import { restoreTrace } from './trace-transfer.js';
import { PARSE_TIMEOUT_MS } from './trace-protocol.js';
import type { ParseRequest, ParseResponse, RetainedTraceSource, TraceSource } from './trace-protocol.js';
import TraceWorker from './trace-worker?worker&inline';

export interface LoadedTrace { trace: ParsedTrace; source: RetainedTraceSource | null }

/** Every request owns its worker, including its reads and downloads. */
export function loadTrace(source: TraceSource, signal: AbortSignal, traceId?: string): Promise<LoadedTrace> {
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error, value?: LoadedTrace): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (worker) {
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
      }
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = (): void => finish(new DOMException('Loading canceled.', 'AbortError'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    try {
      // Bundle trusted parser code with the app: a trace switch should not
      // depend on a second network request after a local file is loaded.
      worker = new TraceWorker();
      worker.onerror = (event) => {
        event.preventDefault();
        finish(new Error('The trace parser stopped unexpectedly. Choose the file or sample again to retry.'));
      };
      worker.onmessageerror = () => finish(new Error('The trace parser response could not be read. Choose the file or sample again to retry.'));
      worker.onmessage = (event: MessageEvent<ParseResponse>) => {
        try {
          const reply = event.data;
          if (reply?.ok === false && typeof reply.error === 'string') { finish(new Error(reply.error)); return; }
          const validSource = reply?.ok && (reply.source === null || typeof reply.source === 'string'
            || (Array.isArray(reply.source) && reply.source.every(input => typeof input?.name === 'string' && typeof input?.text === 'string')));
          if (reply?.ok !== true || !reply.trace || !validSource) {
            throw new Error('Invalid trace parser response. Choose the file or sample again to retry.');
          }
          finish(undefined, { trace: restoreTrace(reply.trace), source: reply.source });
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      };
      timer = setTimeout(() => finish(new Error('Parsing took longer than 30 seconds. Export a smaller trace and try again.')), PARSE_TIMEOUT_MS);
      worker.postMessage({ source, ...(traceId ? { traceId } : {}) } satisfies ParseRequest);
    } catch (error) {
      finish(new Error(`Could not start the trace parser: ${error instanceof Error ? error.message : String(error)}. Choose the file or sample again to retry.`));
    }
  });
}
