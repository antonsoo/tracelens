import type { ParsedSpan, ParsedTrace } from '../core/index.js';

export interface SpanFilter {
  query: string;
  errorsOnly: boolean;
}

interface SearchEntry { span: ParsedSpan; text: string }
const indexes = new WeakMap<ParsedTrace, { entries: SearchEntry[]; parents: Map<string, ParsedSpan> }>();

/** Search identity fields, not prompt/tool payloads. Each word must match.
 * Ancestors provide context; they are not counted as search results. */
export function searchSpans(trace: ParsedTrace, filter: SpanFilter): { matches: Set<string>; included: Set<string> } | null {
  const words = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length && !filter.errorsOnly) return null;
  let index = indexes.get(trace);
  if (!index) {
    index = {
      parents: new Map(trace.spans.map((span) => [span.spanId, span])),
      entries: trace.spans.map((span) => ({ span, text: [
        span.name, span.spanId, span.agentKind, span.status.code,
        span.genai?.operationName, span.genai?.toolName, span.genai?.agentName,
        span.genai?.requestModel, span.genai?.responseModel, span.genai?.provider,
        span.resourceAttributes['service.name'], span.resourceAttributes['service.namespace'],
      ].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase() })),
    };
    indexes.set(trace, index);
  }
  const matches = new Set<string>();
  const included = new Set<string>();
  for (const { span, text } of index.entries) {
    if ((filter.errorsOnly && span.status.code !== 'ERROR') || !words.every((word) => text.includes(word))) continue;
    matches.add(span.spanId);
    let ancestor: ParsedSpan | undefined = span;
    while (ancestor && !included.has(ancestor.spanId)) {
      included.add(ancestor.spanId);
      ancestor = ancestor.parentSpanId ? index.parents.get(ancestor.parentSpanId) : undefined;
    }
  }
  return { matches, included };
}
