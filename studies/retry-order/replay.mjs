// Run unchanged SDK span permutations through the core and the actual CLI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const cli = resolve(option('--cli') ?? resolve(here, '../../dist-cli/cli/index.js'));
const modulePath = resolve(dirname(cli), '../core/index.js');
const core = await import(pathToFileURL(modulePath));
const doc = JSON.parse(readFileSync(resolve(here, 'fixtures/native.json'), 'utf8'));
const oracle = JSON.parse(readFileSync(resolve(here, 'fixtures/oracle.json'), 'utf8'));
const spans = doc.resourceSpans[0].scopeSpans[0].spans;
const root = spans.find(s => !s.parentSpanId);
const tools = spans.filter(s => s.parentSpanId);
const output = resolve(option('--out') ?? resolve(here, 'results/after.json'));
mkdirSync(dirname(output), { recursive: true });
const work = mkdtempSync(resolve(dirname(output), 'retry-replay-'));
const permutations = values => values.length ? values.flatMap((v, i) =>
  permutations(values.filter((_, j) => i !== j)).map(rest => [v, ...rest])) : [[]];
const records = [];
try {
  for (const [index, order] of permutations(tools).entries()) {
    const input = structuredClone(doc);
    input.resourceSpans[0].scopeSpans[0].spans = [root, ...order];
    const trace = core.parseOtlpJson(input);
    const summary = core.buildSummary(trace, core.DEFAULT_PRICE_TABLE);
    const counts = { retryCount: summary.retryCount, unknownRetryCount: summary.unknownRetryCount ?? 0 };
    writeFileSync(resolve(work, 'trace.json'), JSON.stringify(input));
    const consoleResult = spawnSync(option('--node') ?? process.execPath, [cli, 'summary', 'trace.json'], {
      cwd: work, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(consoleResult.status, 0, consoleResult.stderr);
    assert(!consoleResult.error, String(consoleResult.error));
    const terminalAgrees = /0 observed possible retried call\(s\); 1 preceding call outcome\(s\) unknown/.test(consoleResult.stdout);
    const agrees = JSON.stringify(counts) === JSON.stringify(oracle.expected) && terminalAgrees;
    records.push({ index, order: order.map(span => span.spanId), ...counts,
      errorCount: summary.errorCount, warnings: trace.warnings,
      agrees, terminalAgrees, command: ['tracelens', 'summary', 'trace.json'],
      stdout: consoleResult.stdout, stderr: consoleResult.stderr });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
const hash = value => createHash('sha256').update(value).digest('hex');
const result = {
  node: spawnSync(option('--node') ?? process.execPath, ['--version'], { encoding: 'utf8' }).stdout.trim(),
  nativeSha256: hash(readFileSync(resolve(here, 'fixtures/native.json'))),
  summaryModuleSha256: hash(readFileSync(resolve(dirname(cli), '../core/summary.js'))),
  expected: oracle.expected, permutations: records.length,
  disagreements: records.filter(record => !record.agrees).length, records,
};
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ permutations: result.permutations, disagreements: result.disagreements,
  observed: [...new Set(records.map(r => `${r.retryCount} observed; ${r.unknownRetryCount} unknown`))] }));
assert(argv.includes('--observe-only') || result.disagreements === 0);
