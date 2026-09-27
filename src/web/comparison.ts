import type {
  CallEvidence,
  Change,
  Measurement,
  MetricChanges,
  OperationComparison,
  TraceComparison,
} from '../core/compare.js';
import { h, mount } from './dom.js';
import { fmtInt, fmtMs, fmtUsd } from './format.js';

export type ComparisonSide = 'baseline' | 'candidate';
interface Callbacks {
  onSwap: () => void;
  onReplace: (file: File) => void;
  onInspect: (side: ComparisonSide, spanId: string) => void;
  onClose: () => void;
}
type Format = (value: number) => string;

function measured(m: Measurement, format: Format): HTMLElement {
  return m.missing
    ? h(
        'span',
        {
          className: 'tl-unknown',
          title: `Known subtotal: ${format(m.value)}; ${m.missing} call(s) missing this measurement.`,
        },
        `Unknown (${m.missing} missing)`,
      )
    : h('span', {}, format(m.value));
}

function changed(change: Change, format: Format): HTMLElement {
  if (change.delta === null) return h('span', { className: 'tl-unknown' }, 'Unknown');
  const n = change.delta;
  return h(
    'span',
    { className: n > 0 ? 'tl-increase' : n < 0 ? 'tl-decrease' : 'dim' },
    `${n > 0 ? '+' : n < 0 ? '-' : ''}${format(Math.abs(n))}`,
    change.percent === null ? null : h('small', {}, ` (${change.percent > 0 ? '+' : ''}${change.percent.toFixed(1)}%)`),
  );
}

function metricsTable(metrics: MetricChanges, wall?: Change): HTMLElement {
  const rows: [string, Change, Format][] = [
    ...(wall ? [['Elapsed time', wall, fmtMs] as [string, Change, Format]] : []),
    ['Summed self time', metrics.selfTimeMs, fmtMs],
    ['Calls', metrics.calls, fmtInt],
    ['Input tokens', metrics.inputTokens, fmtInt],
    ['Output tokens', metrics.outputTokens, fmtInt],
    ['Estimated cost', metrics.costUsd, fmtUsd],
    ['Errors', metrics.errors, fmtInt],
  ];
  return h(
    'div',
    { className: 'tl-compare-table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Run measurements' },
    h(
      'table',
      { className: 'tl-compare-metrics' },
      h(
        'thead',
        {},
        h('tr', {}, ...['Measurement', 'Baseline', 'Candidate', 'Change'].map((s) => h('th', { scope: 'col' }, s))),
      ),
      h(
        'tbody',
        {},
        ...rows.map(([label, change, format]) =>
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, label),
            h('td', { className: 'mono' }, measured(change.baseline, format)),
            h('td', { className: 'mono' }, measured(change.candidate, format)),
            h('td', { className: 'mono' }, changed(change, format)),
          ),
        ),
      ),
    ),
  );
}

function evidence(calls: CallEvidence[], side: ComparisonSide, cb: Callbacks): HTMLElement {
  return h(
    'section',
    { className: 'tl-compare-evidence' },
    h('h4', {}, `${side === 'baseline' ? 'Baseline' : 'Candidate'} calls (${calls.length})`),
    calls.length
      ? h(
          'ul',
          {},
          ...calls
            .slice(0, 100)
            .map((call) =>
              h(
                'li',
                {},
                h(
                  'button',
                  {
                    className: 'tl-call-link',
                    onClick: () => cb.onInspect(side, call.spanId),
                    title: `Inspect span ${call.spanId}`,
                  },
                  call.name,
                ),
                h('span', { className: 'mono dim' }, `${fmtMs(call.selfTimeMs)} self${call.error ? ' / error' : ''}`),
                h('code', { className: 'dim' }, call.spanId),
                call.model ? h('span', { className: 'dim' }, call.model) : null,
              ),
            ),
        )
      : h('p', { className: 'dim' }, 'No calls on this side.'),
    calls.length > 100
      ? h('p', { className: 'dim' }, 'Showing the first 100 calls. Export JSON for all span IDs.')
      : null,
  );
}

function operationRow(op: OperationComparison, maxTime: number, cb: Callbacks): HTMLElement {
  const bar = (side: ComparisonSide) =>
    h(
      'div',
      { className: 'tl-pair-line' },
      h('span', { className: 'tl-pair-label' }, side === 'baseline' ? 'B' : 'C'),
      h(
        'span',
        { className: 'tl-pair-track', 'aria-hidden': 'true' },
        h('span', {
          className: `tl-pair-fill ${side}`,
          style: `width:${(op.metrics.selfTimeMs[side].value / maxTime) * 100}%`,
        }),
      ),
      h('span', { className: 'mono' }, fmtMs(op.metrics.selfTimeMs[side].value)),
    );
  return h(
    'details',
    { className: 'tl-operation' },
    h(
      'summary',
      {},
      h(
        'span',
        { className: 'tl-operation-label' },
        h('strong', {}, op.path.at(-1) ?? ''),
        h('span', { className: 'dim tl-operation-path' }, op.path.slice(0, -1).join(' / ') || 'Root operation'),
        op.status !== 'matched' ? h('span', { className: 'tl-operation-status' }, op.status) : null,
      ),
      h(
        'span',
        { className: 'mono tl-operation-count', title: 'Baseline calls to candidate calls' },
        `${op.baselineCalls.length} → ${op.candidateCalls.length}`,
      ),
      h(
        'span',
        { className: 'tl-pair', 'aria-label': 'Summed self time, baseline and candidate' },
        bar('baseline'),
        bar('candidate'),
      ),
      h('span', { className: 'mono tl-operation-change' }, changed(op.metrics.selfTimeMs, fmtMs)),
    ),
    h(
      'div',
      { className: 'tl-operation-details' },
      metricsTable(op.metrics),
      h(
        'div',
        { className: 'tl-evidence-columns' },
        evidence(op.baselineCalls, 'baseline', cb),
        evidence(op.candidateCalls, 'candidate', cb),
      ),
    ),
  );
}

