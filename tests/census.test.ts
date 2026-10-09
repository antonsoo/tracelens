// Spans written by instrumentation libraries while replaying recorded provider responses
// (tests/fixtures/census/, made by studies/instrumentation-census/make-fixtures.py). The expected
// values are what the recorded response said, not what the span says: each comment names the
// figure in the response. Before these were read, every one of these facts was missing from the
// viewer or wrong.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseOtlpJson } from '../src/core/otlp-parser.js';
import { estimateSpanCost } from '../src/core/cost.js';
import { DEFAULT_PRICE_TABLE } from '../src/core/pricing.js';
import type { ParsedSpan } from '../src/core/types.js';

const DIR = fileURLToPath(new URL('./fixtures/census/', import.meta.url));

function spans(file: string): ParsedSpan[] {
  return parseOtlpJson(JSON.parse(readFileSync(DIR + file, 'utf8'))).spans;
}
function named(file: string, name: string): ParsedSpan {
  const span = spans(file).find((s) => s.name === name);
  if (!span) throw new Error(`no span ${name} in ${file}`);
  return span;
}
function toolCalls(span: ParsedSpan): string[] {
  return (span.genai?.outputMessages ?? []).flatMap((m) => m.parts.filter((p) => p.type === 'tool_call').map((p) => p.name ?? ''));
}

describe('Vercel AI SDK 6, ai.* attributes', () => {
  // The recorded OpenAI Responses stream (packages/openai/src/responses/__fixtures__/
  // openai-code-interpreter-tool.1.chunks.txt) ends with input 6047 (of which 2944 cached),
  // output 1623 (of which 1408 reasoning), model gpt-5-nano-2025-08-07.
  const stream = named('vercel-ai-sdk-6-openai-responses-stream.json', 'ai.streamText.doStream');
  const wrapper = named('vercel-ai-sdk-6-openai-responses-stream.json', 'ai.streamText');

  it('reads the cached and reasoning tokens the SDK writes under ai.usage', () => {
    expect(stream.genai?.usage).toMatchObject({ inputTokens: 6047, outputTokens: 1623, cacheReadTokens: 2944, reasoningOutputTokens: 1408 });
  });

  it('prices the call with the cached tokens at the cache rate', () => {
    // The response model is gpt-5-nano, not gpt-5. Its official model page (2026-10-09)
    // gives $0.05 input, $0.005 cached input and $0.40 output per million tokens.
    // The former substring match silently used the gpt-5 rates: 25 times too high.
    const cost = estimateSpanCost(stream.genai!, DEFAULT_PRICE_TABLE);
    expect(cost?.matchedModel).toBe('gpt-5-nano');
    expect(cost?.costUsd).toBeCloseTo(0.00081907, 12);
  });

  it('counts the model call once: the span that repeats its totals is a chain, not a second call', () => {
    expect(stream.agentKind).toBe('llm');
    expect(wrapper.agentKind).toBe('chain');
    expect(wrapper.convention).toBe('vercel-ai');
  });

  // packages/deepseek/src/chat/__fixtures__/deepseek-tool-call.json: model deepseek-reasoner, 339
  // prompt tokens (320 cached), 92 completion (48 reasoning), finish_reason tool_calls, one call to
  // the tool `weather`.
  it('shows the tool the model called, and the tool span', () => {
    const call = named('vercel-ai-sdk-6-deepseek-tool-call.json', 'ai.generateText.doGenerate');
    const tool = named('vercel-ai-sdk-6-deepseek-tool-call.json', 'ai.toolCall');
    expect(call.genai?.usage).toMatchObject({ inputTokens: 339, outputTokens: 92, cacheReadTokens: 320, reasoningOutputTokens: 48 });
    expect(toolCalls(call)).toEqual(['weather']);
    expect(tool.agentKind).toBe('tool');
    expect(tool.genai?.toolName).toBe('weather');
    expect(tool.parentSpanId).toBeDefined();
  });
});

