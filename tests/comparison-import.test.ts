import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compareTraces, parseOtlpJson, parseTraceInputs, parseTraceText } from '../src/core/index.js';
import { attr, fakeSpan, otlpDoc, sv } from './fixtures.js';

const nativeText = readFileSync('tests/fixtures/census/strands-operation-details-events-tool-call.json', 'utf8');
const complete = () => parseTraceText(nativeText);
interface NativeDoc {
  resourceSpans: { scopeSpans: { spans: { traceId: string; endTimeUnixNano?: string; events?: unknown[] }[] }[] }[];
}
const nativeDoc = () => JSON.parse(nativeText) as NativeDoc;

describe('comparison import evidence', () => {
  it('refuses a false reduction caused by skipping a captured model call', () => {
    const raw = nativeDoc();
    delete raw.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.endTimeUnixNano;
    const partial = parseOtlpJson(raw);
    expect(partial.spans).toHaveLength(5);
    expect(() => compareTraces(complete(), partial, [])).toThrow(/Cannot compare candidate:.*missing or invalid timestamps/);
    expect(() => compareTraces(partial, complete(), [])).toThrow(/Cannot compare baseline:/);
  });

  it('keeps optional event evidence warnings separate from span inventory', () => {
    const raw = nativeDoc();
    raw.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.events = [null];
    const trace = parseOtlpJson(raw);
    expect(trace.warnings.length).toBeGreaterThan(0);
    expect(compareTraces(complete(), trace, []).metrics.inputTokens.delta).toBe(0);
  });

  it('rejects unknown container coverage and a truncated collector tail', () => {
    const raw = nativeDoc();
    expect(() => compareTraces(complete(), parseOtlpJson({ ...raw, resourceSpans: [...raw.resourceSpans, false] }), [])).toThrow(/span evidence is unknown/);
    const partial = parseTraceText(JSON.stringify(raw) + '\n{"resourceSpans":[');
    expect(() => compareTraces(complete(), partial, [])).toThrow(/not complete JSON/);
  });

  it('scopes a known lost span to its own trace', () => {
    const raw = nativeDoc();
    const other = structuredClone(raw.resourceSpans);
    for (const resource of other) for (const scope of resource.scopeSpans) {
      for (const span of scope.spans) span.traceId = 'bb'.repeat(16);
    }
    delete other[0]!.scopeSpans[0]!.spans[0]!.endTimeUnixNano;
    raw.resourceSpans.push(...other);
    const selected = parseOtlpJson(raw, { traceId: complete().traceId });
    expect(compareTraces(complete(), selected, []).metrics.inputTokens.delta).toBe(0);
    const partial = parseOtlpJson(raw, { traceId: 'bb'.repeat(16) });
    expect(() => compareTraces(complete(), partial, [])).toThrow(/Cannot compare candidate:/);
  });

  it('requires missing parents to be resolved, including directly constructed traces', () => {
    const root = fakeSpan({ spanId: 'root', startNs: 0, endNs: 10 });
    const child = fakeSpan({ spanId: 'child', parentSpanId: 'root', startNs: 2, endNs: 8 });
    const parentText = JSON.stringify(otlpDoc([root]));
    const childText = JSON.stringify(otlpDoc([child]));
    const partial = parseTraceText(childText);
    expect(() => compareTraces(partial, partial, [])).toThrow(/parent/);
    partial.warnings = [];
    expect(() => compareTraces(partial, partial, [])).toThrow(/parent is absent/);
    const merged = parseTraceInputs([{ name: 'parent', text: parentText }, { name: 'child', text: childText }]);
    expect(compareTraces(merged, merged, []).metrics.selfTimeMs.delta).toBe(0);
    const invalid = parseOtlpJson(otlpDoc([{ ...root, parentSpanId: 42 }]));
    expect(() => compareTraces(invalid, invalid, [])).toThrow(/invalid parentSpanId/);
  });

  it('distinguishes a clamped invalid interval from recorded zero duration', () => {
    const raw = fakeSpan({ spanId: 'call', startNs: 10, endNs: 9, attributes: [attr('gen_ai.operation.name', sv('chat'))] });
    const skewed = parseOtlpJson(otlpDoc([raw]));
    expect(skewed.spans[0]!.durationNs).toBe(0n);
    expect(() => compareTraces(skewed, skewed, [])).toThrow(/valid intervals/);
    const zero = parseOtlpJson(otlpDoc([{ ...raw, endTimeUnixNano: '10' }]));
    expect(compareTraces(zero, zero, []).metrics.selfTimeMs.delta).toBe(0);
    zero.spans[0]!.durationNs = -1n;
    expect(() => compareTraces(zero, zero, [])).toThrow(/interval is invalid/);
  });
});
