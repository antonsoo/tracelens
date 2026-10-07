import type { ParsedSpan, ParsedTrace, ParseWarning } from './types.js';

export type TimingBucket = 'llm' | 'tool' | 'other' | 'overlap' | 'uncovered';
export const TIMING_BUCKETS: TimingBucket[] = ['llm', 'tool', 'other', 'overlap', 'uncovered'];
export const TIMING_LABELS: Record<TimingBucket, string> = {
  llm: 'LLM alone', tool: 'Tool alone', other: 'Other alone',
  overlap: 'Overlapping work', uncovered: 'No recorded span',
};

export interface TimingInterval {
  /** Relative to startTimeUnixNano. Integer strings preserve nanoseconds in JSON. */
  offsetNs: string;
  durationNs: string;
  bucket: TimingBucket;
  activeCount: number;
  /** Bounded examples, not a complete list when omittedSpanCount is nonzero. */
  spanIds: string[];
  omittedSpanCount: number;
}

export interface TraceTiming {
  schemaVersion: 1;
  format: 'tracelens-timing';
  traceId: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  elapsedNs: string;
  bucketsNs: Record<TimingBucket, string>;
  summedSelfNs: string;
  /** Repeated coverage: integral(max(active self-time spans - 1, 0)). */
  overlapExcessNs: string;
  peakConcurrency: number;
  spanRefsPerInterval: number;
  intervals: TimingInterval[];
  warnings: ParseWarning[];
}

interface Interval { start: bigint; end: bigint }

/** Positive, half-open pieces of a span not covered by a direct child.
 * Children are clipped to the parent and unioned, including overlaps and ties.
 * Detached child time remains the child's own recorded time elsewhere.
 */
export function selfIntervals(span: ParsedSpan): Interval[] {
  const start = span.startTimeUnixNano;
  const end = span.endTimeUnixNano;
  if (end <= start) return [];
  const children = span.children.map((child) => ({
    start: child.startTimeUnixNano > start ? child.startTimeUnixNano : start,
    end: child.endTimeUnixNano < end ? child.endTimeUnixNano : end,
  })).filter((child) => child.end > child.start)
    .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  const pieces: Interval[] = [];
  let cursor = start;
  for (const child of children) {
    if (child.start > cursor) pieces.push({ start: cursor, end: child.start });
    if (child.end > cursor) cursor = child.end;
  }
  if (cursor < end) pieces.push({ start: cursor, end });
  return pieces;
}

/** Observed timestamp accounting, not CPU utilization or a causal critical path.
 * Subtract children first, then sweep exclusive intervals. Parent + child do
 * not count as concurrent work. Nanosecond arithmetic remains exact throughout.
 * Work is O(n log n); retained interval evidence is O(n), even for full overlap.
 */
export function buildTiming(trace: ParsedTrace): TraceTiming {
  const events: { at: bigint; index: number; start: boolean }[] = [];
  let summedSelf = 0n;
  trace.spans.forEach((span, index) => {
    for (const piece of selfIntervals(span)) {
      events.push({ at: piece.start, index, start: true }, { at: piece.end, index, start: false });
      summedSelf += piece.end - piece.start;
    }
  });
  events.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.index - b.index);
  const buckets = { llm: 0n, tool: 0n, other: 0n, overlap: 0n, uncovered: 0n };
  const intervals: TimingInterval[] = [];
  const active = new Set<number>();
  const refLimit = 8;
  let previous = trace.minStartNs;
  let excess = 0n;
  let peak = 0;
  const append = (end: bigint): void => {
    if (end <= previous) return;
    const duration = end - previous;
    const first = active.values().next().value;
    const kind = first === undefined ? undefined : trace.spans[first]!.agentKind;
    const bucket: TimingBucket = active.size === 0 ? 'uncovered' : active.size > 1 ? 'overlap'
      : kind === 'llm' || kind === 'tool' ? kind : 'other';
    buckets[bucket] += duration;
    if (active.size > 1) excess += BigInt(active.size - 1) * duration;
    peak = Math.max(peak, active.size);
    const spanIds: string[] = [];
    for (const index of active) {
      spanIds.push(trace.spans[index]!.spanId);
      if (spanIds.length === refLimit) break;
    }
    intervals.push({ offsetNs: (previous - trace.minStartNs).toString(), durationNs: duration.toString(),
      bucket, activeCount: active.size, spanIds, omittedSpanCount: active.size - spanIds.length });
    previous = end;
  };
  for (let i = 0; i < events.length;) {
    const at = events[i]!.at;
    append(at);
    // Applying all changes before the next positive interval makes touching
    // endpoints non-overlapping, irrespective of export/source ordering.
    while (i < events.length && events[i]!.at === at) {
      const event = events[i++]!;
      if (event.start) active.add(event.index);
      else active.delete(event.index);
    }
  }
  append(trace.maxEndNs);
  return {
    schemaVersion: 1, format: 'tracelens-timing', traceId: trace.traceId,
    startTimeUnixNano: trace.minStartNs.toString(), endTimeUnixNano: trace.maxEndNs.toString(),
    elapsedNs: (trace.maxEndNs - trace.minStartNs).toString(),
    bucketsNs: { llm: buckets.llm.toString(), tool: buckets.tool.toString(), other: buckets.other.toString(),
      overlap: buckets.overlap.toString(), uncovered: buckets.uncovered.toString() },
    summedSelfNs: summedSelf.toString(), overlapExcessNs: excess.toString(), peakConcurrency: peak,
    spanRefsPerInterval: refLimit, intervals, warnings: trace.warnings.map((warning) => ({ ...warning })),
  };
}

/** Resolve every active span for an explicitly selected window without storing
 * a quadratic copy of concurrent IDs at every timestamp boundary. */
export function timingSpansAt(trace: ParsedTrace, offsetNs: string): ParsedSpan[] {
  const at = trace.minStartNs + BigInt(offsetNs);
  return trace.spans.filter((span) => span.startTimeUnixNano <= at && at < span.endTimeUnixNano
    && !span.children.some((child) => child.startTimeUnixNano <= at && at < child.endTimeUnixNano));
}

export const timingMs = (ns: string): number => Number(ns) / 1_000_000;
