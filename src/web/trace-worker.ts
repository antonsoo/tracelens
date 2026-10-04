import { decodeText } from '../core/decode.js';
import { parseTraceText } from '../core/otlp-parser.js';
import { flattenTrace } from './trace-transfer.js';
import { MAX_TRACE_BYTES } from './trace-protocol.js';
import type { ParseRequest, ParseResponse, TraceSource } from './trace-protocol.js';

const tooLarge = (): Error => new Error('Trace files must be 25 MB or smaller. Export a single run and try again.');

async function readSource(source: TraceSource): Promise<string> {
  if (source.kind === 'text') return source.text;
  if (source.kind === 'file') {
    if (source.file.size > MAX_TRACE_BYTES) throw tooLarge();
    const bytes = await source.file.arrayBuffer();
    if (bytes.byteLength > MAX_TRACE_BYTES) throw tooLarge();
    return decodeText(new Uint8Array(bytes));
  }
  if (new URL(source.url).origin !== self.location.origin) throw new Error('Samples must load from this site.');
  const response = await fetch(source.url, { redirect: 'error' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_TRACE_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) throw new Error('The sample download was empty. Choose the sample again to retry.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_TRACE_BYTES) throw tooLarge();
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return decodeText(bytes);
}

self.onmessage = (event: MessageEvent<ParseRequest>): void => {
  void (async () => {
    try {
      const text = await readSource(event.data.source);
      const trace = parseTraceText(text, { traceId: event.data.traceId });
      self.postMessage({ ok: true, trace: flattenTrace(trace), source: trace.traces.length > 1 ? text : null } satisfies ParseResponse);
    } catch (error) {
      self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ParseResponse);
    }
  })();
};
