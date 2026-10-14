import { decodeAnyValue, decodeAttributes } from './attributes.js';
import { normalizeId } from './identity.js';
import { assertPayloadDepth, TraceParseError } from './payload-depth.js';
import type { ParsedSpan, ParsedTrace, ParseWarning, TraceLogRecord } from './types.js';

export interface LogBatch { json: unknown; line?: number }
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function collectionKey(value: Record<string, unknown>, camel: string, snake: string): string {
  if (value[camel] != null && value[snake] != null) {
    throw new TraceParseError(`Log export contains both ${camel} and ${snake}. Keep one collection spelling so no records are hidden.`);
  }
  return value[camel] != null || !(snake in value) ? camel : snake;
}

export function hasLogSignal(json: unknown): boolean {
  return record(json) && ('resourceLogs' in json || 'resource_logs' in json);
}

function timestamp(value: unknown): bigint | undefined {
  if (value === undefined || value === null || value === '0' || value === 0) return undefined;
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return undefined;
  if (typeof value === 'string' && !/^\d{1,20}$/.test(value)) return undefined;
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const result = BigInt(value);
  return result > 0n && result <= 18_446_744_073_709_551_615n ? result : undefined;
}

/** Missing IDs, malformed records and unsupported bodies remain inspectable. */
export function collectLogs(batches: readonly LogBatch[], warnings: ParseWarning[], file?: ParsedSpan['sourceFile']): TraceLogRecord[] {
  const logs: TraceLogRecord[] = [];
  for (const batch of batches) {
    assertPayloadDepth(batch.json);
    if (!record(batch.json) || !hasLogSignal(batch.json)) continue;
    const source = (path: string): TraceLogRecord['source'] => ({ path,
      ...(batch.line === undefined ? {} : { line: batch.line }), ...(file ? { file } : {}),
    });
    const warn = (path: string, message: string): void => {
      const where = `${file ? `File ${file.index} (${file.name}): ` : ''}${batch.line ? `line ${batch.line}, ` : ''}${path}`;
      warnings.push({ message: `${where}: ${message}`, ...(file ? { sourceFile: file } : {}) });
    };
    const array = (value: unknown, path: string): unknown[] => {
      if (value === undefined || value === null) return [];
      if (Array.isArray(value)) return value;
      warn(path, 'expected an array; the number of missing log records is unknown.');
      return [];
    };
    const resourceKey = collectionKey(batch.json, 'resourceLogs', 'resource_logs');
    for (const [ri, resource] of array(batch.json[resourceKey], resourceKey).entries()) {
      const rp = `${resourceKey}[${ri}]`;
      if (!record(resource)) { warn(rp, 'invalid resource entry; contained log records are unknown.'); continue; }
      const attrs = record(resource.resource) ? resource.resource.attributes : undefined;
      const resourceAttributes = decodeAttributes(attrs, message => warn(rp, message), `${rp}.resource.attributes`);
      const scopeKey = collectionKey(resource, 'scopeLogs', 'scope_logs');
      for (const [si, scope] of array(resource[scopeKey], `${rp}.${scopeKey}`).entries()) {
        const sp = `${rp}.${scopeKey}[${si}]`;
        if (!record(scope)) { warn(sp, 'invalid scope entry; contained log records are unknown.'); continue; }
        const info = record(scope.scope) ? scope.scope : {};
        const logKey = collectionKey(scope, 'logRecords', 'log_records');
        for (const [li, raw] of array(scope[logKey], `${sp}.${logKey}`).entries()) {
          const path = `${sp}.${logKey}[${li}]`;
          if (!record(raw)) {
            warn(path, 'invalid log record; retained without span attribution.');
            logs.push({ raw, attributes: {}, resourceAttributes, source: source(path) });
            continue;
          }
          const identity = (camel: string, snake: string, bytes: 8 | 16): string => {
            const first = normalizeId(raw[camel], bytes), second = normalizeId(raw[snake], bytes);
            if (raw[camel] != null && raw[snake] != null && first !== second) {
              warn(path, `conflicting ${camel} spellings; the record cannot be attributed to a span.`);
              return '';
            }
            return first || second;
          };
          const traceId = identity('traceId', 'trace_id', 16);
          const spanId = identity('spanId', 'span_id', 8);
          const field = (camel: string, snake: string): unknown => {
            if (raw[camel] != null && raw[snake] != null) {
              warn(path, `both ${camel} and ${snake} are present; kept the raw fields without selecting a value.`);
              return undefined;
            }
            return raw[camel] ?? raw[snake];
          };
          // All-zero trace context means absent, not a real correlation target.
          const hasTrace = Boolean(traceId && !/^0+$/.test(traceId));
          const hasSpan = Boolean(spanId && !/^0+$/.test(spanId));
          const eventName = field('eventName', 'event_name');
          const attributes = decodeAttributes(raw.attributes, message => warn(path, message), `${path}.attributes`);
          const times: { timeUnixNano?: bigint; observedTimeUnixNano?: bigint } = {};
          for (const [camel, snake] of [['timeUnixNano', 'time_unix_nano'], ['observedTimeUnixNano', 'observed_time_unix_nano']] as const) {
            const value = field(camel, snake);
            const parsed = timestamp(value);
            if (parsed !== undefined) times[camel] = parsed;
            else if (value !== undefined && value !== null && value !== '0' && value !== 0) {
              warn(path, `invalid ${camel}; kept the raw value, without inventing an event time.`);
            }
          }
          const droppedRaw = field('droppedAttributesCount', 'dropped_attributes_count');
          let dropped: number | undefined;
          if (droppedRaw !== undefined && droppedRaw !== null) {
            const count = typeof droppedRaw === 'string' && /^\d+$/.test(droppedRaw) ? Number(droppedRaw) : droppedRaw;
            if (typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 0xffffffff) {
              dropped = count;
              if (count) warn(path, `${count} log attributes were dropped before export; their content is unavailable.`);
            } else warn(path, 'invalid droppedAttributesCount; the omission count is unknown.');
          }
          logs.push({ raw, source: source(path), attributes, resourceAttributes, ...times,
            ...(hasTrace ? { traceId } : {}), ...(hasSpan ? { spanId } : {}),
            ...(typeof eventName === 'string' ? { eventName } : {}),
            ...(Object.hasOwn(raw, 'body') ? { body: decodeAnyValue(raw.body, message => warn(path, message), `${path}.body`) } : {}),
            ...(typeof info.name === 'string' ? { scopeName: info.name } : {}),
            ...(typeof info.version === 'string' ? { scopeVersion: info.version } : {}),
            ...(dropped !== undefined ? { droppedAttributesCount: dropped } : {}),
          });
        }
      }
    }
  }
  return logs;
}

