// Maps two independent semantic conventions — OpenTelemetry's GenAI semconv
// (`gen_ai.*`) and Arize's OpenInference (`openinference.*` / `llm.*`) — onto
// one normalized `GenAiInfo` shape, and classifies each span into the
// coarse `AgentSpanKind` buckets the UI colors by. See docs/formats.md for
// the exact attribute keys and spec versions this was verified against.
import type { AgentSpanKind, AttrMap, Convention, GenAiInfo, NormalizedMessage, NormalizedMessagePart, ParsedSpan, TokenUsage } from './types.js';
import { isTokenCount } from './cost.js';

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

type UsageField = Exclude<keyof TokenUsage, 'invalidFields'>;
function extractUsage(attrs: AttrMap, fields: Partial<Record<UsageField, string[]>>): TokenUsage | undefined {
  const usage: TokenUsage = {};
  for (const field of Object.keys(fields) as UsageField[]) {
    const key = fields[field]!.find((key) => Object.hasOwn(attrs, key));
    if (!key) continue;
    const value = attrs[key];
    usage[field] = isTokenCount(value) ? value : undefined;
    if (!isTokenCount(value)) (usage.invalidFields ??= []).push(field);
  }
  return Object.keys(usage).length ? usage : undefined;
}

function mergeUsage(oi: TokenUsage | undefined, otel: TokenUsage | undefined): TokenUsage | undefined {
  if (!oi || !otel) return otel ?? oi;
  const merged = { ...oi, ...otel };
  const invalid = [...(oi.invalidFields ?? []).filter((field) => !Object.hasOwn(otel, field)), ...(otel.invalidFields ?? [])];
  delete merged.invalidFields;
  if (invalid.length) merged.invalidFields = invalid;
  return merged;
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

/** `gen_ai.system_instructions` is a list of parts (`[{"type": "text", "content": ...}]`), not of
 * messages: there is no role on its entries, and the role is the system's. Older exporters
 * wrote a list of messages instead, which is read as before. */
function parseSystemInstructions(v: unknown): NormalizedMessage[] | undefined {
  const messages = parseMessageList(v);
  if (!messages) return undefined;
  let value = v;
  if (typeof value === 'string') value = JSON.parse(value);
  const entries = value as unknown[];
  const areParts = entries.every((e) => typeof e === 'object' && e !== null && !('role' in e) && !('parts' in e));
  if (!areParts) return messages;
  return [{ role: 'system', parts: messages.flatMap((m) => m.parts) }];
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
  if (!Object.keys(attrs).some((key) => key.startsWith('gen_ai.'))) {
    return undefined;
  }

  const usage = extractUsage(attrs, {
    inputTokens: ['gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens'],
    outputTokens: ['gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens'],
    cacheReadTokens: ['gen_ai.usage.cache_read.input_tokens'],
    // The spec's name is cache_creation; cache_write is accepted from emitters that used it.
    cacheWriteTokens: ['gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_write.input_tokens'],
    reasoningOutputTokens: ['gen_ai.usage.reasoning.output_tokens'],
  });

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
    ...(usage ? { usage } : {}),
    ...(parseMessageList(attrs['gen_ai.input.messages']) ? { inputMessages: parseMessageList(attrs['gen_ai.input.messages']) } : {}),
    ...(parseMessageList(attrs['gen_ai.output.messages']) ? { outputMessages: parseMessageList(attrs['gen_ai.output.messages']) } : {}),
    ...(parseSystemInstructions(attrs['gen_ai.system_instructions'])
      ? { systemInstructions: parseSystemInstructions(attrs['gen_ai.system_instructions']) }
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

// OpenInference flattens each message into indexed attributes. What its instrumentation
// libraries really write (checked against spans from openinference-instrumentation-anthropic
// and -openai, tests/fixtures/instrumented/):
//
//   llm.output_messages.0.message.role                                   assistant
//   llm.output_messages.0.message.content                                plain-string content, or
//   llm.output_messages.0.message.contents.0.message_content.type        text | tool_use | image
//   llm.output_messages.0.message.contents.0.message_content.text
//   llm.output_messages.0.message.contents.1.tool_call.function.name     (a tool_use block)
//   llm.output_messages.0.message.tool_calls.0.tool_call.id
//   llm.output_messages.0.message.tool_calls.0.tool_call.function.name
//   llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments   a JSON string
//   llm.input_messages.3.message.tool_call_id                            on a tool's result
//
// The Anthropic instrumentation writes every assistant turn as `contents`, never `content`, and
// lists a tool call twice: among the contents and under `tool_calls`.
const OI_MESSAGE_KEY = /^llm\.(input|output)_messages\.(\d+)\.message\.(.+)$/;
const OI_CONTENT_KEY = /^contents\.(\d+)\.(.+)$/;
const OI_TOOL_CALL_KEY = /^tool_calls\.(\d+)\.tool_call\.(.+)$/;

interface OiToolCall {
  id?: string;
  name?: string;
  arguments?: string;
}
interface OiContent {
  type?: string;
  text?: string;
  image?: string;
  toolCall: OiToolCall;
}
interface OiMessage {
  role?: string;
  content?: string;
  toolCallId?: string;
  functionCall: OiToolCall;
  contents: Map<number, OiContent>;
  toolCalls: Map<number, OiToolCall>;
}

function setToolCallField(call: OiToolCall, field: string, value: unknown): void {
  if (field === 'id') call.id = str(value);
  else if (field === 'function.name') call.name = str(value);
  else if (field === 'function.arguments') call.arguments = str(value);
}

function toolCallPart(call: OiToolCall): NormalizedMessagePart {
  return {
    type: 'tool_call',
    ...(call.id !== undefined ? { id: call.id } : {}),
    ...(call.name !== undefined ? { name: call.name } : {}),
    ...(call.arguments !== undefined ? { arguments: parseJsonish(call.arguments) } : {}),
  };
}

function openInferenceParts(message: OiMessage): NormalizedMessagePart[] {
  const parts: NormalizedMessagePart[] = [];
  const emitted = new Set<string>();
  const callKey = (call: OiToolCall): string => call.id ?? `${call.name ?? ''}\u0000${call.arguments ?? ''}`;
  const pushCall = (call: OiToolCall): void => {
    if (call.id === undefined && call.name === undefined && call.arguments === undefined) return;
    if (emitted.has(callKey(call))) return; // the same call, listed among the contents and under tool_calls
    emitted.add(callKey(call));
    parts.push(toolCallPart(call));
  };

  if (message.content !== undefined) {
    parts.push(
      message.toolCallId !== undefined
        ? { type: 'tool_call_response', id: message.toolCallId, response: parseJsonish(message.content) }
        : { type: 'text', content: message.content },
    );
  }
  for (const [, content] of [...message.contents.entries()].sort(([a], [b]) => a - b)) {
    if (content.text !== undefined) {
      parts.push(
        message.toolCallId !== undefined
          ? { type: 'tool_call_response', id: message.toolCallId, response: parseJsonish(content.text) }
          : { type: 'text', content: content.text },
      );
    } else if (content.image !== undefined) {
      parts.push({ type: 'image', content: content.image });
    } else {
      pushCall(content.toolCall);
    }
  }
  for (const [, call] of [...message.toolCalls.entries()].sort(([a], [b]) => a - b)) pushCall(call);
  pushCall(message.functionCall);
  // A message with a role and nothing readable still takes its place in the thread.
  return parts.length > 0 ? parts : [{ type: 'text' }];
}

function extractOpenInferenceMessages(attrs: AttrMap, direction: 'input' | 'output'): NormalizedMessage[] | undefined {
  const byIndex = new Map<number, OiMessage>();
  for (const [key, value] of Object.entries(attrs)) {
    const m = OI_MESSAGE_KEY.exec(key);
    if (!m || m[1] !== direction) continue;
    const idx = Number(m[2]);
    const field = m[3]!;
    let message = byIndex.get(idx);
    if (!message) {
      message = { functionCall: {}, contents: new Map(), toolCalls: new Map() };
      byIndex.set(idx, message);
    }
    if (field === 'role') message.role = str(value);
    else if (field === 'content') message.content = str(value);
    else if (field === 'tool_call_id') message.toolCallId = str(value);
    else if (field === 'function_call_name') message.functionCall.name = str(value);
    else if (field === 'function_call_arguments_json') message.functionCall.arguments = str(value);
    else {
      const content = OI_CONTENT_KEY.exec(field);
      const toolCall = OI_TOOL_CALL_KEY.exec(field);
      if (content) {
        const at = Number(content[1]);
        const entry = message.contents.get(at) ?? { toolCall: {} };
        const sub = content[2]!;
        if (sub === 'message_content.type') entry.type = str(value);
        else if (sub === 'message_content.text') entry.text = str(value);
        else if (sub === 'message_content.image.image.url') entry.image = str(value);
        else if (sub.startsWith('tool_call.')) setToolCallField(entry.toolCall, sub.slice('tool_call.'.length), value);
        message.contents.set(at, entry);
      } else if (toolCall) {
        const at = Number(toolCall[1]);
        const entry = message.toolCalls.get(at) ?? {};
        setToolCallField(entry, toolCall[2]!, value);
        message.toolCalls.set(at, entry);
      }
    }
  }
  if (byIndex.size === 0) return undefined;
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, message]) => ({ role: message.role ?? 'unknown', parts: openInferenceParts(message) }));
}

