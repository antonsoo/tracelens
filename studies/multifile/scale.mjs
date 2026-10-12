// A synthetic scale control: repeat the captured workload with distinct trace
// IDs, distributing its spans over the maximum supported file count.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
const { values: args } = parseArgs({ options: {
  core: { type: 'string', default: 'dist-cli/core/index.js' }, output: { type: 'string' },
} });
const { parseTraceInputs } = await import(pathToFileURL(resolve(args.core)));
const directory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const oracle = JSON.parse(await readFile(join(directory, 'oracle.json')));
const resources = [];
for (const file of oracle.files) {
  const text = await readFile(join(directory, file.name), 'utf8');
  const docs = file.name.endsWith('.jsonl') ? text.trim().split('\n').map(line => JSON.parse(line)) : [JSON.parse(text)];
  for (const doc of docs) for (const resource of doc.resourceSpans) for (const scope of resource.scopeSpans) for (const span of scope.spans) {
    resources.push({ resource: resource.resource, scope: scope.scope, span });
  }
}
const buckets = Array.from({ length: 32 }, () => []);
let index = 0;
for (let repeat = 0; repeat < 500; repeat++) {
  const id = original => createHash('sha256').update(`${repeat}:${original}`).digest().subarray(0, 16).toString('base64');
  for (const item of resources) {
    const span = { ...item.span, traceId: id(item.span.traceId),
      ...(item.span.links ? { links: item.span.links.map(link => ({ ...link, traceId: id(link.traceId) })) } : {}) };
    buckets[index++ % buckets.length].push({ resource: item.resource, scopeSpans: [{ scope: item.scope, spans: [span] }] });
  }
}
const inputs = buckets.map((resourceSpans, i) => ({ name: `part-${i}.json`, text: JSON.stringify({ resourceSpans }) }));
const times = [];
for (let run = 0; run < 6; run++) {
  const start = performance.now();
  const trace = parseTraceInputs(inputs);
  const elapsed = performance.now() - start;
  assert.equal(trace.traces.length, 1000);
  assert.equal(trace.spans.length, 7);
  assert.equal(trace.roots.length, 1);
  assert.equal(trace.warnings.length, 0);
  assert.equal(trace.inputFiles.reduce((sum, file) => sum + file.spanCount, 0), 4500);
  if (run) times.push(elapsed);
}
const result = { workload: 'Synthetic 500 repetitions of captured SDK spans with remapped trace IDs, spread over 32 files',
  node: process.version, platform: process.platform, files: inputs.length, bytes: inputs.reduce((n, input) => n + Buffer.byteLength(input.text), 0),
  spans: index, traces: 1000, selectedSpans: 7, warmupRuns: 1, milliseconds: times, medianMs: [...times].sort((a, b) => a - b)[2] };
if (args.output) await writeFile(args.output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
