import type { AgentSpanKind, GenAiInfo } from './types.js';
import type { PriceEntry } from './pricing.js';

export interface CostComponent {
  kind: 'input' | 'cache-read' | 'cache-write' | 'output';
  tokens: number;
  perMillionUsd: number;
  costUsd: number;
  /** A missing cache rate can explicitly fall back to the ordinary input rate. */
  rateSource: 'input' | 'cache-read' | 'cache-write' | 'output';
}

export interface SpanCost {
  costUsd: number;
  matchedModel: string;
  entry: PriceEntry;
  match: 'exact' | 'snapshot';
  components: CostComponent[];
  assumptions: string[];
}

export type CostReason = 'missing-model' | 'no-price' | 'provider-mismatch' | 'ambiguous-price'
  | 'invalid-price-table' | 'missing-input' | 'missing-output' | 'invalid-usage'
  | 'inconsistent-cache' | 'unsupported-billing' | 'numeric-overflow';

export type CostExplanation =
  | ({ status: 'priced' } & SpanCost)
  | { status: 'unpriced'; reason: CostReason; message: string };

export function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Price tables can originate in browser storage or caller-supplied JSON. */
export function isPriceEntry(value: unknown): value is PriceEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  const rate = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  return typeof entry.id === 'string' && entry.id.trim().length > 0 &&
    typeof entry.matchModel === 'string' && entry.matchModel.trim().length > 0 &&
    (entry.matchMode === undefined || entry.matchMode === 'exact' || entry.matchMode === 'snapshot') &&
    typeof entry.provider === 'string' && typeof entry.sourceUrl === 'string' && typeof entry.sourceDate === 'string' &&
    rate(entry.inputPerMTok) && rate(entry.outputPerMTok) &&
    (entry.cacheReadPerMTok === undefined || rate(entry.cacheReadPerMTok)) &&
    (entry.cacheWritePerMTok === undefined || rate(entry.cacheWritePerMTok));
}

export function reportedModel(genai: GenAiInfo): string | undefined {
  return genai.responseModel?.trim() || genai.requestModel?.trim() || undefined;
}

/** These are instrumentation endpoint names, not different billing providers.
 * Do not collapse Azure, Bedrock, gateways or arbitrary dotted prefixes. */
export function priceProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  const aliases: Record<string, string> = {
    'openai.chat': 'openai', 'openai.responses': 'openai', 'openai.completion': 'openai',
    'openai.embedding': 'openai', 'anthropic.messages': 'anthropic',
  };
  return Object.hasOwn(aliases, normalized) ? aliases[normalized]! : normalized;
}

