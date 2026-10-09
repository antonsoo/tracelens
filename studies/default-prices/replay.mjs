// Controlled token counters, not provider calls or a measured invoice.
// Expected USD values were transcribed from the cited provider rates separately
// from the application table. Run against compiled/installed core, not TS source.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [corePath, output, recordOnly] = process.argv.slice(2);
if (!corePath || !output) throw new Error('Usage: node studies/default-prices/replay.mjs <compiled-core/index.js> <output.json> [--record-only]');
const core = await import(pathToFileURL(resolve(corePath)).href);
const sources = {
  'claude-sonnet-5-5': ['anthropic', [2, 10, 0.1, 2.5], 'https://claude.com/pricing'],
  'gpt-6-astra': ['openai', [10, 50, 1, 12.5], 'https://developers.openai.com/api/docs/pricing'],
  'gpt-6-sol': ['openai', [2, 10, 0.2, 2.5], 'https://developers.openai.com/api/docs/models/gpt-6-sol'],
  'gpt-6-luna': ['openai', [0.1, 0.5, 0.01, 0.125], 'https://developers.openai.com/api/docs/pricing'],
  'gpt-6.1-sol': ['openai', [2, 10, 0.1, 2.5], 'https://developers.openai.com/api/docs/models/gpt-6.1-sol'],
};
const cases = [];
for (const [model, [provider, rates, sourceUrl]] of Object.entries(sources)) {
  for (const [index, component] of ['input', 'output', 'cache-read', 'cache-write'].entries()) {
    const usage = { inputTokens: index === 1 ? 0 : 1000, outputTokens: index === 1 ? 1000 : 0,
      cacheReadTokens: index === 2 ? 1000 : 0, cacheWriteTokens: index === 3 ? 1000 : 0 };
    const result = core.explainSpanCost({ provider, responseModel: model, usage }, core.DEFAULT_PRICE_TABLE);
    const expectedUsd = rates[index] / 1000;
    const observedUsd = result.status === 'priced' ? result.costUsd : null;
    cases.push({ model, component, usage, expectedUsd, observedUsd, sourceUrl,
      matches: observedUsd !== null && Math.abs(observedUsd - expectedUsd) < 1e-12, result });
  }
}
const report = { runtime: process.version, checked: '2026-10-09', scope: 'Constructed 1000-token standard, short-context API calls; 5-minute Anthropic cache writes. No provider requests.',
  cases: cases.length, mismatches: cases.filter((row) => !row.matches).length, rows: cases };
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ cases: report.cases, mismatches: report.mismatches }));
if (recordOnly !== '--record-only') assert.equal(report.mismatches, 0, 'Default rates differ from separately cited provider prices');
