// Core, framework-agnostic types for a parsed agent trace. Nothing in this
// file knows about OTLP wire format, HTML, or the CLI — it is the shared
// vocabulary that src/core/otlp-parser.ts produces and src/web + src/cli
// consume.

/** OTel span kinds, decoded from either the numeric OTLP enum or its name. */
export type SpanKind =
  | 'UNSPECIFIED'
  | 'INTERNAL'
  | 'SERVER'
  | 'CLIENT'
  | 'PRODUCER'
  | 'CONSUMER';

export type StatusCode = 'UNSET' | 'OK' | 'ERROR';

/** The high-level "shape" tracelens buckets a span into for coloring and rollups. */
export type AgentSpanKind =
  | 'agent'
  | 'llm'
  | 'tool'
  | 'chain'
  | 'retriever'
  | 'embedding'
  | 'reranker'
  | 'guardrail'
  | 'evaluator'
  | 'other';

/** Which semantic convention(s) contributed attributes to a span. */
export type Convention = 'otel-genai' | 'openinference' | 'none';

export interface AttrMap {
  [key: string]: unknown;
}

export interface SpanEvent {
  name: string;
  timeUnixNano: bigint;
  attributes: AttrMap;
}

export interface NormalizedMessagePart {
  type: string; // "text" | "tool_call" | "tool_call_response" | ...
  content?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  response?: unknown;
}

export interface NormalizedMessage {
  role: string;
  parts: NormalizedMessagePart[];
}

/** Token usage, normalized across gen_ai.usage.* and llm.token_count.* naming. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

/** GenAI-specific fields extracted from either supported convention. */
export interface GenAiInfo {
  operationName?: string;
  provider?: string;
  requestModel?: string;
  responseModel?: string;
  agentName?: string;
  conversationId?: string;
  temperature?: number;
  maxTokens?: number;
  finishReasons?: string[];
  usage?: TokenUsage;
  inputMessages?: NormalizedMessage[];
  outputMessages?: NormalizedMessage[];
  systemInstructions?: NormalizedMessage[];
  toolName?: string;
  toolCallId?: string;
  toolDescription?: string;
  toolType?: string;
  toolArguments?: unknown;
  toolResult?: unknown;
  errorType?: string;
}

export interface ParsedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  durationNs: bigint;
  status: { code: StatusCode; message?: string };
  attributes: AttrMap;
  events: SpanEvent[];
  resourceAttributes: AttrMap;
  scopeName?: string;
  scopeVersion?: string;

  // derived during normalization
  agentKind: AgentSpanKind;
  convention: Convention;
  genai?: GenAiInfo;

  // derived during tree-building
  depth: number;
  children: ParsedSpan[];
}

export interface ParseWarning {
  message: string;
  spanId?: string;
}

export interface ParsedTrace {
  traceId: string;
  spans: ParsedSpan[]; // flat, includes all spans
  roots: ParsedSpan[]; // spans with no resolvable parent in this trace
  minStartNs: bigint;
  maxEndNs: bigint;
  warnings: ParseWarning[];
  sourceFormat: 'otlp-json';
}

export function spanDurationMs(span: ParsedSpan): number {
  return Number(span.durationNs) / 1_000_000;
}
