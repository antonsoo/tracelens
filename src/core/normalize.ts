// Maps two independent semantic conventions — OpenTelemetry's GenAI semconv
// (`gen_ai.*`) and Arize's OpenInference (`openinference.*` / `llm.*`) — onto
// one normalized `GenAiInfo` shape, and classifies each span into the
// coarse `AgentSpanKind` buckets the UI colors by. See docs/formats.md for
// the exact attribute keys and spec versions this was verified against.
import type { AgentSpanKind, AttrMap, Convention, GenAiInfo, NormalizedMessage, ParsedSpan, TokenUsage } from './types.js';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : undefined;
}

/** `gen_ai.input.messages` / `.output.messages` / `.system_instructions` may arrive as a
 * JSON string (span attributes can't hold nested objects in some exporters) or already
 * structured (if the exporter used arrayValue/kvlistValue faithfully). Handle both. */
function parseMessageList(v: unknown): NormalizedMessage[] | undefined {
  let value = v;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(value)) return undefined;
  const messages: NormalizedMessage[] = [];
  for (const m of value) {
    if (typeof m !== 'object' || m === null) continue;
    const rec = m as Record<string, unknown>;
    const role = str(rec.role) ?? 'unknown';
    const partsRaw = Array.isArray(rec.parts) ? rec.parts : [{ type: 'text', content: rec.content }];
    const parts = partsRaw
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p) => ({
        type: str(p.type) ?? 'text',
        ...(str(p.content) !== undefined ? { content: str(p.content) } : {}),
        ...(str(p.id) !== undefined ? { id: str(p.id) } : {}),
        ...(str(p.name) !== undefined ? { name: str(p.name) } : {}),
        ...('arguments' in p ? { arguments: p.arguments } : {}),
        ...('response' in p ? { response: p.response } : {}),
      }));
    messages.push({ role, parts });
  }
  return messages.length > 0 ? messages : undefined;
}

