import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compareTraces, measurementChange } from '../src/core/compare.js';
import { parseOtlpJson } from '../src/core/otlp-parser.js';
import { selfTimeNs } from '../src/core/summary.js';
import type { PriceEntry } from '../src/core/pricing.js';
import { attr, fakeSpan, iv, otlpDoc, sv } from './fixtures.js';

const prices: PriceEntry[] = [
  {
    id: 'test',
    matchModel: 'test',
    provider: 'test',
    inputPerMTok: 2,
    outputPerMTok: 4,
    sourceDate: '2026-09-26',
    sourceUrl: 'https://example.com/synthetic-test-prices',
  },
];
const span = (id: string, start: number, end: number, parent?: string, name = 'work') =>
  fakeSpan({
    spanId: id,
    startNs: start * 1_000_000,
    endNs: end * 1_000_000,
    parentSpanId: parent,
    name,
  });
const parse = (...spans: ReturnType<typeof fakeSpan>[]) => parseOtlpJson(otlpDoc(spans));
function llm(id: string, model: string, input?: number, output?: number) {
  return fakeSpan({
    spanId: id,
    name: `chat ${model}`,
    startNs: 0,
    endNs: 1_000_000,
    attributes: [
      attr('gen_ai.operation.name', sv('chat')),
      attr('gen_ai.request.model', sv(model)),
      ...(input === undefined ? [] : [attr('gen_ai.usage.input_tokens', iv(input))]),
      ...(output === undefined ? [] : [attr('gen_ai.usage.output_tokens', iv(output))]),
    ],
  });
}

describe('self time interval accounting', () => {
  it('clips children at each parent boundary, unions overlaps, ignores detached intervals', () => {
    const trace = parse(
      span('root', 10, 30),
      span('a', 0, 12, 'root'),
      span('b', 11, 18, 'root'),
      span('c', 25, 40, 'root'),
      span('d', 50, 60, 'root'),
    );
    // [10,18) and [25,30) cover 13 of the parent's 20 ms.
    expect(selfTimeNs(trace.roots[0]!)).toBe(7_000_000n);
  });
  it('agrees with an independent discrete occupancy oracle over 100 interval sets', () => {
    let seed = 17;
    const next = () => ((seed = (seed * 16807) % 2147483647) % 45) - 10;
    for (let trial = 0; trial < 100; trial++) {
      const intervals = Array.from({ length: 8 }, () => {
        const a = next(),
          b = next();
        return [Math.min(a, b), Math.max(a, b)] as const;
      });
      const trace = parse(span('root', 100, 120), ...intervals.map(([a, b], i) => span(`c${i}`, a + 100, b + 100, 'root')));
      const uncovered = Array.from({ length: 20 }, (_, t) => t).filter(
        (t) => !intervals.some(([a, b]) => a <= t && t < b),
      ).length;
      expect(selfTimeNs(trace.roots[0]!)).toBe(BigInt(uncovered) * 1_000_000n);
    }
  });
});

