import type { GenAiInfo } from './types.js';
import type { PriceEntry } from './pricing.js';

export interface SpanCost {
  costUsd: number;
  matchedModel: string;
  entry: PriceEntry;
}

/** Finds the price entry whose `matchModel` is the longest substring match
 * against the span's response model (falling back to the request model),
 * case-insensitively. Longest match wins so e.g. "gpt-4o-mini" beats "gpt-4o". */
export function findPriceEntry(genai: GenAiInfo, table: PriceEntry[]): PriceEntry | undefined {
  const model = (genai.responseModel ?? genai.requestModel ?? '').toLowerCase();
  if (!model) return undefined;
  let best: PriceEntry | undefined;
  for (const entry of table) {
    const needle = entry.matchModel.toLowerCase();
    if (model.includes(needle) && (!best || needle.length > best.matchModel.length)) {
      best = entry;
    }
  }
  return best;
}

/** Estimates the USD cost of one LLM call. Returns undefined when no token
 * usage or no matching price entry is available — callers must show "—",
 * never silently treat that as $0. */
export function estimateSpanCost(genai: GenAiInfo, table: PriceEntry[]): SpanCost | undefined {
  const entry = findPriceEntry(genai, table);
  if (!entry) return undefined;
  const usage = genai.usage;
  if (!usage) return undefined;

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const billableInput = Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);
  const output = usage.outputTokens ?? 0;

  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return undefined;

  const cost =
    (billableInput / 1_000_000) * entry.inputPerMTok +
    (output / 1_000_000) * entry.outputPerMTok +
    (cacheRead / 1_000_000) * (entry.cacheReadPerMTok ?? entry.inputPerMTok) +
    (cacheWrite / 1_000_000) * (entry.cacheWritePerMTok ?? entry.inputPerMTok);

  return { costUsd: cost, matchedModel: entry.id, entry };
}