function parseJsonish(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

const GENAI_OP_TO_KIND: Record<string, AgentSpanKind> = {
  invoke_agent: 'agent',
  create_agent: 'agent',
  chat: 'llm',
  generate_content: 'llm',
  text_completion: 'llm',
  fetch_response: 'llm',
  embeddings: 'embedding',
  execute_tool: 'tool',
  retrieval: 'retriever',
  plan: 'chain',
  invoke_workflow: 'chain',
  create_memory: 'chain',
  delete_memory: 'chain',
  update_memory: 'chain',
  upsert_memory: 'chain',
  search_memory: 'chain',
  create_memory_store: 'chain',
  delete_memory_store: 'chain',
};

const OPENINFERENCE_KIND_MAP: Record<string, AgentSpanKind> = {
  AGENT: 'agent',
  LLM: 'llm',
  TOOL: 'tool',
  CHAIN: 'chain',
  RETRIEVER: 'retriever',
  EMBEDDING: 'embedding',
  RERANKER: 'reranker',
  GUARDRAIL: 'guardrail',
  EVALUATOR: 'evaluator',
  PROMPT: 'chain',
};

function extractOtelGenAi(attrs: AttrMap): GenAiInfo | undefined {
  const operationName = str(attrs['gen_ai.operation.name']);
  const provider = str(attrs['gen_ai.provider.name']) ?? str(attrs['gen_ai.system']); // gen_ai.system is the pre-provider.name (legacy) attribute
  if (!operationName && !provider && !('gen_ai.request.model' in attrs) && !('gen_ai.tool.name' in attrs)) {
    return undefined;
  }

  const usage: TokenUsage = {
    inputTokens: num(attrs['gen_ai.usage.input_tokens']) ?? num(attrs['gen_ai.usage.prompt_tokens']),
    outputTokens: num(attrs['gen_ai.usage.output_tokens']) ?? num(attrs['gen_ai.usage.completion_tokens']),
    cacheReadTokens: num(attrs['gen_ai.usage.cache_read.input_tokens']),
    cacheWriteTokens: num(attrs['gen_ai.usage.cache_write.input_tokens']),
    reasoningOutputTokens: num(attrs['gen_ai.usage.reasoning.output_tokens']),
  };
  const hasUsage = Object.values(usage).some((x) => x !== undefined);

  const info: GenAiInfo = {
    ...(operationName ? { operationName } : {}),
    ...(provider ? { provider } : {}),
    ...(str(attrs['gen_ai.request.model']) ? { requestModel: str(attrs['gen_ai.request.model']) } : {}),
    ...(str(attrs['gen_ai.response.model']) ? { responseModel: str(attrs['gen_ai.response.model']) } : {}),
    ...(str(attrs['gen_ai.agent.name']) ? { agentName: str(attrs['gen_ai.agent.name']) } : {}),
    ...(str(attrs['gen_ai.conversation.id']) ? { conversationId: str(attrs['gen_ai.conversation.id']) } : {}),
    ...(num(attrs['gen_ai.request.temperature']) !== undefined
      ? { temperature: num(attrs['gen_ai.request.temperature']) }
      : {}),
    ...(num(attrs['gen_ai.request.max_tokens']) !== undefined
      ? { maxTokens: num(attrs['gen_ai.request.max_tokens']) }
      : {}),
    ...(strArray(attrs['gen_ai.response.finish_reasons'])
      ? { finishReasons: strArray(attrs['gen_ai.response.finish_reasons']) }
      : {}),
    ...(hasUsage ? { usage } : {}),
    ...(parseMessageList(attrs['gen_ai.input.messages']) ? { inputMessages: parseMessageList(attrs['gen_ai.input.messages']) } : {}),
    ...(parseMessageList(attrs['gen_ai.output.messages']) ? { outputMessages: parseMessageList(attrs['gen_ai.output.messages']) } : {}),
    ...(parseMessageList(attrs['gen_ai.system_instructions'])
      ? { systemInstructions: parseMessageList(attrs['gen_ai.system_instructions']) }
      : {}),
    ...(str(attrs['gen_ai.tool.name']) ? { toolName: str(attrs['gen_ai.tool.name']) } : {}),
    ...(str(attrs['gen_ai.tool.call.id']) ? { toolCallId: str(attrs['gen_ai.tool.call.id']) } : {}),
    ...(str(attrs['gen_ai.tool.description']) ? { toolDescription: str(attrs['gen_ai.tool.description']) } : {}),
    ...(str(attrs['gen_ai.tool.type']) ? { toolType: str(attrs['gen_ai.tool.type']) } : {}),
    ...('gen_ai.tool.call.arguments' in attrs ? { toolArguments: parseJsonish(attrs['gen_ai.tool.call.arguments']) } : {}),
    ...('gen_ai.tool.call.result' in attrs ? { toolResult: parseJsonish(attrs['gen_ai.tool.call.result']) } : {}),
    ...(str(attrs['error.type']) ? { errorType: str(attrs['error.type']) } : {}),
  };
  return info;
}

const OI_MESSAGE_KEY = /^llm\.(input|output)_messages\.(\d+)\.message\.(role|content)$/;

function extractOpenInferenceMessages(attrs: AttrMap, direction: 'input' | 'output'): NormalizedMessage[] | undefined {
  const byIndex = new Map<number, { role?: string; content?: string }>();
  for (const [key, value] of Object.entries(attrs)) {
    const m = OI_MESSAGE_KEY.exec(key);
    if (!m || m[1] !== direction) continue;
    const idx = Number(m[2]);
    const field = m[3] as 'role' | 'content';
    const entry = byIndex.get(idx) ?? {};
    entry[field] = str(value);
    byIndex.set(idx, entry);
  }
  if (byIndex.size === 0) return undefined;
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, { role, content }]) => ({
      role: role ?? 'unknown',
      parts: [{ type: 'text', ...(content !== undefined ? { content } : {}) }],
    }));
}

