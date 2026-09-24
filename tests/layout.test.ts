import { describe, expect, it } from 'vitest';
import { clampPan, clampZoom, nsPerPixel, spanRect, timeToX, visibleDurationNs, xToTime } from '../src/core/layout.js';
import type { Viewport } from '../src/core/layout.js';

const baseVp: Viewport = { domainStartNs: 0n, domainEndNs: 1_000_000_000n, widthPx: 1000, zoom: 1, panNs: 0n };

describe('visibleDurationNs / nsPerPixel', () => {
  it('at zoom=1, the whole domain is visible', () => {
    expect(visibleDurationNs(baseVp)).toBe(1_000_000_000n);
  });

  it('doubling zoom halves the visible duration', () => {
    const zoomed = { ...baseVp, zoom: 2 };
    expect(visibleDurationNs(zoomed)).toBe(500_000_000n);
  });

  it('nsPerPixel matches domain / width at zoom=1', () => {
    expect(nsPerPixel(baseVp)).toBeCloseTo(1_000_000, 5); // 1e9 ns / 1000px
  });
});

describe('timeToX / xToTime', () => {
  it('maps the domain start to x=0 and domain end to the viewport width', () => {
    expect(timeToX(0n, baseVp)).toBeCloseTo(0, 5);
    expect(timeToX(1_000_000_000n, baseVp)).toBeCloseTo(1000, 5);
  });

  it('is a round trip within one pixel of rounding error', () => {
    const t = 456_789_000n;
    const x = timeToX(t, baseVp);
    const back = xToTime(x, baseVp);
    const diffNs = back > t ? back - t : t - back;
    expect(diffNs).toBeLessThan(BigInt(Math.ceil(nsPerPixel(baseVp))) + 1n);
  });

  it('panning shifts the visible window', () => {
    const panned = { ...baseVp, panNs: 100_000_000n };
    expect(timeToX(100_000_000n, panned)).toBeCloseTo(0, 5);
  });
});

describe('spanRect', () => {
  it('computes x/width proportional to the span duration', () => {
    const rect = spanRect({ startTimeUnixNano: 0n, endTimeUnixNano: 100_000_000n }, baseVp);
    expect(rect.x).toBeCloseTo(0, 5);
    expect(rect.width).toBeCloseTo(100, 5);
  });

  it('floors sub-pixel spans to 1px so they stay clickable', () => {
    const rect = spanRect({ startTimeUnixNano: 0n, endTimeUnixNano: 1n }, baseVp);
    expect(rect.width).toBe(1);
  });
});

describe('clampPan', () => {
  it('never goes negative', () => {
    expect(clampPan(-500n, baseVp)).toBe(0n);
  });

  it('never exceeds domain length minus the visible window, at high zoom', () => {
    const zoomed = { ...baseVp, zoom: 10 }; // visible = 1/10th of domain
    const maxPan = 1_000_000_000n - 100_000_000n;
    expect(clampPan(999_000_000_000n, zoomed)).toBe(maxPan);
  });

  it('is a no-op at zoom=1 (the whole domain is already visible)', () => {
    expect(clampPan(0n, baseVp)).toBe(0n);
  });
});

describe('clampZoom', () => {
  it('floors to the minimum', () => {
    expect(clampZoom(0.1)).toBe(1);
  });
  it('caps at the maximum', () => {
    expect(clampZoom(100_000)).toBe(500);
  });
  it('falls back to the minimum for NaN/Infinity', () => {
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(1);
  });
});
