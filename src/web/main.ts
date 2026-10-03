import './fonts/fonts.css';
import './style.css';
import { decodeText } from '../core/decode.js';
import { buildSummary, compareTraces, parseOtlpJson, parseTraceText, TraceParseError } from '../core/index.js';
import type { ParsedSpan, ParsedTrace, PriceEntry, TraceComparison, TraceListing, TraceSummary } from '../core/index.js';
import { Store } from './store.js';
import { h, mount } from './dom.js';
import { fmtInt, fmtMs } from './format.js';
import { renderDropzone } from './dropzone.js';
import { renderSummaryHeader } from './summary-header.js';
import { disposeWaterfall, renderWaterfall } from './waterfall.js';
import { renderDetailPanel } from './detail-panel.js';
import type { DetailTab } from './detail-panel.js';
import { loadPriceTable, openPriceDialog } from './price-settings.js';
import { createComparisonViewState, renderComparison } from './comparison.js';
import type { ComparisonSide } from './comparison.js';
import type { SpanFilter } from './span-search.js';

interface AppState {
  trace: ParsedTrace | null;
  /** The text `trace` was read from, kept so that another of the file's traces can be read. Null for the bundled samples. */
  source: string | null;
  baseline: ParsedTrace | null;
  baselineName: string | null;
  baselineSource: string | null;
  view: 'trace' | 'compare';
  inspectedSide: ComparisonSide;
  fileName: string | null;
  loadError: string | null;
  loading: string | null;
  selectedSpanId: string | null;
  detailTab: DetailTab;
  collapsedIds: Set<string>;
  priceTable: PriceEntry[];
  theme: 'light' | 'dark';
  zoom: number;
  panNs: bigint;
}

const THEME_KEY = 'tracelens.theme';
function initialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* Use the system theme when browser storage is blocked. */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const store = new Store<AppState>({
  trace: null,
  source: null,
  baseline: null,
  baselineName: null,
  baselineSource: null,
  view: 'trace',
  inspectedSide: 'candidate',
  fileName: null,
  loadError: null,
  loading: null,
  selectedSpanId: null,
  detailTab: 'overview',
  collapsedIds: new Set(),
  priceTable: loadPriceTable(),
  theme: initialTheme(),
  zoom: 1,
  panNs: 0n,
});

function findSpan(trace: ParsedTrace, spanId: string | null): ParsedSpan | null {
  if (!spanId) return null;
  return trace.spans.find((s) => s.spanId === spanId) ?? null;
}

// A newer file choice or navigation supersedes any outstanding read/fetch.
let loadVersion = 0;
let loadController: AbortController | null = null;

function supersedeLoads(): void {
  loadVersion++;
  loadController?.abort();
  loadController = null;
}

function beginLoad(label: string): { version: number; signal: AbortSignal } {
  supersedeLoads();
  loadController = new AbortController();
  const task = { version: loadVersion, signal: loadController.signal };
  store.set({ loading: label, loadError: null });
  return task;
}

function finishLoad(version: number, patch: Partial<AppState>): void {
  if (version !== loadVersion) return;
  // Also stops a sibling sample request if one half of a comparison failed.
  loadController?.abort();
  loadController = null;
  store.set({ ...patch, loading: null });
  if (patch.trace) {
    const destination = document.querySelector<HTMLElement>('.tl-comparison h1, #tl-span-search');
    destination?.focus({ preventScroll: true });
  }
}

function loadNotice(state: AppState): HTMLElement | null {
  return state.loading ? h('div', { className: 'tl-load-notice' },
    h('span', { role: 'status' }, `Loading ${state.loading}...`),
    h('button', { className: 'tl-btn', 'data-focus-key': 'cancel-load', onClick: () => {
      supersedeLoads();
      store.set({ loading: null });
      document.querySelector<HTMLElement>('[data-focus-key="choose-file"], [data-focus-key="compare-run"], [data-focus-key="replace-candidate"]')?.focus();
    } }, 'Cancel loading')) : null;
}

