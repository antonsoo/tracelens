// Default price table for the cost estimator. Every entry is either a price
// verified via WebFetch against the vendor's own pricing page (cited with
// URL + the date it was checked), or absent entirely — tracelens never
// guesses a price. The table is fully editable at runtime in the web UI
// (Settings -> Pricing) and edits persist to localStorage; nothing here is
// hardcoded into the cost calculation itself (see cost.ts).
export interface PriceEntry {
  id: string;
  /** Whole model name, case-insensitive. No substring or deployment-prefix guessing. */
  matchModel: string;
  /** Default: snapshot (whole name, or that name plus a calendar-date suffix). */
  matchMode?: 'exact' | 'snapshot';
  /** Empty explicitly permits any provider. A recorded provider otherwise must match. */
  provider: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  sourceUrl: string;
  sourceDate: string; // YYYY-MM-DD, the date the price was checked against the source
}

export const DEFAULT_PRICE_TABLE: PriceEntry[] = [
  // --- Anthropic — Claude API, self-reported list price ---
  // Checked directly against claude.com/pricing on 2026-10-09.
  // Standard API rates; cache writes use the 5-minute TTL.
  // Extended TTL, service tiers, regional and long-context premiums are not inferred.
  { id: 'claude-fable-5-1', matchModel: 'claude-fable-5-1', provider: 'anthropic', inputPerMTok: 10.0, outputPerMTok: 50.0, cacheReadPerMTok: 0.25, cacheWritePerMTok: 12.5, sourceUrl: 'https://claude.com/pricing', sourceDate: '2026-10-09' },
  { id: 'claude-fable-5', matchModel: 'claude-fable-5', provider: 'anthropic', inputPerMTok: 10.0, outputPerMTok: 50.0, cacheReadPerMTok: 1.0, cacheWritePerMTok: 12.5, sourceUrl: 'https://claude.com/pricing', sourceDate: '2026-10-09' },
  { id: 'claude-opus-5-5', matchModel: 'claude-opus-5-5', provider: 'anthropic', inputPerMTok: 4.0, outputPerMTok: 20.0, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5.0, sourceUrl: 'https://claude.com/pricing', sourceDate: '2026-10-09' },
  { id: 'claude-opus-5', matchModel: 'claude-opus-5', provider: 'anthropic', inputPerMTok: 5.0, outputPerMTok: 25.0, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25, sourceUrl: 'https://claude.com/pricing', sourceDate: '2026-10-09' },
  { id: 'claude-opus-4-8', matchModel: 'claude-opus-4-8', provider: 'anthropic', inputPerMTok: 5.0, outputPerMTok: 25.0, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25, sourceUrl: 'https://claude.com/pricing', sourceDate: '2026-10-09' },
  { id: 'claude-opus-4-7', matchModel: 'claude-opus-4-7', provider: 'anthropic', inputPerMTok: 5.0, outputPerMTok: 25.0, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25, sourceUrl: 'https://claude.com/pricing', sourceDate: '2026-10-09' },
  { id: 'claude-opus-4-6', matchModel: 'claude-opus-4-6', provider: 'anthropic', inputPerMTok: 5.0, outputPerMTok: 25.0, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25, sourceUrl: 'https://claude.com/pricing', sourceDate: '2026-10-09' },
  { id: 'claude-sonnet-5-5', matchModel: 'claude-sonnet-5-5', provider: 'anthropic', inputPerMTok: 2.0, outputPerMTok: 10.0, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2.5, sourceUrl: 'https://claude.com/pricing', sourceDate: '2026-10-09' },
  { id: 'claude-sonnet-5', matchModel: 'claude-sonnet-5', provider: 'anthropic', inputPerMTok: 2.0, outputPerMTok: 10.0, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5, sourceUrl: 'https://claude.com/pricing', sourceDate: '2026-10-09' },
  { id: 'claude-sonnet-4-6', matchModel: 'claude-sonnet-4-6', provider: 'anthropic', inputPerMTok: 3.0, outputPerMTok: 15.0, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, sourceUrl: 'https://claude.com/pricing', sourceDate: '2026-10-09' },
  { id: 'claude-haiku-4-5', matchModel: 'claude-haiku-4-5', provider: 'anthropic', inputPerMTok: 1.0, outputPerMTok: 5.0, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25, sourceUrl: 'https://claude.com/pricing', sourceDate: '2026-10-09' },

  // --- OpenAI — standard, short-context token rates; checked dates are per row. ---
  { id: 'gpt-6-astra', matchModel: 'gpt-6-astra', provider: 'openai', inputPerMTok: 10.0, outputPerMTok: 50.0, cacheReadPerMTok: 1.0, cacheWritePerMTok: 12.5, sourceUrl: 'https://developers.openai.com/api/docs/pricing', sourceDate: '2026-10-09' },
  { id: 'gpt-6.1-sol', matchModel: 'gpt-6.1-sol', provider: 'openai', inputPerMTok: 2.0, outputPerMTok: 10.0, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2.5, sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol', sourceDate: '2026-10-09' },
  { id: 'gpt-6-sol', matchModel: 'gpt-6-sol', provider: 'openai', inputPerMTok: 2.0, outputPerMTok: 10.0, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5, sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6-sol', sourceDate: '2026-10-09' },
  { id: 'gpt-6-luna', matchModel: 'gpt-6-luna', provider: 'openai', inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125, sourceUrl: 'https://developers.openai.com/api/docs/pricing', sourceDate: '2026-10-09' },
  { id: 'gpt-5', matchModel: 'gpt-5', provider: 'openai', inputPerMTok: 1.25, outputPerMTok: 10.0, cacheReadPerMTok: 0.125, sourceUrl: 'https://developers.openai.com/api/docs/pricing', sourceDate: '2026-09-24' },
  { id: 'gpt-5-mini', matchModel: 'gpt-5-mini', provider: 'openai', inputPerMTok: 0.25, outputPerMTok: 2.0, cacheReadPerMTok: 0.025, sourceUrl: 'https://developers.openai.com/api/docs/pricing', sourceDate: '2026-09-24' },
  // This is a separate product, not a gpt-5 snapshot. Verified on its own model page.
  { id: 'gpt-5-nano', matchModel: 'gpt-5-nano', provider: 'openai', inputPerMTok: 0.05, outputPerMTok: 0.4, cacheReadPerMTok: 0.005, sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5-nano', sourceDate: '2026-10-09' },
  { id: 'gpt-4o-mini', matchModel: 'gpt-4o-mini', provider: 'openai', inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075, sourceUrl: 'https://developers.openai.com/api/docs/pricing', sourceDate: '2026-09-24' },
  { id: 'gpt-4o', matchModel: 'gpt-4o', provider: 'openai', inputPerMTok: 2.5, outputPerMTok: 10.0, cacheReadPerMTok: 1.25, sourceUrl: 'https://developers.openai.com/api/docs/pricing', sourceDate: '2026-09-24' },
  { id: 'gpt-4.1-nano', matchModel: 'gpt-4.1-nano', provider: 'openai', inputPerMTok: 0.1, outputPerMTok: 0.4, cacheReadPerMTok: 0.025, sourceUrl: 'https://developers.openai.com/api/docs/pricing', sourceDate: '2026-09-24' },
  { id: 'gpt-4.1-mini', matchModel: 'gpt-4.1-mini', provider: 'openai', inputPerMTok: 0.4, outputPerMTok: 1.6, cacheReadPerMTok: 0.1, sourceUrl: 'https://developers.openai.com/api/docs/pricing', sourceDate: '2026-09-24' },
  { id: 'gpt-4.1', matchModel: 'gpt-4.1', provider: 'openai', inputPerMTok: 2.0, outputPerMTok: 8.0, cacheReadPerMTok: 0.5, sourceUrl: 'https://developers.openai.com/api/docs/pricing', sourceDate: '2026-09-24' },
  { id: 'o4-mini', matchModel: 'o4-mini', provider: 'openai', inputPerMTok: 1.1, outputPerMTok: 4.4, cacheReadPerMTok: 0.275, sourceUrl: 'https://developers.openai.com/api/docs/pricing', sourceDate: '2026-09-24' },
  { id: 'o3', matchModel: 'o3', provider: 'openai', inputPerMTok: 2.0, outputPerMTok: 8.0, cacheReadPerMTok: 0.5, sourceUrl: 'https://developers.openai.com/api/docs/pricing', sourceDate: '2026-09-24' },
];
