import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseOtlpJson } from '../src/core/otlp-parser.js';

const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url));
function loadTrace(name: string) {
  return parseOtlpJson(JSON.parse(readFileSync(EXAMPLES + name, 'utf8')));
}

describe('OTel GenAI semconv mapping (gen_ai.*)', () => {
  const trace = loadTrace('genai-semconv-trace.json');
  const chat = trace.spans.find((s) => s.name.startsWith('chat'))!;
  const tool = trace.spans.find((s) => s.genai?.toolName === 'get_weather')!;
  const failedTool = trace.spans.find((s) => s.status.code === 'ERROR' && s.genai?.toolName === 'lookup_currency')!;

  it('classifies chat spans as llm and execute_tool spans as tool', () => {
    expect(chat.convention).toBe('otel-genai');
    expect(chat.agentKind).toBe('llm');
    expect(tool.agentKind).toBe('tool');
  });

  it('reads request/response model, provider and token usage', () => {
    expect(chat.genai?.provider).toBe('openai');
    expect(chat.genai?.requestModel).toBeTruthy();
    expect(chat.genai?.usage?.inputTokens).toBeGreaterThan(0);
    expect(chat.genai?.usage?.outputTokens).toBeGreaterThan(0);
  });

  it('parses gen_ai.input.messages / gen_ai.output.messages JSON strings into structured messages', () => {
    expect(chat.genai?.inputMessages?.length).toBeGreaterThan(0);
    expect(chat.genai?.outputMessages?.length).toBeGreaterThan(0);
    const firstPart = chat.genai!.inputMessages![0]!.parts[0]!;
    expect(typeof firstPart.type).toBe('string');
  });

  it('parses gen_ai.tool.call.arguments / .result JSON strings into objects', () => {
    expect(tool.genai?.toolArguments).toMatchObject({ location: expect.any(String) });
    expect(tool.genai?.toolResult).toMatchObject({ location: expect.any(String) });
  });

  it('captures error.type on the failing tool span', () => {
    expect(failedTool.status.code).toBe('ERROR');
    expect(failedTool.genai?.errorType).toBeTruthy();
  });
});

describe('OpenInference convention mapping (openinference.*, llm.*)', () => {
  const trace = loadTrace('openinference-trace.json');
  const llm = trace.spans.find((s) => s.attributes['openinference.span.kind'] === 'LLM')!;
  const tool = trace.spans.find((s) => s.genai?.toolName === 'get_weather')!;
  const agent = trace.spans.find((s) => s.attributes['openinference.span.kind'] === 'AGENT')!;

  it('classifies spans by openinference.span.kind', () => {
    expect(llm.convention).toBe('openinference');
    expect(llm.agentKind).toBe('llm');
    expect(tool.agentKind).toBe('tool');
    expect(agent.agentKind).toBe('agent');
  });

  it('reads llm.token_count.* usage', () => {
    expect(llm.genai?.usage?.inputTokens).toBeGreaterThan(0);
    expect(llm.genai?.usage?.outputTokens).toBeGreaterThan(0);
  });

  it('reassembles flattened llm.input_messages.<i>.message.role/content into a message list', () => {
    expect(llm.genai?.inputMessages?.length).toBeGreaterThan(0);
    expect(llm.genai?.inputMessages?.[0]?.role).toBeTruthy();
    expect(llm.genai?.inputMessages?.[0]?.parts[0]?.content).toBeTruthy();
  });

  it('reads tool.name / tool.parameters on TOOL spans', () => {
    expect(tool.genai?.toolName).toBe('get_weather');
    expect(tool.genai?.toolArguments).toBeTruthy();
  });
});