/** `llm.invocation_parameters` is the request's own options as a JSON string. */
function invocationParameters(attrs: AttrMap): { temperature?: number; maxTokens?: number } {
  const parsed = parseJsonish(attrs['llm.invocation_parameters']);
  if (typeof parsed !== 'object' || parsed === null) return {};
  const params = parsed as Record<string, unknown>;
  const maxTokens = num(params['max_tokens']) ?? num(params['max_completion_tokens']) ?? num(params['max_output_tokens']);
  return {
    ...(num(params['temperature']) !== undefined ? { temperature: num(params['temperature']) } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function extractOpenInference(attrs: AttrMap): GenAiInfo | undefined {
  const kind = str(attrs['openinference.span.kind']);
  if (!kind) return undefined;

  const usage = extractUsage(attrs, {
    inputTokens: ['llm.token_count.prompt'],
    outputTokens: ['llm.token_count.completion'],
    totalTokens: ['llm.token_count.total'],
    cacheReadTokens: ['llm.token_count.prompt_details.cache_read'],
    cacheWriteTokens: ['llm.token_count.prompt_details.cache_write'],
    reasoningOutputTokens: ['llm.token_count.completion_details.reasoning'],
  });

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
    ...invocationParameters(attrs),
    ...(str(attrs['llm.finish_reason']) ? { finishReasons: [str(attrs['llm.finish_reason'])!] } : {}),
    ...(usage ? { usage } : {}),
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
    const usage = mergeUsage(oi.usage, otel.usage);
    if (usage) genai.usage = usage;
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
  const oiKind = str(span.attributes['openinference.span.kind']);
  if (otel?.operationName && Object.hasOwn(GENAI_OP_TO_KIND, otel.operationName)) {
    agentKind = GENAI_OP_TO_KIND[otel.operationName]!;
  } else if (oiKind && Object.hasOwn(OPENINFERENCE_KIND_MAP, oiKind)) {
    agentKind = OPENINFERENCE_KIND_MAP[oiKind]!;
  } else if (!otel?.operationName && !oiKind && genai) {
    // Older exporters have model/usage attributes but no operation name.
    if (genai.toolName) agentKind = 'tool';
    else if (genai.requestModel || genai.responseModel || genai.usage) agentKind = 'llm';
  }

  return {
    ...span,
    agentKind,
    convention,
    ...(genai ? { genai } : {}),
  };
}