/** Identity is the only join key. Neither name, timestamp nor file order fills a missing ID. */
export function correlateLogs(spans: ParsedSpan[], logs: TraceLogRecord[], warnings: ParseWarning[]): TraceLogRecord[] {
  const targets = new Map<string, Map<string, ParsedSpan | null>>();
  for (const span of spans) {
    let trace = targets.get(span.traceId);
    if (!trace) { trace = new Map(); targets.set(span.traceId, trace); }
    trace.set(span.spanId, trace.has(span.spanId) ? null : span);
  }
  const unmatched: TraceLogRecord[] = [];
  for (const log of logs) {
    const span = log.traceId && log.spanId ? targets.get(log.traceId)?.get(log.spanId) : undefined;
    if (span) (span.logs ??= []).push(log);
    else unmatched.push(log);
  }
  if (unmatched.length) warnings.push({
    message: `${unmatched.length} log record(s) could not be matched to exactly one imported span by traceId and spanId. They remain available as unmatched log evidence; no calls, durations or errors were inferred from them.`,
  });
  return unmatched;
}

/** Flat evidence report; log records never change elapsed time or token totals. */
export function buildLogsReport(trace: ParsedTrace) {
  return {
    schemaVersion: 1,
    format: 'tracelens-log-evidence',
    traceId: trace.traceId,
    sourceFormat: trace.sourceFormat,
    ...(trace.inputFiles ? { inputFiles: trace.inputFiles } : {}),
    matchedRecords: trace.spans.reduce((sum, span) => sum + (span.logs?.length ?? 0), 0),
    spans: trace.spans.filter(span => span.logs?.length).map(span => ({
      traceId: span.traceId, spanId: span.spanId, name: span.name, logs: span.logs!,
      ...(span.genai?.inputMessages ? { inputMessages: span.genai.inputMessages } : {}),
      ...(span.genai?.outputMessages ? { outputMessages: span.genai.outputMessages } : {}),
      ...(span.genai?.systemInstructions ? { systemInstructions: span.genai.systemInstructions } : {}),
    })),
    unmatched: trace.unmatchedLogs ?? [],
    warnings: trace.warnings,
    notes: ['Matched records belong to the selected trace; unmatched records cover all selected files.',
      'A log needs both traceId and spanId to join exactly one imported span. File order, names and clocks are not matching keys.',
      'Span attributes and span events take precedence over log message content. Other log bodies remain evidence without an inferred message schema.'],
  };
}
