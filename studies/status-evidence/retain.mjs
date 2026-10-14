// Retain identical full reports once, while preserving exact CLI JSON stdout reconstruction.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
assert(input && output, 'Expected INPUT_FULL_CAPTURE OUTPUT_RETAINED_CAPTURE');
const full = JSON.parse(readFileSync(input, 'utf8'));
const hash = text => createHash('sha256').update(text).digest('hex');
const reports = {};
const records = full.records.map(record => {
  const reportRef = hash(JSON.stringify(record.report));
  reports[reportRef] ??= record.report;
  const stdout = record.captures['compare-json'].stdout;
  assert.equal(JSON.stringify(record.report, null, 2) + '\n', stdout);
  const { report, ...rest } = record;
  assert.equal(hash(JSON.stringify(report)), reportRef);
  const retained = { ...rest, reportRef,
    captures: { ...record.captures, 'compare-json': { ...record.captures['compare-json'],
      stdout: undefined, stdoutSha256: hash(stdout), stdoutReportRef: reportRef } } };
  assert.equal(hash(JSON.stringify(reports[retained.reportRef], null, 2) + '\n'), retained.captures['compare-json'].stdoutSha256);
  return retained;
});
writeFileSync(output, JSON.stringify({ ...full, reports, records,
  retention: 'Full reports are shared by SHA-256 references. CLI JSON stdout is exactly JSON.stringify(reports[stdoutReportRef], null, 2) followed by one newline; its raw SHA-256 is verified before retention. Other stdout/stderr remains unedited.' }, null, 2) + '\n');
console.log(`Retained ${records.length} cases using ${Object.keys(reports).length} full reports.`);
