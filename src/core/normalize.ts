// Maps two independent semantic conventions — OpenTelemetry's GenAI semconv
// (`gen_ai.*`) and Arize's OpenInference (`openinference.*` / `llm.*`) — onto
// one normalized `GenAiInfo` shape, and classifies each span into the
// coarse `AgentSpanKind` buckets the UI colors by. See docs/formats.md for
// the exact attribute keys and spec versions this was verified against.
import type { AgentSpanKind, AttrMap, Convention, GenAiInfo, NormalizedMessage, NormalizedMessagePart, ParsedSpan, ParseWarning, TokenUsage } from './types.js';
import { isTokenCount } from './cost.js';
import { parsePayloadJson } from './payload-depth.js';

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
      value = parsePayloadJson(value);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
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

/** Each output message carries its own `finish_reason` in the current spec; Strands and
 * OpenLLMetry's newer instrumentations write nothing to `gen_ai.response.finish_reasons`. */
function finishReasonsOfMessages(v: unknown): string[] | undefined {
  const list = parseJsonish(v);
  if (!Array.isArray(list)) return undefined;
  const reasons = list.map((m) => (typeof m === 'object' && m !== null ? str((m as Record<string, unknown>).finish_reason) : undefined)).filter((r): r is string => r !== undefined);
  return reasons.length > 0 ? reasons : undefined;
}

/** `gen_ai.system_instructions` is a list of parts (`[{"type": "text", "content": ...}]`), not of
 * messages: there is no role on its entries, and the role is the system's. Older exporters
 * wrote a list of messages instead, which is read as before. */
function parseSystemInstructions(v: unknown): NormalizedMessage[] | undefined {
  const messages = parseMessageList(v);
  if (!messages) return undefined;
  let value = v;
  if (typeof value === 'string') value = parsePayloadJson(value);
  const entries = value as unknown[];
  const areParts = entries.every((e) => typeof e === 'object' && e !== null && !('role' in e) && !('parts' in e));
  if (!areParts) return messages;
  return [{ role: 'system', parts: messages.flatMap((m) => m.parts) }];
}

function parseJsonish(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return parsePayloadJson(v);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
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
    // The spec writes cache_read.input_tokens; Strands writes cache_read_input_tokens.
    cacheReadTokens: ['gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.cache_read_input_tokens'],
    // The spec's name is cache_creation; cache_write is accepted from emitters that used it.
    cacheWriteTokens: [
      'gen_ai.usage.cache_creation.input_tokens',
      'gen_ai.usage.cache_write.input_tokens',
      'gen_ai.usage.cache_creation_input_tokens',
      'gen_ai.usage.cache_write_input_tokens',
    ],
    // OpenLLMetry writes reasoning_tokens; Pydantic AI nests the provider's own figure under usage.details.
    reasoningOutputTokens: [
      'gen_ai.usage.reasoning.output_tokens',
      'gen_ai.usage.reasoning_tokens',
      'gen_ai.usage.details.reasoning_tokens',
      'gen_ai.usage.details.thoughts_tokens',
    ],
  });

  // OpenLLMetry before it adopted gen_ai.input.messages wrote indexed gen_ai.prompt.N.* / gen_ai.completion.N.*.
  const indexedInput = attrs['gen_ai.input.messages'] === undefined ? extractIndexedMessages(attrs, 'gen_ai.prompt') : undefined;
  const indexedOutput = attrs['gen_ai.output.messages'] === undefined ? extractIndexedMessages(attrs, 'gen_ai.completion') : undefined;
  const finishReasons = strArray(attrs['gen_ai.response.finish_reasons']) ?? finishReasonsOfMessages(attrs['gen_ai.output.messages']) ?? indexedOutput?.finishReasons;

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
    ...(finishReasons ? { finishReasons } : {}),
    ...(usage ? { usage } : {}),
    ...(parseMessageList(attrs['gen_ai.input.messages']) ? { inputMessages: parseMessageList(attrs['gen_ai.input.messages']) } : {}),
    ...(parseMessageList(attrs['gen_ai.output.messages']) ? { outputMessages: parseMessageList(attrs['gen_ai.output.messages']) } : {}),
    ...(indexedInput ? { inputMessages: indexedInput.messages } : {}),
    ...(indexedOutput ? { outputMessages: indexedOutput.messages } : {}),
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

