import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSummary, parseOtlpJson } from '../src/core/index.js';
import { attr, fakeSpan, otlpDoc, sv } from './fixtures.js';

const tool = (id: string, start: number, end: number, statusCode = 0, name = 'lookup', parentSpanId?: string) =>
  fakeSpan({ spanId: id, name, startNs: start, endNs: end, statusCode, parentSpanId,
    attributes: [attr('gen_ai.operation.name', sv('execute_tool'))] });

function permutations<T>(values: T[]): T[][] {
  return values.length ? values.flatMap((value, i) => permutations(values.filter((_, j) => i !== j))
    .map(rest => [value, ...rest])) : [[]];
}

const counts = (spans: unknown[]) => {
  const summary = buildSummary(parseOtlpJson(otlpDoc(spans)), []);
  return [summary.retryCount, summary.unknownRetryCount ?? 0];
};

describe('equal-start retry predecessors', () => {
  it('retains the native SDK ambiguity under every unchanged span permutation', () => {
    const doc = JSON.parse(readFileSync(new URL('../studies/retry-order/fixtures/native.json', import.meta.url), 'utf8'));
    const spans = doc.resourceSpans[0].scopeSpans[0].spans as unknown[];
    for (const order of permutations(spans)) {
      const summary = buildSummary(parseOtlpJson(otlpDoc(order)), []);
      expect([summary.retryCount, summary.unknownRetryCount ?? 0, summary.errorCount]).toEqual([0, 1, 1]);
    }
  });

  it.each([
    ['conflicting outcomes', [tool('a', 0, 2, 2), tool('b', 0, 2, 1), tool('c', 3, 4, 1)], [0, 1]],
    ['both failed', [tool('a', 0, 2, 2), tool('b', 0, 2, 2), tool('c', 3, 4, 1)], [1, 0]],
    ['both successful', [tool('a', 0, 2, 1), tool('b', 0, 2, 1), tool('c', 3, 4, 1)], [0, 0]],
    ['unreadable outcome', [tool('a', 0, 2, 8), tool('b', 0, 2, 1), tool('c', 3, 4, 1)], [0, 1]],
    ['conflicting completion', [tool('a', 0, 2, 2), tool('b', 0, 6, 2), tool('c', 3, 4, 1)], [0, 1]],
    ['overlapping failures', [tool('a', 0, 6, 2), tool('b', 0, 6, 2), tool('c', 3, 4, 1)], [0, 0]],
    ['parallel later attempts', [tool('a', 0, 2, 2), tool('b', 3, 4, 1), tool('c', 3, 4, 1)], [2, 0]],
    ['same-start zero durations', [tool('a', 0, 0, 2), tool('b', 0, 0, 1), tool('c', 0, 0, 1)], [0, 0]],
    ['other tool name', [tool('a', 0, 2, 2), tool('b', 0, 2, 1, 'other'), tool('c', 3, 4, 1)], [1, 0]],
  ])('%s does not depend on record order', (_name, spans, expected) => {
    for (const order of permutations(spans)) expect(counts(order)).toEqual(expected);
  });

  it('does not mix different parents or different traces', () => {
    const root = fakeSpan({ spanId: 'root', startNs: 0, endNs: 20 });
    const other = fakeSpan({ spanId: 'other', startNs: 0, endNs: 20 });
    expect(counts([root, other, tool('a', 0, 2, 2, 'lookup', 'root'), tool('b', 3, 4, 1, 'lookup', 'other')]))
      .toEqual([0, 0]);
    const a = tool('a', 0, 2, 2), b = { ...tool('b', 3, 4, 1), traceId: 'b'.repeat(32) };
    expect(counts([a, b])).toEqual([0, 0]);
  });

  it('handles large timestamp peer groups without enumerating every candidate pair', () => {
    const spans = Array.from({ length: 20_000 }, (_, i) => tool(String(i), i < 10_000 ? 0 : 3, i < 10_000 ? 2 : 4,
      i < 10_000 ? 2 : 1));
    expect(counts(spans)).toEqual([10_000, 0]);
  });
});
