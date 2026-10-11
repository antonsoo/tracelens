// node studies/attribute-values/replay.mjs DIST_DIRECTORY OUTPUT_JSON
// Dist may be a baseline build or an installed package's dist-cli directory.
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const dist = resolve(process.argv[2] ?? 'dist-cli');
const output = process.argv[3];
if (!output) throw new Error('Supply DIST_DIRECTORY OUTPUT_JSON');
const { parseOtlpJson } = await import(pathToFileURL(`${dist}/core/otlp-parser.js`));
const { buildCostReport } = await import(pathToFileURL(`${dist}/core/cost-report.js`));
const root = new URL('./fixtures/', import.meta.url);
const doc = JSON.parse(await readFile(new URL('capture.json', root), 'utf8'));
const oracle = JSON.parse(await readFile(new URL('oracle.json', root), 'utf8'));
const prices = JSON.parse(await readFile(new URL('prices.json', root), 'utf8'));
const results = [];
for (const expected of oracle.cases) {
  const trace = parseOtlpJson(doc, { traceId: expected.traceId });
  const span = trace.spans[0];
  const cost = buildCostReport(trace, prices);
  const processResult = spawnSync(process.execPath, [`${dist}/cli/index.js`, 'cost',
    new URL('capture.json', root).pathname, '--trace', expected.traceId, '--json', '--prices', new URL('prices.json', root).pathname],
  { encoding: 'utf8' });
  if (processResult.status !== 0) throw new Error(processResult.stderr);
  const cli = JSON.parse(processResult.stdout);
  const inputTokens = span.genai?.usage?.inputTokens ?? null;
  const actual = { inputTokens, costUsd: cost.estimatedCostUsd, warnings: trace.warnings,
    attribute: span.attributes['gen_ai.usage.input_tokens'], cliAgrees: JSON.stringify(cli) === JSON.stringify(cost) };
  const checks = { inputTokens: inputTokens === expected.expectedInputTokens,
    cost: actual.costUsd === expected.expectedCostUsd || (actual.costUsd !== null && expected.expectedCostUsd !== null
      && Math.abs(actual.costUsd - expected.expectedCostUsd) <= 4 * Number.EPSILON * Math.max(Math.abs(actual.costUsd), Math.abs(expected.expectedCostUsd))),
    warnings: Boolean(trace.warnings.length) === expected.expectedWarning,
    cliAgrees: actual.cliAgrees };
  results.push({ name: expected.name, traceId: expected.traceId, source: expected.sourceValue,
    expectedInputTokens: expected.expectedInputTokens, expectedCostUsd: expected.expectedCostUsd,
    checks, actual });
}
const checks = results.flatMap(r => Object.values(r.checks));
const record = { node: process.version, parserSha256: createHash('sha256').update(await readFile(`${dist}/core/otlp-parser.js`)).digest('hex'),
  fixtureSha256: oracle.sha256, passed: checks.filter(Boolean).length, total: checks.length, results };
await writeFile(output, JSON.stringify(record, null, 2) + '\n');
console.log(`${record.passed}/${record.total} workflow checks; ${results.filter(r => Object.values(r.checks).every(Boolean)).length}/${results.length} cases`);
