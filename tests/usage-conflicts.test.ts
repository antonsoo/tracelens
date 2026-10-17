import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCostReport, buildSummary, compareTraces, explainSpanCost, parseOtlpJson } from '../src/core/index.js';
import type { PriceEntry, TokenUsage } from '../src/core/index.js';
import { attr, fakeSpan, iv, otlpDoc, sv } from './fixtures.js';

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../studies/usage-conflicts/fixtures/${name}`, import.meta.url), 'utf8'));
const fixture = read('native.json');
const ledger = read('capture.json') as {
  cases: { name: string; expected: { costUsd: number | null; unknownFields: (keyof TokenUsage)[]; invalid?: boolean } }[];
  attributesPerCase: { name: string; attributes: Record<string, unknown> }[];
};
const prices = read('prices.json') as PriceEntry[];
const trace = parseOtlpJson(fixture);
const report = buildCostReport(trace, prices);
const rows = new Map(report.rows.map(row => [row.name, row]));
const spans = new Map(trace.spans.map(span => [span.name, span]));

describe('native SDK usage evidence', () => {
  it.each(ledger.cases)('$name', ({ name, expected }) => {
    const row = rows.get(name)!;
    expect(row).toBeDefined();
    const usage = row.usage!;
    for (const field of expected.unknownFields) expect(usage[field]).toBeUndefined();
    if (expected.unknownFields.length) {
      expect(expected.invalid ? usage.invalidFields : usage.conflictingFields).toEqual(expected.unknownFields);
    } else {
      expect(usage.invalidFields).toBeUndefined();
      expect(usage.conflictingFields).toBeUndefined();
    }
    if (expected.costUsd === null) {
      expect(row.result).toMatchObject({ status: 'unpriced', reason: expected.invalid ? 'invalid-usage' : 'conflicting-usage' });
    } else {
      expect(row.result.status).toBe('priced');
      if (row.result.status === 'priced') expect(row.result.costUsd).toBeCloseTo(expected.costUsd, 12);
    }
    expect(spans.get(name)!.attributes).toEqual(ledger.attributesPerCase.find(item => item.name === name)!.attributes);
  });

  it('keeps all original measurements and does not let attribute order select a count', () => {
    const reversed = structuredClone(fixture) as { resourceSpans: { scopeSpans: { spans: { attributes: unknown[] }[] }[] }[] };
    for (const resource of reversed.resourceSpans) for (const scope of resource.scopeSpans) for (const span of scope.spans) span.attributes.reverse();
    const other = parseOtlpJson(reversed);
    for (const span of other.spans) expect(span.genai).toEqual(spans.get(span.name)!.genai);
    expect(buildCostReport(other, prices)).toEqual(report);
  });

  it('distinguishes a real zero from an ambiguous zero in summary and comparison', () => {
    const zero = parseOtlpJson(read('equal-zero.json')), ambiguous = parseOtlpJson(read('focused.json'));
    const before = buildSummary(zero, prices), after = buildSummary(ambiguous, prices);
    expect(before.costReport.estimatedCostUsd).toBe(0);
    expect(before.modelUsage[0]!.missingInputCalls).toBe(0);
    expect(after.costReport.knownCostUsd).toBeNull();
    expect(after.costReport.estimatedCostUsd).toBeNull();
    expect(after.modelUsage[0]).toMatchObject({ inputTokens: 0, missingInputCalls: 1, outputTokens: 0, missingOutputCalls: 0 });
    const comparison = compareTraces(zero, ambiguous, prices);
    expect(comparison.metrics.inputTokens.candidate).toMatchObject({ value: 0, missing: 1 });
    expect(comparison.metrics.costUsd.candidate).toMatchObject({ value: 0, missing: 1 });
    expect(comparison.metrics.costUsd.delta).toBeNull();
  });

  it('does not replace a conflicting embedding output count with the implicit vector zero', () => {
    const embedding = parseOtlpJson(otlpDoc([fakeSpan({ spanId: 'a', startNs: 0, endNs: 1, attributes: [
      attr('gen_ai.operation.name', sv('embeddings')), attr('gen_ai.response.model', sv('controlled-model')),
      attr('gen_ai.usage.input_tokens', iv(0)), attr('gen_ai.usage.output_tokens', iv(0)), attr('gen_ai.usage.completion_tokens', iv(1)),
    ] })]));
    const result = buildSummary(embedding, prices.map(price => ({ ...price, outputPerMTok: 0 })));
    expect(result.modelUsage[0]!.missingOutputCalls).toBe(1);
    expect(result.costReport.rows[0]!.result).toMatchObject({ status: 'unpriced', reason: 'conflicting-usage' });
  });

  it('retains an unusable reasoning/total breakdown while pricing agreed inclusive operands', () => {
    const result = explainSpanCost({ responseModel: 'controlled-model', provider: 'example', usage: {
      inputTokens: 1_000_000, outputTokens: 1_000_000, conflictingFields: ['reasoningOutputTokens'], invalidFields: ['totalTokens'],
    } }, prices);
    expect(result.status).toBe('priced');
    if (result.status === 'priced') {
      expect(result.costUsd).toBe(2);
      expect(result.assumptions.join(' ')).toContain('not operands');
    }
  });
});
