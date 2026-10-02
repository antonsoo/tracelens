import type { Change, Measurement, TraceComparison } from '../core/compare.js';
import { fmtInt, fmtMs, fmtUsd, heading, safe, table } from './format.js';

type Format = (value: number) => string;
function measured(value: Measurement, format: Format): string {
  return value.missing ? `unknown (${value.missing} missing)` : format(value.value);
}
function delta(change: Change, format: Format): string {
  if (change.delta === null) return 'unknown';
  const sign = change.delta > 0 ? '+' : change.delta < 0 ? '-' : '';
  const relative = change.percent === null ? '' : ` (${change.percent > 0 ? '+' : ''}${change.percent.toFixed(1)}%)`;
  return `${sign}${format(Math.abs(change.delta))}${relative}`;
}

export function formatComparison(report: TraceComparison): string {
  const row = (name: string, change: Change, format: Format): string[] => [
    name,
    measured(change.baseline, format),
    measured(change.candidate, format),
    delta(change, format),
  ];
  return [
    heading('Run comparison'),
    'Change = candidate - baseline. One pair of observations; not a benchmark.',
    table(
      ['metric', 'baseline', 'candidate', 'change'],
      [
        row('wall time', report.wallTimeMs, fmtMs),
        row('summed self time', report.metrics.selfTimeMs, fmtMs),
        row('spans', report.metrics.calls, fmtInt),
        row('input tokens', report.metrics.inputTokens, fmtInt),
        row('output tokens', report.metrics.outputTokens, fmtInt),
        row('estimated cost', report.metrics.costUsd, fmtUsd),
        row('errors', report.metrics.errors, fmtInt),
      ],
    ),
    heading('Operations, largest absolute self-time change first'),
    'Grouped by service, kind and full operation ancestry. Repeated calls are aggregated.',
    'Self time excludes direct children; concurrent work can exceed wall time.',
    table(
      ['operation path', 'status', 'calls B -> C', 'self time B -> C', 'change'],
      report.operations.map((op) => [
        safe(op.path.join(' > ')),
        op.status,
        `${op.baselineCalls.length} -> ${op.candidateCalls.length}`,
        `${fmtMs(op.metrics.selfTimeMs.baseline.value)} -> ${fmtMs(op.metrics.selfTimeMs.candidate.value)}`,
        delta(op.metrics.selfTimeMs, fmtMs),
      ]),
    ),
    ...report.warnings.map((warning) => `Warning: ${safe(warning)}`),
    '\nUse --json for token/cost changes and original span IDs per operation.',
  ].join('\n');
}
