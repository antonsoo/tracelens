// Actual built parser and CLI checked against pre-serialization SDK objects.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const [directory = 'dist-cli', output = 'studies/dropped-evidence/after.json', mode = 'verify'] = process.argv.slice(2);
const dist = resolve(directory);
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const oracleBytes = readFileSync(join(fixtures, 'oracle.json'));
const oracle = JSON.parse(oracleBytes);
const core = await import(pathToFileURL(join(dist, 'core/index.js')));
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v));
const results = [];
for (const file of oracle.files) {
  const bytes = readFileSync(join(fixtures, file.name));
  assert.equal(hash(bytes), file.sha256);
  for (const expected of oracle.spans) {
    const trace = core.parseOtlpJson(JSON.parse(bytes), { traceId: expected.traceId });
    const span = trace.spans[0];
    const observed = { droppedAttributesCount: span.droppedAttributesCount ?? 0, droppedEventsCount: span.droppedEventsCount ?? 0,
      eventDroppedAttributes: span.events.map(e => e.droppedAttributesCount ?? 0) };
    const wanted = { droppedAttributesCount: expected.droppedAttributesCount, droppedEventsCount: expected.droppedEventsCount,
      eventDroppedAttributes: expected.events.map(e => e.droppedAttributesCount) };
    assert.deepEqual(plain(span.attributes), expected.attributes);
    assert.deepEqual(plain(span.events).map(({ droppedAttributesCount: _count, ...event }) => event), expected.events.map(({ droppedAttributesCount: _count, ...event }) => event));
    assert.equal(String(span.startTimeUnixNano), expected.start);
    assert.equal(String(span.endTimeUnixNano), expected.end);
    const warningsExpected = Number(expected.droppedAttributesCount > 0) + Number(expected.droppedEventsCount > 0) + expected.events.filter(e => e.droppedAttributesCount > 0).length;
    const cli = [];
    for (const command of ['summary', 'tree', 'timing', 'cost', 'links']) {
      const structured = ['timing', 'cost', 'links'].includes(command);
      const run = spawnSync(process.execPath, [join(dist, 'cli/index.js'), command, join(fixtures, file.name), '--trace', expected.traceId, ...(structured ? ['--json'] : [])], { encoding: 'utf8', timeout: 15_000 });
      assert.equal(run.status, 0, run.stderr);
      const warnings = structured ? JSON.parse(run.stdout).warnings : run.stdout.split('\n').filter(line => line.includes('reports ') && line.includes('dropped'));
      cli.push({ command, omissionWarnings: warnings.length, outputSha256: hash(run.stdout) });
      if (mode !== 'observe') assert.equal(warnings.length, warningsExpected, command);
    }
    const countsMatchSdk = JSON.stringify(observed) === JSON.stringify(wanted);
    if (mode !== 'observe') { assert.equal(countsMatchSdk, true); assert.equal(trace.warnings.length, warningsExpected); }
    results.push({ file: file.name, traceId: trace.traceId, name: span.name, countsMatchSdk, expected: wanted, observed, retainedEvents: span.events.length, warnings: trace.warnings, cli });
  }
}
writeFileSync(output, JSON.stringify({ node: process.version, oracleSha256: hash(oracleBytes), results }, null, 2) + '\n');
console.log({ cases: results.length, countersMatchSdk: results.filter(r => r.countsMatchSdk).length, warnings: results.map(r => r.warnings.length) });
