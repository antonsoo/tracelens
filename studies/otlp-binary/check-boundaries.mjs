// node studies/otlp-binary/check-boundaries.mjs OUTPUT
// Compare the semantic runtime directly with the importer's wire guard.
import assert from 'node:assert/strict';
import { fromBinary, toJson } from '@bufbuild/protobuf';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ExportTraceServiceRequestSchema as schema } from '../../dist-cli/core/proto/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import { decodeTraceFile } from '../../dist-cli/core/trace-file.js';
const output = process.argv[2];
if (!output) throw new Error('Supply OUTPUT');
const oracle = JSON.parse(readFileSync(new URL('./controls/oracle.json', import.meta.url)));
const cases = [];
for (const name of ['nested-length-overrun', 'length-overflow']) {
  const control = oracle.cases.find(row => row.name === name);
  const file = new URL('./controls/' + control.file, import.meta.url);
  const bytes = readFileSync(file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), control.sha256);
  assert.equal(control.googleAccepted, false);
  const json = toJson(schema, fromBinary(schema, bytes), { enumAsInteger: true });
  let guardedError;
  try { decodeTraceFile(bytes, control.file); } catch (error) { guardedError = String(error); }
  assert.ok(guardedError, 'The importer must refuse this malformed native control');
  cases.push({ name, file: control.file, sha256: control.sha256, googleAccepted: false,
    unguarded: { accepted: true, resourceCount: json.resourceSpans.length },
    guarded: { accepted: false, error: guardedError } });
}
writeFileSync(output, JSON.stringify({ runtime: '@bufbuild/protobuf 2.16.0', node: process.version,
  scope: 'Direct semantic-runtime calls versus the import guard on explicitly constructed malformed controls. Google refusals are independently retained in controls/oracle.json.', cases }, null, 2) + '\n');
console.log(`${cases.length} malformed wire inputs accepted by the direct runtime and refused by the guarded importer`);
