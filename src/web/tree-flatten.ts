import type { ParsedSpan, ParsedTrace } from '../core/index.js';

/** Depth-first list of spans that should currently render as a row — every
 * root, plus every descendant of a span *not* in `collapsedIds`. */
export function flattenVisible(trace: ParsedTrace, collapsedIds: ReadonlySet<string>): ParsedSpan[] {
  const out: ParsedSpan[] = [];
  const walk = (span: ParsedSpan): void => {
    out.push(span);
    if (!collapsedIds.has(span.spanId)) {
      for (const child of span.children) walk(child);
    }
  };
  for (const root of trace.roots) walk(root);
  return out;
}
