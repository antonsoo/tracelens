// node studies/otlp-binary/replay.mjs --core CORE --cli CLI --out OUTPUT [--verify] [--artifacts DIR]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values: args } = parseArgs({ options: {
  core: { type: 'string', default: 'dist-cli/core/index.js' },
  cli: { type: 'string', default: 'dist-cli/cli/index.js' },
  out: { type: 'string' }, verify: { type: 'boolean', default: false }, artifacts: { type: 'string' },
} });
assert.ok(args.out, 'Supply --out');
const core = await import(pathToFileURL(resolve(args.core)));
const cli = resolve(args.cli), root = dirname(fileURLToPath(import.meta.url));
const directory = join(root, 'fixtures');
const oracle = JSON.parse(readFileSync(join(directory, 'oracle.json')));
// Decoder maps deliberately have null prototypes; compare their JSON values.
const jsonValue = value => JSON.parse(JSON.stringify(value));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const file of oracle.files) assert.equal(sha(readFileSync(join(directory, file.file))), file.sha256, file.file);
const carriers = {
  collector: ['collector.traces.otlp', 'collector.logs.otlp'],
  raw: oracle.requests.map(request => request.file),
};
const ids = [...new Set(oracle.spans.map(span => span.traceId))];
const artifacts = args.artifacts ? resolve(args.artifacts) : undefined;
if (artifacts) mkdirSync(artifacts, { recursive: true });
function invoke(params) {
  const call = spawnSync(process.execPath, [cli, ...params], { cwd: directory, encoding: 'utf8', maxBuffer: 20_000_000 });
  if (call.error || call.signal) throw call.error ?? new Error(`CLI signal ${call.signal}`);
  return { exitCode: call.status, stdout: call.stdout, stderr: call.stderr };
}
const cases = [], discrepancies = [];
const supported = typeof core.decodeTraceFile === 'function';
for (const [carrier, files] of Object.entries(carriers)) {
  if (!supported) {
    const result = invoke(['tree', ...files]);
    cases.push({ carrier, files, supported: false, result });
    discrepancies.push({ carrier, issue: 'No native binary importer in this revision' });
    continue;
  }
  const inputs = files.map(name => core.decodeTraceFile(readFileSync(join(directory, name)), name));
  for (const traceId of ids) {
    const trace = core.parseTraceInputs(inputs, { traceId });
    const nativeSpans = oracle.spans.filter(span => span.traceId === traceId);
    assert.equal(trace.spans.length, nativeSpans.length);
    for (const expected of nativeSpans) {
      const span = trace.spans.find(item => item.spanId === expected.spanId);
      assert.ok(span, expected.name);
      assert.deepEqual({ traceId: span.traceId, spanId: span.spanId, name: span.name,
        start: String(span.startTimeUnixNano), end: String(span.endTimeUnixNano),
        parentSpanId: span.parentSpanId ?? null, status: span.status.code,
        attributes: jsonValue(span.attributes),
        links: (span.links ?? []).map(link => ({ traceId: link.traceId, spanId: link.spanId })) },
      { traceId: expected.traceId, spanId: expected.spanId, name: expected.name,
        start: expected.start, end: expected.end, parentSpanId: expected.parentSpanId,
        status: expected.status, attributes: expected.attributes, links: expected.links });
    }
    const nativeLogs = oracle.logs.filter(log => log.traceId === traceId);
    const logs = trace.spans.flatMap(span => span.logs ?? []);
    assert.equal(logs.length, nativeLogs.length);
    for (const expected of nativeLogs) {
      const log = logs.find(item => item.spanId === expected.spanId);
      assert.ok(log);
      assert.equal(log.timeUnixNano === undefined ? null : String(log.timeUnixNano), expected.timestamp);
      assert.equal(log.observedTimeUnixNano === undefined ? null : String(log.observedTimeUnixNano), expected.observedTimestamp);
      assert.deepEqual(jsonValue(log.attributes), expected.attributes);
      assert.deepEqual(jsonValue(log.body), expected.body);
      assert.equal(log.source.line, undefined);
    }
    const commands = {};
    for (const command of ['summary', 'tree', 'timing', 'cost', 'links', 'logs']) {
      const json = !['summary', 'tree'].includes(command);
      const result = invoke([command, ...files, '--trace', traceId, ...(json ? ['--json'] : [])]);
      assert.equal(result.exitCode, 0, result.stderr);
      const name = `${carrier}-${traceId.slice(0, 8)}-${command}.${json ? 'json' : 'txt'}`;
      if (artifacts) writeFileSync(join(artifacts, name), result.stdout);
      if (json) {
        const report = JSON.parse(result.stdout);
        assert.equal(report.traceId, traceId);
        if (command === 'logs') assert.equal(report.matchedRecords, nativeLogs.length);
        if (command === 'links') assert.equal(report.linkCount, nativeSpans.reduce((count, span) => count + span.links.length, 0));
        if (command === 'timing') assert.equal(report.elapsedNs, String(trace.maxEndNs - trace.minStartNs));
      }
      commands[command] = { exitCode: result.exitCode, bytes: Buffer.byteLength(result.stdout), sha256: sha(result.stdout) };
    }
    cases.push({ carrier, files, traceId, supported: true, spans: trace.spans.length,
      logs: logs.length, exactSdkObservations: true, sourceFormat: trace.sourceFormat, commands });
  }
}
const comparisons = [];
if (supported) {
  for (const [carrier, files] of Object.entries(carriers)) for (const traceId of ids) {
    const params = ['compare', ...files.flatMap(file => ['--baseline-file', file]),
      '--candidate-file', 'collector-traces.jsonl', '--candidate-file', 'collector-logs.jsonl',
      '--baseline-trace', traceId, '--candidate-trace', traceId, '--json'];
    const result = invoke(params);
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const expectedCount = oracle.spans.filter(span => span.traceId === traceId).length;
    assert.equal(report.metrics.calls.baseline.value, expectedCount);
    assert.equal(report.metrics.calls.candidate.value, expectedCount);
    for (const metric of Object.values(report.metrics)) {
      if (metric.delta !== null) assert.equal(metric.delta, 0);
    }
    if (artifacts) writeFileSync(join(artifacts, `${carrier}-${traceId.slice(0, 8)}-comparison.json`), result.stdout);
    comparisons.push({ carrier, traceId, exitCode: 0, spans: expectedCount,
      allAvailableDeltasZero: true, reportSha256: sha(result.stdout) });
  }
}
const result = { schemaVersion: 1, node: process.version,
  scope: 'Retained native SDK requests and actual Collector files, with SDK object observations checked before each CLI workflow. No source inference, model call or registry release is established.',
  oracleSha256: sha(readFileSync(join(directory, 'oracle.json'))), supported,
  cases, comparisons, discrepancies };
writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n');
console.log(`${cases.length} carrier/trace cases; ${comparisons.length} comparisons; ${discrepancies.length} discrepancies`);
if (args.verify && (!supported || discrepancies.length)) process.exitCode = 1;
