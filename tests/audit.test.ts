import { describe, expect, it } from 'vitest';
import { buildSummary, compareTraces, decodeAnyValue, estimateSpanCost, findPriceEntry, isPriceEntry, parseOtlpJson } from '../src/core/index.js';
import type { PriceEntry, TokenUsage } from '../src/core/index.js';
import { flattenVisible } from '../src/web/tree-flatten.js';
import { attr, dv, fakeSpan, iv, otlpDoc, sv } from './fixtures.js';

const price: PriceEntry = { id: 'known', matchModel: 'known', provider: 'test', inputPerMTok: 2, outputPerMTok: 4, sourceUrl: '', sourceDate: '' };
const rawSpan = (attributes: Array<{ key: string; value: unknown }>) => fakeSpan({ spanId: 'a', startNs: 100, endNs: 200, attributes });
const parse = (attributes: Array<{ key: string; value: unknown }>) => parseOtlpJson(otlpDoc([rawSpan(attributes)]));

describe('untrusted pricing and token accounting', () => {
  it.each([null, {}, { ...price, matchModel: '' }, { ...price, matchModel: '  ' }, { ...price, inputPerMTok: -1 }, { ...price, outputPerMTok: NaN }, { ...price, cacheWritePerMTok: Infinity }])('ignores malformed price entry %j', (entry) => {
    expect(isPriceEntry(entry)).toBe(false);
    expect(findPriceEntry({ requestModel: 'unknown' }, [entry] as PriceEntry[])).toBeUndefined();
  });
  it('allows explicit zero prices for a named model', () => {
    expect(estimateSpanCost({ requestModel: 'known', usage: { inputTokens: 100, outputTokens: 20 } }, [{ ...price, inputPerMTok: 0, outputPerMTok: 0 }])?.costUsd).toBe(0);
  });
  it.each<TokenUsage>([
    { inputTokens: 10 }, { outputTokens: 10 }, { inputTokens: -1, outputTokens: 1 },
    { inputTokens: 1.5, outputTokens: 1 }, { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 1 },
    { inputTokens: 10, outputTokens: 1, cacheWriteTokens: NaN },
    { inputTokens: 10, outputTokens: 1, cacheReadTokens: 6, cacheWriteTokens: 6 },
  ])('keeps incomplete or invalid usage unknown: %j', (usage) => {
    expect(estimateSpanCost({ requestModel: 'known', usage }, [price])).toBeUndefined();
  });
  it('prices fresh input, cache reads, cache writes and output independently', () => {
    const cost = estimateSpanCost({ requestModel: 'known', usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 300_000, cacheWriteTokens: 200_000 } }, [{ ...price, cacheReadPerMTok: 0.5, cacheWritePerMTok: 3 }]);
    expect(cost?.costUsd).toBeCloseTo(1 + 0.15 + 0.6 + 0.4);
  });
  it('classifies legacy model-only spans and counts them in both summary and comparison', () => {
    const trace = parse([attr('gen_ai.response.model', sv('known')), attr('gen_ai.usage.prompt_tokens', iv(100)), attr('gen_ai.usage.completion_tokens', iv(20))]);
    expect(trace.spans[0]!.agentKind).toBe('llm');
    expect(buildSummary(trace, [price]).modelUsage[0]).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 20 });
    const cost = compareTraces(trace, trace, [price]).metrics.costUsd.baseline;
    expect(cost.value).toBeCloseTo(0.00028, 10);
    expect(cost.missing).toBe(0);
  });
  it('merges mixed usage field by field, with OTel precedence only for fields it supplies', () => {
    const trace = parse([attr('openinference.span.kind', sv('LLM')), attr('llm.model_name', sv('known')), attr('llm.token_count.prompt', iv(100)), attr('llm.token_count.completion', iv(20)), attr('gen_ai.usage.input_tokens', iv(200))]);
    expect(trace.spans[0]!.agentKind).toBe('llm');
    expect(trace.spans[0]!.genai?.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    expect(buildSummary(trace, [price]).uncostedCalls).toBe(0);
  });
  it.each([dv(-1), dv(1.5), sv('bad'), iv(Number.MAX_SAFE_INTEGER + 1)])('does not turn invalid optional cache usage into zero: %j', (value) => {
    const trace = parse([attr('gen_ai.request.model', sv('known')), attr('gen_ai.usage.input_tokens', iv(100)), attr('gen_ai.usage.output_tokens', iv(20)), attr('gen_ai.usage.cache_read.input_tokens', value)]);
    expect(buildSummary(trace, [price]).totalCostUsd).toBeUndefined();
    expect(compareTraces(trace, trace, [price]).metrics.costUsd.delta).toBeNull();
    expect(compareTraces(trace, trace, [price]).metrics.inputTokens.delta).toBe(0);
  });
  it('reads cache writes under the spec name gen_ai.usage.cache_creation.input_tokens, and the older cache_write name', () => {
    for (const key of ['gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_write.input_tokens']) {
      const trace = parse([attr('gen_ai.request.model', sv('known')), attr('gen_ai.usage.input_tokens', iv(1_000_000)), attr('gen_ai.usage.output_tokens', iv(0)), attr(key, iv(400_000))]);
      expect(trace.spans[0]!.genai?.usage).toMatchObject({ inputTokens: 1_000_000, cacheWriteTokens: 400_000 });
      // 600k at the input rate plus 400k at the cache-write rate, not 1M at the input rate.
      const cost = buildSummary(trace, [{ ...price, cacheWritePerMTok: price.inputPerMTok * 1.25 }]).totalCostUsd!;
      expect(cost).toBeCloseTo(0.6 * price.inputPerMTok + 0.4 * price.inputPerMTok * 1.25, 10);
    }
  });
  it('reports invalid required token counts as missing independently', () => {
    const trace = parse([attr('gen_ai.request.model', sv('known')), attr('gen_ai.usage.input_tokens', dv(-5)), attr('gen_ai.usage.output_tokens', iv(20))]);
    const report = compareTraces(trace, trace, [price]);
    expect(report.metrics.inputTokens.baseline).toEqual({ value: 0, missing: 1 });
    expect(report.metrics.outputTokens.baseline).toEqual({ value: 20, missing: 0 });
    expect(buildSummary(trace, [price]).modelUsage[0]).toMatchObject({ inputTokens: 0, missingInputCalls: 1, outputTokens: 20, missingOutputCalls: 0 });
  });
  it.each([[dv(-1), iv(100), 0], [iv(100), dv(-1), 1]])('preserves validity when merging explicitly supplied usage fields', (oiInput, otelInput, uncostedCalls) => {
    const trace = parse([attr('openinference.span.kind', sv('LLM')), attr('llm.model_name', sv('known')), attr('llm.token_count.prompt', oiInput), attr('llm.token_count.completion', iv(20)), attr('gen_ai.usage.input_tokens', otelInput)]);
    expect(buildSummary(trace, [price]).uncostedCalls).toBe(uncostedCalls);
  });
});

