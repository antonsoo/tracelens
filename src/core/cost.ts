import type { GenAiInfo } from './types.js';
import type { PriceEntry } from './pricing.js';

export interface SpanCost {
  costUsd: number;
  matchedModel: string;
  entry: PriceEntry;
}

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
    typeof entry.provider === 'string' && typeof entry.sourceUrl === 'string' && typeof entry.sourceDate === 'string' &&
    rate(entry.inputPerMTok) && rate(entry.outputPerMTok) &&
    (entry.cacheReadPerMTok === undefined || rate(entry.cacheReadPerMTok)) &&
    (entry.cacheWritePerMTok === undefined || rate(entry.cacheWritePerMTok));
}

/** Finds the price entry whose `matchModel` is the longest substring match
 * against the span's response model (falling back to the request model),
 * case-insensitively. Longest match wins so e.g. "gpt-4o-mini" beats "gpt-4o". */
export function findPriceEntry(genai: GenAiInfo, table: PriceEntry[]): PriceEntry | undefined {
  const model = (genai.responseModel ?? genai.requestModel ?? '').toLowerCase();
  if (!model) return undefined;
  let best: PriceEntry | undefined;
  for (const entry of table) {
    if (!isPriceEntry(entry)) continue;
    const needle = entry.matchModel.trim().toLowerCase();
    if (model.includes(needle) && (!best || needle.length > best.matchModel.trim().length)) {
      best = entry;
    }
  }
  return best;
}

/** Estimates the USD cost of one LLM call. Returns undefined when complete,
 * valid usage or a matching price entry is unavailable — callers must show "—",
 * never silently treat that as $0. */
export function estimateSpanCost(genai: GenAiInfo, table: PriceEntry[]): SpanCost | undefined {
  const entry = findPriceEntry(genai, table);
  if (!entry) return undefined;
  const usage = genai.usage;
  if (!usage || usage.invalidFields?.length || !isTokenCount(usage.inputTokens) || !isTokenCount(usage.outputTokens)) return undefined;

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  if (!isTokenCount(cacheRead) || !isTokenCount(cacheWrite) || cacheRead + cacheWrite > usage.inputTokens) return undefined;
  const billableInput = usage.inputTokens - cacheRead - cacheWrite;
  const output = usage.outputTokens;

  const cost =
    (billableInput / 1_000_000) * entry.inputPerMTok +
    (output / 1_000_000) * entry.outputPerMTok +
    (cacheRead / 1_000_000) * (entry.cacheReadPerMTok ?? entry.inputPerMTok) +
    (cacheWrite / 1_000_000) * (entry.cacheWritePerMTok ?? entry.inputPerMTok);

  return Number.isFinite(cost) ? { costUsd: cost, matchedModel: entry.id, entry } : undefined;
}
