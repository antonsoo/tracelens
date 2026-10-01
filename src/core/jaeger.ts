/**
 * Jaeger's native JSON (the Jaeger UI's "Download JSON", or the query API's
 * `/api/traces/{id}` response), converted to OTLP/JSON so it goes through the
 * same parser and validation as an OTLP export.
 *
 * Shape, from Jaeger's `model/json` package: `{"data": [Trace]}` or a bare
 * Trace, where a Trace is `{traceID, spans, processes}` and a Span is
 * `{traceID, spanID, operationName, references, startTime, duration, tags,
 * logs, processID}`. `startTime` and `duration` are **microseconds** (since
 * the Unix epoch, and elapsed), and each tag is `{key, type, value}` with type
 * `string`, `bool`, `int64`, `float64` or `binary`. The span kind and the
 * OpenTelemetry status travel as the tags `span.kind`, `otel.status_code`
 * and `otel.status_description` (plus the older `error: true`), and the
 * instrumentation scope as `otel.scope.name` / `otel.scope.version` (older
 * Jaeger: `otel.library.*`); they become the OTLP fields and leave the
 * attribute list.
 */

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isJaegerTrace(v: unknown): v is Json {
  return isRecord(v) && Array.isArray(v.spans) && (isRecord(v.processes) || 'traceID' in v);
}

/** True for a Jaeger JSON document: `{"data": [trace, ...]}` or one bare trace. */
export function isJaegerJson(json: unknown): boolean {
  if (isJaegerTrace(json)) return true;
  return isRecord(json) && Array.isArray(json.data) && json.data.length > 0 && json.data.every(isJaegerTrace);
}

const SPAN_KIND: Record<string, number> = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 };
const SCOPE_NAME_TAGS = ['otel.scope.name', 'otel.library.name'];
const SCOPE_VERSION_TAGS = ['otel.scope.version', 'otel.library.version'];
const LIFTED_TAGS = new Set(['span.kind', 'otel.status_code', 'otel.status_description', ...SCOPE_NAME_TAGS, ...SCOPE_VERSION_TAGS]);

/** Microseconds (number or decimal string) to a decimal nanosecond string; undefined if invalid. */
function microsToNanos(raw: unknown): string | undefined {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return (BigInt(raw) * 1000n).toString();
  if (typeof raw === 'string' && /^\d{1,17}$/.test(raw)) return (BigInt(raw) * 1000n).toString();
  return undefined;
}

function addMicros(start: unknown, duration: unknown): string | undefined {
  const s = microsToNanos(start);
  const d = microsToNanos(duration ?? 0);
  return s === undefined || d === undefined ? undefined : (BigInt(s) + BigInt(d)).toString();
}

/** A tag value as text: primitives as themselves, anything else as JSON. */
function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value) ?? '';
}

/** A Jaeger tag value as an OTLP AnyValue, by its declared type. */
function anyValue(tag: Json): Json {
  const value = tag.value;
  switch (tag.type) {
    case 'bool':
      return { boolValue: value === true || value === 'true' };
    case 'int64':
      return { intValue: asText(value) };
    case 'float64':
      return { doubleValue: typeof value === 'number' ? value : Number(value) };
    default:
      if (typeof value === 'boolean') return { boolValue: value };
      if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
      return { stringValue: asText(value) };
  }
}

function tagList(raw: unknown): Json[] {
  return Array.isArray(raw) ? raw.filter((t): t is Json => isRecord(t) && typeof t.key === 'string') : [];
}

function attributes(tags: Json[]): Json[] {
  return tags.filter((t) => !LIFTED_TAGS.has(t.key as string)).map((t) => ({ key: t.key, value: anyValue(t) }));
}

function status(tags: Json[]): Json | undefined {
  const byKey = new Map(tags.map((t) => [t.key as string, t.value]));
  const code = asText(byKey.get('otel.status_code')).toUpperCase();
  const message = byKey.get('otel.status_description');
  const failed = code === 'ERROR' || byKey.get('error') === true || byKey.get('error') === 'true';
  if (!failed && code !== 'OK') return undefined;
  return { code: failed ? 'STATUS_CODE_ERROR' : 'STATUS_CODE_OK', ...(typeof message === 'string' ? { message } : {}) };
}

