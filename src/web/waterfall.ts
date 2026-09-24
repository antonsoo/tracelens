import type { ParsedSpan, ParsedTrace, Viewport } from '../core/index.js';
import { clampPan, clampZoom, spanDurationMs, spanRect } from '../core/index.js';
import { h, mount } from './dom.js';
import { flattenVisible } from './tree-flatten.js';
import { kindClass, LEGEND_KINDS, KIND_LABEL } from './kind-colors.js';
import { fmtMs } from './format.js';

export interface WaterfallState {
  collapsedIds: Set<string>;
  selectedSpanId: string | null;
  zoom: number;
  panNs: bigint;
}

export interface WaterfallCallbacks {
  onToggle: (spanId: string) => void;
  onSelect: (spanId: string) => void;
  onViewportChange: (patch: { zoom?: number; panNs?: bigint }) => void;
}

const ROW_LABEL_WIDTH = 340;
const MIN_TRACK_WIDTH = 600;

function niceStep(roughNs: number): number {
  // Pick a "nice" tick spacing (1/2/5 x a power of ten) at or above roughNs.
  const pow = 10 ** Math.floor(Math.log10(Math.max(roughNs, 1)));
  for (const mult of [1, 2, 5, 10]) {
    if (mult * pow >= roughNs) return mult * pow;
  }
  return 10 * pow;
}

export function renderWaterfall(
  container: HTMLElement,
  trace: ParsedTrace,
  state: WaterfallState,
  cb: WaterfallCallbacks,
): void {
  const visible = flattenVisible(trace, state.collapsedIds);
  const domainStartNs = trace.minStartNs;
  const domainEndNs = trace.maxEndNs;
  const zoom = clampZoom(state.zoom);
  const panNs = clampPan(state.panNs, { domainStartNs, domainEndNs, widthPx: 1, zoom, panNs: state.panNs });

  const toolbar = h(
    'div',
    { className: 'tl-waterfall-toolbar' },
    h('button', { className: 'tl-btn', title: 'Zoom out', onClick: () => cb.onViewportChange({ zoom: clampZoom(zoom / 1.6) }) }, '−'),
    h('span', { className: 'mono dim', style: 'min-width:42px;text-align:center;display:inline-block' }, `${zoom.toFixed(1)}×`),
    h('button', { className: 'tl-btn', title: 'Zoom in', onClick: () => cb.onViewportChange({ zoom: clampZoom(zoom * 1.6) }) }, '+'),
    h('button', { className: 'tl-btn', title: 'Reset zoom', onClick: () => cb.onViewportChange({ zoom: 1, panNs: 0n }) }, 'Reset'),
    h(
      'span',
      { className: 'faint', style: 'margin-left:4px' },
      zoom > 1 ? 'drag to pan · ctrl+scroll to zoom' : 'ctrl+scroll to zoom',
    ),
    h(
      'div',
      { className: 'tl-legend', style: 'margin-left:auto' },
      ...LEGEND_KINDS.map((k) =>
        h('span', { className: 'tl-legend-item' }, h('span', { className: `tl-kind-dot ${kindClass(k)}` }), KIND_LABEL[k]),
      ),
    ),
  );

  const rulerTrack = h('div', { className: 'tl-wf-track' });
  const ruler = h('div', { className: 'tl-wf-ruler' }, h('div', { className: 'tl-wf-label' }, 'span'), rulerTrack);

  const rowsEl = h('div', { role: 'tree', 'aria-label': 'Span waterfall' });
  const rowEls: { span: ParsedSpan; track: HTMLElement; bar: HTMLElement }[] = [];

  for (const span of visible) {
    const hasChildren = span.children.length > 0;
    const isCollapsed = state.collapsedIds.has(span.spanId);
    const toggle = hasChildren
      ? h(
          'button',
          {
            className: 'tl-tree-toggle',
            'aria-label': isCollapsed ? 'Expand' : 'Collapse',
            onClick: (e: Event) => {
              e.stopPropagation();
              cb.onToggle(span.spanId);
            },
          },
          isCollapsed ? '▸' : '▾',
        )
      : h('span', { className: 'tl-tree-toggle' });

    const toolName = span.genai?.toolName;
    const toolSuffix = toolName && !span.name.includes(toolName) ? ` (${toolName})` : '';
    const label = h(
      'div',
      { className: 'tl-wf-label', style: `padding-left:${8 + span.depth * 14}px` },
      toggle,
      h('span', { className: `tl-kind-dot ${kindClass(span.agentKind)}` }),
      h('span', { className: 'tl-wf-name', title: span.name + toolSuffix }, span.name + toolSuffix),
      h('span', { className: 'mono faint', style: 'margin-left:auto;padding-left:6px' }, fmtMs(spanDurationMs(span))),
    );

    const bar = h('div', { className: `tl-wf-bar ${kindClass(span.agentKind)}${span.status.code === 'ERROR' ? ' status-error' : ''}` });
    const track = h('div', { className: 'tl-wf-track' }, bar);

    const row = h(
      'div',
      {
        className: `tl-wf-row${span.spanId === state.selectedSpanId ? ' selected' : ''}${span.status.code === 'ERROR' ? ' status-error' : ''}`,
        role: 'treeitem',
        tabindex: '0',
        onClick: () => cb.onSelect(span.spanId),
        onKeydown: (e: Event) => {
          const ke = e as KeyboardEvent;
          if (ke.key === 'Enter' || ke.key === ' ') {
            e.preventDefault();
            cb.onSelect(span.spanId);
          }
        },
      },
      label,
      track,
    );
    rowsEl.appendChild(row);
    rowEls.push({ span, track, bar });
  }

  const scrollWrap = h('div', { className: 'tl-waterfall-scroll' }, ruler, rowsEl);
  mount(container, toolbar, scrollWrap);

  // Measure after mount: all track columns share one flex-computed width.
  const widthPx = Math.max(rulerTrack.clientWidth || container.clientWidth - ROW_LABEL_WIDTH, MIN_TRACK_WIDTH);
  const viewport: Viewport = { domainStartNs, domainEndNs, widthPx, zoom, panNs };

  drawRuler(rulerTrack, viewport, trace.minStartNs);
  for (const { span, bar } of rowEls) {
    const rect = spanRect(span, viewport);
    if (rect.x + rect.width < 0 || rect.x > widthPx) {
      bar.style.display = 'none';
      continue;
    }
    bar.style.left = `${rect.x}px`;
    bar.style.width = `${rect.width}px`;
    bar.style.top = '5px';
    if (rect.width > 26) {
      bar.appendChild(h('span', { className: 'tl-wf-bar-label' }, fmtMs(spanDurationMs(span))));
    }
  }

  wireInteractions(scrollWrap, viewport, cb);
}

