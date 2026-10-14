import type { TraceCostReport } from '../core/cost-report.js';
import { bold, dim, fmtInt, heading, safe, table } from './format.js';
import { formatCostUsd } from '../core/cost-format.js';

export function formatCostReport(report: TraceCostReport): string {
  const money = (value: number | null): string => value === null ? 'Unknown' : formatCostUsd(value);
  const lines = [
    bold(`Token cost evidence for trace ${safe(report.traceId)}`),
    `${report.pricedCalls} priced / ${report.unpricedCalls} unpriced model calls; ${report.excludedSpans} excluded spans`,
    `${report.unpricedCalls || report.incompleteInput ? 'Known subtotal' : 'Token estimate'}: ${money(report.knownCostUsd)}`,
    ...(report.incompleteInput ? ['Incomplete span inventory: full token estimate and missing call count are unknown. Counts above describe retained spans only.'] : []),
    dim('At the supplied rates. Not an invoice; context premiums, service tiers and tool fees are outside this estimate.'),
  ];
  for (const row of report.rows) {
    lines.push(heading(`${safe(row.name)} [${safe(row.spanId)}]`));
    lines.push(`${safe(row.model ?? '(no model)')} / ${safe(row.provider ?? '(provider not recorded)')} / ${row.kind}`);
    const cost = row.result;
    if (cost.status !== 'priced') {
      lines.push(`${cost.status}: ${cost.reason}`, safe(cost.message));
      continue;
    }
    lines.push(`Price: ${safe(cost.entry.id)} (${cost.match}); source date: ${safe(cost.entry.sourceDate || 'not supplied')}`);
    lines.push(cost.entry.sourceUrl ? safe(cost.entry.sourceUrl) : 'User-supplied rate; no source URL.');
    lines.push(table(['component', 'tokens', 'USD / million', 'USD'], cost.components.map((part) => [
      part.kind === 'input' ? 'fresh input' : part.kind,
      fmtInt(part.tokens), String(part.perMillionUsd), formatCostUsd(part.costUsd),
    ])));
    lines.push(`Call token estimate: ${formatCostUsd(cost.costUsd)}`);
    for (const assumption of cost.assumptions) lines.push(dim(`Assumption: ${safe(assumption)}`));
  }
  if (!report.rows.length) lines.push('No model or usage evidence was found.');
  for (const warning of report.warnings) lines.push(`Warning: ${safe(warning)}`);
  lines.push(dim('Use --json for the full price table, captured usage attributes, assumptions and span IDs.'));
  return lines.join('\n');
}
