import type { ParsedSpan, ParsedTrace } from '../core/types.js';

/** Clone a flat graph: structured cloning a deep children tree can overflow. */
export interface TraceTransfer extends Omit<ParsedTrace, 'spans' | 'roots'> {
  spans: (Omit<ParsedSpan, 'children'> & { children: number[] })[];
  roots: number[];
}

export function flattenTrace(trace: ParsedTrace): TraceTransfer {
  const indices = new Map(trace.spans.map((span, index) => [span, index]));
  return {
    ...trace,
    spans: trace.spans.map((span) => ({ ...span, children: span.children.map((child) => indices.get(child)!) })),
    roots: trace.roots.map((span) => indices.get(span)!),
  };
}

export function restoreTrace(wire: TraceTransfer): ParsedTrace {
  if (!Array.isArray(wire.spans) || !wire.spans.length || !Array.isArray(wire.roots)
    || !Array.isArray(wire.warnings) || !Array.isArray(wire.traces)
    || typeof wire.minStartNs !== 'bigint' || typeof wire.maxEndNs !== 'bigint') {
    throw new Error('Invalid trace parser response. Choose the file again to retry.');
  }
  const spans: ParsedSpan[] = wire.spans.map((span) => ({ ...span, children: [] }));
  const at = (index: number): ParsedSpan => {
    if (!Number.isInteger(index) || !spans[index]) throw new Error('Invalid span reference in parser response. Choose the file again to retry.');
    return spans[index];
  };
  wire.spans.forEach((span, index) => { spans[index]!.children = span.children.map(at); });
  return { ...wire, spans, roots: wire.roots.map(at) };
}