/** Text of a message `content` that is either a string or, as Cohere and Anthropic write it, a
 * JSON string holding a list of `{"type": "text", "text": ...}` blocks. */
function contentParts(content: string): NormalizedMessagePart[] {
  if (content.startsWith('[')) {
    const blocks = parseJsonish(content);
    if (Array.isArray(blocks) && blocks.length > 0 && blocks.every((b) => typeof b === 'object' && b !== null && 'type' in b)) {
      const texts = (blocks as Record<string, unknown>[]).filter((b) => b.type === 'text' && str(b.text) !== undefined);
      if (texts.length === blocks.length) return texts.map((b) => ({ type: 'text', content: str(b.text) }));
    }
  }
  return [{ type: 'text', content }];
}

interface IndexedMessage {
  role?: string;
  content?: string;
  finish?: string;
  calls: Map<number, OiToolCall>;
}

/** OpenLLMetry's pre-`gen_ai.input.messages` layout (still written by its Cohere and Mistral
 * instrumentations at 0.62.4):
 *
 *   gen_ai.prompt.0.role / .content
 *   gen_ai.completion.0.role / .content / .finish_reason
 *   gen_ai.completion.0.tool_calls.0.id / .name / .arguments        (a JSON string)
 */
const INDEXED_MESSAGE_KEY = /^(?:gen_ai\.prompt|gen_ai\.completion)\.(\d+)\.(.+)$/;
function extractIndexedMessages(attrs: AttrMap, prefix: 'gen_ai.prompt' | 'gen_ai.completion'): { messages: NormalizedMessage[]; finishReasons?: string[] } | undefined {
  const byIndex = new Map<number, IndexedMessage>();
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith(prefix + '.')) continue;
    const m = INDEXED_MESSAGE_KEY.exec(key);
    if (!m) continue;
    const message: IndexedMessage = byIndex.get(Number(m[1])) ?? { calls: new Map() };
    const field = m[2]!;
    const call = /^tool_calls\.(\d+)\.(id|name|arguments)$/.exec(field);
    if (field === 'role') message.role = str(value);
    else if (field === 'content') message.content = str(value);
    else if (field === 'finish_reason') message.finish = str(value);
    else if (call) {
      const entry = message.calls.get(Number(call[1])) ?? {};
      if (call[2] === 'id') entry.id = str(value);
      else if (call[2] === 'name') entry.name = str(value);
      else entry.arguments = typeof value === 'string' ? value : value === undefined ? undefined : JSON.stringify(value);
      message.calls.set(Number(call[1]), entry);
    } else continue; // content_filter_results and the like: not part of the message
    byIndex.set(Number(m[1]), message);
  }
  if (byIndex.size === 0) return undefined;
  const ordered = [...byIndex.entries()].sort(([a], [b]) => a - b);
  const messages = ordered.map(([, message]) => {
    const parts: NormalizedMessagePart[] = message.content !== undefined ? contentParts(message.content) : [];
    for (const [, call] of [...message.calls.entries()].sort(([a], [b]) => a - b)) parts.push(toolCallPart(call));
    return { role: message.role ?? (prefix === 'gen_ai.prompt' ? 'unknown' : 'assistant'), parts: parts.length > 0 ? parts : [{ type: 'text' }] };
  });
  const finish = ordered.map(([, message]) => message.finish).filter((f): f is string => f !== undefined);
  return { messages, ...(finish.length > 0 ? { finishReasons: finish } : {}) };
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
    // Embedding spans name their model under embedding.model_name, not llm.model_name.
    ...((str(attrs['llm.model_name']) ?? str(attrs['embedding.model_name'])) ? { requestModel: str(attrs['llm.model_name']) ?? str(attrs['embedding.model_name']) } : {}),
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

