import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus, totalmem } from 'node:os';

const [corePath, output] = process.argv.slice(2);
if (!corePath || !output) throw new Error('Usage: node studies/span-links/measure.mjs <compiled-core/index.js> <output.json>');
const { parseTraceText } = await import(pathToFileURL(resolve(corePath)).href);
const id = (n, width) => n.toString(16).padStart(width, '0');
const spans = Array.from({ length: 20_000 }, (_, index) => {
  const trace = Math.floor(index / 200) + 1, span = index % 200 + 1;
  return { traceId: id(trace, 32), spanId: id(span, 16), name: `job ${span}`, startTimeUnixNano: '1790000000000000000', endTimeUnixNano: '1790000000001000000',
    links: [{ traceId: id(trace % 100 + 1, 32), spanId: id(span, 16) }, { traceId: id(101, 32), spanId: id(span, 16) }] };
});
const text = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
const times = [];
let observedLinks = 0;
for (let i = 0; i < 7; i++) {
  const start = performance.now();
  const trace = parseTraceText(text);
  const elapsed = performance.now() - start;
  observedLinks = trace.spans.reduce((sum, span) => sum + (span.links?.length ?? 0), 0);
  if (i >= 2) times.push(Number(elapsed.toFixed(3)));
}
const result = { runtime: process.version, logicalCpus: cpus().length, totalMemoryGiB: Math.round(totalmem() / 2 ** 30),
  inputBytes: Buffer.byteLength(text), spans: spans.length, traces: 100, suppliedLinks: 40_000,
  selectedTraceSpans: 200, selectedTraceLinks: observedLinks, parseMilliseconds: times,
  medianMilliseconds: [...times].sort((a, b) => a - b)[2],
  note: 'Controlled generated input, two warmups and five timed JSON-decode/import passes; excludes file I/O and browser rendering. Before importer discards links, so work is unequal.' };
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
