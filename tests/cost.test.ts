import { describe, expect, it } from 'vitest';
import { estimateSpanCost, findPriceEntry } from '../src/core/cost.js';
import type { PriceEntry } from '../src/core/pricing.js';

const table: PriceEntry[] = [
  { id: 'gpt-4o', matchModel: 'gpt-4o', provider: 'openai', inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25, sourceUrl: 'https://example.com', sourceDate: '2026-09-24' },
  { id: 'gpt-4o-mini', matchModel: 'gpt-4o-mini', provider: 'openai', inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075, sourceUrl: 'https://example.com', sourceDate: '2026-09-24' },
];

describe('findPriceEntry', () => {
  it('matches the longest substring so gpt-4o-mini does not match the gpt-4o entry', () => {
    const entry = findPriceEntry({ responseModel: 'gpt-4o-mini-2024-07-18' }, table);
    expect(entry?.id).toBe('gpt-4o-mini');
  });

  it('falls back to requestModel when responseModel is absent', () => {
    const entry = findPriceEntry({ requestModel: 'gpt-4o-2024-08-06' }, table);
    expect(entry?.id).toBe('gpt-4o');
  });

  it('returns undefined for an unknown model', () => {
    expect(findPriceEntry({ responseModel: 'llama-3-70b' }, table)).toBeUndefined();
  });
});

describe('estimateSpanCost', () => {
  it('computes cost from input/output tokens at the matched rate', () => {
    const cost = estimateSpanCost(
      { responseModel: 'gpt-4o-mini-2024-07-18', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
      table,
    );
    expect(cost?.costUsd).toBeCloseTo(0.15 + 0.6, 6);
  });

  it('bills cache-read tokens at the cache rate, not the full input rate', () => {
    const cost = estimateSpanCost(
      {
        responseModel: 'gpt-4o',
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 },
      },
      table,
    );
    // all 1,000,000 input tokens are cache reads, so billable "fresh" input is 0
    expect(cost?.costUsd).toBeCloseTo(1.25, 6);
  });

  it('returns undefined when there is no usage at all', () => {
    expect(estimateSpanCost({ responseModel: 'gpt-4o' }, table)).toBeUndefined();
  });

  it('returns undefined when the model has no price entry', () => {
    expect(
      estimateSpanCost({ responseModel: 'mystery-model', usage: { inputTokens: 100, outputTokens: 100 } }, table),
    ).toBeUndefined();
  });

  it('never returns a negative cost when cache tokens exceed reported input tokens', () => {
    const cost = estimateSpanCost(
      { responseModel: 'gpt-4o', usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 500 } },
      table,
    );
    expect(cost!.costUsd).toBeGreaterThanOrEqual(0);
  });
});
