const useColor = process.stdout.isTTY && process.env['NO_COLOR'] === undefined;

function wrap(code: string, s: string): string {
  return useColor ? `\u001b[${code}m${s}\u001b[0m` : s;
}
export const bold = (s: string): string => wrap('1', s);
export const dim = (s: string): string => wrap('2', s);
export const red = (s: string): string => wrap('31', s);
export const green = (s: string): string => wrap('32', s);
export const yellow = (s: string): string => wrap('33', s);
export const cyan = (s: string): string => wrap('36', s);
export const magenta = (s: string): string => wrap('35', s);

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtUsd(v: number | undefined): string {
  if (v === undefined) return dim('—');
  if (v < 0.01) return `$${v.toFixed(5)}`;
  return `$${v.toFixed(4)}`;
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

export function pad(s: string, width: number): string {
  const visible = s.replace(/\u001b\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, width - visible.length));
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').replace(/\u001b\[[0-9;]*m/g, '').length)),
  );
  const line = (cells: string[]): string => cells.map((c, i) => pad(c, widths[i]!)).join('  ');
  const out = [bold(line(headers)), dim(widths.map((w) => '─'.repeat(w)).join('  '))];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

export function heading(s: string): string {
  return `\n${bold(cyan(s))}\n${dim('─'.repeat(s.length))}`;
}