describe('timestamp and attribute integrity', () => {
  it.each(['garbage', '', '-1', '0x10', '1.5', '18446744073709551616', 1.5, 1e18, null, undefined])('skips invalid timestamps with a warning: %j', (startTimeUnixNano) => {
    const valid = rawSpan([]);
    const trace = parseOtlpJson(otlpDoc([valid, { ...valid, spanId: 'bad', startTimeUnixNano }]));
    expect(trace.spans).toHaveLength(1);
    expect(trace.minStartNs).toBe(100n);
    expect(trace.warnings).toEqual([expect.objectContaining({ spanId: 'bad', message: expect.stringContaining('invalid timestamps') })]);
  });
  it('accepts precise decimal timestamps and safe numeric timestamps', () => {
    const trace = parseOtlpJson(otlpDoc([{ ...rawSpan([]), startTimeUnixNano: '1800000000000000000', endTimeUnixNano: '1800000000000000001' }]));
    expect(trace.spans[0]!.durationNs).toBe(1n);
    expect(parseOtlpJson(otlpDoc([{ ...rawSpan([]), startTimeUnixNano: 0, endTimeUnixNano: 100 }])).spans[0]!.durationNs).toBe(100n);
  });
  it('keeps __proto__ attributes as data without inheriting injected models', () => {
    const injected = { kvlistValue: { values: [attr('gen_ai.request.model', sv('injected'))] } };
    const trace = parse([attr('__proto__', injected), attr('gen_ai.operation.name', sv('__proto__'))]);
    expect(Object.getPrototypeOf(trace.spans[0]!.attributes)).toBeNull();
    expect(trace.spans[0]!.agentKind).toBe('other');
    expect(trace.spans[0]!.genai?.requestModel).toBeUndefined();
    const nested = decodeAnyValue({ kvlistValue: { values: [attr('__proto__', injected)] } });
    expect(Object.getPrototypeOf(nested)).toBeNull();
    expect(Object.hasOwn(nested as object, '__proto__')).toBe(true);
  });
  it('flattens a deeply nested trace without stack overflow, respecting collapse', () => {
    const spans = Array.from({ length: 10_000 }, (_, i) => fakeSpan({ spanId: String(i), parentSpanId: i ? String(i - 1) : undefined, startNs: 0, endNs: 100 }));
    const trace = parseOtlpJson(otlpDoc(spans));
    expect(flattenVisible(trace, new Set()).at(-1)?.spanId).toBe('9999');
    expect(flattenVisible(trace, new Set(['1'])).map((s) => s.spanId)).toEqual(['0', '1']);
  });
});

describe('possible retries', () => {
  const tool = (id: string, start: number, end: number, statusCode = 0) => fakeSpan({ spanId: id, name: 'search', startNs: start, endNs: end, statusCode, attributes: [attr('gen_ai.operation.name', sv('execute_tool'))] });
  it('does not count successful repetitions or overlapping failures as retries', () => {
    for (const spans of [[tool('a', 0, 10), tool('b', 10, 20)], [tool('a', 0, 20, 2), tool('b', 10, 30)]]) {
      expect(buildSummary(parseOtlpJson(otlpDoc(spans)), []).retryCount).toBe(0);
    }
  });
  it('counts a new attempt after a failed tool finishes', () => {
    expect(buildSummary(parseOtlpJson(otlpDoc([tool('a', 0, 10, 2), tool('b', 10, 20)])), []).retryCount).toBe(1);
  });
});