function parentOf(span: Json): string | undefined {
  const refs = Array.isArray(span.references) ? span.references.filter(isRecord) : [];
  // CHILD_OF is the parent; a span that only FOLLOWS_FROM another is drawn under that one.
  const ref = refs.find((r) => r.refType === 'CHILD_OF') ?? refs.find((r) => r.refType === 'FOLLOWS_FROM');
  if (ref && typeof ref.spanID === 'string') return ref.spanID;
  return typeof span.parentSpanID === 'string' && span.parentSpanID !== '' ? span.parentSpanID : undefined;
}

function events(logs: unknown): Json[] {
  if (!Array.isArray(logs)) return [];
  return logs.filter(isRecord).map((log) => {
    const fields = tagList(log.fields);
    const named = fields.find((f) => f.key === 'event') ?? fields.find((f) => f.key === 'message');
    return {
      // An invalid timestamp is left for the OTLP parser to reject with its own warning.
      timeUnixNano: microsToNanos(log.timestamp) ?? log.timestamp,
      name: named ? asText(named.value) : 'log',
      attributes: attributes(fields.filter((f) => f !== named)),
    };
  });
}

/** Converts a Jaeger JSON document (see `isJaegerJson`) to an OTLP/JSON `ExportTraceServiceRequest`. */
export function jaegerToOtlp(json: unknown): { resourceSpans: Json[] } {
  const traces = isJaegerTrace(json) ? [json] : isRecord(json) && Array.isArray(json.data) ? json.data.filter(isJaegerTrace) : [];
  const resourceSpans: Json[] = [];
  for (const trace of traces) {
    const processes = isRecord(trace.processes) ? trace.processes : {};
    // Spans grouped by process (the OTLP resource), then by instrumentation scope.
    const byProcess = new Map<string, Map<string, { scope: Json; spans: Json[] }>>();
    const embedded = new Map<string, unknown>();
    (trace.spans as unknown[]).forEach((raw, i) => {
      if (!isRecord(raw)) return;
      const tags = tagList(raw.tags);
      const kind = tags.find((t) => t.key === 'span.kind');
      const parent = parentOf(raw);
      const spanStatus = status(tags);
      const start = microsToNanos(raw.startTime);
      const span: Json = {
        traceId: raw.traceID ?? trace.traceID,
        spanId: raw.spanID,
        ...(parent ? { parentSpanId: parent } : {}),
        name: typeof raw.operationName === 'string' ? raw.operationName : '(unnamed span)',
        kind: kind ? (SPAN_KIND[asText(kind.value).toLowerCase()] ?? 0) : 0,
        // Invalid times are passed through so the OTLP parser skips the span with its warning.
        startTimeUnixNano: start ?? raw.startTime,
        endTimeUnixNano: addMicros(raw.startTime, raw.duration) ?? raw.startTime,
        attributes: attributes(tags),
        events: events(raw.logs),
        ...(spanStatus ? { status: spanStatus } : {}),
      };
      // A span may carry its process inline instead of by processID.
      const processId = typeof raw.processID === 'string' ? raw.processID : `inline-${i}`;
      if (!(typeof raw.processID === 'string') && isRecord(raw.process)) embedded.set(processId, raw.process);
      const scopeName = tags.find((t) => SCOPE_NAME_TAGS.includes(t.key as string))?.value;
      const scopeVersion = tags.find((t) => SCOPE_VERSION_TAGS.includes(t.key as string))?.value;
      const scope: Json = {
        ...(typeof scopeName === 'string' ? { name: scopeName } : {}),
        ...(typeof scopeVersion === 'string' ? { version: scopeVersion } : {}),
      };
      const scopes = byProcess.get(processId) ?? new Map<string, { scope: Json; spans: Json[] }>();
      const scopeKey = JSON.stringify([scope.name ?? '', scope.version ?? '']);
      const group = scopes.get(scopeKey) ?? { scope, spans: [] };
      group.spans.push(span);
      scopes.set(scopeKey, group);
      byProcess.set(processId, scopes);
    });
    for (const [processId, scopes] of byProcess) {
      const process = processes[processId] ?? embedded.get(processId);
      const resource: Json[] = [];
      if (isRecord(process)) {
        if (typeof process.serviceName === 'string') resource.push({ key: 'service.name', value: { stringValue: process.serviceName } });
        resource.push(...attributes(tagList(process.tags)));
      }
      const scopeSpans = [...scopes.values()].map(({ scope, spans }) => (Object.keys(scope).length > 0 ? { scope, spans } : { spans }));
      resourceSpans.push({ resource: { attributes: resource }, scopeSpans });
    }
  }
  return { resourceSpans };
}
