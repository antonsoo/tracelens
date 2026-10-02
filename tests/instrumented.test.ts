// Traces written by real instrumentation libraries (tests/fixtures/instrumented/, made by
// scripts/instrumented-traces/): the same two agent turns, one calling a tool and one
// answering, through the Anthropic and the OpenAI SDK, instrumented once with OpenInference
// (openinference-instrumentation-anthropic 3.0.1, -openai 0.1.63) and once with OpenLLMetry
// 0.62.4, which writes the OpenTelemetry GenAI conventions. The conversation is made up; the
// spans are what the libraries wrote.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseOtlpJson, parseTraceText } from '../src/core/otlp-parser.js';
import { buildSummary } from '../src/core/summary.js';
import { DEFAULT_PRICE_TABLE } from '../src/core/pricing.js';
import type { NormalizedMessage, ParsedSpan } from '../src/core/types.js';

const DIR = fileURLToPath(new URL('./fixtures/instrumented/', import.meta.url));

/** The LLM spans of one SDK's run in a fixture, in call order. */
function llmSpans(file: string, spanName: string): ParsedSpan[] {
  const text = readFileSync(DIR + file, 'utf8');
  const listing = parseTraceText(text).traces ?? [];
  const all = listing.flatMap((t) => parseTraceText(text, { traceId: t.traceId }).spans);
  return all.filter((s) => s.name === spanName).sort((a, b) => Number(a.startTimeUnixNano - b.startTimeUnixNano));
}

const TOOL_CALL = { type: 'tool_call', name: 'get_weather', arguments: { city: 'Paris' } };
const ANSWER: NormalizedMessage = { role: 'assistant', parts: [{ type: 'text', content: 'It is 18°C and sunny in Paris.' }] };

describe('OpenInference, as its instrumentation writes it', () => {
  const [anthropicCall, anthropicAnswer] = llmSpans('openinference.json', 'messages.create');
  const [openaiCall, openaiAnswer] = llmSpans('openinference.json', 'ChatCompletion');

  it('reads an assistant turn written as contents: its text and its tool call', () => {
    // The Anthropic instrumentation never writes message.content for an assistant turn, only
    // message.contents.N.*: until 0.3.1 every such turn was an empty bubble.
    expect(anthropicCall!.convention).toBe('openinference');
    expect(anthropicCall!.agentKind).toBe('llm');
    expect(anthropicCall!.genai?.outputMessages).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: "I'll check the weather." }, { ...TOOL_CALL, id: 'toolu_1' }] },
    ]);
    expect(anthropicAnswer!.genai?.outputMessages).toEqual([ANSWER]);
  });

  it('lists a tool call once although the span carries it twice', () => {
    const keys = Object.keys(anthropicCall!.attributes);
    expect(keys).toContain('llm.output_messages.0.message.tool_calls.0.tool_call.function.name');
    expect(keys).toContain('llm.output_messages.0.message.contents.1.tool_call.function.name');
    const calls = anthropicCall!.genai!.outputMessages![0]!.parts.filter((p) => p.type === 'tool_call');
    expect(calls).toHaveLength(1);
  });

  it('reads a tool call that has no text beside it', () => {
    expect(openaiCall!.genai?.outputMessages).toEqual([{ role: 'assistant', parts: [{ ...TOOL_CALL, id: 'call_1' }] }]);
    expect(openaiAnswer!.genai?.outputMessages).toEqual([ANSWER]);
  });

  it('shows the whole thread of the second call, tool result included', () => {
    expect(anthropicAnswer!.genai?.inputMessages).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'You are a weather assistant.' }] },
      { role: 'user', parts: [{ type: 'text', content: "What's the weather in Paris?" }] },
      { role: 'assistant', parts: [{ type: 'text', content: "I'll check the weather." }, { ...TOOL_CALL, id: 'toolu_1' }] },
      { role: 'user', parts: [{ type: 'tool_call_response', id: 'toolu_1', response: '18°C, sunny' }] },
    ]);
    expect(openaiAnswer!.genai?.inputMessages?.slice(2)).toEqual([
      { role: 'assistant', parts: [{ ...TOOL_CALL, id: 'call_1' }] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call_1', response: '18°C, sunny' }] },
    ]);
  });

  it('reads the request options and the finish reason', () => {
    expect(anthropicCall!.genai).toMatchObject({ provider: 'anthropic', requestModel: 'claude-opus-5-5', maxTokens: 256, finishReasons: ['tool_use'] });
    expect(openaiAnswer!.genai).toMatchObject({ provider: 'openai', requestModel: 'gpt-6-sol', finishReasons: ['stop'] });
  });

  it('leaves no assistant message empty', () => {
    for (const span of [anthropicCall!, anthropicAnswer!, openaiCall!, openaiAnswer!]) {
      for (const message of [...(span.genai?.inputMessages ?? []), ...(span.genai?.outputMessages ?? [])]) {
        expect(message.parts.some((p) => p.content !== undefined || p.name !== undefined || p.response !== undefined)).toBe(true);
      }
    }
  });
});

