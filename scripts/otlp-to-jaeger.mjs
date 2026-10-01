// Writes an OTLP/JSON trace out in Jaeger's native JSON (the shape the Jaeger
// UI's "Download JSON" produces): microsecond times, typed tags, span kind and
// status as tags, events as logs, one process per resource. It is written
// independently of src/core/jaeger.ts, the reader, so the example it produces
// is a real cross-check:
//
//   node scripts/otlp-to-jaeger.mjs examples/genai-semconv-trace.json > examples/jaeger-genai-trace.json
import { readFileSync } from 'node:fs';

const KIND = { 1: 'internal', 2: 'server', 3: 'client', 4: 'producer', 5: 'consumer' };

function tag(key, value) {
  if ('stringValue' in value) return { key, type: 'string', value: value.stringValue };
  if ('boolValue' in value) return { key, type: 'bool', value: value.boolValue };
  if ('intValue' in value) return { key, type: 'int64', value: Number(value.intValue) };
  if ('doubleValue' in value) return { key, type: 'float64', value: value.doubleValue };
  // Jaeger has no array or map tags; its OTLP receiver stores them as JSON strings.
  const plain = (v) =>
    'arrayValue' in v ? (v.arrayValue.values ?? []).map(plain) : 'stringValue' in v ? v.stringValue : Object.values(v)[0];
  return { key, type: 'string', value: JSON.stringify(plain(value)) };
}

const micros = (nanos) => Number(BigInt(nanos) / 1000n);

const otlp = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const processes = {};
const spans = [];
let traceID = '';
otlp.resourceSpans.forEach((rs, i) => {
  const processID = `p${i + 1}`;
  const attrs = rs.resource?.attributes ?? [];
  const service = attrs.find((a) => a.key === 'service.name');
  processes[processID] = {
    serviceName: service ? service.value.stringValue : 'unknown',
    tags: attrs.filter((a) => a !== service).map((a) => tag(a.key, a.value)),
  };
  for (const ss of rs.scopeSpans) {
    for (const s of ss.spans) {
      traceID = s.traceId;
      const start = micros(s.startTimeUnixNano);
      const tags = (s.attributes ?? []).map((a) => tag(a.key, a.value));
      if (KIND[s.kind]) tags.push({ key: 'span.kind', type: 'string', value: KIND[s.kind] });
      if (ss.scope?.name) tags.push({ key: 'otel.scope.name', type: 'string', value: ss.scope.name });
      if (s.status?.code === 2) {
        tags.push({ key: 'otel.status_code', type: 'string', value: 'ERROR' });
        tags.push({ key: 'error', type: 'bool', value: true });
        if (s.status.message) tags.push({ key: 'otel.status_description', type: 'string', value: s.status.message });
      }
      spans.push({
        traceID: s.traceId,
        spanID: s.spanId,
        operationName: s.name,
        references: s.parentSpanId ? [{ refType: 'CHILD_OF', traceID: s.traceId, spanID: s.parentSpanId }] : [],
        startTime: start,
        duration: micros(s.endTimeUnixNano) - start,
        tags,
        logs: (s.events ?? []).map((e) => ({
          timestamp: micros(e.timeUnixNano),
          fields: [{ key: 'event', type: 'string', value: e.name }, ...(e.attributes ?? []).map((a) => tag(a.key, a.value))],
        })),
        processID,
        warnings: null,
      });
    }
  }
});

process.stdout.write(JSON.stringify({ data: [{ traceID, spans, processes, warnings: null }], total: 0, limit: 0, offset: 0, errors: null }, null, 2) + '\n');
