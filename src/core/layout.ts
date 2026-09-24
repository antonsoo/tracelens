// Pure time-domain -> pixel-range math for the waterfall. Kept separate
// from any DOM/canvas code so it's trivial to unit test and reuse (the CLI
// doesn't need it, but the web waterfall and its tests both import it).
export interface Viewport {
  /** The full trace's time domain — never changes as the user pans/zooms. */
  domainStartNs: bigint;
  domainEndNs: bigint;
  widthPx: number;
  /** 1 = the whole domain fits in widthPx; 2 = twice as much detail, etc. Must be >= 1. */
  zoom: number;
  /** Offset in ns, from domainStartNs, of the visible window's left edge. */
  panNs: bigint;
}

export function visibleDurationNs(vp: Viewport): bigint {
  const domainNs = vp.domainEndNs - vp.domainStartNs;
  if (domainNs <= 0n) return 1n;
  const scaled = Number(domainNs) / Math.max(vp.zoom, 1);
  return BigInt(Math.max(1, Math.round(scaled)));
}

export function nsPerPixel(vp: Viewport): number {
  return Number(visibleDurationNs(vp)) / Math.max(vp.widthPx, 1);
}

export function timeToX(ns: bigint, vp: Viewport): number {
  const visibleStart = vp.domainStartNs + vp.panNs;
  const offsetNs = Number(ns - visibleStart);
  return offsetNs / nsPerPixel(vp);
}

export function xToTime(x: number, vp: Viewport): bigint {
  const visibleStart = vp.domainStartNs + vp.panNs;
  return visibleStart + BigInt(Math.round(x * nsPerPixel(vp)));
}

export interface Rect {
  x: number;
  width: number;
}

/** Computes a span's pixel rect, with a 1px floor so sub-pixel spans (a
 * fast tool call at high zoom-out) stay clickable instead of disappearing. */
export function spanRect(span: { startTimeUnixNano: bigint; endTimeUnixNano: bigint }, vp: Viewport): Rect {
  const x = timeToX(span.startTimeUnixNano, vp);
  const rawWidth = timeToX(span.endTimeUnixNano, vp) - x;
  return { x, width: Math.max(rawWidth, 1) };
}

/** Keeps the visible window inside the trace's domain: pan can't go
 * negative, and can't push the window past the domain's end. */
export function clampPan(panNs: bigint, vp: Viewport): bigint {
  const domainNs = vp.domainEndNs - vp.domainStartNs;
  const visNs = visibleDurationNs(vp);
  const maxPan = domainNs > visNs ? domainNs - visNs : 0n;
  if (panNs < 0n) return 0n;
  if (panNs > maxPan) return maxPan;
  return panNs;
}

export function clampZoom(zoom: number, min = 1, max = 500): number {
  if (!Number.isFinite(zoom)) return min;
  return Math.min(max, Math.max(min, zoom));
}
