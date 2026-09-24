import './style.css';
import { buildSummary, parseOtlpJson, TraceParseError } from '../core/index.js';
import type { ParsedSpan, ParsedTrace, PriceEntry } from '../core/index.js';
import { Store } from './store.js';
import { h, mount } from './dom.js';
import { renderDropzone } from './dropzone.js';
import { renderSummaryHeader } from './summary-header.js';
import { renderWaterfall } from './waterfall.js';
import { renderDetailPanel } from './detail-panel.js';
import type { DetailTab } from './detail-panel.js';
import { loadPriceTable, openPriceDialog } from './price-settings.js';

interface AppState {
  trace: ParsedTrace | null;
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

async function loadFile(file: File): Promise<void> {
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    const trace = parseOtlpJson(json);
    store.set({ trace, fileName: file.name, loadError: null, selectedSpanId: null, collapsedIds: new Set(), zoom: 1, panNs: 0n });
  } catch (err) {
    const message =
      err instanceof TraceParseError || err instanceof SyntaxError
        ? err.message
        : `Couldn't load "${file.name}": ${err instanceof Error ? err.message : String(err)}`;
    store.set({ loadError: message });
  }
}

async function loadExample(path: string): Promise<void> {
  try {
    const base = import.meta.env.BASE_URL;
    const res = await fetch(`${base}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const trace = parseOtlpJson(json);
    store.set({ trace, fileName: path.split('/').pop() ?? path, loadError: null, selectedSpanId: null, collapsedIds: new Set(), zoom: 1, panNs: 0n });
  } catch (err) {
    store.set({ loadError: `Couldn't load the sample trace: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', theme);
}

function buildHeader(state: AppState): HTMLElement {
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
      state.trace
        ? h('span', { className: 'faint mono', style: 'margin-right:4px' }, state.fileName ?? '')
        : null,
      state.trace
        ? h(
            'button',
            {
              className: 'tl-btn',
              onClick: () => {
                store.set({ trace: null, fileName: null, selectedSpanId: null });
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
      state.loadError ? h('div', { style: 'padding:8px 16px;color:var(--accent-error);font-size:12.5px' }, state.loadError) : null,
    );
    const rest = h('div', { style: 'flex:1;display:flex;min-height:0' });
    app.appendChild(rest);
    renderDropzone(rest, {
      onFile: (f) => void loadFile(f),
      onLoadExample: (p) => void loadExample(p),
    });
    return;
  }

  const summary = buildSummary(state.trace, state.priceTable);
  const selectedSpan = findSpan(state.trace, state.selectedSpanId);

  const summaryEl = h('div', {});
  renderSummaryHeader(summaryEl, summary);

  const centerEl = h('div', { className: 'tl-center' });
  renderWaterfall(
    centerEl,
    state.trace,
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

  mount(app, buildHeader(state), summaryEl, h('div', { className: 'tl-main' }, centerEl, detailEl));
}

store.subscribe(render);
render();

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 120);
});