function extractOpenInference(attrs: AttrMap): GenAiInfo | undefined {
  const kind = str(attrs['openinference.span.kind']);
  if (!kind) return undefined;

  const usage: TokenUsage = {
    inputTokens: num(attrs['llm.token_count.prompt']),
    outputTokens: num(attrs['llm.token_count.completion']),
    totalTokens: num(attrs['llm.token_count.total']),
    cacheReadTokens: num(attrs['llm.token_count.prompt_details.cache_read']),
    cacheWriteTokens: num(attrs['llm.token_count.prompt_details.cache_write']),
    reasoningOutputTokens: num(attrs['llm.token_count.completion_details.reasoning']),
  };
  const hasUsage = Object.values(usage).some((x) => x !== undefined);

  const inputMessages = extractOpenInferenceMessages(attrs, 'input');
  const outputMessages = extractOpenInferenceMessages(attrs, 'output');
  const fallbackInput = str(attrs['input.value']);
  const fallbackOutput = str(attrs['output.value']);

  const info: GenAiInfo = {
    operationName: kind.toLowerCase(),
    ...(str(attrs['llm.provider']) ?? str(attrs['llm.system']) ? { provider: str(attrs['llm.provider']) ?? str(attrs['llm.system']) } : {}),
    ...(str(attrs['llm.model_name']) ? { requestModel: str(attrs['llm.model_name']) } : {}),
    ...(str(attrs['llm.response.model_name']) ? { responseModel: str(attrs['llm.response.model_name']) } : {}),
    ...(str(attrs['session.id']) ? { conversationId: str(attrs['session.id']) } : {}),
    ...(hasUsage ? { usage } : {}),
    ...(inputMessages
      ? { inputMessages }
      : fallbackInput
        ? { inputMessages: [{ role: 'user', parts: [{ type: 'text', content: fallbackInput }] }] }
        : {}),
    ...(outputMessages
      ? { outputMessages }
      : fallbackOutput
        ? { outputMessages: [{ role: 'assistant', parts: [{ type: 'text', content: fallbackOutput }] }] }
        : {}),
    ...(str(attrs['tool.name']) ? { toolName: str(attrs['tool.name']) } : {}),
    ...(str(attrs['tool.description']) ? { toolDescription: str(attrs['tool.description']) } : {}),
    ...('tool.parameters' in attrs ? { toolArguments: parseJsonish(attrs['tool.parameters']) } : {}),
    ...(str(attrs['error.type']) ? { errorType: str(attrs['error.type']) } : {}),
  };
  return info;
}

/** Legacy per-message span events (pre gen_ai.input/output.messages): one
 * event per turn, named `gen_ai.{system,user,assistant,tool}.message` or
 * `gen_ai.choice`, each carrying its content as event attributes. Still
 * emitted by some instrumentation built against the 2023-2024 draft. */
function extractLegacyEventMessages(span: ParsedSpan): { input?: NormalizedMessage[]; output?: NormalizedMessage[] } {
  const input: NormalizedMessage[] = [];
  const output: NormalizedMessage[] = [];
  for (const ev of span.events) {
    const content = ev.attributes['content'];
    if (ev.name === 'gen_ai.system.message' || ev.name === 'gen_ai.user.message' || ev.name === 'gen_ai.assistant.message' || ev.name === 'gen_ai.tool.message') {
      const role = ev.name.split('.')[1] ?? 'unknown';
      input.push({ role, parts: [{ type: 'text', ...(str(content) !== undefined ? { content: str(content) } : {}) }] });
    } else if (ev.name === 'gen_ai.choice') {
      const message = ev.attributes['message'];
      const text = typeof message === 'string' ? message : str(content);
      output.push({ role: 'assistant', parts: [{ type: 'text', ...(text !== undefined ? { content: text } : {}) }] });
    }
  }
  return {
    ...(input.length > 0 ? { input } : {}),
    ...(output.length > 0 ? { output } : {}),
  };
}

export function normalizeSpan(span: ParsedSpan): ParsedSpan {
  const otel = extractOtelGenAi(span.attributes);
  const oi = extractOpenInference(span.attributes);

  let convention: Convention = 'none';
  let genai: GenAiInfo | undefined;
  if (otel && oi) {
    convention = 'otel-genai'; // both present is unusual; prefer the richer, more current convention
    genai = { ...oi, ...otel };
  } else if (otel) {
    convention = 'otel-genai';
    genai = otel;
  } else if (oi) {
    convention = 'openinference';
    genai = oi;
  }

  if (genai && !genai.inputMessages && !genai.outputMessages) {
    const legacy = extractLegacyEventMessages(span);
    if (legacy.input || legacy.output) {
      genai = { ...genai, ...(legacy.input ? { inputMessages: legacy.input } : {}), ...(legacy.output ? { outputMessages: legacy.output } : {}) };
    }
  }

  let agentKind: AgentSpanKind = 'other';
  if (convention === 'otel-genai' && genai?.operationName) {
    agentKind = GENAI_OP_TO_KIND[genai.operationName] ?? 'other';
  } else if (convention === 'openinference') {
    const kind = str(span.attributes['openinference.span.kind']);
    agentKind = (kind && OPENINFERENCE_KIND_MAP[kind]) || 'other';
  }

  return {
    ...span,
    agentKind,
    convention,
    ...(genai ? { genai } : {}),
  };
}