describe('trace comparison', () => {
  it('rejects excessive nesting before constructing unbounded ancestry keys', () => {
    const trace = parse(...Array.from({ length: 257 }, (_, i) => span(String(i), 0, 1, i ? String(i - 1) : undefined)));
    expect(() => compareTraces(trace, trace, prices)).toThrow('256 nesting levels');
  });
  it('ignores new IDs, absolute timestamps and export order', () => {
    const a = parse(span('r1', 0, 10), span('a1', 2, 7, 'r1', 'search'));
    const b = parse(span('b1', 102, 107, 'r2', 'search'), span('r2', 100, 110));
    const report = compareTraces(a, b, prices);
    expect(report.operations).toHaveLength(2);
    expect(report.operations.every((op) => op.status === 'matched' && op.metrics.selfTimeMs.delta === 0)).toBe(true);
    expect(report.wallTimeMs.delta).toBe(0);
    expect(() => JSON.stringify(report)).not.toThrow();
  });
  it('aggregates repeated calls without guessing their correspondence', () => {
    const a = parse(span('a', 0, 10), span('b', 10, 20));
    const b = parse(span('x', 0, 5), span('y', 5, 10), span('z', 10, 15));
    const op = compareTraces(a, b, prices).operations[0]!;
    expect(op.baselineCalls).toHaveLength(2);
    expect(op.candidateCalls).toHaveLength(3);
    expect(op.metrics.calls.delta).toBe(1);
    expect(op.metrics.selfTimeMs.delta).toBe(-5);
  });
  it('shows model substitutions within the same operation', () => {
    const op = compareTraces(parse(llm('a', 'test-v1', 10, 20)), parse(llm('b', 'test-v2', 15, 10)), prices)
      .operations[0]!;
    expect(op.status).toBe('matched');
    expect(op.baselineCalls[0]!.model).toBe('test-v1');
    expect(op.candidateCalls[0]!.model).toBe('test-v2');
    expect(op.metrics.inputTokens.delta).toBe(5);
    expect(op.metrics.costUsd.delta).toBeCloseTo(-0.00003);
  });
  it('keeps ancestry, service and namespace distinct', () => {
    const trace = parse(
      span('r', 0, 10, undefined, 'first'),
      span('s', 0, 10, undefined, 'second'),
      span('a', 1, 2, 'r'),
      span('b', 1, 2, 's'),
    );
    expect(compareTraces(trace, trace, prices).operations).toHaveLength(4);
    const a = parseOtlpJson(
      otlpDoc([span('a', 0, 1)], [attr('service.name', sv('api')), attr('service.namespace', sv('prod'))]),
    );
    const b = parseOtlpJson(
      otlpDoc([span('b', 0, 1)], [attr('service.name', sv('api')), attr('service.namespace', sv('stage'))]),
    );
    expect(
      compareTraces(a, b, prices)
        .operations.map((op) => op.status)
        .sort(),
    ).toEqual(['added', 'removed']);
  });
  it('does not collide when operation names contain path separators', () => {
    const a = parse(span('a', 0, 2, undefined, 'a > other b'));
    const b = parse(span('b', 0, 2, undefined, 'a'), span('c', 0, 2, 'b', 'b'));
    expect(compareTraces(a, b, prices).operations).toHaveLength(3);
  });
  it('labels added/removed calls and treats absence as known zero', () => {
    const a = parse(llm('a', 'test', 10, 20));
    const b = parse(span('b', 0, 1, undefined, 'new'));
    const removed = compareTraces(a, b, prices).operations.find((op) => op.status === 'removed')!;
    expect(removed.metrics.outputTokens.delta).toBe(-20);
    expect(removed.metrics.costUsd.candidate).toEqual({ value: 0, missing: 0 });
  });
  it('keeps missing input/output and partial cost unknown, with subtotals inspectable', () => {
    const a = parse(llm('a', 'test', 100, 20), llm('b', 'test', 200));
    const report = compareTraces(a, parse(llm('c', 'test', 50, 10)), prices);
    expect(report.metrics.outputTokens.baseline).toEqual({ value: 20, missing: 1 });
    expect(report.metrics.outputTokens.delta).toBeNull();
    expect(report.metrics.inputTokens.delta).toBe(-250);
    expect(report.metrics.costUsd.delta).toBeNull();
  });
  it('does not equate unpriced models with free calls', () => {
    const a = parse(llm('a', 'unknown', 10, 20));
    const report = compareTraces(a, a, prices);
    expect(report.metrics.costUsd.baseline.missing).toBe(1);
    expect(report.metrics.costUsd.delta).toBeNull();
  });
  it('handles zero baselines without infinity or invented percentages', () => {
    expect(measurementChange({ value: 0, missing: 0 }, { value: 12, missing: 0 })).toMatchObject({
      delta: 12,
      percent: null,
    });
  });
  it('rejects multi-run files and duplicate or disconnected trees', () => {
    const multi = parse(span('a', 0, 10), span('b', 0, 10));
    multi.spans[1]!.traceId = 'other'; // Also defend the core against caller-built trees.
    expect(() => compareTraces(multi, multi, prices)).toThrow('more than one trace');
    const duplicate = parse(span('a', 0, 10));
    duplicate.spans.push(duplicate.spans[0]!);
    expect(() => compareTraces(duplicate, duplicate, prices)).toThrow('duplicate span IDs');
    const cyclic = parse(span('a', 0, 10));
    cyclic.roots = [];
    expect(() => compareTraces(cyclic, cyclic, prices)).toThrow('incomplete span tree');
  });
  it('preserves parser warnings', () => {
    const a = parse(span('a', 0, 1, 'missing'));
    expect(compareTraces(a, a, prices).warnings).toHaveLength(2);
  });
  it('explains the synthetic example using independently calculated totals', () => {
    const load = (side: string) =>
      parseOtlpJson(JSON.parse(readFileSync(new URL(`../examples/comparison-${side}.json`, import.meta.url), 'utf8')));
    const report = compareTraces(load('baseline'), load('candidate'), []);
    expect(report.wallTimeMs.delta).toBe(3400);
    expect(report.metrics.inputTokens.delta).toBe(2000);
    expect(report.metrics.outputTokens.delta).toBe(230);
    expect(report.metrics.selfTimeMs.baseline.value).toBe(7000);
    expect(report.metrics.selfTimeMs.candidate.value).toBe(9600);
    expect(report.operations[0]!.path.at(-1)).toContain('search_docs');
    expect(report.operations[0]!.metrics.selfTimeMs.delta).toBe(1500);
  });
});
