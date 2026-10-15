// Repeated members are labelled file damage applied to a retained SDK export.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const directory = resolve(option('--build', resolve(root, 'dist-cli')));
const out = resolve(option('--out', resolve(root, 'studies/json-members/results/current.json')));
const work = resolve(option('--inputs', resolve(dirname(out), 'inputs')));
const core = await import(pathToFileURL(resolve(directory, 'core/index.js')));
const sha = text => createHash('sha256').update(text).digest('hex');
const json = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v);
mkdirSync(dirname(out), { recursive: true }); mkdirSync(work, { recursive: true });
const sourcePath = 'tests/fixtures/small-genai-semconv-trace.json';
const source = readFileSync(resolve(root, sourcePath), 'utf8'), native = JSON.parse(source);
const compact = JSON.stringify(native);
const replaceStatus = members => {
  const text = compact.replace(/"code":(?:2|"STATUS_CODE_ERROR")/, members);
  assert.notEqual(text, compact); return text;
};
const subset = structuredClone(native);
// Retain the root but omit the other seven spans, including both known errors.
const spans = subset.resourceSpans[0].scopeSpans[0].spans;
subset.resourceSpans[0].scopeSpans[0].spans = spans.filter(span => !span.parentSpanId);
assert.equal(subset.resourceSpans[0].scopeSpans[0].spans.length, 1);
const hiddenInventory = '{"resourceSpans":' + JSON.stringify(native.resourceSpans) +
  ',"resourceSpans":' + JSON.stringify(subset.resourceSpans) + '}';
