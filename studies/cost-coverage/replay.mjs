import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { costCases, illustrativePrices } from './cases.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const cli = resolve(option('--cli') ?? resolve(root, 'dist-cli/cli/index.js'));
const node = option('--node') ?? process.execPath;
const core = resolve(dirname(cli), '../core/index.js');
const { parseTraceInputs, parseTraceText, buildCostReport, buildSummary } = await import(pathToFileURL(core));
const hash = value => createHash('sha256').update(value).digest('hex');
const work = mkdtempSync(resolve(option('--work-root') ?? tmpdir(), 'tracelens-cost-coverage-'));
const records = [];
for (const item of costCases(root)) {
  const folder = resolve(work, item.id); mkdirSync(folder);
  const inputs = (item.candidateParts ?? [item.candidate]).map((text, i) => ({ name: `input-${i}.json`, text }));
  for (const input of inputs) writeFileSync(resolve(folder, input.name), input.text);
  const prices = illustrativePrices(parseTraceText(item.baseline));
  writeFileSync(resolve(folder, 'prices.json'), JSON.stringify(prices));
  const selection = item.candidateTrace ? { traceId: item.candidateTrace } : {};
  let report = null, summary = null, error = null;
  try { const trace = parseTraceInputs(inputs, selection); report = buildCostReport(trace, prices); summary = buildSummary(trace, prices); }
  catch (caught) { error = caught.message; }
  const acceptable = value => item.parserReject ? error !== null : value !== null
    && (item.incomplete ? value.incompleteInput === true && value.estimatedCostUsd === null : !value.incompleteInput);
  records.push({ id: item.id, kind: 'core-cost', incomplete: item.incomplete, report, error, agrees: acceptable(report) });
  records.push({ id: item.id, kind: 'core-summary', incomplete: item.incomplete,
    knownSubtotal: summary?.totalCostUsd ?? null, report: summary?.costReport ?? null, error,
    agrees: acceptable(summary?.costReport ?? null) && (item.parserReject || (summary?.totalCostUsd ?? null) === report?.knownCostUsd) });
  const base = inputs.map(input => input.name);
  for (const [command, json] of [['cost', true], ['cost', false], ['summary', false]]) {
    const commandArgs = [command, ...base, '--prices', 'prices.json', ...(json ? ['--json'] : []),
      ...(item.candidateTrace ? ['--trace', item.candidateTrace] : [])];
    const result = spawnSync(node, [cli, ...commandArgs], { cwd: folder, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, NO_COLOR: '1' } });
    assert(!result.error, String(result.error));
    const agrees = item.parserReject ? result.status === 1 && result.stdout === '' : result.status === 0
      && (json ? acceptable(JSON.parse(result.stdout)) && JSON.stringify(JSON.parse(result.stdout)) === JSON.stringify(report)
        : item.incomplete ? /Incomplete span inventory: full token estimate/.test(result.stdout)
          && !/^(?:Token estimate:|token estimate:)/m.test(result.stdout) : !/Incomplete span inventory:/.test(result.stdout));
    records.push({ id: item.id, kind: `cli-${command}-${json ? 'json' : 'terminal'}`, incomplete: item.incomplete,
      command: ['tracelens', ...commandArgs], exit: result.status, stdout: result.stdout, stderr: result.stderr, agrees });
  }
  for (const input of inputs) assert.equal(readFileSync(resolve(folder, input.name), 'utf8'), input.text);
}
const result = { population: 'Native SDK exports and labelled import damage; illustrative user rates, no live model or collector requests.',
  node: spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout.trim(), cliSha256: hash(readFileSync(cli)),
  cases: records.length / 5, workflows: records.length, disagreements: records.filter(row => !row.agrees).length, records };
const out = resolve(option('--out') ?? resolve(root, 'studies/cost-coverage/results/after.json'));
mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ cases: result.cases, workflows: result.workflows, disagreements: result.disagreements }));
assert(args.includes('--observe-only') || result.disagreements === 0);
