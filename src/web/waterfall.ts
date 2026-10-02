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

// renderWaterfall re-runs on every state change and rebuilds the DOM from
// scratch, so interaction listeners must be re-wired each time too — this
// tracks the previous render's window- and document-level listeners (drag can
// move the mouse outside the pane) so they're removed before new ones are
// added, instead of piling up one set per render.
let activeController: AbortController | undefined;

const MIN_TRACK_WIDTH = 600;
/** A character of `.tl-wf-bar-label` (10.5px) is at most this wide, and the label has 6px of padding each side. */
const BAR_LABEL_CHAR_WIDTH = 6;
const BAR_LABEL_PADDING = 14;
/** Room a ruler label needs to its right, so the last one is not cut by the edge of the track. */
const RULER_LABEL_WIDTH = 58;
/** Height of a row, matching `.tl-wf-row` in style.css: the rows in view are found by arithmetic. */
const ROW_HEIGHT = 25;
/** Rows kept rendered beyond each edge of the view, so a scroll shows rows before the next paint. */
const OVERSCAN = 12;

/**
 * What a trace's waterfall keeps between renders. Every state change (a
 * selection, a zoom step, each mouse move of a pan) rebuilds the view from
 * scratch, and without this the list would start again from the top with
 * nothing focused each time.
 */
interface WaterfallMemory {
  scrollTop: number;
  scrollLeft: number;
  /** The row that has keyboard focus, if one does. */
  focusedSpanId: string | null;
  /** The selection as of the last render: a change made elsewhere is scrolled into view. */
  selectedSpanId: string | null;
}
const memories = new WeakMap<ParsedTrace, WaterfallMemory>();
/** Traces whose bars have already grown in once; the animation is for the first paint only. */
const introduced = new WeakSet<ParsedTrace>();

function niceStep(roughNs: number): number {
  // Pick a "nice" tick spacing (1/2/5 x a power of ten) at or above roughNs.
  const pow = 10 ** Math.floor(Math.log10(Math.max(roughNs, 1)));
  for (const mult of [1, 2, 5, 10]) {
    if (mult * pow >= roughNs) return mult * pow;
  }
  return 10 * pow;
}

/**
 * Renders the waterfall into `container`, which must already be in the
 * document: the track's width is measured, and the scroll position restored.
 *
 * Only the rows in view (and a few either side) exist as elements. A trace
 * of forty thousand spans is forty thousand rows, and building them all on
 * every state change took seconds per click.
 */