const ambiguous = replaceStatus('"code":2,"code":1');
const cases = [
  { name: 'native', text: source, valid: true },
  { name: 'status-error-then-ok', text: ambiguous },
  { name: 'status-ok-then-error', text: replaceStatus('"code":1,"code":2') },
  { name: 'status-escaped-key', text: replaceStatus('"code":2,"\\u0063ode":1') },
  { name: 'status-identical', text: replaceStatus('"code":2,"code":2') },
  { name: 'inventory-last-subset', text: hiddenInventory },
  ...['resourceSpans', 'scopeSpans', 'spans'].map(key => ({ name: 'inventory-' + key,
    text: compact.replace(`"${key}":`, `"${key}":[],"${key}":`) })),
  { name: 'usage-last-zero', text: compact.replace(/("key":"gen_ai.usage.input_tokens","value":\{)"intValue":"(\d+)"/,
    '$1"intValue":"$2","intValue":"0"') },
  { name: 'future-field', text: '{"future":1,"future":2,' + compact.slice(1) },
  { name: 'prototype-field', text: '{"__proto__":{},"__proto__":{},' + compact.slice(1) },
  { name: 'empty-field', text: '{"":1,"":2,' + compact.slice(1) },
  ...[0, 1, 2].map(index => { const lines = ['{"resourceSpans":[]}', '{"resourceSpans":[]}', '{"resourceSpans":[]}'];
    lines[index] = ambiguous; return { name: `jsonl-line-${index + 1}`, text: lines.join('\r\n') }; }),
  { name: 'multifile-logs', text: '{"resourceLogs":[],"resourceLogs":[]}', companion: source },
  { name: 'quoted-json-and-siblings', valid: true,
    text: compact.slice(0, -1) + ',"future":[{"code":1},{"code":2}],"literal":' + JSON.stringify('{"code":2,"code":1} \\" [] {} : ,') + '}' },
  { name: 'jsonl-unfinished', valid: true, text: compact + '\n{"resourceSpans":[' },
  { name: 'jsonl-unfinished-duplicate', valid: true, text: compact + '\n{"resourceSpans":[],"resourceSpans":[' },
];

const results = [];
for (const test of cases) {
  const file = resolve(work, test.name + '.json'); writeFileSync(file, test.text);
  const input = [{ name: test.name + '.json', text: test.text }];
  const files = [file];
  if (test.companion) {
    const companion = resolve(work, 'native-companion.json'); writeFileSync(companion, test.companion);
    input.unshift({ name: 'native-companion.json', text: test.companion }); files.unshift(companion);
  }
  let parsed;
  try {
    const trace = core.parseTraceInputs(input), summary = core.buildSummary(trace, core.DEFAULT_PRICE_TABLE);
    parsed = { outcome: 'parsed', spans: trace.spans.length, errors: summary.errorCount,
      warnings: trace.warnings, modelUsage: summary.modelUsage,
      cost: summary.totalCostUsd };
  } catch (error) { parsed = { outcome: 'rejected', message: error.message }; }
  const commands = test.name === 'status-error-then-ok' || test.name === 'inventory-last-subset'
    ? ['summary', 'tree', 'cost', 'timing', 'links', 'logs', 'compare'] : ['summary'];
  const cli = [];
  for (const command of commands) {
    const operands = command === 'compare' ? [resolve(work, 'native.json'), file, '--json']
      : [...files, ...(['cost', 'timing', 'links', 'logs'].includes(command) ? ['--json'] : [])];
    const run = spawnSync(process.execPath, [resolve(directory, 'cli/index.js'), command, ...operands],
      { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 30_000 });
    assert.equal(run.signal, null, run.error?.message);
    // Summary filenames vary by checkout/install location; retain the basename.
    const clean = raw => raw.split(work).join('<inputs>');
    cli.push({ command, exitCode: run.status, stdout: clean(run.stdout), stderr: clean(run.stderr) });
  }
  if (args.includes('--expect-fixed')) {
    if (test.valid) {
      assert.equal(parsed.outcome, 'parsed', test.name); assert.equal(parsed.spans, 8, test.name);
      assert.equal(parsed.errors, 2, test.name); assert.equal(cli[0].exitCode, 0, test.name);
      assert.equal(parsed.warnings.length, test.name.startsWith('jsonl-unfinished') ? 1 : 0);
    } else {
      assert.equal(parsed.outcome, 'rejected', test.name); assert.match(parsed.message, /Duplicate JSON object field/);
      for (const run of cli) { assert.equal(run.exitCode, 1, test.name + '/' + run.command);
        assert.equal(run.stdout, ''); assert.match(run.stderr, /Duplicate JSON object field/); }
    }
  }
  results.push({ name: test.name, role: test.valid ? 'control' : 'controlled repeated-member damage',
    bytes: Buffer.byteLength(test.text), inputSha256: sha(test.text), parsed, cli });
}

// Fixed retained baseline corpus, including invalid fixtures: compare complete
// normalized spans, raw fields, logs, warnings and calculated summaries.
const corpusRoot = resolve(option('--corpus', root));
const beforeDirectory = option('--compare');
const corpus = [];
if (beforeDirectory) {
  const before = await import(pathToFileURL(resolve(beforeDirectory, 'core/index.js')));
  const paths = spawnSync('git', ['ls-tree', '-r', '--name-only', '5846310a9052c82b7f3b521c0a349488fa6341c3'],
    { cwd: corpusRoot, encoding: 'utf8' });
  assert.equal(paths.status, 0);
  const flatten = trace => ({ ...trace, roots: trace.roots.map(s => s.spanId),
    spans: trace.spans.map(s => ({ ...s, children: s.children.map(child => child.spanId) })) });
  const run = (module, text) => { try {
    const trace = module.parseTraceText(text), summary = module.buildSummary(trace, module.DEFAULT_PRICE_TABLE);
    return { trace: flatten(trace), summary: { ...summary, criticalPath: summary.criticalPath.map(s => s.spanId) } };
  } catch (error) { return { error: { name: error.name, message: error.message } }; } };
  for (const path of paths.stdout.trim().split('\n').filter(path => /\.jsonl?$/.test(path))) {
    const text = readFileSync(resolve(corpusRoot, path), 'utf8'), a = run(before, text), b = run(core, text);
    assert.deepEqual(b, a, path);
    corpus.push({ path, inputSha256: sha(text),
      outcome: a.error ? 'rejected' : 'parsed', resultSha256: sha(json(a)) });
  }
}
writeFileSync(out, JSON.stringify({ checkedAt: new Date().toISOString(), node: process.version,
  source: { path: sourcePath, sha256: sha(source), provenance: 'Retained eight-span SDK fixture; repeated members are controlled local damage, not native exporter output.' },
  coreSha256: sha(readFileSync(resolve(directory, 'core/otlp-parser.js'))), results, corpus }, null, 2) + '\n');
console.log(JSON.stringify({ out, cases: results.length, cliRuns: results.reduce((n, r) => n + r.cli.length, 0),
  refused: results.filter(r => r.parsed.outcome === 'rejected').length, unchangedCorpus: corpus.length }));
