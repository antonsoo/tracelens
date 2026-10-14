// Actual CLI import workflows. Damage controls partition or add fields to native captures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
const cli = resolve(option('--cli') ?? resolve(root, 'dist-cli/cli/index.js'));
const out = resolve(option('--out') ?? resolve(root, 'studies/field-aliases/results/after.json'));
const observe = argv.includes('--observe-only');
const fixtureDir = resolve(root, 'tests/fixtures/census');
const nativePath = resolve(fixtureDir, 'strands-legacy-events-tool-call.json');
const native = JSON.parse(readFileSync(nativePath, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const firstSpan = doc => doc.resourceSpans[0].scopeSpans[0].spans[0];
const cloned = () => structuredClone(native);
const definitions = [];
for (const name of readdirSync(fixtureDir).filter(name => name.endsWith('.json')).sort()) {
  definitions.push({ id: `native-${name}`, bytes: readFileSync(resolve(fixtureDir, name)), reject: false, native: true });
}
const add = (id, doc, reject = true) => definitions.push({ id, bytes: Buffer.from(JSON.stringify(doc)), reject, native: false });
const hidden = { resourceSpans: [native.resourceSpans.at(-1)], resource_spans: native.resourceSpans.slice(0, -1) };
add('hidden-five-child-spans', hidden);
definitions.push({ id: 'hidden-jsonl-batch', bytes: Buffer.from(`${JSON.stringify(hidden)}\n${JSON.stringify({ resourceSpans: [] })}\n`), reject: true, native: false });
const scope = cloned(); scope.resourceSpans[0].scope_spans = scope.resourceSpans[0].scopeSpans; scope.resourceSpans[0].scopeSpans = [];
add('hidden-scope-spans', scope);
for (const [camel, snake] of [
  ['traceId', 'trace_id'], ['spanId', 'span_id'], ['parentSpanId', 'parent_span_id'],
  ['startTimeUnixNano', 'start_time_unix_nano'], ['endTimeUnixNano', 'end_time_unix_nano'],
  ['droppedAttributesCount', 'dropped_attributes_count'], ['droppedEventsCount', 'dropped_events_count'],
  ['droppedLinksCount', 'dropped_links_count'],
]) {
  const doc = cloned(), span = firstSpan(doc);
  span[camel] ??= 0; span[snake] = span[camel];
  add(`span-${camel}`, doc);
}
for (const [camel, snake] of [['timeUnixNano', 'time_unix_nano'], ['droppedAttributesCount', 'dropped_attributes_count']]) {
  const doc = cloned(); firstSpan(doc).events = [{ name: 'derived-control', [camel]: 0, [snake]: 5 }];
  add(`event-${camel}`, doc);
}
for (const [camel, snake] of [['traceId', 'trace_id'], ['spanId', 'span_id'], ['traceState', 'trace_state'], ['droppedAttributesCount', 'dropped_attributes_count']]) {
  const doc = cloned(), span = firstSpan(doc);
  const link = { traceId: span.traceId, spanId: span.spanId, [camel]: span[camel] ?? 'control' };
  span.links = [{ ...link, [snake]: link[camel] }];
  add(`link-${camel}`, doc);
}
const singleSnake = cloned(); singleSnake.resource_spans = singleSnake.resourceSpans; delete singleSnake.resourceSpans;
add('single-snake-case', singleSnake, false);
add('null-unset-companion', { ...singleSnake, resourceSpans: null }, false);
const logRaw = { eventName: 'one', event_name: 'two', timeUnixNano: '1', time_unix_nano: '2',
  observedTimeUnixNano: '3', observed_time_unix_nano: '4', droppedAttributesCount: 0, dropped_attributes_count: 99 };
const logs = { ...cloned(), resourceLogs: [{ scopeLogs: [{ logRecords: [logRaw] }] }] };
definitions.push({ id: 'ambiguous-log-fields', bytes: Buffer.from(JSON.stringify(logs)), reject: false, native: false, logs: true });
const cache = resolve(root, 'studies/field-aliases/cache'); mkdirSync(cache, { recursive: true });
const work = mkdtempSync(resolve(cache, 'cli-'));
const cases = [];
try {
  for (const c of definitions) {
    const path = resolve(work, `${c.id}.json`); writeFileSync(path, c.bytes);
    const args = [c.logs ? 'logs' : 'cost', relative(root, path), '--json'];
    const process = spawnSync(option('--node') ?? globalThis.process.execPath, [cli, ...args], {
      cwd: root, env: { ...globalThis.process.env, NO_COLOR: '1' }, encoding: 'utf8', timeout: 20_000,
    });
    let payload = null; if (process.status === 0) payload = JSON.parse(process.stdout);
    let agrees = c.reject ? process.status === 1 && process.stdout === '' && /contains both|both .* and /.test(process.stderr)
      : process.status === 0 && payload !== null;
    if (!c.reject && !c.logs && !c.native) {
      const calls = payload.rows.filter(row => row.kind === 'llm');
      agrees &&= calls.length === 2 && calls.reduce((sum, row) => sum + row.usage.inputTokens, 0) === 175
        && calls.reduce((sum, row) => sum + row.usage.outputTokens, 0) === 26;
    }
    if (c.logs && payload) {
      const record = payload.unmatched[0];
      agrees &&= JSON.stringify(record.raw) === JSON.stringify(logRaw)
        && ['eventName', 'timeUnixNano', 'observedTimeUnixNano', 'droppedAttributesCount'].every(key => !(key in record))
        && payload.warnings.filter(w => w.message.includes('kept the raw fields without selecting a value')).length === 4;
    }
    const normalize = text => text.replaceAll(relative(root, work), '<work>');
    cases.push({ id: c.id, native: c.native, expected: c.reject ? 'reject' : c.logs ? 'retain raw; normalized fields unknown' : 'accept',
      command: ['tracelens', ...args.map(normalize)], inputBytes: c.bytes.length, inputSha256: hash(c.bytes),
      exitCode: process.status, stdout: normalize(process.stdout), stderr: normalize(process.stderr),
      inputUnchanged: readFileSync(path).equals(c.bytes), agrees });
    assert.ok(cases.at(-1).inputUnchanged);
  }
} finally { rmSync(work, { recursive: true, force: true }); }
const result = { node: option('--node') ? spawnSync(option('--node'), ['--version'], { encoding: 'utf8' }).stdout.trim() : process.version,
  population: 'Eight native census exports and labelled field-alias damage controls; no live model calls',
  nativeCaptureSha256: hash(readFileSync(nativePath)), cliSha256: hash(readFileSync(cli)),
  count: cases.length, disagreements: cases.filter(c => !c.agrees).length, cases };
mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(`${result.count} CLI workflows; ${result.disagreements} disagreements`);
if (result.disagreements && !observe) process.exitCode = 1;
