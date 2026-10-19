import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const [compiledArg, outputArg] = process.argv.slice(2);
assert(compiledArg && outputArg, "Usage: replay-codec.mjs COMPILED_ROOT OUTPUT_DIR");
const { decodeZstdCarrier } = await import(
  pathToFileURL(join(resolve(compiledArg), "core/zstd.js"))
);
const here = fileURLToPath(new URL("./cache/codec-corpus/", import.meta.url)),
  output = resolve(outputArg),
  oracleBytes = await readFile(join(here, "oracle.json")),
  oracle = JSON.parse(oracleBytes),
  sha = (b) => createHash("sha256").update(b).digest("hex");
const positive = [],
  mutations = [],
  failures = [];
for (const row of oracle.positiveCases) {
  const bytes = await readFile(join(here, row.file));
  assert.equal(sha(bytes), row.sha256);
  try {
    const decoded = decodeZstdCarrier(bytes, "raw");
    assert.equal(decoded.bytes.length, row.decodedBytes);
    assert.equal(sha(decoded.bytes), row.decodedSha256);
    positive.push({ file: row.file, matched: true });
  } catch (e) {
    failures.push({ file: row.file, error: e.message });
  }
}
const sources = new Map();
for (const row of oracle.mutationSources) {
 const bytes=await readFile(join(here,row.file));assert.equal(sha(bytes),row.sha256);sources.set(row.name,bytes);
}
for (const row of oracle.mutations) {
  const bytes = new Uint8Array(sources.get(row.source));
  bytes[row.offset] ^= 1 << row.bit;
  let decoded = null,
    error = null;
  try {
    decoded = decodeZstdCarrier(bytes, "raw").bytes;
  } catch (e) {
    error = e.message;
  }
  const accepted = decoded !== null,
    expected = row.expected === "accept";
  const matched = accepted === expected && (!accepted || sha(decoded) === row.decodedSha256);
  if (!matched)
    failures.push({ ...row, accepted, error, actualDecodedSha256: decoded ? sha(decoded) : null });
  mutations.push({ source: row.source,
    offset: row.offset, bit: row.bit, expected: row.expected, accepted, matched });
}
await mkdir(output, { recursive: true });
await writeFile(
  join(output, "codec-oracle.json.gz"),
  gzipSync(oracleBytes, { level: 9, mtime: 0 }),
);
const summary = {
  node: process.version,
  oracleSha256: sha(oracleBytes),
  referenceZstandard: oracle.zstandardVersion,
  syntheticCodecCases: oracle.positiveCases.length,
  singleBitMutations: oracle.mutations.length,
  withinLimitsReferenceAccepted: oracle.mutations.filter((r) => r.expected === "accept").length,
  expectedReferenceRejected: oracle.mutations.filter((r) => r.expected === "reject").length,
  outsideSupportedLimits: oracle.mutations.filter((r) => r.expected === "outside-supported-limits")
    .length,
  failures,
  positiveCasesMatched: positive.length,
  mutationsMatched: mutations.filter((r) => r.matched).length,
  scope:
    "Constructed byte-codec controls, not telemetry populations. Python zstandard validates original bytes and single-bit mutations of one retained native Collector frame. Resource/dictionary exclusions remain explicit; accepted decoded bytes must match exactly.",
};
await writeFile(join(output, "codec.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
assert.deepEqual(failures, []);
