import { formatCostUsd } from '../core/cost-format.js';

export function fmtMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtUsd(v: number | undefined): string {
  if (v === undefined) return '—';
  return formatCostUsd(v);
}

export function fmtInt(n: number | undefined): string {
  if (n === undefined) return '—';
  return n.toLocaleString('en-US');
}

export function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

/** Show the complete significant 64-bit ID when a Jaeger trace was zero-extended. */
export function traceIdLabel(id: string): string {
  const significant = /^0{16}[\da-f]{16}$/i.test(id) ? id.slice(16) : id;
  return significant.length <= 16 ? significant : `${significant.slice(0, 8)}…`;
}

export function spanIdLabel(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 12)}…`;
}

export function textPreview(value: string, maxLen = 4000): string {
  return value.length > maxLen ? value.slice(0, maxLen) + '\n… (preview; download for full value)' : value;
}

/** Stop serializing at the display budget, instead of stringifying an entire payload first. */
export function jsonPreview(value: unknown, maxLen = 4000): string {
  let output = '';
  let truncated = false;
  const ancestors = new Set<object>();
  const write = (text: string): void => {
    const remaining = Math.max(0, maxLen - output.length);
    output += text.slice(0, remaining);
    if (text.length > remaining) truncated = true;
  };
  const visit = (v: unknown, depth: number): void => {
    if (truncated) return;
    if (typeof v === 'string') { write(JSON.stringify(v.slice(0, maxLen + 1))); return; }
    if (typeof v !== 'object' || v === null) { write(String(v)); return; }
    if (ancestors.has(v)) { write('"[circular]"'); return; }
    if (depth >= 128) { truncated = true; return; }
    ancestors.add(v);
    const array = Array.isArray(v);
    write(array ? '[' : '{');
    let first = true;
    for (const key in v) {
      if (!Object.hasOwn(v, key)) continue;
      if (truncated) break;
      write(`${first ? '' : ','}\n${'  '.repeat(depth + 1)}`);
      first = false;
      if (!array) { visit(key, depth + 1); write(': '); }
      visit((v as Record<string, unknown>)[key], depth + 1);
    }
    if (!first) write(`\n${'  '.repeat(depth)}`);
    write(array ? ']' : '}');
    ancestors.delete(v);
  };
  visit(value, 0);
  return output + (truncated ? '\n… (preview; download for full value)' : '');
}
