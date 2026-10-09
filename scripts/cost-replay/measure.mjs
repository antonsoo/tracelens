// Synthetic scale check using the recorded call's usage, not a provider benchmark.
// Run after npm run build:cli. No dependencies beyond Node and the built core.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { parseTraceText, buildCostReport, DEFAULT_PRICE_TABLE } from '../../dist-cli/core/index.js';

const input = JSON.parse(readFileSync(new URL('../../examples/cost-nano-stream.json', import.meta.url), 'utf8'));
const group = input.resourceSpans[0].scopeSpans[0];
const template = group.spans.find((span) => span.name === 'ai.streamText.doStream');
const attributes = template.attributes.filter(({ key }) =>
  ['ai.operationId', 'ai.model.id', 'ai.model.provider', 'ai.response.model'].includes(key) || key.startsWith('ai.usage.'));
const calls = 10_000;
group.spans = Array.from({ length: calls }, (_, i) => ({
  ...template, name: `cost-call-${i}`, spanId: (i + 1).toString(16).padStart(16, '0'),
  parentSpanId: undefined, attributes,
}));
const text = JSON.stringify(input);
const start = performance.now();
const trace = parseTraceText(text);
const parsed = performance.now();
const report = buildCostReport(trace, DEFAULT_PRICE_TABLE);
const calculated = performance.now();
const exported = JSON.stringify(report);
const finished = performance.now();
assert.equal(trace.spans.length, calls);
assert.equal(report.pricedCalls, calls);
assert.equal(report.unpricedCalls, 0);
assert.ok(Math.abs(report.estimatedCostUsd - calls * 0.00081907) < 1e-9);
console.log(JSON.stringify({
  scope: 'One local synthetic scale observation, not a latency guarantee or a provider benchmark.',
  node: process.version, platform: `${platform()} ${arch()}`, cpu: cpus()[0]?.model,
  spans: calls, inputBytes: Buffer.byteLength(text), exportBytes: Buffer.byteLength(exported),
  parseMs: +(parsed - start).toFixed(3), costReportMs: +(calculated - parsed).toFixed(3),
  jsonExportMs: +(finished - calculated).toFixed(3), knownTokenCostUsd: report.knownCostUsd,
}, null, 2));
