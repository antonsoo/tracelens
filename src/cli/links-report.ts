import { linkTargetLabel } from '../core/links.js';
import type { LinksReport } from '../core/links.js';
import { heading, safe } from './format.js';

export function formatLinks(report: LinksReport): string {
  const lines = [heading('Span links'), `Trace ${safe(report.traceId)}`,
    `${report.linkCount} recorded links; ${report.reportedDroppedLinks} reported dropped; ${report.skippedInvalidLinks} malformed records skipped.`, ''];
  for (const span of report.spans) {
    lines.push(`${safe(span.name)} (${safe(span.spanId)})`);
    if (span.droppedLinksCount || span.invalidLinkCount) lines.push(`  ${span.droppedLinksCount} reported dropped; ${span.invalidLinkCount} malformed records skipped`);
    for (const link of span.links) {
      lines.push(`  -> ${safe(link.traceId)} / ${safe(link.spanId)}: ${safe(linkTargetLabel(link))}`);
      if (Object.keys(link.attributes).length) lines.push(`     attributes: ${safe(JSON.stringify(link.attributes))}`);
      if (link.droppedAttributesCount) lines.push(`     ${link.droppedAttributesCount} link attributes reported dropped`);
    }
  }
  lines.push('', ...report.notes);
  for (const warning of report.warnings) lines.push(`Warning: ${safe(warning.message)}`);
  return lines.join('\n');
}
