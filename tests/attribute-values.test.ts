import { describe, expect, it } from 'vitest';
import { decodeAnyValue, parseOtlpJson } from '../src/core/otlp-parser.js';
import { buildCostReport } from '../src/core/cost-report.js';
import { flattenTrace, restoreTrace } from '../src/web/trace-transfer.js';
import { attr, fakeSpan, otlpDoc, sv } from './fixtures.js';
import type { PriceEntry } from '../src/core/pricing.js';

const prices: PriceEntry[] = [{ id: 'fixture', matchModel: 'fixture', provider: '', inputPerMTok: 1,
  outputPerMTok: 1, sourceUrl: 'https://example.com/synthetic-rates', sourceDate: '2026-10-10' }];
function usage(value: unknown, extra: Array<{ key: string; value: unknown }> = []) {
  return parseOtlpJson(otlpDoc([fakeSpan({ spanId: 'a', startNs: 0, endNs: 1, attributes: [
    attr('gen_ai.operation.name', sv('chat')), attr('gen_ai.request.model', sv('fixture')),
    attr('gen_ai.usage.input_tokens', value), attr('gen_ai.usage.output_tokens', { intValue: '0' }), ...extra,
  ] })]));
}

describe('typed attribute measurements', () => {
  it.each([
    { intValue: '' }, { intValue: ' ' }, { intValue: '0x10' }, { intValue: true },
    { intValue: '1.00000000000000001' }, { intValue: '9223372036854775808' },
    { intValue: '-9223372036854775809' }, { intValue: 9007199254740992 },
    { intValue: '1e100000000000' }, { intValue: '1e-100000000000' },
    { doubleValue: '' }, { doubleValue: ' ' }, { doubleValue: '0x10' }, { doubleValue: '1e400' },
    { stringValue: 10 }, { intValue: '10', doubleValue: 0 }, { intValue: '10', int_value: '0' }, 10,
  ])('never prices a malformed attribute %j', value => {
    const parsed = restoreTrace(structuredClone(flattenTrace(usage(value))));
    expect(parsed.spans[0]!.attributes['gen_ai.usage.input_tokens']).toEqual({ invalidAnyValue: value });
    expect(parsed.spans[0]!.genai?.usage?.invalidFields).toEqual(['inputTokens']);
    const cost = buildCostReport(parsed, prices);
    expect(cost.estimatedCostUsd).toBeNull();
    expect(cost.unpricedCalls).toBe(1);
    expect(parsed.warnings).toEqual([expect.objectContaining({ spanId: 'a', traceId: 'aa'.repeat(16),
      message: expect.stringContaining('gen_ai.usage.input_tokens') })]);
  });

  it.each([
    [{ intValue: '10' }, 10], [{ int_value: '1e2' }, 100], [{ intValue: '+0010' }, 10],
    [{ intValue: '1000e-2' }, 10], [{ intValue: '10.000' }, 10], [{ intValue: '-0' }, 0],
    [{ doubleValue: '10' }, 10], [{ double_value: '1.0e2' }, 100], [{ doubleValue: 0 }, 0],
  ])('prices supported numeric form %j as %s tokens', (value, tokens) => {
    const parsed = usage(value);
    expect(parsed.spans[0]!.genai?.usage?.inputTokens).toBe(tokens);
    expect(buildCostReport(parsed, prices).estimatedCostUsd).toBe(Number(tokens) / 1e6);
    expect(parsed.warnings).toEqual([]);
  });

  it.each(['9223372036854775807', '-9223372036854775808', '9e18'])('preserves valid large int64 %s without claiming safe numeric precision', value => {
    expect(decodeAnyValue({ intValue: value })).toBe(value);
    expect(buildCostReport(usage({ intValue: value }), prices).estimatedCostUsd).toBeNull();
  });

  it.each(['NaN', 'Infinity', '-Infinity'])('keeps nonfinite Protobuf spelling %s in JSON evidence', value => {
    const trace = usage({ doubleValue: value });
    expect(JSON.parse(JSON.stringify(trace.spans[0]!.attributes))['gen_ai.usage.input_tokens']).toBe(value);
    expect(buildCostReport(trace, prices).estimatedCostUsd).toBeNull();
    expect(trace.warnings).toEqual([]);
  });

  it('treats null fields as unset and does not reinterpret text booleans', () => {
    expect(decodeAnyValue({ boolValue: null })).toBeNull();
    expect(decodeAnyValue({ intValue: null, doubleValue: '10' })).toBe(10);
    expect(decodeAnyValue({ boolValue: false })).toBe(false);
    expect(decodeAnyValue({ boolValue: 'false' })).toEqual({ invalidAnyValue: { boolValue: 'false' } });
  });

  it('keeps duplicate values in original order without pricing the last one', () => {
    const trace = usage({ intValue: '1000' }, [attr('gen_ai.usage.input_tokens', { intValue: '0' })]);
    expect(trace.spans[0]!.attributes['gen_ai.usage.input_tokens']).toEqual({
      duplicateAttributeValues: [{ intValue: '1000' }, { intValue: '0' }],
    });
    expect(buildCostReport(trace, prices).estimatedCostUsd).toBeNull();
    expect(trace.warnings[0]!.message).toContain('duplicate attribute key');
  });
});

it('scopes nested resource, span, event and link diagnostics to their affected traces', () => {
  const control = fakeSpan({ spanId: 'control', traceId: 'bb', startNs: 0, endNs: 1 });
  const affected = fakeSpan({ spanId: 'affected', traceId: 'aa', startNs: 0, endNs: 1,
    attributes: [attr('nested', { kvlist_value: { values: [attr('items', { arrayValue: { values: [
      { int_value: '' }, { bool_value: false }, null,
    ] } })] } })],
    events: [{ name: 'event', attributes: [attr('bad', { intValue: ' ' })] }],
  });
  const resource = otlpDoc([{ ...affected, links: [{ traceId: 'bb', spanId: 'control', attributes: [attr('bad', { doubleValue: '' })] }] }],
    [attr('resource.bad', { boolValue: 'false' })]).resourceSpans[0]!;
  const doc = { resourceSpans: [resource, ...otlpDoc([control]).resourceSpans] };
  const trace = parseOtlpJson(doc, { traceId: 'aa' });
  expect(trace.warnings).toHaveLength(5);
  expect(trace.warnings.every(w => w.traceId === 'aa')).toBe(true);
  expect(trace.warnings.find(w => w.message.startsWith('resource.'))?.spanId).toBeUndefined();
  expect(trace.spans[0]!.attributes.nested).toEqual({ items: [{ invalidAnyValue: { int_value: '' } }, false, { invalidAnyValue: null }] });
  expect(parseOtlpJson(doc, { traceId: 'bb' }).warnings).toEqual([]);
});

it.each(['float64', 'int64'])('does not let Jaeger %s conversion invent zero before validation', type => {
  const trace = parseOtlpJson({ data: [{ traceID: 'aa', spans: [{ spanID: 'a', operationName: 'chat', startTime: 1, duration: 1,
    tags: [{ key: 'gen_ai.operation.name', type: 'string', value: 'chat' },
      { key: 'gen_ai.request.model', type: 'string', value: 'fixture' },
      { key: 'gen_ai.usage.input_tokens', type, value: '' },
      { key: 'gen_ai.usage.output_tokens', type: 'int64', value: 0 }],
  }] }] });
  expect(buildCostReport(trace, prices).estimatedCostUsd).toBeNull();
  expect(trace.warnings).toHaveLength(1);
});