// The Vercel AI SDK's own span format (`ai.*`), written by `experimental_telemetry` in AI SDK 4 to 6
// and by `LegacyOpenTelemetry` in AI SDK 7. Checked against spans from ai 6.0.302 and
// @ai-sdk/otel 1.0.133 (studies/instrumentation-census/):
//
//   ai.operationId                       ai.streamText | ai.streamText.doStream | ai.toolCall | ...
//   ai.model.id / ai.model.provider      ai.response.model / ai.response.finishReason
//   ai.usage.inputTokens / .outputTokens / .cachedInputTokens / .reasoningTokens
//   ai.prompt.messages                   JSON: [{role, content: string | [{type: text | tool-call | tool-result}]}]
//   ai.response.text / ai.response.toolCalls   (JSON: [{toolCallId, toolName, input | args}])
//   ai.toolCall.name / .id / .args / .result   on the tool's own span
//
// The `doGenerate` and `doStream` spans are the model calls (and also carry a few gen_ai.*
// attributes); the other spans of a call (`ai.generateText`, `ai.streamText`) repeat its totals
// across steps and are not model calls.
function aiSdkKind(operationId: string): AgentSpanKind {
  if (operationId.endsWith('.doGenerate') || operationId.endsWith('.doStream')) return 'llm';
  if (operationId.endsWith('.doEmbed')) return 'embedding';
  if (operationId === 'ai.toolCall') return 'tool';
  return 'chain';
}

function aiSdkParts(content: unknown): NormalizedMessagePart[] {
  if (typeof content === 'string') return [{ type: 'text', content }];
  if (!Array.isArray(content)) return [{ type: 'text' }];
  return content
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map((p): NormalizedMessagePart => {
      if (p.type === 'text') return { type: 'text', ...(str(p.text) !== undefined ? { content: str(p.text) } : {}) };
      if (p.type === 'tool-call') {
        const args = 'input' in p ? p.input : p.args;
        return { type: 'tool_call', ...(str(p.toolCallId) ? { id: str(p.toolCallId) } : {}), ...(str(p.toolName) ? { name: str(p.toolName) } : {}), ...(args !== undefined ? { arguments: args } : {}) };
      }
      if (p.type === 'tool-result') {
        const output = 'output' in p ? p.output : p.result;
        return { type: 'tool_call_response', ...(str(p.toolCallId) ? { id: str(p.toolCallId) } : {}), ...(output !== undefined ? { response: output } : {}) };
      }
      return { type: str(p.type) ?? 'text' };
    });
}

function aiSdkMessages(v: unknown): NormalizedMessage[] | undefined {
  const list = parseJsonish(v);
  if (!Array.isArray(list)) return undefined;
  const messages = list
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({ role: str(m.role) ?? 'unknown', parts: aiSdkParts(m.content) }));
  return messages.length > 0 ? messages : undefined;
}

function extractAiSdk(attrs: AttrMap): GenAiInfo | undefined {
  const operationId = str(attrs['ai.operationId']);
  if (!operationId) return undefined;
  const usage = extractUsage(attrs, {
    inputTokens: ['ai.usage.inputTokens', 'ai.usage.promptTokens'],
    outputTokens: ['ai.usage.outputTokens', 'ai.usage.completionTokens'],
    cacheReadTokens: ['ai.usage.cachedInputTokens', 'ai.usage.inputTokenDetails.cacheReadTokens'],
    cacheWriteTokens: ['ai.usage.inputTokenDetails.cacheWriteTokens'],
    reasoningOutputTokens: ['ai.usage.reasoningTokens', 'ai.usage.outputTokenDetails.reasoningTokens'],
  });

  const calls = parseJsonish(attrs['ai.response.toolCalls']);
  const outputParts: NormalizedMessagePart[] = [];
  if (str(attrs['ai.response.text']) !== undefined) outputParts.push({ type: 'text', content: str(attrs['ai.response.text']) });
  if (Array.isArray(calls)) outputParts.push(...aiSdkParts(calls.map((c) => (typeof c === 'object' && c !== null ? { ...c, type: 'tool-call' } : c))));
  const inputMessages = aiSdkMessages(attrs['ai.prompt.messages']);
  const isToolSpan = operationId === 'ai.toolCall';

  return {
    operationName: operationId,
    ...(str(attrs['ai.model.provider']) ? { provider: str(attrs['ai.model.provider']) } : {}),
    ...(str(attrs['ai.model.id']) ? { requestModel: str(attrs['ai.model.id']) } : {}),
    ...(str(attrs['ai.response.model']) ? { responseModel: str(attrs['ai.response.model']) } : {}),
    ...(str(attrs['ai.response.finishReason']) ? { finishReasons: [str(attrs['ai.response.finishReason'])!] } : {}),
    ...(usage ? { usage } : {}),
    ...(inputMessages ? { inputMessages } : {}),
    ...(outputParts.length > 0 ? { outputMessages: [{ role: 'assistant', parts: outputParts }] } : {}),
    ...(isToolSpan && str(attrs['ai.toolCall.name']) ? { toolName: str(attrs['ai.toolCall.name']) } : {}),
    ...(isToolSpan && str(attrs['ai.toolCall.id']) ? { toolCallId: str(attrs['ai.toolCall.id']) } : {}),
    ...(isToolSpan && 'ai.toolCall.args' in attrs ? { toolArguments: parseJsonish(attrs['ai.toolCall.args']) } : {}),
    ...(isToolSpan && 'ai.toolCall.result' in attrs ? { toolResult: parseJsonish(attrs['ai.toolCall.result']) } : {}),
  };
}

