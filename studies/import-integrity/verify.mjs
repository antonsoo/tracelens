// Controlled damaged variants of the checked-in synthetic Jaeger example.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [directory = 'dist-cli', output = 'studies/import-integrity/after.json', mode = 'verify'] = process.argv.slice(2);
const core = await import(pathToFileURL(resolve(directory, 'core/index.js')));
const source = readFileSync('examples/jaeger-genai-trace.json');
const original = JSON.parse(source);
const cases = [
  ['missing duration', s => { delete s.duration; }, false],
  ['null duration', s => { s.duration = null; }, false],
  ['negative duration', s => { s.duration = -1; }, false],
  ['fractional duration', s => { s.duration = 1.5; }, false],
  ['text duration', s => { s.duration = 'unknown'; }, false],
  ['oversized start', s => { s.startTime = '100000000000000000'; }, false],
  ['zero duration', s => { s.duration = 0; }, true, []],
  ['string duration', s => { s.duration = String(s.duration); }, true, []],
  ['missing log time', s => { s.logs = [{ fields: [] }]; }, true, []],
  ['null log time', s => { s.logs = [{ timestamp: null, fields: [] }]; }, true, []],
  ['oversized log time', s => { s.logs = [{ timestamp: '100000000000000000', fields: [] }]; }, true, []],
  ['non-object log', s => { s.logs = [null, 7]; }, true, []],
  ['zero log time', s => { s.logs = [{ timestamp: 0, fields: [] }]; }, true, ['0']],
  ['string log time', s => { s.logs = [{ timestamp: String(s.startTime), fields: [] }]; }, true, null],
];
const baseline = core.parseTraceText(source.toString());
const target = baseline.spans.find(s => s.children.length === 0 && s.events.length === 0).spanId;
const results = [];
for (const [name, mutate, present, eventTimes] of cases) {
  const doc = structuredClone(original);
  const raw = doc.data[0].spans.find(s => s.spanID === target);
  mutate(raw);
  const trace = core.parseTraceText(JSON.stringify(doc));
  const span = trace.spans.find(s => s.spanId === raw.spanID);
  const warnings = trace.warnings.filter(w => w.spanId === raw.spanID);
  const observedTimes = span?.events.map(e => String(e.timeUnixNano));
  const expectedTimes = eventTimes === null ? [String(BigInt(raw.startTime) * 1000n)] : eventTimes;
  const matches = Boolean(span) === present && (!span || JSON.stringify(observedTimes) === JSON.stringify(expectedTimes));
  // Retained source fields stay unchanged; removing a span can change tree/link resolution.
  const plain = ({ children: _children, depth: _depth, links, ...value }) => JSON.stringify({ ...value, links: links?.map(({ target: _target, ...link }) => link) }, (_key, v) => typeof v === 'bigint' ? String(v) : v);
  for (const other of baseline.spans.filter(s => s.spanId !== raw.spanID)) {
    assert.equal(plain(trace.spans.find(s => s.spanId === other.spanId)), plain(other));
  }
  if (mode !== 'observe') {
    assert.equal(matches, true, name);
    if (['zero duration', 'string duration', 'zero log time', 'string log time'].includes(name)) assert.equal(warnings.length, 0, name);
    else assert.ok(warnings.some(w => /invalid|missing|non-object/.test(w.message)), name);
    assert.equal(warnings.some(w => /clock skew/.test(w.message)), false, name);
  }
  results.push({ name, matches, targetRetained: Boolean(span), spanCount: trace.spans.length,
    ...(span ? { start: String(span.startTimeUnixNano), duration: String(span.durationNs), eventTimes: observedTimes } : {}), warnings });
}
writeFileSync(output, JSON.stringify({ source: 'examples/jaeger-genai-trace.json', sourceSha256: createHash('sha256').update(source).digest('hex'), results }, null, 2) + '\n');
console.log({ cases: results.length, expectedOutcomes: results.filter(r => r.matches).length });
