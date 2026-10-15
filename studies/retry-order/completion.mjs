// Labelled timing damage applied to retained native SDK spans, with valid controls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const cli = resolve(option('--cli') ?? resolve(here, '../../dist-cli/cli/index.js'));
const core = await import(pathToFileURL(resolve(dirname(cli), '../core/index.js')));
const nativePath = resolve(here, 'fixtures/native.json');
const native = JSON.parse(readFileSync(nativePath, 'utf8'));
const oracle = JSON.parse(readFileSync(resolve(here, 'fixtures/oracle.json'), 'utf8'));
const failed = oracle.observations.find(o => o.outcome === 'ERROR').spanId;
const later = oracle.observations.find(o => o.role === 'later-call').spanId;
const cases = [
  ['completed-error', undefined, 2, [1, 0]],
  ['reversed-error', 'reversed', 2, [0, 1]],
  ['zero-duration-error', 'zero', 2, [1, 0]],
  ['overlapping-error', 'overlap', 2, [0, 0]],
  ['reversed-success', 'reversed', 1, [0, 0]],
  ['reversed-unknown-status', 'reversed', 8, [0, 1]],
];
const hash = raw => createHash('sha256').update(raw).digest('hex');
const output = resolve(option('--out') ?? resolve(here, 'results/completion-after.json'));
mkdirSync(dirname(output), { recursive: true });
const work = mkdtempSync(resolve(dirname(output), 'completion-replay-'));
const records = [];
try {
  for (const [name, damage, status, expected] of cases) {
    const input = structuredClone(native);
    const scope = input.resourceSpans[0].scopeSpans[0];
    scope.spans = scope.spans.filter(s => !s.parentSpanId || s.spanId === failed || s.spanId === later);
    const previous = scope.spans.find(s => s.spanId === failed);
    previous.status.code = status;
    if (damage === 'reversed') previous.endTimeUnixNano = String(BigInt(previous.startTimeUnixNano) - 1n);
    if (damage === 'zero') previous.endTimeUnixNano = previous.startTimeUnixNano;
    if (damage === 'overlap') previous.endTimeUnixNano = String(BigInt(previous.startTimeUnixNano) + 3_000_000n);
    const text = JSON.stringify(input);
    writeFileSync(resolve(work, 'trace.json'), text);
    if (option('--inputs')) {
      mkdirSync(resolve(option('--inputs')), { recursive: true });
      writeFileSync(resolve(option('--inputs'), name + '.json'), text + '\n');
    }
    const trace = core.parseOtlpJson(input), summary = core.buildSummary(trace, core.DEFAULT_PRICE_TABLE);
    const counts = [summary.retryCount, summary.unknownRetryCount ?? 0];
    const result = spawnSync(option('--node') ?? process.execPath, [cli, 'summary', 'trace.json'], {
      cwd: work, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    const terminalAgrees = expected[1]
      ? /0 observed possible retried call\(s\); 1 preceding call outcome\(s\) unknown/.test(result.stdout)
      : new RegExp(`\\b${expected[0]} possible retried call\\(s\\)`).test(result.stdout);
    const agrees = JSON.stringify(counts) === JSON.stringify(expected) && terminalAgrees;
    records.push({ name, damage: damage ?? 'none', source: 'Native SDK capture minus the successful timestamp peer; declared mutations only.',
      inputSha256: hash(text), previousInput: previous, expected, counts, terminalAgrees, agrees,
      spans: trace.spans.length, errors: summary.errorCount, warnings: trace.warnings, stdout: result.stdout, stderr: result.stderr });
  }
} finally { rmSync(work, { recursive: true, force: true }); }
const result = { node: spawnSync(option('--node') ?? process.execPath, ['--version'], { encoding: 'utf8' }).stdout.trim(),
  nativeSha256: hash(readFileSync(nativePath)), summaryModuleSha256: hash(readFileSync(resolve(dirname(cli), '../core/summary.js'))),
  disagreements: records.filter(r => !r.agrees).length, records };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ cases: records.length, disagreements: result.disagreements, results: records.map(r => [r.name, r.counts]) }));
assert(args.includes('--observe-only') || result.disagreements === 0);
