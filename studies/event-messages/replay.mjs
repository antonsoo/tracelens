// node studies/event-messages/replay.mjs <dist-cli> <output.json> <scratch-dir> [--baseline]
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cases, spanOf, hash, json } from './cases.mjs';
const [build, destination, scratch, mode] = process.argv.slice(2);
assert(build && destination && scratch, 'build directory, output and scratch directory required');
const core = await import(pathToFileURL(resolve(build, 'core/index.js')));
const cliPath = resolve(build, 'cli/index.js');
await mkdir(scratch, { recursive: true });
const rows = [];
const unmodified = new Map(cases.filter(c => c.id.endsWith('-control')).map(c => [c.mode, core.parseOtlpJson(c.doc)]));
function measurements(trace) {
  const cost = core.buildCostReport(trace, core.DEFAULT_PRICE_TABLE);
  delete cost.warnings;
  const timing = core.buildTiming(trace);
  delete timing.warnings;
  return { cost, timing, spans: trace.spans.map(s => {
    const { children, events, attributes, genai, ...rest } = s;
    const { inputMessages, outputMessages, ...info } = genai ?? {};
    return { ...rest, childIds: children.map(c => c.spanId), genai: info };
  }) };
}
for (const c of cases) {
  const file = `${c.id}.json`;
  const text = json(c.doc);
  await writeFile(join(scratch, file), text);
  const row = { id: c.id, source: c.source, inputSha256: hash(text), expected: c.expected };
  try {
    const trace = core.parseOtlpJson(c.doc);
    const span = trace.spans.find(s => s.spanId === spanOf(c.doc).spanId);
    row.actual = { input: span.genai?.inputMessages, output: span.genai?.outputMessages, warnings: trace.warnings };
    row.spanCount = trace.spans.length;
    for (const [index, event] of span.events.entries()) {
      assert.deepEqual({ ...event.attributes }, Object.fromEntries(spanOf(c.doc).events[index].attributes.map(a => [a.key, a.value.stringValue])));
    }
    row.rawEventsSha256 = hash(json(span.events));
    const expected = { ...c.expected, warnings: trace.warnings.length };
    row.matches = json({ ...row.actual, warnings: trace.warnings.length }) === json(expected) && trace.warnings.length === c.expected.warnings;
    assert.deepEqual(measurements(trace), measurements(unmodified.get(c.mode)), `${c.id}: unrelated measurements changed`);
    assert.equal(trace.spans.length, 6);
    for (const warning of trace.warnings) {
      assert.equal(warning.traceId, span.traceId);
      assert.equal(warning.spanId, span.spanId);
    }
    row.measurementsSha256 = hash(json(measurements(trace)));
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error;
    row.error = error.message;
    row.matches = false;
  }
  row.cli = {};
  for (const command of ['summary', 'tree', 'cost']) {
    const result = spawnSync(process.execPath, [cliPath, command, file, ...(command === 'cost' ? ['--json'] : [])], {
      cwd: resolve(scratch), encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
    });
    row.cli[command] = { status: result.status, stderr: result.stderr, stdoutSha256: hash(result.stdout),
      ...(['legacy-control', 'toolUse-string', 'legacy-input-attribute'].includes(c.id) ? { stdout: result.stdout } : {}) };
    if (!row.error) {
      assert.equal(result.status, 0, `${c.id}: ${command}`);
      if (command === 'cost') {
        const report = JSON.parse(result.stdout);
        assert.deepEqual(report, core.buildCostReport(core.parseOtlpJson(c.doc), core.DEFAULT_PRICE_TABLE));
      } else if (c.expected.warnings && mode !== '--baseline') assert.match(result.stdout, /Kept the original message as text/);
    } else assert.notEqual(result.status, 0);
  }
  rows.push(row);
}
const report = { node: process.version, driverSha256: hash(await readFile(new URL(import.meta.url))),
  casesSha256: hash(await readFile(new URL('./cases.mjs', import.meta.url))),
  cases: rows.length, matches: rows.filter(r => r.matches).length, rejected: rows.filter(r => r.error).length, rows };
await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(`${report.matches}/${report.cases} expected outcomes; ${report.rejected} rejected; ${rows.length * 3} CLI invocations`);
if (mode !== '--baseline') assert.equal(report.matches, report.cases);