function drawRuler(track: HTMLElement, vp: Viewport, traceStartNs: bigint): void {
  const visibleNs = Number(vp.domainEndNs - vp.domainStartNs) / vp.zoom;
  const step = niceStep(visibleNs / 6);
  const startOffsetNs = Number(vp.panNs);
  const firstTick = Math.floor(startOffsetNs / step) * step;
  for (let t = firstTick; t <= startOffsetNs + visibleNs + step; t += step) {
    if (t < 0) continue;
    const ns = vp.domainStartNs + BigInt(Math.round(t));
    const x = ((t - startOffsetNs) / (visibleNs || 1)) * vp.widthPx;
    if (x < -40 || x > vp.widthPx + 40) continue;
    const offsetFromStart = Number(ns - traceStartNs) / 1_000_000;
    track.appendChild(h('div', { className: 'tl-wf-grid-line', style: `left:${x}px` }));
    track.appendChild(h('span', { style: `left:${x + 3}px` }, `+${fmtMs(offsetFromStart)}`));
  }
}

// renderWaterfall re-runs on every state change and rebuilds the DOM from
// scratch, so interaction listeners must be re-wired each time too — this
// tracks the previous render's window-level listeners (drag can move the
// mouse outside scrollWrap) so they're removed before new ones are added,
// instead of piling up one set per render.
let activeController: AbortController | undefined;

function wireInteractions(scrollWrap: HTMLElement, vp: Viewport, cb: WaterfallCallbacks): void {
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  const { signal } = controller;

  scrollWrap.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        cb.onViewportChange({ zoom: clampZoom(vp.zoom * factor) });
      } else if (e.shiftKey) {
        e.preventDefault();
        const nsPerPx = Number(vp.domainEndNs - vp.domainStartNs) / vp.zoom / vp.widthPx;
        cb.onViewportChange({ panNs: vp.panNs + BigInt(Math.round(e.deltaY * nsPerPx)) });
      }
    },
    { passive: false, signal },
  );

  let dragging = false;
  let lastX = 0;
  scrollWrap.addEventListener(
    'mousedown',
    (e: MouseEvent) => {
      if (vp.zoom <= 1) return;
      dragging = true;
      lastX = e.clientX;
    },
    { signal },
  );
  window.addEventListener(
    'mousemove',
    (e: MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      const nsPerPx = Number(vp.domainEndNs - vp.domainStartNs) / vp.zoom / vp.widthPx;
      cb.onViewportChange({ panNs: vp.panNs - BigInt(Math.round(dx * nsPerPx)) });
    },
    { signal },
  );
  window.addEventListener('mouseup', () => (dragging = false), { signal });
}
