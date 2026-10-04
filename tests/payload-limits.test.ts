import { describe, expect, it } from 'vitest';
import { decodeAnyValue, parseOtlpJson, parseTraceText, TraceParseError } from '../src/core/otlp-parser.js';
import { assertPayloadDepth, MAX_PAYLOAD_DEPTH } from '../src/core/payload-depth.js';
import { attr, fakeSpan, otlpDoc, sv } from './fixtures.js';

const span = (attributes: ReturnType<typeof attr>[]) => fakeSpan({ spanId: 'a', startNs: 0, endNs: 1, attributes });
const nested = (levels: number): string => '['.repeat(levels) + '"leaf"' + ']'.repeat(levels);

describe('bounded payloads', () => {
  it('accepts the boundary and rejects one further object before recursive consumers run', () => {
    expect(() => assertPayloadDepth(JSON.parse(nested(MAX_PAYLOAD_DEPTH)))).not.toThrow();
    expect(() => assertPayloadDepth(JSON.parse(nested(MAX_PAYLOAD_DEPTH + 1)))).toThrow(TraceParseError);
  });

  it('rejects a small, deeply nested AnyValue with an actionable error', () => {
    const value = '{"arrayValue":{"values":['.repeat(6000) + '{"stringValue":"leaf"}' + ']}}'.repeat(6000);
    const text = JSON.stringify(otlpDoc([span([attr('payload', 'REPLACE')])])).replace('"REPLACE"', value);
    expect(text.length).toBeLessThan(200_000);
    expect(() => parseTraceText(text)).toThrow('128 nested object/array levels');
    expect(() => decodeAnyValue(JSON.parse(value))).toThrow(TraceParseError);
  });

  for (const key of ['gen_ai.tool.call.arguments', 'gen_ai.tool.call.result', 'tool.parameters']) {
    it(`bounds JSON embedded in ${key}`, () => {
      const attributes = [attr('gen_ai.operation.name', sv('execute_tool')), attr('openinference.span.kind', sv('TOOL')), attr(key, sv(nested(6000)))];
      expect(() => parseOtlpJson(otlpDoc([span(attributes)]))).toThrow(TraceParseError);
    });
  }

  for (const key of ['gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.system_instructions']) {
    it(`bounds JSON embedded in ${key}`, () => {
      const message = '[{"role":"assistant","parts":[{"type":"tool_call","arguments":' + nested(6000) + '}]}]';
      expect(() => parseOtlpJson(otlpDoc([span([attr(key, sv(message))])]))).toThrow(TraceParseError);
    });
  }

  it('still retains non-JSON tool payloads verbatim', () => {
    const trace = parseOtlpJson(otlpDoc([span([attr('gen_ai.tool.call.arguments', sv('not JSON'))])]));
    expect(trace.spans[0]!.genai!.toolArguments).toBe('not JSON');
  });

  it('also guards Jaeger objects before tag serialization', () => {
    const doc = { data: [{ traceID: 'a', spans: [], processes: { p: { tags: [{ key: 'payload', value: JSON.parse(nested(6000)) }] } } }] };
    expect(() => parseOtlpJson(doc)).toThrow(TraceParseError);
  });
});

describe('physical JSON Lines locations', () => {
  const valid = JSON.stringify(otlpDoc([span([])]));
  for (const newline of ['\n', '\r\n', '\r']) {
    it(`counts blank lines with ${JSON.stringify(newline)} separators`, () => {
      const text = ['', '', valid, '  ', '{"resourceSpans":[', ''].join(newline);
      expect(parseTraceText(text).warnings[0]!.message).toContain('last line (5)');
      expect(() => parseTraceText(text + newline + valid)).toThrow('line 5:');
      expect(() => parseTraceText(['', valid, '', '42'].join(newline))).toThrow('Line 4 is not an OTLP/JSON trace export');
    });
  }
});
