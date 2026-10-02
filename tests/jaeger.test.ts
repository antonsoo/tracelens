import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSummary, DEFAULT_PRICE_TABLE, isJaegerJson, parseOtlpJson } from '../src/core/index.js';
import type { ParsedSpan } from '../src/core/index.js';

const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8'));

// examples/jaeger-genai-trace.json is examples/genai-semconv-trace.json written out by
// scripts/otlp-to-jaeger.mjs, which shares no code with the reader in src/core/jaeger.ts.
describe('Jaeger JSON', () => {
  const otlp = parseOtlpJson(load('genai-semconv-trace.json'));
  const jaeger = parseOtlpJson(load('jaeger-genai-trace.json'));

  const shape = (s: ParsedSpan) => ({
    spanId: s.spanId,
    parent: s.parentSpanId,
    name: s.name,
    kind: s.kind,
    start: s.startTimeUnixNano,
    end: s.endTimeUnixNano,
    status: s.status,
    events: s.events.map((e) => [e.name, e.timeUnixNano]),
    agentKind: s.agentKind,
    convention: s.convention,
    service: s.resourceAttributes['service.name'],
    scope: s.scopeName,
  });

  it('is recognized, and OTLP is not', () => {
    expect(isJaegerJson(load('jaeger-genai-trace.json'))).toBe(true);
    expect(isJaegerJson(load('genai-semconv-trace.json'))).toBe(false);
    expect(jaeger.sourceFormat).toBe('jaeger-json');
    expect(otlp.sourceFormat).toBe('otlp-json');
  });

  it('reads the same trace as its OTLP original: tree, microsecond times, kinds, status, events', () => {
    expect(jaeger.traceId).toBe(otlp.traceId);
    expect(jaeger.warnings).toEqual(otlp.warnings);
    expect(jaeger.spans.map(shape).sort((a, b) => a.spanId.localeCompare(b.spanId))).toEqual(
      otlp.spans.map(shape).sort((a, b) => a.spanId.localeCompare(b.spanId)),
    );
  });

  it('gives the same summary, cost and token counts included', () => {
    const a = buildSummary(otlp, DEFAULT_PRICE_TABLE);
    const b = buildSummary(jaeger, DEFAULT_PRICE_TABLE);
    expect(b.totalCostUsd).toBeCloseTo(a.totalCostUsd!, 10);
    expect(b.modelUsage).toEqual(a.modelUsage);
    expect([b.spanCount, b.errorCount, b.retryCount, b.totalDurationMs]).toEqual([a.spanCount, a.errorCount, a.retryCount, a.totalDurationMs]);
    expect(b.criticalPath.map((s) => s.spanId)).toEqual(a.criticalPath.map((s) => s.spanId));
  });

  const span = (spanID: string, extra: Record<string, unknown> = {}) => ({
    traceID: 'abc123',
    spanID,
    operationName: `op ${spanID}`,
    references: [],
    startTime: 1_790_000_000_000_000,
    duration: 2_000,
    tags: [],
    logs: [],
    processID: 'p1',
    ...extra,
  });
  const trace = (spans: unknown[]) => ({ traceID: 'abc123', spans, processes: { p1: { serviceName: 'svc', tags: [] } } });

  it('handles FOLLOWS_FROM, the legacy error tag, inline processes, string int64 values and bare traces', () => {
    const parsed = parseOtlpJson(
      trace([
        span('a'),
        span('b', {
          references: [{ refType: 'FOLLOWS_FROM', traceID: 'abc123', spanID: 'a' }],
          tags: [
            { key: 'error', type: 'bool', value: true },
            { key: 'gen_ai.usage.input_tokens', type: 'int64', value: '1200' },
          ],
          logs: [{ timestamp: 1_790_000_000_000_500, fields: [{ key: 'message', type: 'string', value: 'retrying' }, { key: 'attempt', type: 'int64', value: 2 }] }],
          processID: undefined,
          process: { serviceName: 'worker', tags: [{ key: 'host.name', type: 'string', value: 'w1' }] },
        }),
      ]),
    );
    const b = parsed.spans.find((s) => s.spanId === 'b')!;
    expect(b.parentSpanId).toBe('a');
    expect(b.status.code).toBe('ERROR');
    expect(b.attributes['gen_ai.usage.input_tokens']).toBe(1200);
    expect(b.resourceAttributes).toMatchObject({ 'service.name': 'worker', 'host.name': 'w1' });
    expect(b.events).toEqual([{ name: 'retrying', timeUnixNano: 1_790_000_000_000_500_000n, attributes: { attempt: 2 } }]);
    expect(b.durationNs).toBe(2_000_000n);
  });

  it('skips a span with an invalid start time, with the parser warning', () => {
    const parsed = parseOtlpJson({ data: [trace([span('a'), span('b', { startTime: -5 })])] });
    expect(parsed.spans.map((s) => s.spanId)).toEqual(['a']);
    expect(parsed.warnings.some((w) => w.message.includes('invalid timestamps'))).toBe(true);
  });

  it('reads one trace of a search result that holds several, and lists them all', () => {
    const other = { traceID: 'def456', spans: [span('z', { traceID: 'def456' }), span('y', { traceID: 'def456' })], processes: { p1: { serviceName: 'svc' } } };
    const doc = { data: [trace([span('a')]), other] };
    const parsed = parseOtlpJson(doc);
    expect(parsed.traceId).toBe('def456');
    expect(parsed.spans).toHaveLength(2);
    expect(parsed.traces.map((t) => t.spanCount).sort()).toEqual([1, 2]);
    const first = parsed.traces.find((t) => t.traceId !== 'def456')!;
    expect(parseOtlpJson(doc, { traceId: first.traceId }).spans.map((s) => s.spanId)).toEqual(['a']);
  });
});
