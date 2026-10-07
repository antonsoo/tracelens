import { TIMING_BUCKETS, TIMING_LABELS, timingMs, timingSpansAt } from '../core/timing.js';
import type { TraceTiming, TimingInterval } from '../core/timing.js';
import type { ParsedSpan, ParsedTrace } from '../core/types.js';
import { h, mount } from './dom.js';
import { fmtInt, fmtMs, textPreview } from './format.js';
import { pagedEvidence } from './paged-evidence.js';
import { downloadEvidence } from './evidence.js';

interface View {
  open: boolean;
  filter: string;
  selected: string | null;
  spans: ParsedSpan[];
  timing?: TraceTiming;
  windows?: TimingInterval[];
}
const views = new WeakMap<ParsedTrace, Map<string, View>>();

export function renderTimingPanel(trace: ParsedTrace, timing: TraceTiming, inspect: (id: string) => void, label = 'Trace'): HTMLElement {
  let labels = views.get(trace);
  if (!labels) { labels = new Map(); views.set(trace, labels); }
  let view = labels.get(label);
  if (!view) { view = { open: false, filter: 'interesting', selected: null, spans: [] }; labels.set(label, view); }
  const state = view;
  const body = h('div', { className: 'tl-timing-body' });
  const panel = h('details', { className: 'tl-timing', open: state.open },
    h('summary', { 'data-focus-key': `timing-${label}-open` },
      h('strong', {}, `${label} elapsed-time breakdown`),
      h('span', { className: 'mono dim' }, `${fmtMs(timingMs(timing.bucketsNs.overlap))} overlapping · ${fmtMs(timingMs(timing.bucketsNs.uncovered))} uncovered · peak ${timing.peakConcurrency}`)), body);
  const draw = (): void => {
    if (state.timing !== timing || !state.windows) {
      state.windows = timing.intervals.filter((part) => state.filter === 'all' || (state.filter === 'interesting'
        ? part.bucket === 'overlap' || part.bucket === 'uncovered' : part.bucket === state.filter))
        .sort((a, b) => BigInt(a.durationNs) > BigInt(b.durationNs) ? -1 : BigInt(a.durationNs) < BigInt(b.durationNs) ? 1 : 0);
      state.timing = timing;
    }
    const elapsed = timingMs(timing.elapsedNs);
    const bucketLabels = TIMING_BUCKETS.map((bucket) => `${TIMING_LABELS[bucket]}: ${fmtMs(timingMs(timing.bucketsNs[bucket]))}`);
    const selected = timing.intervals.find((part) => part.offsetNs === state.selected);
    const select = h('select', { 'aria-label': `${label} interval filter`, 'data-focus-key': `timing-${label}-filter`, onChange: (event: Event) => {
      state.filter = (event.target as HTMLSelectElement).value;
      state.windows = undefined;
      draw();
      body.querySelector<HTMLSelectElement>('select')?.focus();
    } }, ...[['interesting', 'Overlap and gaps'], ['all', 'All intervals'], ...TIMING_BUCKETS.map((bucket) => [bucket, TIMING_LABELS[bucket]])]
      .map(([value, title]) => h('option', { value, selected: value === state.filter }, title)));
    mount(body,
      h('h2', { className: 'tl-timing-title' }, `${label} elapsed-time accounting`),
      h('p', { className: 'tl-timing-equation mono' }, `${fmtMs(elapsed)} elapsed = ${fmtMs(timingMs(timing.summedSelfNs))} summed self time − ${fmtMs(timingMs(timing.overlapExcessNs))} overlap excess + ${fmtMs(timingMs(timing.bucketsNs.uncovered))} uncovered`),
      h('div', { className: 'tl-timing-bar', role: 'img', 'aria-label': bucketLabels.join('; ') }, ...TIMING_BUCKETS.map((bucket) =>
        h('span', { className: `timing-${bucket}`, style: `width:${elapsed ? timingMs(timing.bucketsNs[bucket]) / elapsed * 100 : 0}%` }))),
      h('dl', { className: 'tl-timing-buckets' }, ...TIMING_BUCKETS.map((bucket) => h('div', {},
        h('dt', {}, h('i', { className: `timing-${bucket}`, 'aria-hidden': 'true' }), TIMING_LABELS[bucket]),
        h('dd', { className: 'mono' }, fmtMs(timingMs(timing.bucketsNs[bucket])))))),
      h('p', { className: 'dim tl-timing-note' }, 'Parent time covered by a direct child is excluded. Overlap counts each wall-clock moment once; overlap excess counts repeated coverage. Other includes orchestration and uninstrumented time inside spans. A gap means no recorded span, not proof of idle time. Clock skew and missing telemetry can change this view.'),
      h('div', { className: 'tl-timing-controls' },
        h('label', {}, 'Inspect ', select),
        h('button', { className: 'tl-btn', 'data-focus-key': `timing-${label}-download`, onClick: () => downloadEvidence(timing, `tracelens-${label.toLowerCase()}-timing.json`) }, 'Download timing JSON')),
      h('p', { className: 'dim' }, 'Intervals ordered by duration, longest first. Select one to inspect every active self-time span.'),
      pagedEvidence(state, `${label} timing intervals`, state.windows, (page) => h('div', { className: 'tl-timing-windows' }, ...page.map((part) =>
        h('button', { className: 'tl-timing-window', 'aria-pressed': part.offsetNs === state.selected, 'data-focus-key': `timing-${label}-${part.offsetNs}`,
          onClick: () => {
            state.selected = part.offsetNs;
            state.spans = timingSpansAt(trace, part.offsetNs);
            draw();
            body.querySelector<HTMLElement>('.tl-timing-source h3')?.focus();
          } },
        h('span', {}, TIMING_LABELS[part.bucket]),
        h('span', { className: 'mono' }, `+${fmtMs(timingMs(part.offsetNs))} / ${fmtMs(timingMs(part.durationNs))}`),
        h('span', {}, `${fmtInt(part.activeCount)} active`)))), 10),
      selected ? h('section', { className: 'tl-timing-source' },
        h('h3', { tabindex: '-1', 'data-focus-key': `timing-${label}-source` }, `${label}: ${fmtInt(selected.activeCount)} active self-time spans at +${fmtMs(timingMs(selected.offsetNs))}`),
        h('p', { className: 'dim' }, `Exact offset ${selected.offsetNs} ns, duration ${selected.durationNs} ns. Half-open interval: its end is excluded.`),
        state.spans.length ? pagedEvidence(state, `${label} interval spans`, state.spans, (page) => h('ul', {}, ...page.map((span) => h('li', {},
          h('button', { className: 'tl-call-link', onClick: () => inspect(span.spanId), title: `Inspect span ${span.spanId}` }, textPreview(span.name, 120)),
          h('code', {}, span.spanId)))), 20) : h('p', {}, 'No span covers this interval. The trace alone does not identify what happened here.'),
        h('button', { className: 'tl-btn', 'data-focus-key': `timing-${label}-interval-download`, onClick: () => downloadEvidence({
          schemaVersion: 1, format: 'tracelens-timing-interval', traceId: trace.traceId,
          startTimeUnixNano: timing.startTimeUnixNano, ...selected,
          spanIds: state.spans.map((span) => span.spanId), omittedSpanCount: 0,
        }, 'tracelens-timing-interval.json') }, 'Download interval span IDs'),
      ) : null,
    );
  };
  panel.addEventListener('toggle', () => {
    state.open = (panel as HTMLDetailsElement).open;
    if (state.open) draw();
  });
  if (state.open) draw();
  return panel;
}
