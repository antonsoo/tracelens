import { fromBinary, toJson } from '@bufbuild/protobuf';
import type { JsonValue } from '@bufbuild/protobuf';
import { ExportTraceServiceRequestSchema } from './proto/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import { ExportLogsServiceRequestSchema } from './proto/opentelemetry/proto/collector/logs/v1/logs_service_pb.js';
import { decodeText } from './decode.js';
import { assertProtobufWire, MAX_PROTOBUF_DEPTH } from './protobuf-wire.js';
import { TraceParseError } from './payload-depth.js';
import type { ParseWarning, TraceInput } from './types.js';

export interface ProtobufInputFormat {
  signal: 'traces' | 'logs';
  framing: 'raw' | 'collector';
}
export const MAX_PROTOBUF_BYTES = 25 * 1024 * 1024;
export const MAX_PROTOBUF_BATCHES = 100_000;
const MAX_DECODED_UNITS = 25 * 1024 * 1024;

/** Native byte fields carry an exact width, unlike opaque legacy JSON labels.
 * Missing byte values keep the parser's existing incomplete/absent-context
 * policy. A nonempty value of another width is not an OTLP identity. */
function assertIdWidth(value: Uint8Array, bytes: 8 | 16, field: string): void {
  if (value.length && value.length !== bytes) throw new Error(`${field} has ${value.length} bytes; OTLP requires ${bytes} bytes for a nonempty identity`);
}

/** Protobuf has neither a magic number nor a signal discriminator. Require a
 * declared kind/framing, by filename or explicit library option; never retry
 * failed JSON as protobuf or silently retry one framing as the other. */
export function protobufFormat(name: string): ProtobufInputFormat | undefined {
  const basename = name.split(/[/\\]/).at(-1)!;
  const match = /(?:^|\.)(traces|logs)\.(pb|otlp)$/i.exec(basename);
  if (!match) return undefined;
  return { signal: match[1]!.toLowerCase() as 'traces' | 'logs', framing: match[2]!.toLowerCase() === 'pb' ? 'raw' : 'collector' };
}

function messages(bytes: Uint8Array, framing: ProtobufInputFormat['framing']): Uint8Array[] {
  if (framing === 'raw') return [bytes];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const batches: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length;) {
    if (batches.length >= MAX_PROTOBUF_BATCHES) throw new TraceParseError(`Collector protobuf exceeds ${MAX_PROTOBUF_BATCHES} batches. Export a smaller file.`);
    const batch = batches.length + 1;
    if (bytes.length - offset < 4) throw new TraceParseError(`Collector protobuf batch ${batch}: incomplete four-byte length prefix. No batches were imported.`);
    const size = view.getUint32(offset, false);
    offset += 4;
    if (size > bytes.length - offset) throw new TraceParseError(`Collector protobuf batch ${batch}: declares ${size} bytes, but only ${bytes.length - offset} remain. No batches were imported.`);
    batches.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  if (!batches.length) throw new TraceParseError('The Collector protobuf file contains no batches.');
  return batches;
}

/** Count unrecognized wire records without interpreting their data as JSON.
 * The JSON inspection view cannot retain arbitrary unknown protobuf fields. */
function unknownFields(root: unknown): number {
  const pending: unknown[] = [root];
  let count = 0;
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || value instanceof Uint8Array) continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$unknown') { if (Array.isArray(child)) count += child.length; }
      else if (key !== '$typeName' && child && typeof child === 'object') pending.push(child);
    }
  }
  return count;
}

/** Decode a local input into the existing JSON inspection model. The decoded
 * view is not a byte-for-byte copy of the binary file: uint64 values remain
 * decimal strings, IDs remain bytes encoded as base64, and resource batches
 * are joined without inventing physical source-line locations. */
export function decodeTraceFile(bytes: Uint8Array, name: string, format = protobufFormat(name)): TraceInput {
  if (!format) {
    if (/\.(?:pb|otlp)$/i.test(name)) {
      throw new TraceParseError('Declare the protobuf signal and framing: use .traces.pb / .logs.pb for one raw OTLP request, or .traces.otlp / .logs.otlp for a Collector length-prefixed file.');
    }
    return { name, text: decodeText(bytes) };
  }
  if (bytes.byteLength > MAX_PROTOBUF_BYTES) throw new TraceParseError('Binary OTLP files must be 25 MB or smaller. Export a single run and try again.');
  const batches = messages(bytes, format.framing);
  const resources: JsonValue[] = [];
  const key = format.signal === 'traces' ? 'resourceSpans' : 'resourceLogs';
  let unknown = 0, decodedUnits = 0;
  const budget = { fields: 0 };
  for (const [index, batch] of batches.entries()) {
    let json: JsonValue;
    try {
      if (format.signal === 'traces') {
        assertProtobufWire(ExportTraceServiceRequestSchema, batch, budget);
        const message = fromBinary(ExportTraceServiceRequestSchema, batch, { recursionLimit: MAX_PROTOBUF_DEPTH });
        for (const resource of message.resourceSpans) for (const scope of resource.scopeSpans) for (const span of scope.spans) {
          assertIdWidth(span.traceId, 16, 'Span trace_id');
          assertIdWidth(span.spanId, 8, 'Span span_id');
          assertIdWidth(span.parentSpanId, 8, 'Span parent_span_id');
          for (const link of span.links) {
            assertIdWidth(link.traceId, 16, 'Link trace_id');
            assertIdWidth(link.spanId, 8, 'Link span_id');
          }
        }
        unknown += unknownFields(message);
        json = toJson(ExportTraceServiceRequestSchema, message, { enumAsInteger: true });
      } else {
        assertProtobufWire(ExportLogsServiceRequestSchema, batch, budget);
        const message = fromBinary(ExportLogsServiceRequestSchema, batch, { recursionLimit: MAX_PROTOBUF_DEPTH });
        for (const resource of message.resourceLogs) for (const scope of resource.scopeLogs) for (const log of scope.logRecords) {
          assertIdWidth(log.traceId, 16, 'LogRecord trace_id');
          assertIdWidth(log.spanId, 8, 'LogRecord span_id');
        }
        unknown += unknownFields(message);
        json = toJson(ExportLogsServiceRequestSchema, message, { enumAsInteger: true });
      }
    } catch (error) {
      throw new TraceParseError(`OTLP ${format.signal} protobuf batch ${index + 1} could not be decoded: ${error instanceof Error ? error.message : String(error)}. No batches were imported.`);
    }
    const values = (json as Record<string, JsonValue>)[key];
    if (Array.isArray(values)) {
      for (const value of values) {
        decodedUnits += JSON.stringify(value).length + 1;
        if (decodedUnits > MAX_DECODED_UNITS) throw new TraceParseError('Decoded protobuf exceeds 26,214,400 UTF-16 units. Export a smaller run. No batches were imported.');
        resources.push(value);
      }
    }
  }
  const warnings: ParseWarning[] = unknown ? [{ message: `The protobuf input contains ${unknown} unrecognized wire field(s). The decoded JSON inspection view includes only fields in the bundled OTLP schema; retain the original binary for those unknown fields.` }] : [];
  return { name, text: JSON.stringify({ [key]: resources }), sourceFormat: format.framing === 'raw' ? 'otlp-protobuf' : 'otlp-protobuf-framed', ...(warnings.length ? { warnings } : {}) };
}