async function loadFile(file: File): Promise<void> {
  const { version } = beginLoad(file.name);
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('Trace files must be 25 MB or smaller. Export a single run and try again.');
    const bytes = await file.arrayBuffer();
    if (version !== loadVersion) return;
    const text = decodeText(new Uint8Array(bytes));
    const trace = parseTraceText(text);
    if (version !== loadVersion) return;
    finishLoad(version, { trace, source: text, baseline: null, baselineName: null, baselineSource: null, view: 'trace', inspectedSide: 'candidate', fileName: file.name, loadError: null, selectedSpanId: null, collapsedIds: new Set(), zoom: 1, panNs: 0n });
  } catch (err) {
    if (version !== loadVersion) return;
    const message =
      err instanceof TraceParseError
        ? err.message
        : `Couldn't load "${file.name}": ${err instanceof Error ? err.message : String(err)}`;
    finishLoad(version, { loadError: message });
  }
}

/** Reads another trace from the file behind the side being inspected. */
function pickTrace(traceId: string): void {
  const state = store.get();
  const onBaseline = state.baseline !== null && state.inspectedSide === 'baseline';
  const source = onBaseline ? state.baselineSource : state.source;
  if (source === null) return;
  supersedeLoads();
  try {
    const trace = parseTraceText(source, { traceId });
    // Validate before replacing either side. A trace can be inspectable yet
    // exceed the comparison's bounded ancestry limit.
    if (state.baseline && state.trace) comparisonOf(onBaseline ? trace : state.baseline, onBaseline ? state.trace : trace, state.priceTable);
    store.set({ ...(onBaseline ? { baseline: trace } : { trace }), loading: null, loadError: null, selectedSpanId: null, collapsedIds: new Set(), zoom: 1, panNs: 0n });
  } catch (err) {
    store.set({ loading: null, loadError: err instanceof Error ? err.message : String(err) });
  }
}

async function loadCandidate(file: File): Promise<void> {
  const state = store.get();
  const baseline = state.baseline ?? state.trace;
  if (!baseline) return;
  const { version } = beginLoad(file.name);
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('Trace files must be 25 MB or smaller. Export a single run and try again.');
    const bytes = await file.arrayBuffer();
    if (version !== loadVersion) return;
    const text = decodeText(new Uint8Array(bytes));
    const trace = parseTraceText(text);
    if (version !== loadVersion) return;
    comparisonOf(baseline, trace, store.get().priceTable);
    finishLoad(version, { baseline, baselineName: state.baselineName ?? state.fileName, baselineSource: state.baseline ? state.baselineSource : state.source, trace, source: text, fileName: file.name, view: 'compare', inspectedSide: 'candidate', loadError: null, selectedSpanId: null });
  } catch (err) {
    if (version !== loadVersion) return;
    finishLoad(version, { loadError: `Couldn't compare "${file.name}": ${err instanceof Error ? err.message : String(err)}` });
  }
}