/** A legacy event's content when it holds Bedrock-Converse-style blocks, as Strands writes it:
 * `[{"text": ...}, {"toolUse": {"toolUseId", "name", "input"}}, {"toolResult": {"toolUseId", "content"}}]`.
 * Anything else, including a plain string, is one text part. */
function eventContentParts(content: unknown, onMalformed: (blockIndex: number) => void): NormalizedMessagePart[] {
  const text = str(content);
  if (text !== undefined && text.trimStart().startsWith('[')) {
    const blocks = parseJsonish(text);
    const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
    const isBlock = (b: unknown): b is Record<string, unknown> => isObject(b) && ('text' in b || 'toolUse' in b || 'toolResult' in b);
    if (Array.isArray(blocks) && blocks.length > 0 && blocks.every(isBlock)) {
      const parts: NormalizedMessagePart[] = [];
      for (const [index, b] of blocks.entries()) {
        const use = b.toolUse;
        const result = b.toolResult;
        // ContentBlock is a union. Keep the entire original message when a
        // recognized block is malformed, rather than inventing an empty call,
        // picking one conflicting member, or discarding its valid neighbors.
        const members = ['text', 'toolUse', 'toolResult'].filter((key) => Object.hasOwn(b, key));
        if (members.length === 1 && typeof b.text === 'string') {
          parts.push({ type: 'text', ...(str(b.text) !== undefined ? { content: b.text } : {}) });
        } else if (members.length === 1 && isObject(use) && str(use.toolUseId) && str(use.name) && Object.hasOwn(use, 'input')) {
          parts.push({ type: 'tool_call', id: str(use.toolUseId), name: str(use.name), arguments: use.input });
        } else if (members.length === 1 && isObject(result) && str(result.toolUseId) && Array.isArray(result.content)) {
          parts.push({ type: 'tool_call_response', id: str(result.toolUseId), response: result.content });
        } else {
          onMalformed(index);
          return [{ type: 'text', content: text }];
        }
      }
      return parts;
    }
  }
  return [{ type: 'text', ...(text !== undefined ? { content: text } : {}) }];
}

/** Message content that arrives on span events rather than attributes.
 *
 * Legacy per-message events (pre gen_ai.input/output.messages): one event per turn, named
 * `gen_ai.{system,user,assistant,tool}.message` or `gen_ai.choice`, each carrying its content as
 * event attributes. Still emitted by instrumentation built against the 2023-2024 draft.
 *
 * Current-spec event: `gen_ai.client.inference.operation.details`, whose attributes are
 * `gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.system_instructions`, written
 * by Strands in its default mode. */
