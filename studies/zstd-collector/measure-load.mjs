import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const [compiledArg, loadArg, filename, outArg] = process.argv.slice(2);
assert(
  compiledArg && loadArg && filename && outArg,
  "Usage: measure-load.mjs COMPILED_ROOT LOAD_DIR FILENAME OUTPUT_JSON",
);
const compiled = resolve(compiledArg),
  load = resolve(loadArg);
const { decodeTraceFile } = await import(pathToFileURL(join(compiled, "core/trace-file.js")));
const { parseTraceInputs } = await import(pathToFileURL(join(compiled, "core/otlp-parser.js")));
const { buildTiming } = await import(pathToFileURL(join(compiled, "core/timing.js")));
const bytes = await readFile(join(load, filename));
const started = performance.now(),
  input = decodeTraceFile(bytes, filename),
  decoded = performance.now();
const trace = parseTraceInputs([input]),
  parsed = performance.now(),
  timing = buildTiming(trace),
  finished = performance.now();
const sdk = JSON.parse(await readFile(join(load, "sdk-spans.json"))),
  byId = new Map(sdk.map((span) => [span.spanId, span]));
assert.equal(trace.spans.length, sdk.length);
assert.equal(trace.spans.length, 5001);
for (const span of trace.spans) {
  const original = byId.get(span.spanId);
  assert(original);
  assert.equal(span.traceId, original.traceId);
  assert.equal(span.parentSpanId ?? null, original.parentSpanId);
  assert.equal(span.startTimeUnixNano.toString(), original.start);
  assert.equal(span.endTimeUnixNano.toString(), original.end);
  assert.equal(span.name, original.name);
  assert.deepEqual({ ...span.attributes }, original.attributes);
}
assert.equal(trace.roots.length, 1);
assert.equal(trace.roots[0].children.length, 5000);
const serialize = (value) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const result = {
  node: process.version,
  file: filename,
  encodedBytes: bytes.length,
  encodedSha256: sha(bytes),
  decodedUnits: input.text.length,
  spans: trace.spans.length,
  originalSdkObservationsMatch: true,
  decodeMs: decoded - started,
  parseMs: parsed - decoded,
  timingMs: finished - parsed,
  totalCoreMs: finished - started,
  maxRssKiB: process.resourceUsage().maxRSS,
  normalizedSpansSha256: sha(
    serialize(
      trace.spans.map((span) => ({
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        start: span.startTimeUnixNano,
        end: span.endTimeUnixNano,
        attributes: span.attributes,
      })),
    ),
  ),
  timingSha256: sha(serialize({ ...timing, warnings: [] })),
  scope:
    "Fresh process; file I/O and SDK-observation comparisons excluded from core wall time. Peak RSS is the whole process, including verification. Controlled local SDK workload; no production latency or CPU-utilization claim.",
};
await writeFile(outArg, JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify({
    file: filename,
    spans: result.spans,
    totalCoreMs: result.totalCoreMs,
    maxRssKiB: result.maxRssKiB,
  }),
);
