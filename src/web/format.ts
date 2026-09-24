export function fmtMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtUsd(v: number | undefined): string {
  if (v === undefined) return '—';
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(5)}`;
  return `$${v.toFixed(4)}`;
}

export function fmtInt(n: number | undefined): string {
  if (n === undefined) return '—';
  return n.toLocaleString('en-US');
}

export function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export function jsonPreview(v: unknown, maxLen = 4000): string {
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > maxLen ? s.slice(0, maxLen) + '\n… (truncated)' : s;
  } catch {
    return String(v);
  }
}