describe('OpenLLMetry (gen_ai.*), as its instrumentation writes it', () => {
  const [anthropicCall, anthropicAnswer] = llmSpans('openllmetry.json', 'anthropic.chat');
  const [openaiCall] = llmSpans('openllmetry.json', 'openai.chat');

  it('reads the same turns', () => {
    expect(anthropicCall!.convention).toBe('otel-genai');
    expect(anthropicCall!.genai?.outputMessages).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: "I'll check the weather." }, { ...TOOL_CALL, id: 'toolu_1' }] },
    ]);
    expect(anthropicAnswer!.genai?.outputMessages).toEqual([ANSWER]);
    expect(openaiCall!.genai?.outputMessages).toEqual([{ role: 'assistant', parts: [{ ...TOOL_CALL, id: 'call_1' }] }]);
  });

  it('gives system instructions, a list of parts, the system role', () => {
    // gen_ai.system_instructions is [{"type": "text", "content": ...}]: parts, with no role.
    expect(anthropicCall!.attributes['gen_ai.system_instructions']).toBe('[{"type": "text", "content": "You are a weather assistant."}]');
    expect(anthropicCall!.genai?.systemInstructions).toEqual([{ role: 'system', parts: [{ type: 'text', content: 'You are a weather assistant.' }] }]);
  });
});

describe('the two conventions agree on what a run cost', () => {
  // Both report input tokens with the cached ones included (420 fresh + 300 read from cache
  // for Anthropic, 420 of which 300 cached for OpenAI), 37 out.
  it.each([
    ['openinference.json', 'messages.create', 720],
    ['openllmetry.json', 'anthropic.chat', 720],
    ['openinference.json', 'ChatCompletion', 420],
    ['openllmetry.json', 'openai.chat', 420],
  ])('%s %s', (file, name, input) => {
    for (const span of llmSpans(file, name)) {
      expect(span.genai?.usage).toMatchObject({ inputTokens: input, outputTokens: 37, cacheReadTokens: 300 });
    }
  });

  it('prices the Anthropic runs the same under either convention', () => {
    const cost = (file: string): number | undefined => {
      const text = readFileSync(DIR + file, 'utf8');
      const anthropicTrace = (parseTraceText(text).traces ?? []).map((t) => parseTraceText(text, { traceId: t.traceId })).find((t) => t.spans.some((s) => s.genai?.provider === 'anthropic'))!;
      return buildSummary(anthropicTrace, DEFAULT_PRICE_TABLE).totalCostUsd;
    };
    expect(cost('openinference.json')).toBeGreaterThan(0);
    expect(cost('openinference.json')).toBeCloseTo(cost('openllmetry.json')!, 10);
  });
});

describe('OpenInference shapes not in the fixtures', () => {
  /** A one-span OTLP document with these string attributes, parsed like any file. */
  const span = (attributes: Record<string, string>): ParsedSpan => {
    const all = { 'openinference.span.kind': 'LLM', ...attributes };
    const doc = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: '0af7651916cd43dd8448eb211c80319c',
                  spanId: 'b7ad6b7169203331',
                  name: 'llm',
                  startTimeUnixNano: '1',
                  endTimeUnixNano: '2',
                  attributes: Object.entries(all).map(([key, value]) => ({ key, value: { stringValue: value } })),
                },
              ],
            },
          ],
        },
      ],
    };
    return parseOtlpJson(doc).spans[0]!;
  };

  it('reads an image part and a legacy function call', () => {
    const s = span({
      'llm.input_messages.0.message.role': 'user',
      'llm.input_messages.0.message.contents.0.message_content.type': 'text',
      'llm.input_messages.0.message.contents.0.message_content.text': 'What is this?',
      'llm.input_messages.0.message.contents.1.message_content.type': 'image',
      'llm.input_messages.0.message.contents.1.message_content.image.image.url': 'https://example.com/cat.png',
      'llm.output_messages.0.message.role': 'assistant',
      'llm.output_messages.0.message.function_call_name': 'describe',
      'llm.output_messages.0.message.function_call_arguments_json': '{"subject": "cat"}',
    });
    expect(s.genai?.inputMessages).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'What is this?' }, { type: 'image', content: 'https://example.com/cat.png' }] },
    ]);
    expect(s.genai?.outputMessages).toEqual([{ role: 'assistant', parts: [{ type: 'tool_call', name: 'describe', arguments: { subject: 'cat' } }] }]);
  });

  it('keeps two different calls to the same tool, and arguments that are not JSON', () => {
    const s = span({
      'llm.output_messages.0.message.role': 'assistant',
      'llm.output_messages.0.message.tool_calls.0.tool_call.function.name': 'search',
      'llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments': '{"q": "a"}',
      'llm.output_messages.0.message.tool_calls.1.tool_call.function.name': 'search',
      'llm.output_messages.0.message.tool_calls.1.tool_call.function.arguments': '{"q": "b" (cut off',
    });
    expect(s.genai?.outputMessages?.[0]?.parts).toEqual([
      { type: 'tool_call', name: 'search', arguments: { q: 'a' } },
      { type: 'tool_call', name: 'search', arguments: '{"q": "b" (cut off' },
    ]);
  });

  it('keeps a message that has only a role in its place', () => {
    const s = span({ 'llm.input_messages.0.message.role': 'user', 'llm.input_messages.1.message.role': 'assistant', 'llm.input_messages.1.message.content': 'hi' });
    expect(s.genai?.inputMessages).toEqual([{ role: 'user', parts: [{ type: 'text' }] }, { role: 'assistant', parts: [{ type: 'text', content: 'hi' }] }]);
  });
});