async function loadComparisonExample(): Promise<void> {
  const { version, signal } = beginLoad('comparison example');
  try {
    const traces = await Promise.all(['baseline', 'candidate'].map(async (side) => {
      const response = await fetch(`${import.meta.env.BASE_URL}examples/comparison-${side}.json`, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseOtlpJson(await response.json());
    }));
    if (version !== loadVersion) return;
    comparisonOf(traces[0]!, traces[1]!, store.get().priceTable);
    finishLoad(version, { baseline: traces[0]!, baselineName: 'baseline (synthetic)', baselineSource: null, trace: traces[1]!, source: null, fileName: 'candidate (synthetic)', view: 'compare', inspectedSide: 'candidate', loadError: null, selectedSpanId: null });
  } catch (err) {
    if (version !== loadVersion) return;
    finishLoad(version, { loadError: `Couldn't load comparison: ${err instanceof Error ? err.message : String(err)}` });
  }
}

async function loadExample(path: string): Promise<void> {
  const { version, signal } = beginLoad(path.split('/').pop() ?? path);
  try {
    const base = import.meta.env.BASE_URL;
    const res = await fetch(`${base}${path}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const trace = parseOtlpJson(json);
    if (version !== loadVersion) return;
    finishLoad(version, { trace, source: null, baseline: null, baselineName: null, baselineSource: null, view: 'trace', inspectedSide: 'candidate', fileName: path.split('/').pop() ?? path, loadError: null, selectedSpanId: null, collapsedIds: new Set(), zoom: 1, panNs: 0n });
  } catch (err) {
    if (version !== loadVersion) return;
    finishLoad(version, { loadError: `Couldn't load the sample trace: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', theme);
}

function buildHeader(state: AppState): HTMLElement {
  const compareInput = h('input', { type: 'file', accept: '.json,.jsonl,.ndjson,application/json', className: 'visually-hidden', tabindex: '-1', 'aria-label': 'Candidate trace file', onChange: (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void loadCandidate(file);
  } }) as HTMLInputElement;
  return h(
    'header',
    { className: 'tl-header' },
    h(
      'div',
      { className: 'tl-brand' },
      logoSvg(),
      'tracelens',
      h('span', { className: 'tagline' }, 'LLM agent trace viewer'),
    ),
    h(
      'div',
      { className: 'tl-header-actions' },
      state.trace && state.view === 'trace'
        ? h('h1', { className: 'dim mono tl-active-file' }, `${state.baseline ? `${state.inspectedSide}: ` : ''}${state.baseline && state.inspectedSide === 'baseline' ? state.baselineName ?? '' : state.fileName ?? ''}`)
        : null,
      compareInput,
      state.trace && state.view !== 'compare' ? h('button', { className: 'tl-btn', 'data-focus-key': 'compare-run', onClick: () => {
        if (!state.baseline) { compareInput.click(); return; }
        store.set({ view: 'compare' });
        document.querySelector<HTMLElement>('.tl-comparison h1')?.focus({ preventScroll: true });
      } }, state.baseline ? 'Back to comparison' : 'Compare with another run') : null,
      state.trace
        ? h(
            'button',
            {
              className: 'tl-btn',
              onClick: () => {
                supersedeLoads();
                store.set({ trace: null, source: null, baseline: null, baselineName: null, baselineSource: null, view: 'trace', fileName: null, loading: null, loadError: null, selectedSpanId: null });
                document.querySelector<HTMLElement>('[data-focus-key="choose-file"]')?.focus();
              },
            },
            'Load another trace',
          )
        : null,
      h(
        'button',
        { className: 'tl-btn', 'data-focus-key': 'prices', onClick: () => openPriceDialog(state.priceTable, (table) => store.set({ priceTable: table })) },
        'Prices',
      ),
      h('a', { className: 'tl-btn', href: 'https://github.com/antonsoo/tracelens', target: '_blank', rel: 'noreferrer' }, 'GitHub'),
      h(
        'button',
        {
          className: 'tl-btn',
          'data-focus-key': 'theme',
          'aria-pressed': state.theme === 'dark',
          'aria-label': 'Toggle dark mode',
          onClick: () => {
            const next = state.theme === 'dark' ? 'light' : 'dark';
            try { localStorage.setItem(THEME_KEY, next); } catch { /* Theme still works for this session. */ }
            store.set({ theme: next });
          },
        },
        state.theme === 'dark' ? '☾' : '☀',
      ),
    ),
  );
}

function logoSvg(): HTMLElement {
  const wrap = h('div', {});
  wrap.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--text)"/><path d="M5 22 L11 22 L13 12 L17 26 L20 8 L23 22 L27 22" stroke="var(--bg)" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return wrap.firstElementChild as HTMLElement;
}

function describeListing(t: TraceListing): string {
  const started = new Date(Number(t.startNs / 1_000_000n)).toISOString().slice(0, 19).replace('T', ' ');
  return `${started} UTC · ${t.rootName} · ${fmtInt(t.spanCount)} ${t.spanCount === 1 ? 'span' : 'spans'} · ${fmtMs(Number(t.durationNs) / 1_000_000)} · ${t.traceId.slice(0, 8)}`;
}

/** In a comparison, a file of several traces is named with the trace that was read from it. */
function nameWithTrace(name: string, trace: ParsedTrace): string {
  return trace.traces.length > 1 ? `${name} · trace ${trace.traceId.slice(0, 8)} of ${trace.traces.length}` : name;
}

/** For a file that holds several traces: says so, and lets another one be read. */
function tracePicker(trace: ParsedTrace, source: string | null): HTMLElement | null {
  if (trace.traces.length < 2 || source === null) return null;
  const select = h(
    'select',
    { id: 'tl-trace-picker', 'data-focus-key': 'trace-picker', className: 'tl-trace-select mono', onChange: (e: Event) => pickTrace((e.target as HTMLSelectElement).value) },
    ...trace.traces.map((t) => h('option', { value: t.traceId, ...(t.traceId === trace.traceId ? { selected: 'selected' } : {}) }, describeListing(t))),
  );
  return h(
    'div',
    { className: 'tl-trace-picker' },
    h('label', { for: 'tl-trace-picker' }, `This file holds ${fmtInt(trace.traces.length)} traces. Showing`),
    select,
  );
}

// Every state change renders the whole view again: a selection, a zoom step, each mouse move of a
// pan. The summary and the comparison depend only on the traces and the prices, so the last one
// of each is kept rather than recomputed over every span each time.
let lastSummary: { trace: ParsedTrace; prices: PriceEntry[]; summary: TraceSummary } | null = null;
function summaryOf(trace: ParsedTrace, prices: PriceEntry[]): TraceSummary {
  if (lastSummary?.trace !== trace || lastSummary.prices !== prices) lastSummary = { trace, prices, summary: buildSummary(trace, prices) };
  return lastSummary.summary;
}

let lastComparison: { baseline: ParsedTrace; candidate: ParsedTrace; prices: PriceEntry[]; report: TraceComparison } | null = null;
function comparisonOf(baseline: ParsedTrace, candidate: ParsedTrace, prices: PriceEntry[]): TraceComparison {
  if (lastComparison?.baseline !== baseline || lastComparison.candidate !== candidate || lastComparison.prices !== prices) {
    lastComparison = { baseline, candidate, prices, report: compareTraces(baseline, candidate, prices) };
  }
  return lastComparison.report;
}

let comparisonView = createComparisonViewState();
let comparedBaseline: ParsedTrace | null = null;
let comparedCandidate: ParsedTrace | null = null;
const spanFilters = new WeakMap<ParsedTrace, SpanFilter>();

function renderApp(): void {
  const state = store.get();
  applyTheme(state.theme);
  const app = document.getElementById('app')!;
  const previousComparison = app.querySelector('.tl-comparison-shell');
  if (previousComparison) comparisonView.scrollTop = previousComparison.scrollTop;
  if (!state.baseline) {
    lastComparison = null;
    comparisonView = createComparisonViewState();
    comparedBaseline = null;
    comparedCandidate = null;
  }

  if (!state.trace) {
    disposeWaterfall();
    lastSummary = null;
    mount(
      app,
      buildHeader(state),
      loadNotice(state),
      state.loadError ? h('div', { className: 'tl-load-error', role: 'alert' }, state.loadError) : null,
    );
    const rest = h('div', { style: 'flex:1;display:flex;min-height:0' });
    app.appendChild(h('main', { className: 'tl-page-main' }, rest));
    renderDropzone(rest, {
      onFile: (f) => void loadFile(f),
      onLoadExample: (p) => void loadExample(p),
      onCompareExample: () => void loadComparisonExample(),
    });
    return;
  }

  if (state.baseline && state.view === 'compare') {
    disposeWaterfall();
    lastSummary = null;
    if (comparedBaseline !== state.baseline || comparedCandidate !== state.trace) {
      comparisonView = createComparisonViewState();
      comparedBaseline = state.baseline;
      comparedCandidate = state.trace;
    }
    const focusedFilter = document.activeElement?.matches('.tl-compare-toolbar input') ? document.activeElement as HTMLInputElement : null;
    const selection = focusedFilter ? [focusedFilter.selectionStart, focusedFilter.selectionEnd] as const : null;
    const comparisonEl = h('div', { className: 'tl-comparison-shell' });
    renderComparison(comparisonEl, comparisonOf(state.baseline, state.trace, state.priceTable),
      { baseline: nameWithTrace(state.baselineName ?? 'Baseline', state.baseline), candidate: nameWithTrace(state.fileName ?? 'Candidate', state.trace) }, {
        onSwap: () => { supersedeLoads(); store.set({ trace: state.baseline, source: state.baselineSource, fileName: state.baselineName, baseline: state.trace, baselineSource: state.source, baselineName: state.fileName, selectedSpanId: null, loading: null, loadError: null }); },
        onReplace: (file) => void loadCandidate(file),
        onInspect: (side, spanId) => {
          supersedeLoads();
          spanFilters.delete(side === 'baseline' ? state.baseline! : state.trace!);
          store.set({ view: 'trace', inspectedSide: side, selectedSpanId: spanId, detailTab: 'overview', loading: null, collapsedIds: new Set(), zoom: 1, panNs: 0n });
          document.querySelector<HTMLElement>('.tl-wf-row.selected')?.focus({ preventScroll: true });
        },
        onClose: () => {
          supersedeLoads();
          store.set({ baseline: null, baselineName: null, baselineSource: null, view: 'trace', inspectedSide: 'candidate', selectedSpanId: null, loading: null, loadError: null, collapsedIds: new Set(), zoom: 1, panNs: 0n });
          document.getElementById('tl-span-search')?.focus({ preventScroll: true });
        },
      }, comparisonView);
    mount(app, buildHeader(state), loadNotice(state), state.loadError ? h('div', { className: 'tl-load-error', role: 'alert' }, state.loadError) : null, comparisonEl);
    comparisonEl.scrollTop = comparisonView.scrollTop;
    if (selection) {
      const filter = comparisonEl.querySelector<HTMLInputElement>('input[type="search"]')!;
      filter.focus({ preventScroll: true });
      filter.setSelectionRange(...selection);
    }
    return;
  }

  const activeTrace = state.baseline && state.inspectedSide === 'baseline' ? state.baseline : state.trace;
  const summary = summaryOf(activeTrace, state.priceTable);
  const selectedSpan = findSpan(activeTrace, state.selectedSpanId);

  const summaryEl = h('div', {});
  renderSummaryHeader(summaryEl, summary);

  const centerEl = h('div', { className: 'tl-center' });

  const detailEl = h('div', { className: 'tl-detail-pane' });
  renderDetailPanel(detailEl, selectedSpan, state.detailTab, (tab) => store.set({ detailTab: tab }));

  const picker = tracePicker(activeTrace, state.baseline !== null && state.inspectedSide === 'baseline' ? state.baselineSource : state.source);
  const warnings = activeTrace.warnings.length ? h('details', { className: 'tl-compare-warnings' },
    h('summary', {}, `${activeTrace.warnings.length} parser warnings`),
    h('ul', {}, ...activeTrace.warnings.map((warning) => h('li', {}, warning.message)))) : null;
  mount(app, buildHeader(state), loadNotice(state), state.loadError ? h('div', { className: 'tl-load-error', role: 'alert' }, state.loadError) : null, h('main', { className: 'tl-page-main' }, picker, warnings, summaryEl, h('div', { className: 'tl-main' }, centerEl, detailEl)));
  // After the mount: the waterfall measures its track and restores its scroll position, which a
  // detached element has neither of.
  renderWaterfall(
    centerEl,
    activeTrace,
    { collapsedIds: state.collapsedIds, selectedSpanId: state.selectedSpanId, zoom: state.zoom, panNs: state.panNs, filter: spanFilters.get(activeTrace) ?? { query: '', errorsOnly: false } },
    {
      onToggle: (spanId) => {
        const next = new Set(state.collapsedIds);
        if (next.has(spanId)) next.delete(spanId);
        else next.add(spanId);
        store.set({ collapsedIds: next });
      },
      onSelect: (spanId) => store.set({ selectedSpanId: spanId, detailTab: 'overview' }),
      onViewportChange: (patch) => store.set(patch),
      onFilterChange: (filter) => { spanFilters.set(activeTrace, filter); render(); },
    },
  );
}

function render(): void {
  const active = document.activeElement as HTMLElement | null;
  const key = active?.dataset.focusKey;
  const selection = active instanceof HTMLInputElement && ['search', 'text'].includes(active.type)
    ? [active.selectionStart, active.selectionEnd] as const : null;
  renderApp();
  if (key) {
    const replacement = [...document.querySelectorAll<HTMLElement>('[data-focus-key]')].find((el) => el.dataset.focusKey === key);
    replacement?.focus({ preventScroll: true });
    if (selection && replacement instanceof HTMLInputElement) replacement.setSelectionRange(...selection);
  }
}

store.subscribe(render);
render();
if (new URLSearchParams(window.location.search).get('example') === 'compare') {
  void loadComparisonExample();
}

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 120);
});