export function renderWaterfall(
  container: HTMLElement,
  trace: ParsedTrace,
  state: WaterfallState,
  cb: WaterfallCallbacks,
): void {
  // The previous render's listeners go first: one of them watches where focus moves, and this
  // render is about to move it.
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  const { signal } = controller;

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

  // As tall as every row together; the rows in view are placed inside it by its top padding.
  const rowsEl = h('div', { className: 'tl-wf-rows', role: 'tree', 'aria-label': 'Span waterfall', style: `height:${visible.length * ROW_HEIGHT}px` });
  const firstPaint = !introduced.has(trace);
  introduced.add(trace);
  const scrollWrap = h('div', { className: `tl-waterfall-scroll${firstPaint ? ' tl-first-paint' : ''}` }, ruler, rowsEl);
  mount(container, toolbar, scrollWrap);

  const widthPx = Math.max(rulerTrack.clientWidth, MIN_TRACK_WIDTH);
  const viewport: Viewport = { domainStartNs, domainEndNs, widthPx, zoom, panNs };
  drawRuler(rulerTrack, viewport, trace.minStartNs);

  let memory = memories.get(trace);
  if (!memory) {
    memory = { scrollTop: 0, scrollLeft: 0, focusedSpanId: null, selectedSpanId: null };
    memories.set(trace, memory);
  }
  const view = memory;
  const indexOf = (spanId: string | null): number => (spanId === null ? -1 : visible.findIndex((s) => s.spanId === spanId));

  scrollWrap.scrollTop = view.scrollTop;
  scrollWrap.scrollLeft = view.scrollLeft;

  const buildRow = (span: ParsedSpan, index: number): HTMLElement => {
    const hasChildren = span.children.length > 0;
    const isCollapsed = state.collapsedIds.has(span.spanId);
    const toggle = hasChildren
      ? h(
          'button',
          {
            className: 'tl-tree-toggle',
            tabindex: '-1',
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
    const rect = spanRect(span, viewport);
    if (rect.x + rect.width < 0 || rect.x > widthPx) {
      bar.style.display = 'none';
    } else {
      bar.style.left = `${rect.x}px`;
      bar.style.width = `${rect.width}px`;
      bar.style.top = '5px';
      // The duration goes inside the bar only where it fits whole: cut mid-digit it reads as another
      // number, and the row's label has it anyway.
      const duration = fmtMs(spanDurationMs(span));
      if (rect.width >= duration.length * BAR_LABEL_CHAR_WIDTH + BAR_LABEL_PADDING) bar.appendChild(h('span', { className: 'tl-wf-bar-label' }, duration));
    }

    const isSelected = span.spanId === state.selectedSpanId;
    return h(
      'div',
      {
        className: `tl-wf-row${isSelected ? ' selected' : ''}${span.status.code === 'ERROR' ? ' status-error' : ''}`,
        role: 'treeitem',
        tabindex: '0',
        'aria-level': span.depth + 1,
        'aria-selected': isSelected,
        ...(hasChildren ? { 'aria-expanded': !isCollapsed } : {}),
        'data-index': index,
        onClick: () => cb.onSelect(span.spanId),
        onFocus: () => {
          view.focusedSpanId = span.spanId;
        },
        onKeydown: (e: Event) => onRowKey(e as KeyboardEvent, span, index),
      },
      label,
      h('div', { className: 'tl-wf-track' }, bar),
    );
  };

  let renderedFirst = -1;
  let renderedLast = -1;
  let rendered: HTMLElement[] = [];
  const renderRange = (first: number, last: number): void => {
    if (first === renderedFirst && last === renderedLast) return;
    renderedFirst = first;
    renderedLast = last;
    rendered = [];
    for (let i = first; i < last; i++) rendered.push(buildRow(visible[i]!, i));
    rowsEl.style.paddingTop = `${first * ROW_HEIGHT}px`;
    mount(rowsEl, ...rendered);
    // The focused row was rebuilt with the rest; hand it the focus back.
    const focused = indexOf(view.focusedSpanId);
    if (focused >= first && focused < last) rendered[focused - first]!.focus({ preventScroll: true });
  };

  /**
   * Renders the rows that can be seen. Which those are is read off the
   * page, not off a scroll offset: on a wide screen the waterfall scrolls
   * inside its pane, on a narrow one the whole page scrolls past it.
   */
  const renderRows = (): void => {
    // Remembered here and not only on scroll events: those arrive a frame after the scroll, and
    // a key press handled in between would rebuild the view from the position before it.
    view.scrollTop = scrollWrap.scrollTop;
    view.scrollLeft = scrollWrap.scrollLeft;
    const rows = rowsEl.getBoundingClientRect();
    const pane = scrollWrap.getBoundingClientRect();
    const top = Math.max(pane.top, 0);
    const bottom = Math.min(pane.bottom, window.innerHeight);
    const first = Math.max(0, Math.min(visible.length, Math.floor((top - rows.top) / ROW_HEIGHT) - OVERSCAN));
    const last = Math.max(first, Math.min(visible.length, Math.ceil((bottom - rows.top) / ROW_HEIGHT) + OVERSCAN));
    renderRange(first, last);
  };

  /** Brings row `index` into view, rendering it first if it is off screen, and optionally focuses it. */
  const showRow = (index: number, focus: boolean): void => {
    if (index < 0 || index >= visible.length) return;
    if (focus) view.focusedSpanId = visible[index]!.spanId;
    if (index < renderedFirst || index >= renderedLast) {
      renderRange(Math.max(0, index - OVERSCAN), Math.min(visible.length, index + OVERSCAN + 1));
    }
    const row = rendered[index - renderedFirst]!;
    row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus) row.focus({ preventScroll: true });
    renderRows();
  };
  const focusRow = (index: number): void => showRow(Math.min(visible.length - 1, Math.max(0, index)), true);

  function onRowKey(e: KeyboardEvent, span: ParsedSpan, index: number): void {
    const hasChildren = span.children.length > 0;
    const isCollapsed = state.collapsedIds.has(span.spanId);
    switch (e.key) {
      case 'Enter':
      case ' ':
        cb.onSelect(span.spanId);
        break;
      case 'ArrowDown':
        focusRow(index + 1);
        break;
      case 'ArrowUp':
        focusRow(index - 1);
        break;
      case 'Home':
        focusRow(0);
        break;
      case 'End':
        focusRow(visible.length - 1);
        break;
      case 'ArrowRight':
        if (hasChildren && isCollapsed) cb.onToggle(span.spanId);
        else if (hasChildren) focusRow(index + 1);
        break;
      case 'ArrowLeft':
        if (hasChildren && !isCollapsed) cb.onToggle(span.spanId);
        else if (span.parentSpanId) {
          const parent = indexOf(span.parentSpanId);
          if (parent >= 0) focusRow(parent);
        }
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  renderRows();
  // A selection made somewhere else (a call picked in the comparison) may be far off screen.
  if (state.selectedSpanId !== view.selectedSpanId) {
    view.selectedSpanId = state.selectedSpanId;
    showRow(indexOf(state.selectedSpanId), false);
  }
  if (firstPaint) setTimeout(() => scrollWrap.classList.remove('tl-first-paint'), 500);

  wireInteractions(scrollWrap, viewport, cb, signal);
  // Captured at the document: a scroll event does not bubble, and the element that scrolls is
  // the pane or the page depending on the layout.
  document.addEventListener(
    'scroll',
    renderRows,
    { capture: true, passive: true, signal },
  );
  window.addEventListener('resize', renderRows, { signal });
  // Focus that moves anywhere outside the rows is no longer the waterfall's to restore.
  document.addEventListener(
    'focusin',
    (e) => {
      if (!rowsEl.contains(e.target as Node)) view.focusedSpanId = null;
    },
    { signal },
  );
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
    if (x + RULER_LABEL_WIDTH <= vp.widthPx) track.appendChild(h('span', { style: `left:${x + 3}px` }, `+${fmtMs(offsetFromStart)}`));
  }
}


function wireInteractions(scrollWrap: HTMLElement, vp: Viewport, cb: WaterfallCallbacks, signal: AbortSignal): void {

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
