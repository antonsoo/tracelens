import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeId } from '../src/core/identity.js';
import { decodeTraceFile } from '../src/core/trace-file.js';
import { parseTraceInputs, parseOtlpJson } from '../src/core/otlp-parser.js';
import { buildSummary } from '../src/core/summary.js';
import { compareTraces } from '../src/core/compare.js';
const directory = new URL('../studies/zero-identities/fixtures/', import.meta.url);
const load = (name: string) => decodeTraceFile(readFileSync(new URL(name, directory)), name);
const validTrace = 'aabbccddeeff00112233445566778899';

describe('complete zero identities are invalid in every supported byte encoding', () => {
  it.each([8, 16] as const)('rejects the %s-byte zero value, retaining nonzero and opaque compatibility', bytes => {
    const zero = Buffer.alloc(bytes);
    for (const value of [zero.toString('hex'), zero.toString('base64'), zero.toString('base64url')]) expect(normalizeId(value, bytes)).toBe('');
    zero[bytes - 1] = 1;
    expect(normalizeId(zero.toString('base64'), bytes)).toBe(zero.toString('hex'));
    for (const value of ['0', '000', 'opaque-ID', 'AAAAAAAAAAF=']) expect(normalizeId(value, bytes)).toBe(value);
  });
  it('rejects Jaeger complete zero trace IDs before extending the high word', () => {
    expect(normalizeId('0'.repeat(16), 16)).toBe('');
    expect(normalizeId('1'.padStart(16, '0'), 16)).toBe('1'.padStart(32, '0'));
  });
});

describe('native SDK exports from an explicitly broken custom ID generator', () => {
  it.each(['traces.pb', 'json', 'snake.json'])('keeps the two SDK-valid spans and refuses incomplete comparison: %s', suffix => {
    const trace = parseTraceInputs([load(`mixed.${suffix}`)]);
    expect(trace.traceId).toBe(validTrace);
    expect(trace.traces).toHaveLength(1);
    expect(trace.spans.map(span => span.name)).toEqual(['valid-1', 'valid-2']);
    expect(trace.warnings.filter(w => w.comparisonIssue === 'span-inventory')).toHaveLength(5);
    const summary = buildSummary(trace, []);
    expect(summary.modelUsage[0]!.inputTokens).toBe(20);
    expect(summary.costReport.incompleteInput).toBe(true);
    expect(summary.costReport.estimatedCostUsd).toBeNull();
    expect(() => compareTraces(trace, parseTraceInputs([load(`valid.${suffix}`)]), [])).toThrow('Cannot compare');
  });
  it.each(['zero-trace', 'zero-span', 'both-zero'])('refuses a file whose only SDK context is invalid: %s', name => {
    for (const suffix of ['traces.pb', 'json', 'snake.json']) expect(() => parseTraceInputs([load(`${name}.${suffix}`)])).toThrow('No valid spans');
  });
  it('preserves complete valid native evidence across binary and both JSON spellings', () => {
    const traces = ['traces.pb', 'json', 'snake.json'].map(suffix => parseTraceInputs([load(`valid.${suffix}`)]));
    for (const trace of traces) {
      expect(trace.warnings).toEqual([]);
      expect(trace.spans).toEqual(traces[0]!.spans);
      expect(buildSummary(trace, []).modelUsage[0]!.inputTokens).toBe(20);
      expect(buildSummary(trace, []).costReport.incompleteInput).toBeUndefined();
    }
  });
});

it('does not resolve a zero parent or zero link into a real span', () => {
  const data = { resourceSpans: [{ scopeSpans: [{ spans: [{
    traceId: validTrace, spanId: '1'.padStart(16, '0'), name: 'parent-link-control',
    parentSpanId: Buffer.alloc(8).toString('base64'), startTimeUnixNano: '1', endTimeUnixNano: '2',
    links: [
      { traceId: validTrace, spanId: '0'.repeat(16) },
      { traceId: Buffer.alloc(16).toString('base64'), spanId: '1'.padStart(16, '0') },
    ],
  }] }] }] };
  const trace = parseOtlpJson(data);
  expect(trace.roots).toHaveLength(1);
  expect(trace.spans[0]!.parentSpanId).toBeUndefined();
  expect(trace.spans[0]!.links).toEqual([]);
  expect(trace.spans[0]!.invalidLinkCount).toBe(2);
  expect(trace.warnings.some(w => w.comparisonIssue === 'span-ancestry')).toBe(true);
});
