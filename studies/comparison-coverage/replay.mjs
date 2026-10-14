// Exercise the exported core API, real CLI text/JSON, and grouped file imports.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { comparisonCases } from './cases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = name => { const index = argv.indexOf(name); return index < 0 ? null : argv[index + 1]; };
const cli = resolve(option('--cli') ?? resolve(root, 'dist-cli/cli/index.js'));
const node = option('--node') ?? process.execPath;
const out = resolve(option('--out') ?? resolve(root, 'studies/comparison-coverage/results/after.json'));
const moduleRoot = resolve(dirname(cli), '..');
const { parseTraceInputs, compareTraces, DEFAULT_PRICE_TABLE } = await import(pathToFileURL(resolve(moduleRoot, 'core/index.js')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const work = mkdtempSync(resolve(option('--work-root') ?? tmpdir(), 'tracelens-comparison-coverage-'));
const records = [];
for (const item of comparisonCases(root)) {
  const folder = resolve(work, item.id); mkdirSync(folder);
  const baseInputs = [{ name: 'baseline.json', text: item.baseline }];
  const candidateInputs = (item.candidateParts ?? [item.candidate]).map((text, index) => ({ name: `candidate-${index}.json`, text }));
  for (const input of [...baseInputs, ...candidateInputs]) writeFileSync(resolve(folder, input.name), input.text);
  const digest = Object.fromEntries([...baseInputs, ...candidateInputs].map(input => [input.name, hash(input.text)]));
  let report = null, error = null;
  try {
    report = compareTraces(parseTraceInputs(baseInputs), parseTraceInputs(candidateInputs, item.candidateTrace ? { traceId: item.candidateTrace } : {}), DEFAULT_PRICE_TABLE);
  } catch (caught) { error = caught.message; }
  records.push({ id: item.id, kind: 'core-api', reject: item.reject, scope: item.scope,
    inputSha256: digest, report, error, agrees: item.reject ? error !== null && (item.parserReject || /Cannot compare/.test(error)) : report !== null });
  for (const format of ['json', 'terminal']) {
    const args = ['compare', '--baseline-file', 'baseline.json', ...candidateInputs.flatMap(input => ['--candidate-file', input.name]),
      ...(format === 'json' ? ['--json'] : []), ...(item.candidateTrace ? ['--candidate-trace', item.candidateTrace] : [])];
    const result = spawnSync(node, [cli, ...args], { cwd: folder, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, NO_COLOR: '1' } });
    assert(!result.error, String(result.error));
    const agrees = item.reject ? result.status === 1 && result.stdout === '' && (item.parserReject || /Cannot compare/.test(result.stderr))
      : result.status === 0 && (format !== 'json' || JSON.stringify(JSON.parse(result.stdout)) === JSON.stringify(report));
    for (const input of [...baseInputs, ...candidateInputs]) assert.equal(readFileSync(resolve(folder, input.name), 'utf8'), input.text);
    records.push({ id: item.id, kind: `cli-${format}`, reject: item.reject, scope: item.scope,
      command: ['tracelens', ...args], inputSha256: digest, exit: result.status, stdout: result.stdout, stderr: result.stderr, agrees });
  }
}
const result = { node: spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout.trim(),
  population: 'Unmodified SDK fixtures and labelled import-damage controls. No live model, collector or Jaeger call.',
  cliSha256: hash(readFileSync(cli)), coreSha256: hash(readFileSync(resolve(moduleRoot, 'core/compare.js'))),
  cases: records.length / 3, workflows: records.length, disagreements: records.filter(row => !row.agrees).length, records };
mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ cases: result.cases, workflows: result.workflows, disagreements: result.disagreements }));
assert(argv.includes('--observe-only') || result.disagreements === 0);
