import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const [compiledArg, outputArg] = process.argv.slice(2);
assert(
  compiledArg && outputArg,
  "Usage: node studies/zstd-collector/replay.mjs COMPILED_CORE_ROOT OUTPUT_DIR",
);
const compiled = resolve(compiledArg),
  output = resolve(outputArg),
  here = fileURLToPath(new URL(".", import.meta.url));
const { decodeTraceFile } = await import(pathToFileURL(join(compiled, "core/trace-file.js")));
const { decodeZstdCarrier } = await import(pathToFileURL(join(compiled, "core/zstd.js")));
const { parseTraceInputs } = await import(pathToFileURL(join(compiled, "core/otlp-parser.js")));
const { buildTiming } = await import(pathToFileURL(join(compiled, "core/timing.js")));
const { buildCostReport } = await import(pathToFileURL(join(compiled, "core/cost-report.js")));
const digest = (b) => createHash("sha256").update(b).digest("hex");
const oracle = JSON.parse(await readFile(join(here, "fixtures/oracle.json")));
const controls = JSON.parse(await readFile(join(here, "controls/oracle.json")));
const serialize = (value) =>
  JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item));
const read = async (mode, name) =>
  decodeTraceFile(new Uint8Array(await readFile(join(here, "fixtures", mode, name))), name);
const omit = (value, fields) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
function evidence(trace) {
  const costs = buildCostReport(trace, []);
  return {
    traceId: trace.traceId,
    traces: trace.traces,
    roots: trace.roots.map((span) => span.spanId),
    spans: trace.spans.map((span) => ({
      ...omit(span, ["children", "logs", "sourceFile"]),
      children: span.children.map((child) => child.spanId),
      logs: span.logs?.map((log) => omit(log, ["source"])),
    })),
    timing: { ...buildTiming(trace), warnings: [] },
    costs: { ...costs, warnings: [], rows: costs.rows.map((row) => omit(row, ["sourceFile"])) },
  };
}
const files = [];
for (const row of oracle.observations) {
  const bytes = await readFile(join(here, "fixtures", row.file));
  assert.equal(digest(bytes), row.sha256);
  const start = performance.now(),
    decoded = decodeZstdCarrier(bytes, row.format === "json" ? "text" : "collector");
  const ms = performance.now() - start;
  assert.equal(digest(decoded.bytes), row.decodedSha256);
  files.push({
    ...row,
    carrier: decoded.carrier,
    frames: decoded.frames,
    decodeMs: ms,
    decodedMatchesIndependentPython: true,
  });
}
const workflows = [];
for (const mode of ["legacy", "native"])
  for (const format of ["json", "proto"]) {
    const names =
      format === "json" ? ["traces.jsonl", "logs.jsonl"] : ["traces.traces.otlp", "logs.logs.otlp"];
    const plain = await Promise.all(names.map((name) => read(mode, name)));
    const zipped = await Promise.all(names.map((name) => read(mode, name + ".zst")));
    const choices = parseTraceInputs(plain).traces;
    for (const choice of choices) {
      const expected = parseTraceInputs(plain, { traceId: choice.traceId }),
        actual = parseTraceInputs(zipped, { traceId: choice.traceId });
      assert.deepEqual(actual.warnings,expected.warnings);
      assert(actual.inputFiles.every(file=>file.compression.format==='zstd'));
      assert.deepEqual(
        JSON.parse(serialize(evidence(actual))),
        JSON.parse(serialize(evidence(expected))),
      );
      workflows.push({
        mode,
        format,
        traceId: choice.traceId,
        spans: actual.spans.length,
        logs: actual.spans.reduce((sum, span) => sum + (span.logs?.length ?? 0), 0),
        normalizedEvidenceSha256: digest(serialize(evidence(actual))),
        matchesUncompressed: true,
      });
    }
  }
const failures = [];
for (const row of controls.cases) {
  const bytes = await readFile(join(here, "controls", row.file));
  assert.equal(digest(bytes), row.sha256);
  let error = null;
  try {
    decodeTraceFile(bytes, row.file);
  } catch (e) {
    error = e.message;
  }
  assert.equal(error === null, row.expected === "accept", row.file);
  failures.push({ file: row.file, expected: row.expected, error });
}
await mkdir(output, { recursive: true });
await writeFile(
  join(output, "replay.json"),
  JSON.stringify(
    {
      node: process.version,
      files,
      workflows,
      controls: failures,
      scope:
        "Native Collector outputs of retained scripted SDK requests; independent Python decoded-byte hashes; complete normalized observations, timing and unpriced cost evidence agree. Constructed corruption and resource controls are separate.",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    compressedFiles: files.length,
    completeTraceComparisons: workflows.length,
    controls: failures.length,
    allMatch: true,
  }),
);
