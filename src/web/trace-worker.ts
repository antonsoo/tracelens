import { decodeTraceFile } from '../core/trace-file.js';
import { MAX_TRACE_INPUTS, parseTraceInputs } from '../core/otlp-parser.js';
import type { TraceInput } from '../core/types.js';
import { flattenTrace } from './trace-transfer.js';
import { MAX_TRACE_BYTES } from './trace-protocol.js';
import type { ParseRequest, ParseResponse, TraceSource } from './trace-protocol.js';

const tooLarge = (): Error => new Error('Trace files must be 25 MB or smaller. Export a single run and try again.');

async function readSource(source: Exclude<TraceSource, { kind: 'files' | 'inputs' }>): Promise<TraceInput> {
  if (source.kind === 'text') return { name: 'Trace', text: source.text };
  if (source.kind === 'file') {
    if (source.file.size > MAX_TRACE_BYTES) throw tooLarge();
    const bytes = await source.file.arrayBuffer();
    if (bytes.byteLength > MAX_TRACE_BYTES) throw tooLarge();
    return decodeTraceFile(new Uint8Array(bytes), source.file.name);
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
  return decodeTraceFile(bytes, new URL(source.url).pathname.split('/').at(-1) ?? 'Trace');
}

async function readInputs(source: TraceSource): Promise<TraceInput[]> {
  if (source.kind === 'inputs') return source.inputs;
  if (source.kind !== 'files') return [await readSource(source)];
  if (!source.files.length || source.files.length > MAX_TRACE_INPUTS) throw new Error(`Choose between 1 and ${MAX_TRACE_INPUTS} trace files.`);
  if (source.files.length === 1) return [await readSource({ kind: 'file', file: source.files[0]! })];
  if (source.files.reduce((total, file) => total + file.size, 0) > MAX_TRACE_BYTES) {
    throw new Error('Selected trace files exceed 25 MB in total. Choose a smaller group.');
  }
  const inputs: TraceInput[] = [];
  let decodedUnits = 0;
  for (const [index, file] of source.files.entries()) {
    try {
      const input = await readSource({ kind: 'file', file });
      decodedUnits += input.text.length;
      if (decodedUnits > MAX_TRACE_BYTES) throw new Error('Selected files expand beyond the text limit. Choose a smaller group.');
      inputs.push(input);
    }
    catch (error) { throw new Error(`File ${index + 1} (${file.name}): ${error instanceof Error ? error.message : String(error)}`); }
  }
  return inputs;
}

self.onmessage = (event: MessageEvent<ParseRequest>): void => {
  void (async () => {
    try {
      const inputs = await readInputs(event.data.source);
      const trace = parseTraceInputs(inputs, { traceId: event.data.traceId });
      const source = trace.traces.length > 1
        ? (inputs.length === 1 && !inputs[0]!.sourceFormat && !inputs[0]!.compression && !inputs[0]!.warnings?.length ? inputs[0]!.text : inputs) : null;
      self.postMessage({ ok: true, trace: flattenTrace(trace), source } satisfies ParseResponse);
    } catch (error) {
      self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ParseResponse);
    }
  })();
};
