import type { ParsedSpan } from '../core/types.js';

/** Decoded evidence, with references instead of recursive copies of descendants. */
export function spanEvidence(span: ParsedSpan): object {
  return { schemaVersion: 1, format: 'tracelens-span-evidence', ...span, children: span.children.map((child) => child.spanId) };
}

export function downloadEvidence(value: unknown, filename: string): void {
  const json = JSON.stringify(value, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
