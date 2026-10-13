import type { buildLogsReport } from '../core/logs.js';
import { heading, safe } from './format.js';

export function formatLogs(report: ReturnType<typeof buildLogsReport>): string {
  const lines = [heading('Correlated logs'), `Trace ${safe(report.traceId)}`,
    `${report.matchedRecords} matched records in this trace; ${report.unmatched.length} unmatched records in the imported files.`, ''];
  for (const span of report.spans) {
    lines.push(`${safe(span.name)} (${safe(span.spanId)})`);
    for (const log of span.logs) {
      const file = log.source.file;
      lines.push(`  ${safe(log.eventName ?? 'Log record')}`,
        `    ${file ? `file ${file.index} (${safe(file.name)}), ` : ''}${log.source.line ? `line ${log.source.line}, ` : ''}${safe(log.source.path)}`,
        `    attributes: ${safe(JSON.stringify(log.attributes))}`);
      if (log.body !== undefined) lines.push(`    body: ${safe(JSON.stringify(log.body))}`);
    }
  }
  lines.push('', 'Use --json to retain complete records, provenance and unmatched evidence.', ...report.notes);
  for (const warning of report.warnings) lines.push(`Warning: ${safe(warning.message)}`);
  return lines.join('\n');
}
