// Small helpers for hand-built OTLP/JSON fixtures used by the edge-case
// tests. The *real* fixtures (from an actual OpenTelemetry SDK run) live in
// tests/fixtures/*.json — small copies of the traces in examples/, kept
// deliberately small and stable so span-count/error-count/retry-count
// assertions don't have to change every time the flagship examples/ traces
// are regenerated with a richer scenario. otlp-parser.test.ts /
// normalize.test.ts / summary.test.ts read those instead of these — these
// helpers are only for shapes real traces don't normally have (missing
// parents, clock skew, huge span counts).
export function sv(s: string) {
  return { stringValue: s };
}
export function iv(n: number) {
  return { intValue: String(n) };
}
export function dv(n: number) {
  return { doubleValue: n };
}
export function av(values: unknown[]) {
  return { arrayValue: { values } };
}

export function attr(key: string, value: unknown) {
  return { key, value };
}

export interface FakeSpanOpts {
  traceId?: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startNs: bigint | number;
  endNs: bigint | number;
  attributes?: Array<{ key: string; value: unknown }>;
  statusCode?: number;
  events?: unknown[];
}

export function fakeSpan(o: FakeSpanOpts) {
  return {
    traceId: o.traceId ?? 'aa'.repeat(16),
    spanId: o.spanId,
    ...(o.parentSpanId ? { parentSpanId: o.parentSpanId } : {}),
    name: o.name ?? 'span',
    kind: o.kind ?? 1,
    startTimeUnixNano: String(o.startNs),
    endTimeUnixNano: String(o.endNs),
    attributes: o.attributes ?? [],
    status: { code: o.statusCode ?? 0 },
    events: o.events ?? [],
  };
}

export function otlpDoc(spans: unknown[], resourceAttrs: Array<{ key: string; value: unknown }> = []) {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [{ scope: { name: 'test-scope' }, spans }],
      },
    ],
  };
}
