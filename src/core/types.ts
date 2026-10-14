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

export type StatusCode = 'UNSET' | 'OK' | 'ERROR' | 'UNKNOWN';

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
export type Convention = 'otel-genai' | 'openinference' | 'vercel-ai' | 'none';

export interface AttrMap {
  [key: string]: unknown;
}

export interface SpanEvent {
  name: string;
  timeUnixNano: bigint;
  attributes: AttrMap;
  /** Exporter-reported attributes missing from this retained event. */
  droppedAttributesCount?: number;
}

/** A separately exported OTLP log, never an invented span or span event. */
export interface TraceLogRecord {
  traceId?: string;
  spanId?: string;
  eventName?: string;
  timeUnixNano?: bigint;
  observedTimeUnixNano?: bigint;
  attributes: AttrMap;
  body?: unknown;
  resourceAttributes: AttrMap;
  scopeName?: string;
  scopeVersion?: string;
  droppedAttributesCount?: number;
  /** The original decoded record keeps severity, flags and unknown fields. */
  raw: unknown;
  source: { path: string; line?: number; file?: { index: number; name: string } };
}

export interface SpanLink {
  traceId: string;
  spanId: string;
  attributes: AttrMap;
  traceState?: string;
  flags?: number;
  droppedAttributesCount?: number;
  /** Resolution in this imported file, never a request to an external service. */
  target?: { status: 'available' | 'missing-trace' | 'missing-span' | 'ambiguous'; name?: string };
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
  /** Present but invalid fields must not be mistaken for absent optional counts. */
  invalidFields?: string[];
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
  /** Original file in a combined import; index is one-based to distinguish equal names. */
  sourceFile?: { index: number; name: string };
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  durationNs: bigint;
  status: { code: StatusCode; message?: string; raw?: unknown };
  attributes: AttrMap;
  events: SpanEvent[];
  /** Correlated by both trace and span identity, independently of timestamps. */
  logs?: TraceLogRecord[];
  /** Exporter-reported omissions; absent has the OTLP default of zero. */
  droppedAttributesCount?: number;
  droppedEventsCount?: number;
  links?: SpanLink[];
  /** Exporter-reported omissions; absent has the OTLP default of zero. */
  droppedLinksCount?: number;
  /** Malformed records skipped during import, separate from exporter omissions. */
  invalidLinkCount?: number;
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
  /** Import can remain inspectable while a quantitative comparison is unsupported. */
  comparisonIssue?: 'span-inventory' | 'span-timing' | 'span-ancestry';
  sourceFile?: { index: number; name: string };
  spanId?: string;
  /** The trace the warning is about, when it is about one: a file can hold several. */
  traceId?: string;
}

/** One trace found in a file: enough to tell the runs apart and pick one. */
export interface TraceListing {
  traceId: string;
  spanCount: number;
  /** The name of its earliest root span (a span whose parent is not in the file). */
  rootName: string;
  startNs: bigint;
  durationNs: bigint;
}

export interface ParsedTrace {
  traceId: string;
  spans: ParsedSpan[]; // flat, includes all spans
  roots: ParsedSpan[]; // spans with no resolvable parent in this trace
  minStartNs: bigint;
  maxEndNs: bigint;
  warnings: ParseWarning[];
  /** Logs lacking exactly one matching span, retained separately from measurements. */
  unmatchedLogs?: TraceLogRecord[];
  /** The file's format: Jaeger JSON is converted to OTLP/JSON before parsing. */
  sourceFormat: 'otlp-json' | 'jaeger-json' | 'mixed-json';
  inputFiles?: { name: string; spanCount: number; logCount?: number; sourceFormat: 'otlp-json' | 'jaeger-json' }[];
  /**
   * Every trace in the file, in order of start time. A collector's export
   * holds whatever passed through it; `spans` and `roots` are one of them
   * (see `ParseOptions.traceId`), and this is the list to choose from.
   */
  traces: TraceListing[];
}

/** Decoded file text, retained locally when selecting another trace in a group. */
export interface TraceInput { name: string; text: string }

export function spanDurationMs(span: ParsedSpan): number {
  return Number(span.durationNs) / 1_000_000;
}
