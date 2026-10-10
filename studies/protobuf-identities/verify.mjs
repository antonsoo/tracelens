// Check built parser and actual CLI output against identities read from SDK objects.
// Usage: node studies/protobuf-identities/verify.mjs --dist path/to/dist-cli --output report.json [--observe-only]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const { values } = parseArgs({ options: { dist: { type: 'string' }, output: { type: 'string' }, 'observe-only': { type: 'boolean', default: false } } });
assert(values.dist && values.output, '--dist and --output are required');
const dist = resolve(values.dist);
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const oracle = JSON.parse(await readFile(join(fixtures, 'oracle.json'), 'utf8'));
const core = await import(pathToFileURL(join(dist, 'core/index.js')).href);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item instanceof Map ? [...item] : item);
const rows = [];
async function check(name, action) {
  try { rows.push({ case: name, passed: true, ...await action() }); }
  catch (error) { rows.push({ case: name, passed: false, error: error.message }); }
}

for (const source of oracle.files) {
  const bytes = await readFile(join(fixtures, source.file));
  assert.equal(hash(bytes), source.sha256, `fixture changed: ${source.file}`);
  const data = JSON.parse(bytes);
  const ids = [...new Set(source.spans.map((s) => s.traceId))];
  await check(`${source.file}/default-identities`, () => {
    const parsed = core.parseOtlpJson(data);
    assert.deepEqual(parsed.traces.map((t) => t.traceId).sort(), [...ids].sort());
    const selected = source.spans.filter((s) => s.traceId === parsed.traceId);
    assert.equal(parsed.spans.length, selected.length);
    for (const expected of selected) {
      const span = parsed.spans.find((s) => s.spanId === expected.spanId);
      assert(span, `missing byte identity ${expected.spanId}`);
      const observed = oracle.spans.find((s) => s.traceId === expected.traceId && s.spanId === expected.spanId);
      assert.equal(span.name, observed.name);
      assert.equal(span.parentSpanId ?? null, observed.parentSpanId);
      assert.equal(String(span.startTimeUnixNano), observed.start);
      assert.equal(String(span.endTimeUnixNano), observed.end);
      assert.deepEqual((span.links ?? []).map(({ traceId, spanId }) => ({ traceId, spanId })), observed.links);
    }
    return { traceId: parsed.traceId, traces: ids.length, spans: parsed.spans.length };
  });

  for (const id of ids) {
    const group = source.file.split('.')[0];
    const reference = core.parseOtlpJson(JSON.parse(await readFile(join(fixtures, `${group}.otlp.json`))), { traceId: id });
    for (const [encoding, selected] of [['hex', id], ['base64', Buffer.from(id, 'hex').toString('base64')]]) {
      await check(`${source.file}/select-${encoding}/${id}`, () => {
        const parsed = core.parseOtlpJson(data, { traceId: selected });
        assert.equal(canonical(parsed), canonical(reference));
        return { parsed_sha256: hash(canonical(parsed)) };
      });
    }
    for (const command of ['links', 'timing', 'cost']) {
      await check(`${source.file}/cli-${command}/${id}`, () => {
        const run = spawnSync(process.execPath, [join(dist, 'cli/index.js'), command, join(fixtures, source.file), '--trace', id, '--json'], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        const control = spawnSync(process.execPath, [join(dist, 'cli/index.js'), command, join(fixtures, `${group}.otlp.json`), '--trace', id, '--json'], { encoding: 'utf8' });
        assert.equal(control.status, 0, control.stderr);
        assert.equal(run.stderr, control.stderr); // Trace-choice diagnostics belong on stderr.
        const output = JSON.parse(run.stdout);
        const expected = command === 'links' ? core.buildLinksReport(reference)
          : command === 'timing' ? core.buildTiming(reference) : core.buildCostReport(reference, core.DEFAULT_PRICE_TABLE);
        assert.equal(canonical(output), canonical(JSON.parse(canonical(expected))));
        return { output_sha256: hash(run.stdout) };
      });
    }
  }
}
const report = { node: process.version, driver_sha256: hash(await readFile(fileURLToPath(import.meta.url))),
  parser_sha256: hash(await readFile(join(dist, 'core/otlp-parser.js'))),
  oracle_sha256: hash(await readFile(join(fixtures, 'oracle.json'))),
  passed: rows.filter((r) => r.passed).length, total: rows.length, cases: rows };
await mkdir(dirname(resolve(values.output)), { recursive: true });
await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.passed}/${report.total} SDK identity, full parser and CLI outcomes passed`);
if (!values['observe-only'] && report.passed !== report.total) process.exitCode = 1;