function exportReport(report: TraceComparison): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = h('a', { href: url, download: 'tracelens-comparison.json' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderComparison(
  container: HTMLElement,
  report: TraceComparison,
  names: { baseline: string; candidate: string },
  cb: Callbacks,
): void {
  const input = h('input', {
    type: 'file',
    accept: '.json,application/json',
    className: 'visually-hidden',
    tabindex: '-1',
    'aria-label': 'Replace candidate trace',
    onChange: (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) cb.onReplace(file);
    },
  }) as HTMLInputElement;
  const rows = h('div', {});
  const count = h('p', { className: 'dim', 'aria-live': 'polite' });
  let filter = '';
  let limit = 100;
  let sort: 'selfTimeMs' | 'inputTokens' | 'costUsd' | 'errors' = 'selfTimeMs';
  const maxTime = report.operations.reduce(
    (max, op) => Math.max(max, op.metrics.selfTimeMs.baseline.value, op.metrics.selfTimeMs.candidate.value),
    1,
  );
  function renderRows(): void {
    const selected = report.operations
      .filter((op) => op.path.join(' ').toLowerCase().includes(filter))
      .sort((a, b) => Math.abs(b.metrics[sort].delta ?? 0) - Math.abs(a.metrics[sort].delta ?? 0));
    count.textContent = `${selected.length} of ${report.operations.length} operation paths. Expand a row to inspect calls.`;
    mount(
      rows,
      ...selected.slice(0, limit).map((op) => operationRow(op, maxTime, cb)),
      selected.length ? null : h('p', { className: 'dim' }, 'No operations match this filter.'),
      selected.length > limit
        ? h(
            'button',
            {
              className: 'tl-btn',
              onClick: () => {
                limit += 100;
                renderRows();
              },
            },
            'Show 100 more operations',
          )
        : null,
    );
  }
  renderRows();
  mount(
    container,
    h(
      'main',
      { className: 'tl-comparison' },
      h(
        'div',
        { className: 'tl-compare-title' },
        h(
          'div',
          {},
          h('h1', {}, 'Compare runs'),
          h('p', { className: 'dim' }, 'What changed between these two executions?'),
        ),
        h(
          'div',
          { className: 'tl-compare-actions' },
          h('button', { className: 'tl-btn', onClick: cb.onSwap }, 'Swap runs'),
          h('button', { className: 'tl-btn', onClick: () => input.click() }, 'Replace candidate'),
          h('button', { className: 'tl-btn', onClick: () => exportReport(report) }, 'Export JSON'),
          h('button', { className: 'tl-btn', onClick: cb.onClose }, 'Close comparison'),
          input,
        ),
      ),
      h(
        'div',
        { className: 'tl-run-names' },
        h('div', {}, h('span', { className: 'tl-baseline-key' }, 'Baseline'), h('strong', {}, names.baseline)),
        h('div', {}, h('span', { className: 'tl-candidate-key' }, 'Candidate'), h('strong', {}, names.candidate)),
      ),
      metricsTable(report.metrics, report.wallTimeMs),
      h(
        'p',
        { className: 'tl-compare-note' },
        'Change = candidate minus baseline. One pair of observations, not a benchmark. Self time excludes child spans; concurrent work can exceed elapsed time. Costs use the same editable price table for both runs.',
      ),
      report.warnings.length
        ? h(
            'details',
            { className: 'tl-compare-warnings' },
            h('summary', {}, `${report.warnings.length} parser warnings`),
            h('ul', {}, ...report.warnings.map((w) => h('li', {}, w))),
          )
        : null,
      h(
        'div',
        { className: 'tl-compare-toolbar' },
        h('h2', {}, 'Operation changes'),
        h(
          'label',
          {},
          'Filter ',
          h('input', {
            type: 'search',
            placeholder: 'Operation or service',
            onInput: (e: Event) => {
              filter = (e.target as HTMLInputElement).value.toLowerCase();
              limit = 100;
              renderRows();
            },
          }),
        ),
        h(
          'label',
          {},
          'Sort by ',
          h(
            'select',
            {
              onChange: (e: Event) => {
                sort = (e.target as HTMLSelectElement).value as typeof sort;
                renderRows();
              },
            },
            ...[
              ['selfTimeMs', 'Self-time change'],
              ['inputTokens', 'Input-token change'],
              ['costUsd', 'Cost change'],
              ['errors', 'Error change'],
            ].map(([value, label]) => h('option', { value }, label)),
          ),
        ),
      ),
      h(
        'p',
        { className: 'dim tl-compare-method' },
        'Matched by service, kind and full operation ancestry. Repeated calls are grouped; model changes remain visible inside each row. Renamed or moved operations appear as added or removed.',
      ),
      count,
      h(
        'div',
        { className: 'tl-operation-head', 'aria-hidden': 'true' },
        h('span', {}, 'Operation / parent path'),
        h('span', {}, 'Calls B → C'),
        h('span', {}, 'Self time (same scale)'),
        h('span', {}, 'Self-time change'),
      ),
      rows,
      h(
        'footer',
        { className: 'tl-compare-footer' },
        'Built by ',
        h('a', { href: 'https://github.com/antonsoo' }, 'Anton Soloviev'),
        '. ',
        h('a', { href: 'https://antonsoo.github.io/officina/' }, 'More tools from Officina'),
        '.',
      ),
    ),
  );
}
