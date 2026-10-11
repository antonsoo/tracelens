// node studies/attribute-values/benchmark.mjs BASELINE_DIST CURRENT_DIST OUTPUT_JSON
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [baseline, current, output] = process.argv.slice(2);
if (!output) throw new Error('Supply BASELINE_DIST CURRENT_DIST OUTPUT_JSON');
const parsers = {};
for (const [name, dir] of [['before', baseline], ['after', current]]) {
  parsers[name] = (await import(pathToFileURL(resolve(dir, 'core/otlp-parser.js')))).parseOtlpJson;
}
const spans = Array.from({ length: 20001 }, (_, i) => ({
  traceId: 'a'.repeat(32), spanId: i.toString(16).padStart(16, '0'), ...(i ? { parentSpanId: '0000000000000000' } : {}),
  name: `span ${i}`, startTimeUnixNano: String(i), endTimeUnixNano: String(40002 - i),
  attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
    { key: 'gen_ai.tool.name', value: { stringValue: `tool ${i}` } }],
}));
const doc = { resourceSpans: [{ scopeSpans: [{ spans }] }] };
const runs = { before: [], after: [] };
for (let i = 0; i < 8; i++) for (const [name, parse] of Object.entries(parsers)) {
  const start = performance.now();
  const trace = parse(doc);
  if (trace.spans.length !== spans.length) throw new Error('Lost spans');
  const ms = performance.now() - start;
  if (i > 1) runs[name].push(ms);
}
const result = { node: process.version, environment: '14 vCPU WSL2 Linux, 48 GB RAM', spans: spans.length,
  attributesPerSpan: 2, shape: 'one parent and 20000 children; controlled, no model calls', warmupRuns: 2,
  timedRuns: 6, runsMs: runs, medianMs: Object.fromEntries(Object.entries(runs).map(([key, values]) =>
    [key, [...values].sort((a, b) => a - b).slice(2, 4).reduce((a, b) => a + b) / 2])) };
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result.medianMs));
