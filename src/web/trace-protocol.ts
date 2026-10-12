import type { TraceTransfer } from './trace-transfer.js';
import type { TraceInput } from '../core/types.js';

export const MAX_TRACE_BYTES = 25 * 1024 * 1024;
export const PARSE_TIMEOUT_MS = 30_000;
export type RetainedTraceSource = string | TraceInput[];
export type TraceSource = { kind: 'file'; file: File } | { kind: 'url'; url: string } | { kind: 'text'; text: string }
  | { kind: 'files'; files: File[] } | { kind: 'inputs'; inputs: TraceInput[] };
export interface ParseRequest { source: TraceSource; traceId?: string }
export type ParseResponse = { ok: true; trace: TraceTransfer; source: RetainedTraceSource | null } | { ok: false; error: string };
