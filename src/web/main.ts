import './style.css';
import { buildSummary, compareTraces, parseOtlpJson, TraceParseError } from '../core/index.js';
import type { ParsedSpan, ParsedTrace, PriceEntry } from '../core/index.js';
import { Store } from './store.js';
import { h, mount } from './dom.js';
import { renderDropzone } from './dropzone.js';
import { renderSummaryHeader } from './summary-header.js';
import { renderWaterfall } from './waterfall.js';
import { renderDetailPanel } from './detail-panel.js';
import type { DetailTab } from './detail-panel.js';
import { loadPriceTable, openPriceDialog } from './price-settings.js';
import { renderComparison } from './comparison.js';
import type { ComparisonSide } from './comparison.js';

interface AppState {
  trace: ParsedTrace | null;
  baseline: ParsedTrace | null;
  baselineName: string | null;
  view: 'trace' | 'compare';
  inspectedSide: ComparisonSide;
  fileName: string | null;
  loadError: string | null;
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
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const store = new Store<AppState>({
  trace: null,
  baseline: null,
  baselineName: null,
  view: 'trace',
  inspectedSide: 'candidate',
  fileName: null,
  loadError: null,
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

async function loadFile(file: File): Promise<void> {
  const version = ++loadVersion;
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('Trace files must be 25 MB or smaller. Export a single run and try again.');
    const text = await file.text();
    const json = JSON.parse(text);
    const trace = parseOtlpJson(json);
    if (version !== loadVersion) return;
    store.set({ trace, baseline: null, baselineName: null, view: 'trace', inspectedSide: 'candidate', fileName: file.name, loadError: null, selectedSpanId: null, collapsedIds: new Set(), zoom: 1, panNs: 0n });
  } catch (err) {
    if (version !== loadVersion) return;
    const message =
      err instanceof TraceParseError || err instanceof SyntaxError
        ? err.message
        : `Couldn't load "${file.name}": ${err instanceof Error ? err.message : String(err)}`;
    store.set({ loadError: message });
  }
}

async function loadCandidate(file: File): Promise<void> {
  const state = store.get();
  const baseline = state.baseline ?? state.trace;
  if (!baseline) return;
  const version = ++loadVersion;
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('Trace files must be 25 MB or smaller. Export a single run and try again.');
    const trace = parseOtlpJson(JSON.parse(await file.text()));
    if (version !== loadVersion) return;
    compareTraces(baseline, trace, state.priceTable);
    store.set({ baseline, baselineName: state.baselineName ?? state.fileName, trace, fileName: file.name, view: 'compare', inspectedSide: 'candidate', loadError: null, selectedSpanId: null });
  } catch (err) {
    if (version !== loadVersion) return;
    store.set({ loadError: `Couldn't compare "${file.name}": ${err instanceof Error ? err.message : String(err)}` });
  }
}

async function loadComparisonExample(): Promise<void> {
  const version = ++loadVersion;
  try {
    const traces = await Promise.all(['baseline', 'candidate'].map(async (side) => {
      const response = await fetch(`${import.meta.env.BASE_URL}examples/comparison-${side}.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseOtlpJson(await response.json());
    }));
    if (version !== loadVersion) return;
    compareTraces(traces[0]!, traces[1]!, store.get().priceTable);
    store.set({ baseline: traces[0]!, baselineName: 'baseline (synthetic)', trace: traces[1]!, fileName: 'candidate (synthetic)', view: 'compare', inspectedSide: 'candidate', loadError: null, selectedSpanId: null });
  } catch (err) {
    if (version !== loadVersion) return;
    store.set({ loadError: `Couldn't load comparison: ${err instanceof Error ? err.message : String(err)}` });
  }
}

async function loadExample(path: string): Promise<void> {
  const version = ++loadVersion;
  try {
    const base = import.meta.env.BASE_URL;
    const res = await fetch(`${base}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const trace = parseOtlpJson(json);
    if (version !== loadVersion) return;
    store.set({ trace, baseline: null, baselineName: null, view: 'trace', inspectedSide: 'candidate', fileName: path.split('/').pop() ?? path, loadError: null, selectedSpanId: null, collapsedIds: new Set(), zoom: 1, panNs: 0n });
  } catch (err) {
    if (version !== loadVersion) return;
    store.set({ loadError: `Couldn't load the sample trace: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', theme);
}

function buildHeader(state: AppState): HTMLElement {
  const compareInput = h('input', { type: 'file', accept: '.json,application/json', className: 'visually-hidden', tabindex: '-1', 'aria-label': 'Candidate trace file', onChange: (e: Event) => {
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
        ? h('span', { className: 'dim mono tl-active-file' }, `${state.baseline ? `${state.inspectedSide}: ` : ''}${state.baseline && state.inspectedSide === 'baseline' ? state.baselineName ?? '' : state.fileName ?? ''}`)
        : null,
      compareInput,
      state.trace && state.view !== 'compare' ? h('button', { className: 'tl-btn', onClick: () => state.baseline ? store.set({ view: 'compare' }) : compareInput.click() }, state.baseline ? 'Back to comparison' : 'Compare with another run') : null,
      state.trace
        ? h(
            'button',
            {
              className: 'tl-btn',
              onClick: () => {
                loadVersion++;
                store.set({ trace: null, baseline: null, baselineName: null, view: 'trace', fileName: null, loadError: null, selectedSpanId: null });
              },
            },
            'Load another trace',
          )
        : null,
      h(
        'button',
        { className: 'tl-btn', onClick: () => openPriceDialog(state.priceTable, (table) => store.set({ priceTable: table })) },
        'Prices',
      ),
      h('a', { className: 'tl-btn', href: 'https://github.com/antonsoo/tracelens', target: '_blank', rel: 'noreferrer' }, 'GitHub'),
      h(
        'button',
        {
          className: 'tl-btn',
          'aria-pressed': state.theme === 'dark',
          'aria-label': 'Toggle dark mode',
          onClick: () => {
            const next = state.theme === 'dark' ? 'light' : 'dark';
            localStorage.setItem(THEME_KEY, next);
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

function render(): void {
  const state = store.get();
  applyTheme(state.theme);
  const app = document.getElementById('app')!;

  if (!state.trace) {
    mount(
      app,
      buildHeader(state),
      state.loadError ? h('div', { className: 'tl-load-error', role: 'alert' }, state.loadError) : null,
    );
    const rest = h('div', { style: 'flex:1;display:flex;min-height:0' });
    app.appendChild(rest);
    renderDropzone(rest, {
      onFile: (f) => void loadFile(f),
      onLoadExample: (p) => void loadExample(p),
      onCompareExample: () => void loadComparisonExample(),
    });
    return;
  }

  if (state.baseline && state.view === 'compare') {
    const comparisonEl = h('div', { className: 'tl-comparison-shell' });
    renderComparison(comparisonEl, compareTraces(state.baseline, state.trace, state.priceTable),
      { baseline: state.baselineName ?? 'Baseline', candidate: state.fileName ?? 'Candidate' }, {
        onSwap: () => { loadVersion++; store.set({ trace: state.baseline, fileName: state.baselineName, baseline: state.trace, baselineName: state.fileName, selectedSpanId: null, loadError: null }); },
        onReplace: (file) => void loadCandidate(file),
        onInspect: (side, spanId) => store.set({ view: 'trace', inspectedSide: side, selectedSpanId: spanId, detailTab: 'overview', collapsedIds: new Set(), zoom: 1, panNs: 0n }),
        onClose: () => {
          loadVersion++;
          store.set({ baseline: null, baselineName: null, view: 'trace', inspectedSide: 'candidate', selectedSpanId: null, loadError: null, collapsedIds: new Set(), zoom: 1, panNs: 0n });
        },
      });
    mount(app, buildHeader(state), state.loadError ? h('div', { className: 'tl-load-error', role: 'alert' }, state.loadError) : null, comparisonEl);
    return;
  }

  const activeTrace = state.baseline && state.inspectedSide === 'baseline' ? state.baseline : state.trace;
  const summary = buildSummary(activeTrace, state.priceTable);
  const selectedSpan = findSpan(activeTrace, state.selectedSpanId);

  const summaryEl = h('div', {});
  renderSummaryHeader(summaryEl, summary);

  const centerEl = h('div', { className: 'tl-center' });
  renderWaterfall(
    centerEl,
    activeTrace,
    { collapsedIds: state.collapsedIds, selectedSpanId: state.selectedSpanId, zoom: state.zoom, panNs: state.panNs },
    {
      onToggle: (spanId) => {
        const next = new Set(state.collapsedIds);
        if (next.has(spanId)) next.delete(spanId);
        else next.add(spanId);
        store.set({ collapsedIds: next });
      },
      onSelect: (spanId) => store.set({ selectedSpanId: spanId, detailTab: 'overview' }),
      onViewportChange: (patch) => store.set(patch),
    },
  );

  const detailEl = h('div', { className: 'tl-detail-pane' });
  renderDetailPanel(detailEl, selectedSpan, state.detailTab, (tab) => store.set({ detailTab: tab }));

  mount(app, buildHeader(state), state.loadError ? h('div', { className: 'tl-load-error', role: 'alert' }, state.loadError) : null, summaryEl, h('div', { className: 'tl-main' }, centerEl, detailEl));
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
