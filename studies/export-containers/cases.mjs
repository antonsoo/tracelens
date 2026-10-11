import { readFileSync } from 'node:fs';

// Reuse the real SDK control. Corruptions below are explicit fixture mutations,
// not evidence that the SDK itself emitted malformed container shapes.
const captured = JSON.parse(readFileSync(new URL('../attribute-values/fixtures/sdk-control.json', import.meta.url), 'utf8'));
const resource = captured.resourceSpans[0];
const span = resource.scopeSpans[0].spans[0];
export const first = span.traceId;
export const second = 'b'.repeat(32);
const other = structuredClone(resource);
other.scopeSpans[0].spans[0].traceId = second;
other.scopeSpans[0].spans[0].name = 'second readable trace';
const otlp = extra => ({ resourceSpans: [resource, extra, other] });
const jaegerSpan = { spanID: span.spanId, operationName: 'retained Jaeger span', startTime: 1000, duration: 1000 };
export const cases = [
  { name: 'non-object resource', input: otlp(null), warnings: [1, 1] },
  { name: 'scope collection as an object', input: otlp({ scopeSpans: { scope: { spans: [span] } } }), warnings: [1, 1] },
  { name: 'non-object scope', input: otlp({ scopeSpans: [null] }), warnings: [1, 1] },
  { name: 'span collection as an object', input: otlp({ scopeSpans: [{ spans: { [span.spanId]: span } }] }), warnings: [1, 1] },
  { name: 'legal unset repeated fields', input: otlp({ scopeSpans: [{ spans: null }, {}] }), warnings: [0, 0] },
  { name: 'span with known trace but missing span ID', input: otlp({ scopeSpans: [{ spans: [{ ...span, spanId: '' }] }] }), warnings: [1, 0] },
  { name: 'non-object Jaeger span', input: { data: [{ traceID: first, spans: [jaegerSpan, null] },
    { traceID: second, spans: [jaegerSpan] }] }, warnings: [1, 0] },
];
export const partial = { resourceSpans: [resource, null, { scopeSpans: {} }, { scopeSpans: [null] },
  { scopeSpans: [{ spans: {} }] }, other] };
