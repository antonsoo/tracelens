import type { ParsedSpan, ParsedTrace } from './types.js';

/**
 * The "critical path" here is a specific, cheap-to-explain heuristic, not a
 * formal scheduling-theory critical path: starting from the longest root
 * span, repeatedly descend into whichever *direct child* has the largest
 * duration. For a trace with no concurrent siblings (the common case for a
 * single agent's tool/LLM calls, which run one at a time) that longest
 * child is exactly the span most responsible for how long its parent took,
 * so the resulting chain is a reasonable "where did the time go" backbone —
 * but it does not account for overlapping (concurrent) siblings, and it
 * reports one span per nesting level even when several siblings together
 * dominate the parent's duration. Documented in docs/formats.md.
 */
export function computeCriticalPath(trace: ParsedTrace): ParsedSpan[] {
  if (trace.roots.length === 0) return [];
  let root = trace.roots[0]!;
  for (const r of trace.roots) if (r.durationNs > root.durationNs) root = r;

  const path: ParsedSpan[] = [root];
  let current = root;
  while (current.children.length > 0) {
    let longest = current.children[0]!;
    for (const c of current.children) if (c.durationNs > longest.durationNs) longest = c;
    path.push(longest);
    current = longest;
  }
  return path;
}
