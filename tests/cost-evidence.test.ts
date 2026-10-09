import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCostReport, buildSummary, compareTraces, DEFAULT_PRICE_TABLE, explainSpanCost, findPriceEntry, parseTraceText } from '../src/core/index.js';
import type { GenAiInfo, PriceEntry } from '../src/core/index.js';

const rate: PriceEntry = { id: 'base', matchModel: 'gpt-5', provider: 'openai', inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, sourceUrl: '', sourceDate: '2026-10-09' };
const genai: GenAiInfo = { provider: 'openai', responseModel: 'gpt-5', usage: { inputTokens: 1000, outputTokens: 100 } };
const fixture = (name: string) => parseTraceText(readFileSync(new URL(`./fixtures/census/${name}.json`, import.meta.url), 'utf8'));

describe('price identity, independent of table order', () => {
  it.each(['gpt-5-nano', 'gpt-5-pro', 'gpt-5.1', 'gpt-5-chat-latest', 'my-gpt-5-deployment', 'ft:gpt-5:org:custom', 'gpt-5-2025-02-30', 'gpt-5-2025-13-01'])('does not price %s at the gpt-5 rate', (responseModel) => {
    expect(explainSpanCost({ ...genai, responseModel }, [rate])).toMatchObject({ status: 'unpriced', reason: 'no-price' });
  });
  it.each(['gpt-5-2025-08-07', 'GPT-5-20250807'])('accepts calendar snapshot %s, disclosing the base-rate assumption', (responseModel) => {
    const cost = explainSpanCost({ ...genai, responseModel }, [rate]);
    expect(cost).toMatchObject({ status: 'priced', match: 'snapshot' });
    if (cost.status === 'priced') expect(cost.assumptions.join(' ')).toContain('historical prices may differ');
    expect(findPriceEntry({ ...genai, responseModel }, [{ ...rate, matchMode: 'exact' }])).toBeUndefined();
  });
  it('lets a snapshot-specific entry override the base without depending on row order', () => {
    const snapshot = { ...rate, id: 'snapshot', matchModel: 'gpt-5-2025-08-07', inputPerMTok: 9 };
    for (const table of [[rate, snapshot], [snapshot, rate]]) {
      expect(findPriceEntry({ ...genai, responseModel: snapshot.matchModel }, table)?.id).toBe('snapshot');
    }
  });
  it.each(['azure', 'azure.ai.openai', 'aws.bedrock', 'gateway.openai'])('does not infer the OpenAI rate for provider %s', (provider) => {
    expect(explainSpanCost({ ...genai, provider }, [rate])).toMatchObject({ status: 'unpriced', reason: 'provider-mismatch' });
  });
  it('accepts a known endpoint alias and prefers a scoped rate over explicit any-provider pricing', () => {
    const unscoped = { ...rate, id: 'unscoped', provider: '' };
    for (const table of [[rate, unscoped], [unscoped, rate]]) {
      expect(findPriceEntry({ ...genai, provider: 'openai.responses' }, table)?.id).toBe('base');
    }
    expect(explainSpanCost({ ...genai, provider: 'azure' }, [unscoped])).toMatchObject({ status: 'priced', assumptions: expect.arrayContaining(['This price entry explicitly applies to any provider.']) });
  });
  it('leaves equal-rank rates ambiguous even when their prices are identical', () => {
    expect(explainSpanCost(genai, [rate, { ...rate, id: 'another' }])).toMatchObject({ status: 'unpriced', reason: 'ambiguous-price' });
    expect(explainSpanCost({ ...genai, provider: undefined }, [rate, { ...rate, provider: 'azure' }])).toMatchObject({ status: 'unpriced', reason: 'ambiguous-price' });
  });
  it('does not try the request model when a recorded response model has no price', () => {
    expect(findPriceEntry({ ...genai, requestModel: 'gpt-5', responseModel: 'different-model' }, [rate])).toBeUndefined();
  });
});

