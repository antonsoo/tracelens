import type { TraceTransfer } from './trace-transfer.js';

export const MAX_TRACE_BYTES = 25 * 1024 * 1024;
export const PARSE_TIMEOUT_MS = 30_000;
export type TraceSource = { kind: 'file'; file: File } | { kind: 'url'; url: string } | { kind: 'text'; text: string };
export interface ParseRequest { source: TraceSource; traceId?: string }
export type ParseResponse = { ok: true; trace: TraceTransfer; source: string | null } | { ok: false; error: string };
