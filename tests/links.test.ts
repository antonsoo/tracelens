import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLinksReport, buildSummary, buildTiming, parseOtlpJson } from '../src/core/index.js';
import { flattenTrace, restoreTrace } from '../src/web/trace-transfer.js';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const row = (spanId: string, extra = {}) => ({ traceId: 'trace-a', spanId, name: spanId, startTimeUnixNano: '1000', endTimeUnixNano: '9000', ...extra });
const doc = (...spans: unknown[]) => ({ resourceSpans: [{ scopeSpans: [{ spans }] }] });

describe('recorded span links', () => {
  it('preserves actual SDK link order, identities, attributes, dropped counts and target names', () => {
    const oracle = read('../examples/queue-links.oracle.json');
    const input = read('../examples/queue-links.json');
    const trace = parseOtlpJson(input);
    expect(trace.traceId).toBe(oracle.batch.traceId);
    expect(buildLinksReport(trace)).toMatchObject({ linkCount: 8, reportedDroppedLinks: 1, skippedInvalidLinks: 0 });
    for (const record of oracle.spans) {
      const parsed = parseOtlpJson(input, { traceId: record.traceId });
      const span = parsed.spans.find((s) => s.spanId === record.spanId)!;
      expect(span.parentSpanId ?? null).toBe(record.parentSpanId);
      expect(span.droppedLinksCount ?? 0).toBe(record.droppedLinksCount);
      expect((span.links ?? []).map((link) => ({ traceId: link.traceId, spanId: link.spanId, attributes: link.attributes,
        droppedAttributesCount: link.droppedAttributesCount ?? 0,
        targetName: link.target?.name ?? null,
      }))).toEqual((record.links as { traceState: string }[]).map(({ traceState: _traceState, ...link }) => link));
      // Python encoder 1.45.1 omits Link.trace_state. Do not invent evidence
      // from SDK state that never reached the file; a separate control covers it.
      expect(span.links?.every((link) => link.traceState === undefined)).toBe(true);
    }
    expect(buildLinksReport(restoreTrace(structuredClone(flattenTrace(trace))))).toEqual(buildLinksReport(trace));
  });

  it('links never change OTLP parents, timing, summary or roots, even for cycles and self-links', () => {
    const plain = doc(row('a'), row('b', { parentSpanId: 'a' }));
    const linked = doc(row('a', { links: [{ traceId: 'trace-a', spanId: 'b' }] }), row('b', { parentSpanId: 'a', links: [
      { traceId: 'trace-a', spanId: 'a' }, { traceId: 'trace-a', spanId: 'b' },
    ] }));
    const a = parseOtlpJson(plain);
    const b = parseOtlpJson(linked);
    expect(buildTiming(b)).toEqual(buildTiming(a));
    const summary = (t: typeof a) => { const { criticalPath, ...rest } = buildSummary(t, []); return { ...rest, criticalPath: criticalPath.map((s) => s.spanId) }; };
    expect(summary(b)).toEqual(summary(a));
    expect(b.roots.map((s) => s.spanId)).toEqual(['a']);
  });

  it('uses full identities and separates absent traces, absent spans and ambiguous targets', () => {
    const trace = parseOtlpJson(doc(row('a', { links: [
      { trace_id: 'TRACE-B', span_id: 'same', trace_state: 'key=value', flags: 0x80000301, dropped_attributes_count: 2 },
      { traceId: 'trace-c', spanId: 'same' }, { traceId: 'trace-b', spanId: 'absent' },
      { traceId: 'duplicate', spanId: 'same' },
    ] }), row('same'), row('same', { traceId: 'trace-b', name: 'other trace target' }),
    row('same', { traceId: 'duplicate' }), row('same', { traceId: 'duplicate' })), { traceId: 'trace-a' });
    expect(trace.spans[0]!.links?.map((l) => l.target)).toEqual([
      { status: 'available', name: 'other trace target' }, { status: 'missing-trace' }, { status: 'missing-span' }, { status: 'ambiguous' },
    ]);
    expect(trace.spans[0]!.links?.[0]).toMatchObject({ traceState: 'key=value', flags: 0x80000301, droppedAttributesCount: 2 });
  });

  it('warns about malformed collections, records and counters rather than hiding lost evidence', () => {
    const trace = parseOtlpJson(doc(row('a', { links: [null, {}, { traceId: 'x' }, { traceId: 'trace-a', spanId: 'a', flags: -1, droppedAttributesCount: 1.5 }], droppedLinksCount: -2 }), row('b', { links: {} })));
    expect(buildLinksReport(trace)).toMatchObject({ linkCount: 1, skippedInvalidLinks: 3 });
    expect(trace.warnings.map((w) => w.message).join(' ')).toMatch(/Invalid links collection/);
    expect(trace.warnings.filter((w) => w.message.includes('unknown'))).toHaveLength(3);
    expect(trace.spans[0]!.links?.[0]?.flags).toBeUndefined();
  });

  it('preserves Jaeger reference types and prevents a cross-trace parent collision', () => {
    const span = (spanID: string, references: unknown[] = [], extra = {}) => ({ traceID: 'trace-a', spanID, operationName: spanID, startTime: 100, duration: 10, references, ...extra });
    const input = { data: [
      { traceID: 'trace-a', spans: [span('same'), span('worker', [
        { refType: 'CHILD_OF', traceID: 'trace-b', spanID: 'same' },
        { refType: 'FOLLOWS_FROM', traceID: 'trace-a', spanID: 'same' },
      ])] },
      { traceID: 'trace-b', spans: [span('same', [], { traceID: 'trace-b', operationName: 'real parent' })] },
    ] };
    const parsed = parseOtlpJson(input);
    const worker = parsed.spans.find((s) => s.spanId === 'worker')!;
    expect(worker.parentSpanId).toBeUndefined();
    expect(parsed.roots).toHaveLength(2);
    expect(worker.links?.map((l) => [l.target?.name, l.attributes['opentracing.ref_type']])).toEqual([
      ['real parent', 'child_of'], ['same', 'follows_from'],
    ]);
  });
});
