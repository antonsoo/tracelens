import { explainSpanCost, isModelCall, reportedModel } from './cost.js';
import type { CostExplanation } from './cost.js';
import type { PriceEntry } from './pricing.js';
import type { AgentSpanKind, AttrMap, ParsedSpan, ParsedTrace, TokenUsage } from './types.js';

export interface CostRow {
  spanId: string;
  name: string;
  kind: AgentSpanKind;
  model: string | null;
  provider: string | null;
  requestModel: string | null;
  responseModel: string | null;
  usage: TokenUsage | null;
  /** Only usage attributes: prompts, messages, tool arguments and results are omitted. */
  usageAttributes: AttrMap;
  result: CostExplanation | { status: 'excluded'; reason: 'not-model-call'; message: string };
}

export interface TraceCostReport {
  schemaVersion: 1;
  format: 'tracelens-cost-evidence';
  traceId: string;
  priceTable: PriceEntry[];
  pricedCalls: number;
  unpricedCalls: number;
  excludedSpans: number;
  /** null if there are no priced calls (zero is a real, fully calculated charge). */
  knownCostUsd: number | null;
  /** Present only when skipped span evidence or an absent parent makes inventory incomplete.
   * Call counts and knownCostUsd still describe retained spans; missing calls are not invented. */
  incompleteInput?: true;
  /** null if input inventory is incomplete, any model call is unpriced, or no calls are priced. */
  estimatedCostUsd: number | null;
  rows: CostRow[];
  notes: string[];
  warnings: string[];
}

export function hasCostEvidence(span: ParsedSpan): boolean {
  return isModelCall(span.agentKind) || !!(span.genai?.usage || reportedModel(span.genai ?? {}));
}

export function spanCostEvidence(span: ParsedSpan, prices: PriceEntry[]): CostRow {
  const genai = span.genai ?? {};
  return {
    spanId: span.spanId,
    name: span.name,
    kind: span.agentKind,
    model: reportedModel(genai) ?? null,
    provider: genai.provider ?? null,
    requestModel: genai.requestModel ?? null,
    responseModel: genai.responseModel ?? null,
    usage: genai.usage ? { ...genai.usage,
      ...(genai.usage.invalidFields ? { invalidFields: [...genai.usage.invalidFields] } : {}),
      ...(genai.usage.conflictingFields ? { conflictingFields: [...genai.usage.conflictingFields] } : {}),
    } : null,
    usageAttributes: Object.fromEntries(Object.entries(span.attributes).filter(([key]) =>
      key.startsWith('gen_ai.usage.') || key.startsWith('llm.token_count.') || key.startsWith('ai.usage.'))),
    result: isModelCall(span.agentKind) ? explainSpanCost(genai, prices, span.agentKind) : {
      status: 'excluded', reason: 'not-model-call',
      message: 'Not classified as a model call. Wrapper usage can repeat child-call totals and is not added to the token estimate.',
    },
  };
}

export function buildCostReport(trace: ParsedTrace, prices: PriceEntry[]): TraceCostReport {
  const rows = trace.spans.filter(hasCostEvidence).map((span) => spanCostEvidence(span, prices));
  let known = 0;
  let pricedCalls = 0;
  let unpricedCalls = 0;
  let excludedSpans = 0;
  for (const row of rows) {
    if (row.result.status === 'priced') { known += row.result.costUsd; pricedCalls++; }
    else if (row.result.status === 'unpriced') unpricedCalls++;
    else excludedSpans++;
  }
  const knownCostUsd = pricedCalls && Number.isFinite(known) ? known : null;
  const ids = new Set(trace.spans.map((span) => span.spanId));
  const incompleteInput = trace.warnings.some((warning) => warning.comparisonIssue === 'span-inventory')
    || trace.spans.some((span) => span.parentSpanId && !ids.has(span.parentSpanId));
  return {
    schemaVersion: 1, format: 'tracelens-cost-evidence', traceId: trace.traceId,
    priceTable: prices.map((entry) => ({ ...entry })),
    pricedCalls, unpricedCalls, excludedSpans, knownCostUsd,
    ...(incompleteInput ? { incompleteInput: true as const } : {}),
    estimatedCostUsd: !incompleteInput && unpricedCalls === 0 ? knownCostUsd : null,
    rows,
    notes: [
      'Token charges at the supplied rates, not an invoice. Service tiers, context premiums, region, taxes and tool fees are not inferred.',
      'Rates retain their source dates. A dated model snapshot can use its base model rate; this does not recover historical prices.',
      'LLM and embedding calls contribute token charges. Rerankers remain unpriced. Other spans with model/usage fields are listed as excluded.',
      'Embedding vectors have no completion-token charge. Reasoning tokens are already part of output usage and are not added again.',
      'Missing optional cache counts are assumed zero. Missing cache rates use the input rate; per-call assumptions disclose both.',
      'No cross-instrumentation deduplication is inferred. Two model-call spans may describe the same request; inspect their source spans.',
      ...(incompleteInput ? ['The span inventory is incomplete. Charges and call counts describe retained spans only; the full token estimate and missing call count are unknown.'] : []),
    ],
    warnings: [
      ...trace.warnings.map((warning) => warning.message),
      ...(!Number.isFinite(known) ? ['The known cost subtotal exceeds the supported numeric range.'] : []),
    ],
  };
}