function extractEventMessages(span: ParsedSpan, onWarning?: (warning: ParseWarning) => void): { input?: NormalizedMessage[]; output?: NormalizedMessage[]; system?: NormalizedMessage[]; finishReasons?: string[] } {
  const input: NormalizedMessage[] = [];
  const output: NormalizedMessage[] = [];
  const system: NormalizedMessage[] = [];
  const finishReasons: string[] = [];
  for (const [eventIndex, ev] of span.events.entries()) {
    const onMalformed = (blockIndex: number): void => onWarning?.({
      traceId: span.traceId, spanId: span.spanId,
      message: `events[${eventIndex}] (${ev.name}) content block [${blockIndex}] is malformed or ambiguous. Kept the original message as text; inspect the raw event for details.`,
    });
    const content = ev.attributes['content'];
    if (ev.name === 'gen_ai.client.inference.operation.details') {
      input.push(...(parseMessageList(ev.attributes['gen_ai.input.messages']) ?? []));
      output.push(...(parseMessageList(ev.attributes['gen_ai.output.messages']) ?? []));
      finishReasons.push(...(finishReasonsOfMessages(ev.attributes['gen_ai.output.messages']) ?? []));
      system.push(...(parseSystemInstructions(ev.attributes['gen_ai.system_instructions']) ?? []));
    } else if (ev.name === 'gen_ai.system.message' || ev.name === 'gen_ai.user.message' || ev.name === 'gen_ai.assistant.message' || ev.name === 'gen_ai.tool.message') {
      const role = ev.name.split('.')[1] ?? 'unknown';
      input.push({ role, parts: eventContentParts(content, onMalformed) });
    } else if (ev.name === 'gen_ai.choice') {
      const message = ev.attributes['message'];
      output.push({ role: 'assistant', parts: eventContentParts(typeof message === 'string' ? message : content, onMalformed) });
      if (str(ev.attributes['finish_reason'])) finishReasons.push(str(ev.attributes['finish_reason'])!);
    }
  }
  return {
    ...(input.length > 0 ? { input } : {}),
    ...(output.length > 0 ? { output } : {}),
    ...(system.length > 0 ? { system } : {}),
    ...(finishReasons.length > 0 ? { finishReasons } : {}),
  };
}

const LLM_REQUEST_TYPE_TO_KIND: Record<string, AgentSpanKind> = {
  chat: 'llm',
  completion: 'llm',
  embedding: 'embedding',
  rerank: 'reranker',
};

export function normalizeSpan(span: ParsedSpan, onWarning?: (warning: ParseWarning) => void): ParsedSpan {
  const otel = extractOtelGenAi(span.attributes);
  const oi = extractOpenInference(span.attributes);
  const aiSdk = extractAiSdk(span.attributes);

  // Read in order of how current each convention is; a later one overrides an earlier one field by
  // field, and token counts are merged field by field.
  let genai: GenAiInfo | undefined;
  for (const info of [aiSdk, oi, otel]) {
    if (!info) continue;
    const usage = mergeUsage(genai?.usage, info.usage);
    genai = { ...genai, ...info };
    if (usage) genai.usage = usage;
  }

  const convention: Convention = aiSdk ? 'vercel-ai' : otel ? 'otel-genai' : oi ? 'openinference' : 'none';

  if (genai) {
    const events = extractEventMessages(span, onWarning);
    genai = {
      ...genai,
      ...(!genai.inputMessages && events.input ? { inputMessages: events.input } : {}),
      ...(!genai.outputMessages && events.output ? { outputMessages: events.output } : {}),
      ...(!genai.systemInstructions && events.system ? { systemInstructions: events.system } : {}),
      ...(!genai.finishReasons && events.finishReasons ? { finishReasons: events.finishReasons } : {}),
    };
  }

  let agentKind: AgentSpanKind = 'other';
  const oiKind = str(span.attributes['openinference.span.kind']);
  const requestType = str(span.attributes['llm.request.type']); // OpenLLMetry's own kind of call
  if (otel?.operationName && Object.hasOwn(GENAI_OP_TO_KIND, otel.operationName)) {
    agentKind = GENAI_OP_TO_KIND[otel.operationName]!;
  } else if (oiKind && Object.hasOwn(OPENINFERENCE_KIND_MAP, oiKind)) {
    agentKind = OPENINFERENCE_KIND_MAP[oiKind]!;
  } else if (aiSdk?.operationName) {
    agentKind = aiSdkKind(aiSdk.operationName);
  } else if (genai && requestType && !otel?.operationName && Object.hasOwn(LLM_REQUEST_TYPE_TO_KIND, requestType)) {
    agentKind = LLM_REQUEST_TYPE_TO_KIND[requestType]!;
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
