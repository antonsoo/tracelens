import { TIMING_BUCKETS, TIMING_LABELS, timingMs } from '../core/timing.js';
import type { TraceTiming } from '../core/timing.js';
import { fmtMs, heading, safe, table } from './format.js';

export function formatTiming(timing: TraceTiming, intervals = true): string {
  const windows = [...timing.intervals].filter((part) => part.bucket === 'overlap' || part.bucket === 'uncovered')
    .sort((a, b) => BigInt(a.durationNs) > BigInt(b.durationNs) ? -1 : BigInt(a.durationNs) < BigInt(b.durationNs) ? 1 : 0);
  return [
    heading('Elapsed-time accounting'),
    `${fmtMs(timingMs(timing.elapsedNs))} elapsed = ${fmtMs(timingMs(timing.summedSelfNs))} summed self time - ${fmtMs(timingMs(timing.overlapExcessNs))} overlap excess + ${fmtMs(timingMs(timing.bucketsNs.uncovered))} uncovered`,
    table(['Recorded coverage', 'Elapsed time'], TIMING_BUCKETS.map((bucket) => [TIMING_LABELS[bucket], fmtMs(timingMs(timing.bucketsNs[bucket]))])),
    `Peak concurrent self-time spans: ${timing.peakConcurrency}. Parent/child nesting is excluded.`,
    'Timestamp coverage is not CPU use, a causal critical path, or proof of idle time.',
    ...(intervals && windows.length ? [
      heading('Longest overlap / uncovered intervals'),
      table(['Offset', 'Duration', 'Active', 'Span IDs (examples)'], windows.slice(0, 10).map((part) => [
        fmtMs(timingMs(part.offsetNs)), fmtMs(timingMs(part.durationNs)), String(part.activeCount),
        safe(part.spanIds.slice(0, 2).join(', ')) + (part.activeCount > 2 ? ` (+${part.activeCount - 2})` : '') || '(no span)',
      ])),
      `${windows.length} such interval(s); --json retains every interval and bounded span references.`,
    ] : []),
  ].join('\n');
}
