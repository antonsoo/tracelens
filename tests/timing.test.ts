import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseOtlpJson } from '../src/core/otlp-parser.js';
import { buildTiming, timingSpansAt } from '../src/core/timing.js';
import { selfTimeNs } from '../src/core/summary.js';
import type { ParsedTrace } from '../src/core/types.js';

const epoch = 1790000000000000000n;
const id = (n: number): string => n.toString(16).padStart(16, '0');
type Input = [start: number, end: number, parent?: number, kind?: string];
function trace(rows: Input[]): ParsedTrace {
  return parseOtlpJson({ resourceSpans: [{ scopeSpans: [{ spans: rows.map(([start, end, parent, kind], i) => ({
    traceId: 'a'.repeat(32), spanId: id(i + 1), ...(parent ? { parentSpanId: id(parent) } : {}), name: `span ${i + 1}`,
    startTimeUnixNano: String(epoch + BigInt(start)), endTimeUnixNano: String(epoch + BigInt(end)),
    attributes: [{ key: 'openinference.span.kind', value: { stringValue: kind ?? 'CHAIN' } }],
  })) }] }] });
}

describe('elapsed timing evidence', () => {
  it('accounts for a triple overlap, parent work and an uncovered gap exactly', () => {
    const input = trace([[0, 10], [1, 7, 1, 'LLM'], [3, 8, 1, 'TOOL'], [5, 6, 1, 'TOOL'], [12, 14, undefined, 'TOOL']]);
    const result = buildTiming(input);
    expect(result.bucketsNs).toEqual({ llm: '2', tool: '3', other: '3', overlap: '4', uncovered: '2' });
    expect(result.summedSelfNs).toBe('17');
    expect(result.overlapExcessNs).toBe('5');
    expect(result.peakConcurrency).toBe(3);
    expect(result.elapsedNs).toBe('14');
    expect(result.intervals.find((part) => part.offsetNs === '5')).toMatchObject({ activeCount: 3, spanIds: [id(2), id(3), id(4)] });
    expect(timingSpansAt(input, '10')).toEqual([]);
    expect(timingSpansAt(input, '5').map((span) => span.spanId)).toEqual([id(2), id(3), id(4)]);
  });

  it('treats touching calls and instantaneous spans as no overlap', () => {
    const result = buildTiming(trace([[0, 2, undefined, 'LLM'], [2, 4, undefined, 'TOOL'], [2, 2]]));
    expect(result.bucketsNs.overlap).toBe('0');
    expect(result.peakConcurrency).toBe(1);
    expect(result.intervals.map((part) => part.durationNs)).toEqual(['2', '2']);
    expect(buildTiming(trace([[2, 2]])).intervals).toEqual([]);
  });

  it('keeps detached child time and parser warning evidence', () => {
    const input = trace([[3, 7], [0, 5, 1, 'TOOL'], [6, 10, 1, 'LLM'], [4, 2]]);
    const result = buildTiming(input);
    expect(result.elapsedNs).toBe('10');
    expect(result.summedSelfNs).toBe('10');
    expect(result.bucketsNs).toEqual({ llm: '4', tool: '5', other: '1', overlap: '0', uncovered: '0' });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual(input.warnings);
  });

  it('explains the bundled comparison independently of rounded milliseconds', () => {
    const input = parseOtlpJson(JSON.parse(readFileSync('examples/comparison-baseline.json', 'utf8')));
    const result = buildTiming(input);
    expect(result.elapsedNs).toBe('6200000000');
    expect(result.summedSelfNs).toBe('7000000000');
    expect(result.overlapExcessNs).toBe('800000000');
    expect(result.bucketsNs.uncovered).toBe('0');
    expect(result.peakConcurrency).toBe(2);
  });

  it('matches an independent per-nanosecond oracle on many small irregular trees', () => {
    let state = 113;
    const random = (limit: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
    for (let trial = 0; trial < 180; trial++) {
      const input = trace(Array.from({ length: 2 + random(12) }, (_, i): Input => {
        const start = random(16);
        return [start, start + random(12), i && random(3) ? 1 + random(i) : undefined, ['LLM', 'TOOL', 'CHAIN'][random(3)]];
      }));
      const result = buildTiming(input);
      const buckets = { llm: 0, tool: 0, other: 0, overlap: 0, uncovered: 0 };
      let work = 0;
      let peak = 0;
      for (let t = input.minStartNs; t < input.maxEndNs; t++) {
        // Point membership does not share the interval subtraction/sweep implementation.
        const active = input.spans.filter((span) => t >= span.startTimeUnixNano && t < span.endTimeUnixNano
          && !input.spans.some((child) => child.parentSpanId === span.spanId && t >= child.startTimeUnixNano && t < child.endTimeUnixNano));
        const kind = active[0]?.agentKind;
        const bucket = !active.length ? 'uncovered' : active.length > 1 ? 'overlap' : kind === 'llm' || kind === 'tool' ? kind : 'other';
        buckets[bucket]++;
        work += active.length;
        peak = Math.max(peak, active.length);
        const part = result.intervals.find((p) => BigInt(p.offsetNs) <= t - input.minStartNs && t - input.minStartNs < BigInt(p.offsetNs) + BigInt(p.durationNs))!;
        expect(part.activeCount).toBe(active.length);
        expect(part.bucket).toBe(bucket);
        expect(timingSpansAt(input, part.offsetNs).map((span) => span.spanId).sort()).toEqual(active.map((span) => span.spanId).sort());
      }
      expect(result.bucketsNs).toEqual(Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, String(value)])));
      expect(result.summedSelfNs).toBe(String(work));
      expect(result.peakConcurrency).toBe(peak);
      expect(BigInt(result.summedSelfNs) - BigInt(result.overlapExcessNs) + BigInt(result.bucketsNs.uncovered)).toBe(BigInt(result.elapsedNs));
      expect(input.spans.reduce((total, span) => total + selfTimeNs(span), 0n)).toBe(BigInt(result.summedSelfNs));
    }
  });

  it('bounds stored source references while retaining exact concurrency and complete on-demand evidence', () => {
    const input = trace(Array.from({ length: 1200 }, (_, i): Input => [i, 2400 - i, undefined, 'TOOL']));
    const result = buildTiming(input);
    expect(result.peakConcurrency).toBe(1200);
    expect(result.intervals.length).toBe(2399);
    expect(result.intervals.every((part) => part.spanIds.length <= 8)).toBe(true);
    const middle = result.intervals.find((part) => part.activeCount === 1200)!;
    expect(middle.omittedSpanCount).toBe(1192);
    expect(timingSpansAt(input, middle.offsetNs)).toHaveLength(1200);
    expect(JSON.stringify(result).length).toBeLessThan(900_000);
  });
});
