import type { ParsedSpan, ParsedTrace } from '../core/index.js';

/** Depth-first list of spans that should currently render as a row — every
 * root, plus every descendant of a span *not* in `collapsedIds`. */
export function flattenVisible(trace: ParsedTrace, collapsedIds: ReadonlySet<string>, included?: ReadonlySet<string>): ParsedSpan[] {
  const out: ParsedSpan[] = [];
  const pending = [...trace.roots].reverse();
  while (pending.length) {
    const span = pending.pop()!;
    if (included && !included.has(span.spanId)) continue;
    out.push(span);
    // Search expands matching ancestry temporarily; it does not alter saved folds.
    if (included || !collapsedIds.has(span.spanId)) {
      for (let i = span.children.length - 1; i >= 0; i--) pending.push(span.children[i]!);
    }
  }
  return out;
}
