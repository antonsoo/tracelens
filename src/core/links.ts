import type { ParsedSpan, ParsedTrace, SpanLink } from './types.js';

export function linkTargetLabel(link: SpanLink): string {
  switch (link.target?.status) {
    case 'available': return link.target.name ?? link.spanId;
    case 'missing-trace': return 'Target trace absent from imported data';
    case 'missing-span': return 'Target span absent from imported data';
    case 'ambiguous': return 'Duplicate target span IDs in imported data';
    default: return 'Target not resolved';
  }
}

/** Observed references only. Links never add time, cost or ancestry to a trace. */
export function buildLinksReport(trace: ParsedTrace) {
  const spans = trace.spans.filter((span) => span.links?.length || span.droppedLinksCount || span.invalidLinkCount);
  return {
    schemaVersion: 1,
    format: 'tracelens-span-links',
    traceId: trace.traceId,
    sourceFormat: trace.sourceFormat,
    ...(trace.inputFiles ? { inputFiles: trace.inputFiles } : {}),
    linkCount: spans.reduce((sum, span) => sum + (span.links?.length ?? 0), 0),
    reportedDroppedLinks: spans.reduce((sum, span) => sum + (span.droppedLinksCount ?? 0), 0),
    skippedInvalidLinks: spans.reduce((sum, span) => sum + (span.invalidLinkCount ?? 0), 0),
    notes: [
      trace.inputFiles ? 'Targets are resolved by trace ID and span ID across the selected files only.' : 'Targets are resolved by trace ID and span ID in this imported file only.',
      'Missing targets may be unsampled, unexported or omitted; the cause is not inferred.',
      'Links do not establish elapsed time, waiting time, execution order or additional cost.',
      'Dropped counts are exporter-reported; inspect warnings for malformed evidence.',
    ],
    spans: spans.map((span) => ({ spanId: span.spanId, name: span.name,
      ...(span.sourceFile ? { sourceFile: span.sourceFile } : {}),
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      links: span.links ?? [], droppedLinksCount: span.droppedLinksCount ?? 0,
      invalidLinkCount: span.invalidLinkCount ?? 0,
    })),
    warnings: trace.warnings,
  };
}

export type LinksReport = ReturnType<typeof buildLinksReport>;

export function hasLinks(span: ParsedSpan): boolean {
  return Boolean(span.links?.length || span.droppedLinksCount || span.invalidLinkCount);
}