describe('recorded instrumentation receipts', () => {
  it('corrects the captured nano stream and accounts for every token exactly once', () => {
    const trace = fixture('vercel-ai-sdk-6-openai-responses-stream');
    const report = buildCostReport(trace, DEFAULT_PRICE_TABLE);
    expect(report).toMatchObject({ pricedCalls: 1, unpricedCalls: 0, excludedSpans: 1 });
    expect(report.estimatedCostUsd).toBeCloseTo(0.00081907, 12);
    const call = report.rows.find((row) => row.kind === 'llm')!;
    expect(call.result.status).toBe('priced');
    if (call.result.status !== 'priced') return;
    expect(call.result.components.map((part) => part.tokens)).toEqual([3103, 2944, 0, 1623]);
    expect(call.result.entry.sourceUrl).toBe('https://developers.openai.com/api/docs/models/gpt-5-nano');
    expect(call.usage?.reasoningOutputTokens).toBe(1408); // already inside the 1623; no fifth charge
    expect(report.rows.find((row) => row.kind === 'chain')?.result.status).toBe('excluded');
    expect(buildSummary(trace, DEFAULT_PRICE_TABLE).totalCostUsd).toBe(report.estimatedCostUsd);
    const comparison = compareTraces(trace, trace, DEFAULT_PRICE_TABLE);
    expect(comparison.metrics.costUsd.baseline.value).toBe(report.estimatedCostUsd);
    expect(comparison.costEvidence.baseline).toEqual(report);
    const exported = JSON.stringify(report);
    expect(exported).not.toContain('inputMessages');
    expect(exported).not.toContain('ai.prompt');
    expect(call.usageAttributes['ai.usage.cachedInputTokens']).toBe(2944);
  });
  it('corrects an independent OpenLLMetry capture of the same model', () => {
    const trace = fixture('openllmetry-openai-reasoning');
    // 11 input tokens at .05/MTok; 228 output (including 192 reasoning) at .4/MTok.
    expect(buildCostReport(trace, DEFAULT_PRICE_TABLE).knownCostUsd).toBeCloseTo(0.00009175, 12);
  });
  it('preserves an unpriced embedding call, and supports an explicit input-only rate', () => {
    const trace = fixture('openinference-litellm-embedding');
    const report = buildCostReport(trace, DEFAULT_PRICE_TABLE);
    expect(report).toMatchObject({ pricedCalls: 0, unpricedCalls: 1, knownCostUsd: null, estimatedCostUsd: null });
    expect(buildSummary(trace, DEFAULT_PRICE_TABLE)).toMatchObject({ uncostedCalls: 1, modelUsage: [{ inputTokens: 2, outputTokens: 0, calls: 1 }] });
    const rates = [{ ...rate, matchModel: 'text-embedding-ada-002-v2', provider: '', inputPerMTok: 1, outputPerMTok: 0 }]; // illustrative user rate, not a provider quote
    expect(buildCostReport(trace, rates).estimatedCostUsd).toBe(0.000002);
    expect(compareTraces(trace, trace, rates).metrics.costUsd.baseline).toEqual({ value: 0.000002, missing: 0 });
    expect(explainSpanCost(trace.spans[0]!.genai!, [{ ...rates[0]!, outputPerMTok: 1 }], 'embedding')).toMatchObject({ reason: 'unsupported-billing' });
  });
  it('does not label a same-model partial subtotal as fully priced', () => {
    const trace = fixture('vercel-ai-sdk-6-openai-responses-stream');
    const call = trace.spans.find((span) => span.agentKind === 'llm')!;
    trace.spans.push({ ...call, spanId: 'missing', genai: { ...call.genai, usage: undefined }, children: [] });
    const summary = buildSummary(trace, DEFAULT_PRICE_TABLE);
    expect(summary.modelUsage[0]).toMatchObject({ calls: 2, uncostedCalls: 1, missingInputCalls: 1, missingOutputCalls: 1 });
    expect(summary.costReport.estimatedCostUsd).toBeNull();
    expect(summary.costReport.knownCostUsd).toBeCloseTo(0.00081907, 12);
  });
});

describe('explanations rather than invented zero charges', () => {
  it.each([
    [{ ...genai, usage: undefined }, 'missing-input'],
    [{ ...genai, usage: { inputTokens: 10 } }, 'missing-output'],
    [{ ...genai, usage: { inputTokens: 10, outputTokens: 2, invalidFields: ['cacheReadTokens'] } }, 'invalid-usage'],
    [{ ...genai, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 11 } }, 'inconsistent-cache'],
  ] as const)('explains incomplete usage', (info, reason) => {
    expect(explainSpanCost(info as GenAiInfo, [rate])).toMatchObject({ status: 'unpriced', reason });
  });
  it('makes the fallback for a missing cache rate inspectable', () => {
    const cost = explainSpanCost({ ...genai, usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 10 } }, [{ ...rate, cacheReadPerMTok: undefined }]);
    expect(cost.status).toBe('priced');
    if (cost.status !== 'priced') return;
    expect(cost.components[1]).toMatchObject({ tokens: 10, perMillionUsd: 1.25, rateSource: 'input' });
    expect(cost.assumptions).toContain('No cache-read rate supplied; using the ordinary input rate.');
  });
});