describe('OpenLLMetry, as it writes Cohere and Mistral at 0.62.4 (gen_ai.prompt.N / gen_ai.completion.N)', () => {
  // packages/opentelemetry-instrumentation-cohere/tests/cassettes/test_chat/
  // test_cohere_v2_chat_legacy_with_tool_calls_and_history.yaml: the first response calls get_time
  // and get_weather and finishes with TOOL_CALL.
  it("shows the reply's tool calls", () => {
    const chat = named('openllmetry-cohere-legacy-tool-calls.json', 'cohere.chat');
    expect(chat.agentKind).toBe('llm');
    expect(toolCalls(chat).sort()).toEqual(['get_time', 'get_weather']);
    const call = chat.genai!.outputMessages![0]!.parts.find((p) => p.name === 'get_weather');
    expect(call?.arguments).toEqual({ location: 'Tokyo' });
    expect(chat.genai?.inputMessages?.[0]?.parts[0]?.content).toContain('weather');
  });

  // cassettes/test_embeddings/test_mistral_embeddings_legacy.yaml is a POST to /v1/embeddings.
  it('classifies an embeddings call from llm.request.type', () => {
    const embed = named('openllmetry-mistral-embeddings-legacy.json', 'mistralai.embeddings');
    expect(embed.agentKind).toBe('embedding');
    expect(embed.genai?.requestModel).toBe('mistral-embed');
  });

  // cassettes/test_chat/test_chat_reasoning.yaml: completion_tokens_details.reasoning_tokens 192.
  it('reads gen_ai.usage.reasoning_tokens', () => {
    const chat = named('openllmetry-openai-reasoning.json', 'openai.chat');
    expect(chat.genai?.usage).toMatchObject({ inputTokens: 11, outputTokens: 228, reasoningOutputTokens: 192 });
  });
});

describe('Strands, through OpenInference-instrumented tests', () => {
  // cassettes/test_live_agent/test_agent_with_system_prompt_and_tool[legacy].yaml: the first
  // response is a call to get_weather with {"city": "Paris"}, finish_reason tool_calls.
  const legacy = 'strands-legacy-events-tool-call.json';
  const current = 'strands-operation-details-events-tool-call.json';

  it('reads the tool call from the legacy gen_ai.choice event (Converse-style content blocks)', () => {
    const [first] = spans(legacy).filter((s) => s.name === 'chat').sort((a, b) => Number(a.startTimeUnixNano - b.startTimeUnixNano));
    expect(first!.genai?.outputMessages?.[0]?.parts).toEqual([
      { type: 'tool_call', id: expect.stringMatching(/^call_/), name: 'get_weather', arguments: { city: 'Paris' } },
    ]);
    expect(first!.genai?.finishReasons).toEqual(['tool_use']);
    expect(first!.genai?.inputMessages?.[0]).toEqual({ role: 'user', parts: [{ type: 'text', content: 'What is the weather in Paris?' }] });
  });

  it('reads the thread from gen_ai.client.inference.operation.details events', () => {
    const [first, second] = spans(current).filter((s) => s.name === 'chat').sort((a, b) => Number(a.startTimeUnixNano - b.startTimeUnixNano));
    expect(toolCalls(first!)).toEqual(['get_weather']);
    expect(first!.genai?.finishReasons).toEqual(['tool_use']);
    expect(second!.genai?.inputMessages?.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second!.genai?.outputMessages?.[0]?.parts[0]?.content).toContain('sunny');
  });
});

describe('OpenInference embeddings', () => {
  // cassettes/test_embeddings/test_single_string_embedding.yaml: model text-embedding-ada-002-v2, 2 prompt tokens.
  it('reads the model from embedding.model_name', () => {
    const embed = named('openinference-litellm-embedding.json', 'CreateEmbeddings');
    expect(embed.agentKind).toBe('embedding');
    expect(embed.genai?.requestModel).toBe('text-embedding-ada-002-v2');
    expect(embed.genai?.usage?.inputTokens).toBe(2);
  });
});
