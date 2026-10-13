import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Also accepts an installed package directory, so replay does not depend on source imports.
const study = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? join(study, '../..'));
const output = process.argv[3];
const core = await import(pathToFileURL(join(root, 'dist-cli/core/index.js')));
const cli = join(root, 'dist-cli/cli/index.js');
const read = path => readFileSync(join(study, path), 'utf8');
const sha = data => createHash('sha256').update(data).digest('hex');
const receipts = [];
const plain = value => JSON.parse(JSON.stringify(value));
const clean = value => JSON.parse(JSON.stringify(value, (key, value) =>
  ['inputFiles', 'sourceFile', 'sourceFormat', 'logs', 'inputMessages', 'outputMessages', 'systemInstructions', 'finishReasons'].includes(key)
    ? undefined : typeof value === 'bigint' ? value.toString() : value));
const run = (...args) => {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: study, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
for (const mode of ['event-only', 'span-and-event']) {
  const directory = `capture-${mode}`;
  const paths = ['traces.json', 'logs.json'].map(name => `${directory}/${name}`);
  const inputs = paths.map(name => ({ name, text: read(name) }));
  const oracle = JSON.parse(read(`${directory}/oracle.json`));
  const raw = JSON.parse(inputs[1].text).resourceLogs[0].scopeLogs[0].logRecords;
  const parsed = core.parseTraceInputs(inputs);
  assert.equal(parsed.spans.length, oracle.spanCount);
  assert.deepEqual(parsed.warnings, []);
  const report = core.buildLogsReport(parsed);
  assert.equal(report.matchedRecords, oracle.logCount);
  assert.deepEqual(report.unmatched, []);
  for (const [index, expected] of oracle.logs.entries()) {
    const span = parsed.spans.find(span => span.traceId === expected.traceId && span.spanId === expected.spanId);
    assert.ok(span);
    assert.equal(span.logs.length, 1);
    assert.deepEqual(span.logs[0].raw, raw[index]);
    assert.deepEqual(plain(span.logs[0].attributes), expected.attributes);
    assert.deepEqual(span.logs[0].source, { path: `resourceLogs[0].scopeLogs[0].logRecords[${index}]`, file: { index: 2, name: paths[1] } });
    for (const [attribute, field] of [['gen_ai.input.messages', 'inputMessages'], ['gen_ai.output.messages', 'outputMessages']]) {
      assert.deepEqual(plain(span.genai[field]), expected.attributes[attribute].map(({ role, parts }) => ({ role, parts })));
    }
    if (expected.attributes['gen_ai.system_instructions']) {
      assert.deepEqual(plain(span.genai.systemInstructions), [{ role: 'system', parts: expected.attributes['gen_ai.system_instructions'] }]);
    }
  }
  const traceOnly = core.parseTraceText(inputs[0].text);
  assert.deepEqual(clean(core.buildSummary(parsed, core.DEFAULT_PRICE_TABLE)), clean(core.buildSummary(traceOnly, core.DEFAULT_PRICE_TABLE)));
  const cliReport = run('logs', ...paths, '--json');
  assert.equal(cliReport.status, 0); assert.equal(cliReport.stderr, '');
  assert.deepEqual(JSON.parse(cliReport.stdout), JSON.parse(JSON.stringify(report, (_k, value) => typeof value === 'bigint' ? value.toString() : value)));
  const human = run('logs', ...paths);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /2 matched records/);
  assert.match(human.stdout, /receipt-17/);
  const controls = {};
  for (const command of ['summary', 'tree', 'timing', 'cost']) {
    const flags = ['timing', 'cost'].includes(command) ? ['--json'] : [];
    const before = run(command, paths[0], ...flags), after = run(command, ...paths, ...flags);
    assert.equal(before.status, 0); assert.equal(after.status, 0);
    assert.equal(before.stderr, ''); assert.equal(after.stderr, '');
    const comparable = text => flags.length ? clean(JSON.parse(text)) : command === 'summary' ? text.split('\n').slice(1).join('\n') : text;
    assert.deepEqual(comparable(after.stdout), comparable(before.stdout), command);
    controls[command] = 'unchanged except file provenance and message/log evidence';
  }
  const logOnly = run('logs', paths[1], '--json');
  assert.equal(logOnly.status, 1); assert.match(logOnly.stderr, /trace export alongside/);
  receipts.push({ mode, versions: oracle.versions, spans: parsed.spans.length, matched: report.matchedRecords,
    messagesMatchSdkObjects: true, originalExportRecordsMatch: true, fileProvenanceMatches: true,
    noDuplicateMessages: true, controls, logOnly, cli: { json: JSON.parse(cliReport.stdout), human: human.stdout },
    fixtureHashes: Object.fromEntries([...paths, `${directory}/oracle.json`].map(path => [path, sha(read(path))])) });
}
const combined = run('logs', 'capture-event-only/combined.jsonl', '--json');
assert.equal(combined.status, 0);
const combinedReport = JSON.parse(combined.stdout);
assert.equal(combinedReport.matchedRecords, 2);
assert.ok(combinedReport.spans.every(span => span.logs.every(log => log.source.line === 1)));
const result = { node: process.version, scope: 'Real local SDK exports of a synthetic conversation and actual SHA-256 computation; no model or external service called.',
  cases: receipts, combinedJsonLines: { matched: 2, physicalLogLine: 1, status: combined.status } };
if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ node: result.node, modes: receipts.length, sdkRecordsMatched: 4, combinedJsonLines: result.combinedJsonLines }));
