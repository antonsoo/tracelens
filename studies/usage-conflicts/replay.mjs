// Compare built CLI/core artifacts against controlled native SDK evidence and retained files.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [artifactArg, outputArg, mode] = process.argv.slice(2);
assert.ok(artifactArg && outputArg && ['before', 'after'].includes(mode), 'ARTIFACT OUTPUT before|after');
const artifact = resolve(artifactArg);
const core = await import(pathToFileURL(resolve(artifact, 'dist-cli/core/index.js')).href);
const fixtureDir = resolve(new URL('./fixtures/', import.meta.url).pathname);
const ledger = JSON.parse(readFileSync(resolve(fixtureDir, 'capture.json'), 'utf8'));
const prices = JSON.parse(readFileSync(resolve(fixtureDir, 'prices.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(readFileSync(resolve(fixtureDir, 'native.json'))), ledger.nativeSha256);
const calls = [];
function cli(...args) {
  const run = spawnSync(process.execPath, [resolve(artifact, 'dist-cli/cli/index.js'), ...args], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  calls.push({ args: args.map(arg => arg.startsWith(fixtureDir) ? `fixtures/${arg.slice(fixtureDir.length + 1)}` : arg),
    exitCode: run.status, stdoutSha256: hash(run.stdout), stderr: run.stderr });
  return JSON.parse(run.stdout);
}
const report = cli('cost', resolve(fixtureDir, 'native.json'), '--prices', resolve(fixtureDir, 'prices.json'), '--json');
const trace = core.parseTraceText(readFileSync(resolve(fixtureDir, 'native.json'), 'utf8'));
const byName = new Map(trace.spans.map(span => [span.name, span]));
const verdicts = report.rows.map(row => {
  const expected = ledger.cases.find(item => item.name === row.name).expected;
  const costMatches = expected.costUsd === null ? row.result.status === 'unpriced'
    : row.result.status === 'priced' && Math.abs(row.result.costUsd - expected.costUsd) < 1e-12;
  const unknownsMatch = expected.unknownFields.every(field => row.usage[field] === undefined);
  const original = ledger.attributesPerCase.find(item => item.name === row.name).attributes;
  assert.deepEqual(Object.fromEntries(Object.entries(byName.get(row.name).attributes)), original, 'An original attribute was discarded or rewritten');
  return { name: row.name, expected, costMatches, unknownsMatch, usage: row.usage, result: row.result };
});
assert.equal(verdicts.length, ledger.cases.length);
const focused = cli('cost', resolve(fixtureDir, 'focused.json'), '--prices', resolve(fixtureDir, 'prices.json'), '--json');
const zero = cli('cost', resolve(fixtureDir, 'equal-zero.json'), '--prices', resolve(fixtureDir, 'prices.json'), '--json');
const comparison = cli('compare', resolve(fixtureDir, 'equal-zero.json'), resolve(fixtureDir, 'focused.json'), '--prices', resolve(fixtureDir, 'prices.json'), '--json');
assert.equal(zero.estimatedCostUsd, 0, 'A real zero must remain a known estimate');
const summary = core.buildSummary(trace, prices);

// Pin the baseline's tracked-file list: newly added study data cannot expand a
// compatibility denominator after the implementation has been selected.
const files = JSON.parse(readFileSync(new URL('./baseline-files.json', import.meta.url), 'utf8'));
const corpusRoot = resolve(new URL('../../', import.meta.url).pathname);
const corpus = [];
for (const file of files) {
  const input = readFileSync(resolve(corpusRoot, file));
  let parsed;
  try {
    parsed = core.parseTraceText(input.toString('utf8'));
  } catch (error) { corpus.push({ file, bytes: input.length, sha256: hash(input), status: 'rejected', error: error.message }); continue; }
  // Keep child identities without recursively copying an entire descendant tree
  // once for every ancestor. A failed snapshot is not an input rejection.
  const stringify = value => JSON.stringify(value, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  const identity = stringify({ ...parsed, roots: parsed.roots.map(span => span.spanId),
    spans: parsed.spans.map(span => ({ ...span, children: span.children.map(child => child.spanId) })) });
  const summary = core.buildSummary(parsed, core.DEFAULT_PRICE_TABLE);
  const stats = stringify({ ...summary, criticalPath: summary.criticalPath.map(span => span.spanId) });
  corpus.push({ file, bytes: input.length, sha256: hash(input), status: 'parsed', spans: parsed.spans.length,
    normalizedSha256: hash(identity), summarySha256: hash(stats),
    conflicts: parsed.spans.filter(span => span.genai?.usage?.conflictingFields?.length).map(span => ({ name: span.name, spanId: span.spanId, fields: span.genai.usage.conflictingFields })) });
}
const receipt = { mode, node: process.version, nativeSha256: ledger.nativeSha256,
  scope: ledger.scope, cases: verdicts.length, matched: verdicts.filter(row => row.costMatches && row.unknownsMatch).length,
  pricedCalls: report.pricedCalls, unpricedCalls: report.unpricedCalls, knownCostUsd: report.knownCostUsd,
  focused, zero, comparisonMetrics: comparison.metrics,
  summaryUsage: summary.modelUsage, verdicts, calls, corpus };
if (mode === 'after') {
  assert.equal(receipt.matched, receipt.cases);
  assert.equal(focused.estimatedCostUsd, null);
  assert.equal(focused.rows[0].result.reason, 'conflicting-usage');
  assert.equal(comparison.metrics.costUsd.delta, null);
}
writeFileSync(resolve(outputArg), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ mode, cases: receipt.cases, matched: receipt.matched, focusedEstimate: focused.estimatedCostUsd, realZero: zero.estimatedCostUsd,
  retainedFiles: corpus.length, parsedFiles: corpus.filter(row => row.status === 'parsed').length, filesWithConflicts: corpus.filter(row => row.conflicts?.length).map(row => row.file) }));