function modelMatch(model: string, entry: PriceEntry): 'exact' | 'snapshot' | undefined {
  const name = entry.matchModel.trim().toLowerCase();
  if (model === name) return 'exact';
  if (entry.matchMode === 'exact' || !model.startsWith(`${name}-`)) return undefined;
  const suffix = model.slice(name.length + 1);
  // A dated snapshot is the only implicit alias. A suffix such as -nano,
  // -pro, -audio, -v2 or a fine-tuning ID is a distinct, unpriced product.
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(suffix) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(suffix);
  if (!date) return undefined;
  const iso = `${date[1]}-${date[2]}-${date[3]}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? 'snapshot' : undefined;
}

type PriceMatch = { status: 'matched'; entry: PriceEntry; match: 'exact' | 'snapshot' }
  | Extract<CostExplanation, { status: 'unpriced' }>;

const unknownCost = (reason: CostReason, message: string): Extract<CostExplanation, { status: 'unpriced' }> => ({ status: 'unpriced', reason, message });

function matchPrice(genai: GenAiInfo, table: PriceEntry[]): PriceMatch {
  if (!table.every(isPriceEntry)) return unknownCost('invalid-price-table', 'The price table contains an invalid entry. Correct it before estimating cost.');
  const model = reportedModel(genai)?.toLowerCase();
  if (!model) return unknownCost('missing-model', 'No response or request model was recorded.');
  const candidates = table.flatMap((entry) => {
    const match = modelMatch(model, entry);
    return match ? [{ entry, match }] : [];
  });
  if (!candidates.length) return unknownCost('no-price', 'No whole model name or dated snapshot matches the price table. Add an explicit entry for this model.');
  const provider = priceProvider(genai.provider ?? '');
  const compatible = candidates.filter(({ entry }) => !provider || !entry.provider.trim() || priceProvider(entry.provider) === provider);
  if (!compatible.length) return unknownCost('provider-mismatch', 'The model matches, but its recorded provider does not. Add a price for this provider.');
  // Exact model wins over a base model date alias. Provider-scoped then wins
  // over explicitly unscoped, but only if the provider was recorded.
  const rank = ({ entry, match }: typeof compatible[number]): number => (match === 'exact' ? 2 : 0) + (provider && entry.provider.trim() ? 1 : 0);
  const bestRank = Math.max(...compatible.map(rank));
  const best = compatible.filter((candidate) => rank(candidate) === bestRank);
  if (best.length !== 1) return unknownCost('ambiguous-price', `${best.length} equally specific price entries match. Remove the ambiguity; row order does not choose a rate.`);
  return { status: 'matched', ...best[0]! };
}

/** Return only an unambiguous, provider-compatible whole-name/snapshot match. */
export function findPriceEntry(genai: GenAiInfo, table: PriceEntry[]): PriceEntry | undefined {
  const result = matchPrice(genai, table);
  return result.status === 'matched' ? result.entry : undefined;
}

export function isModelCall(kind: AgentSpanKind): boolean {
  return kind === 'llm' || kind === 'embedding' || kind === 'reranker';
}

/** Embeddings produce vectors, not completion tokens. Keep contradictory readings visible. */
export function modelOutputTokens(genai: GenAiInfo, kind: AgentSpanKind): number | undefined {
  return genai.usage?.outputTokens ?? (kind === 'embedding' ? 0 : undefined);
}

/** One auditable token charge. Rates are a snapshot or user-supplied assumption,
 * not an invoice: service tiers, context premiums and tool fees are outside this model. */
export function explainSpanCost(genai: GenAiInfo, table: PriceEntry[], kind: AgentSpanKind = 'llm'): CostExplanation {
  if (kind !== 'llm' && kind !== 'embedding') return unknownCost('unsupported-billing', 'Only LLM and embedding token charges are supported; this operation needs a different billing model.');
  const price = matchPrice(genai, table);
  if (price.status === 'unpriced') return price;
  const usage = genai.usage;
  if (usage?.invalidFields?.length) return unknownCost('invalid-usage', `Invalid recorded usage: ${usage.invalidFields.join(', ')}.`);
  if (usage?.inputTokens === undefined) return unknownCost('missing-input', 'Input token usage was not recorded.');
  const output = modelOutputTokens(genai, kind);
  if (output === undefined) return unknownCost('missing-output', 'Output token usage was not recorded.');
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  if (![usage.inputTokens, output, cacheRead, cacheWrite].every(isTokenCount)) return unknownCost('invalid-usage', 'Token counts must be nonnegative safe integers.');
  if (cacheRead > usage.inputTokens - cacheWrite) return unknownCost('inconsistent-cache', 'Cache-read and cache-write tokens exceed the recorded total input tokens.');
  if (kind === 'embedding' && (output !== 0 || price.entry.outputPerMTok !== 0)) return unknownCost('unsupported-billing', 'Embedding estimates require zero output tokens and an explicit zero output rate.');

  const entry = { ...price.entry };
  const assumptions: string[] = [];
  if (!genai.responseModel?.trim()) assumptions.push('No response model recorded; using the request model.');
  if (!genai.provider?.trim() && entry.provider.trim()) assumptions.push(`No provider recorded; using the ${entry.provider} reference rate.`);
  if (!entry.provider.trim()) assumptions.push('This price entry explicitly applies to any provider.');
  if (price.match === 'snapshot') assumptions.push('The dated snapshot uses its base model rate; historical prices may differ.');
  if (usage.cacheReadTokens === undefined) assumptions.push('No cache-read count recorded; assuming zero cache reads.');
  if (usage.cacheWriteTokens === undefined) assumptions.push('No cache-write count recorded; assuming zero cache writes.');
  if (cacheRead && entry.cacheReadPerMTok === undefined) assumptions.push('No cache-read rate supplied; using the ordinary input rate.');
  if (cacheWrite && entry.cacheWritePerMTok === undefined) assumptions.push('No cache-write rate supplied; using the ordinary input rate.');
  if (kind === 'embedding' && usage.outputTokens === undefined) assumptions.push('Embedding output is a vector; no completion-token charge.');
  const component = (part: CostComponent['kind'], tokens: number, rate: number, rateSource: CostComponent['rateSource'] = part): CostComponent => ({
    kind: part, tokens, perMillionUsd: rate, costUsd: tokens / 1_000_000 * rate, rateSource,
  });
  const components = [
    component('input', usage.inputTokens - cacheRead - cacheWrite, entry.inputPerMTok),
    component('cache-read', cacheRead, entry.cacheReadPerMTok ?? entry.inputPerMTok, entry.cacheReadPerMTok === undefined ? 'input' : 'cache-read'),
    component('cache-write', cacheWrite, entry.cacheWritePerMTok ?? entry.inputPerMTok, entry.cacheWritePerMTok === undefined ? 'input' : 'cache-write'),
    component('output', output, entry.outputPerMTok),
  ];
  const costUsd = components.reduce((sum, part) => sum + part.costUsd, 0);
  if (!Number.isFinite(costUsd)) return unknownCost('numeric-overflow', 'The token charge exceeds the numeric range supported by this estimator.');
  return { status: 'priced', costUsd, matchedModel: entry.id, entry, match: price.match, components, assumptions };
}

/** Compatibility helper for callers that need only priced calls. */
export function estimateSpanCost(genai: GenAiInfo, table: PriceEntry[], kind: AgentSpanKind = 'llm'): SpanCost | undefined {
  const result = explainSpanCost(genai, table, kind);
  return result.status === 'priced' ? result : undefined;
}
