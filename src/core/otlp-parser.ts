// Parses OTLP/JSON trace exports — the shape produced by the OpenTelemetry
// Collector's file/JSON exporter, or by protobuf's `MessageToJson` on an
// `ExportTraceServiceRequest`: resourceSpans -> scopeSpans -> spans, with
// every attribute value as a typed `AnyValue` object. Spec:
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/common/v1/common.proto
// (verified against the `main` branch, 2026-09-24).
import type { AttrMap, ParseWarning, ParsedSpan, ParsedTrace, SpanEvent, SpanKind, StatusCode } from './types.js';
import { normalizeSpan } from './normalize.js';

const SPAN_KIND_BY_NUMBER: Record<number, SpanKind> = {
  0: 'UNSPECIFIED',
  1: 'INTERNAL',
  2: 'SERVER',
  3: 'CLIENT',
  4: 'PRODUCER',
  5: 'CONSUMER',
};

const STATUS_CODE_BY_NUMBER: Record<number, StatusCode> = {
  0: 'UNSET',
  1: 'OK',
  2: 'ERROR',
};

export class TraceParseError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Decodes a single OTLP `AnyValue` (typed union) into a plain JS value. */
export function decodeAnyValue(v: unknown): unknown {
  if (!isRecord(v)) return v ?? null;
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return Boolean(v.boolValue);
  if ('intValue' in v) {
    const raw = v.intValue;
    const n = typeof raw === 'string' ? Number(raw) : (raw as number);
    return Number.isSafeInteger(n) ? n : raw; // keep huge ints as their raw string
  }
  if ('doubleValue' in v) return v.doubleValue;
  if ('bytesValue' in v) return v.bytesValue; // base64 string, left as-is
  if ('arrayValue' in v) {
    const arr = v.arrayValue;
    const values = isRecord(arr) && Array.isArray(arr.values) ? arr.values : [];
    return values.map(decodeAnyValue);
  }
  if ('kvlistValue' in v) {
    const kv = v.kvlistValue;
    const values = isRecord(kv) && Array.isArray(kv.values) ? kv.values : [];
    const out: AttrMap = {};
    for (const entry of values) {
      if (isRecord(entry) && typeof entry.key === 'string') {
        out[entry.key] = decodeAnyValue(entry.value);
      }
    }
    return out;
  }
  return null;
}

function decodeAttributes(list: unknown): AttrMap {
  const out: AttrMap = {};
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (isRecord(entry) && typeof entry.key === 'string') {
      out[entry.key] = decodeAnyValue(entry.value);
    }
  }
  return out;
}

function toBigNanos(raw: unknown): bigint {
  if (raw === undefined || raw === null) return 0n;
  if (typeof raw === 'string') {
    try {
      return BigInt(raw);
    } catch {
      return 0n;
    }
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return BigInt(Math.round(raw));
  return 0n;
}

const VALID_SPAN_KIND_NAMES = new Set<string>(Object.values(SPAN_KIND_BY_NUMBER));

function decodeSpanKind(raw: unknown): SpanKind {
  if (typeof raw === 'number') return SPAN_KIND_BY_NUMBER[raw] ?? 'UNSPECIFIED';
  if (typeof raw === 'string') {
    const cleaned = raw.replace('SPAN_KIND_', '');
    if (VALID_SPAN_KIND_NAMES.has(cleaned)) return cleaned as SpanKind;
  }
  return 'UNSPECIFIED';
}

function decodeStatus(raw: unknown): { code: StatusCode; message?: string } {
  if (!isRecord(raw)) return { code: 'UNSET' };
  const codeRaw = raw.code;
  let code: StatusCode = 'UNSET';
  if (typeof codeRaw === 'number') code = STATUS_CODE_BY_NUMBER[codeRaw] ?? 'UNSET';
  else if (typeof codeRaw === 'string') {
    const cleaned = codeRaw.replace('STATUS_CODE_', '');
    if (cleaned === 'OK' || cleaned === 'ERROR' || cleaned === 'UNSET') code = cleaned;
  }
  const message = typeof raw.message === 'string' ? raw.message : undefined;
  return message !== undefined ? { code, message } : { code };
}

function decodeEvents(raw: unknown): SpanEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => {
    const rec = isRecord(e) ? e : {};
    return {
      name: typeof rec.name === 'string' ? rec.name : '',
      timeUnixNano: toBigNanos(rec.timeUnixNano ?? rec.time_unix_nano),
      attributes: decodeAttributes(rec.attributes),
    };
  });
}

function hexId(raw: unknown): string {
  if (typeof raw === 'string') return raw.toLowerCase();
  return '';
}

/**
 * Parses a raw OTLP/JSON `ExportTraceServiceRequest` document (or a bare
 * `resourceSpans` array) into a flat span list plus a computed tree. Throws
 * `TraceParseError` on structurally invalid input; individual malformed
 * spans are skipped with a warning rather than aborting the whole parse.
 */
export function parseOtlpJson(json: unknown): ParsedTrace {
  const root = isRecord(json) ? json : { resourceSpans: json };
  const resourceSpans = root.resourceSpans ?? root.resource_spans;
  if (!Array.isArray(resourceSpans)) {
    throw new TraceParseError(
      'Not a recognizable OTLP/JSON trace export: expected a top-level "resourceSpans" array.',
    );
  }
  if (resourceSpans.length === 0) {
    throw new TraceParseError('This trace file has no resourceSpans — nothing to show.');
  }

  const flat: ParsedSpan[] = [];
  const warnings: ParseWarning[] = [];
  let traceId = '';

  for (const rs of resourceSpans) {
    if (!isRecord(rs)) continue;
    const resourceAttributes = decodeAttributes(isRecord(rs.resource) ? rs.resource.attributes : undefined);
    const scopeSpans = rs.scopeSpans ?? rs.scope_spans;
    if (!Array.isArray(scopeSpans)) continue;

    for (const ss of scopeSpans) {
      if (!isRecord(ss)) continue;
      const scope = ss.scope;
      const scopeName = isRecord(scope) && typeof scope.name === 'string' ? scope.name : undefined;
      const scopeVersion = isRecord(scope) && typeof scope.version === 'string' ? scope.version : undefined;
      const spans = ss.spans;
      if (!Array.isArray(spans)) continue;

      for (const raw of spans) {
        if (!isRecord(raw)) {
          warnings.push({ message: 'Skipped a non-object entry in "spans".' });
          continue;
        }
        const spanId = hexId(raw.spanId ?? raw.span_id);
        const spanTraceId = hexId(raw.traceId ?? raw.trace_id);
        if (!spanId || !spanTraceId) {
          warnings.push({ message: `Skipped a span with a missing traceId/spanId (name: ${String(raw.name)}).` });
          continue;
        }
        if (!traceId) traceId = spanTraceId;

        const start = toBigNanos(raw.startTimeUnixNano ?? raw.start_time_unix_nano);
        let end = toBigNanos(raw.endTimeUnixNano ?? raw.end_time_unix_nano);
        if (end < start) {
          warnings.push({
            message: `Span "${String(raw.name)}" has an end time before its start time (clock skew?) — clamped to start.`,
            spanId,
          });
          end = start;
        }

        const parentRaw = raw.parentSpanId ?? raw.parent_span_id;
        const parentSpanId = typeof parentRaw === 'string' && parentRaw.length > 0 ? hexId(parentRaw) : undefined;

        const attributes = decodeAttributes(raw.attributes);

        const base: ParsedSpan = {
          traceId: spanTraceId,
          spanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          name: typeof raw.name === 'string' ? raw.name : '(unnamed span)',
          kind: decodeSpanKind(raw.kind),
          startTimeUnixNano: start,
          endTimeUnixNano: end,
          durationNs: end - start,
          status: decodeStatus(raw.status),
          attributes,
          events: decodeEvents(raw.events),
          resourceAttributes,
          ...(scopeName ? { scopeName } : {}),
          ...(scopeVersion ? { scopeVersion } : {}),
          agentKind: 'other',
          convention: 'none',
          depth: 0,
          children: [],
        };
        flat.push(normalizeSpan(base));
      }
    }
  }

  if (flat.length === 0) {
    throw new TraceParseError('No valid spans were found in this file.');
  }

  const byId = new Map(flat.map((s) => [s.spanId, s] as const));
  const roots: ParsedSpan[] = [];
  for (const span of flat) {
    if (span.parentSpanId && byId.has(span.parentSpanId)) {
      byId.get(span.parentSpanId)!.children.push(span);
    } else {
      if (span.parentSpanId && !byId.has(span.parentSpanId)) {
        warnings.push({
          message: `Span "${span.name}" references a parent (${span.parentSpanId}) not present in this file — shown as a root.`,
          spanId: span.spanId,
        });
      }
      roots.push(span);
    }
  }

  const assignDepth = (span: ParsedSpan, depth: number): void => {
    span.depth = depth;
    span.children.sort((a, b) => (a.startTimeUnixNano < b.startTimeUnixNano ? -1 : 1));
    for (const child of span.children) assignDepth(child, depth + 1);
  };
  roots.sort((a, b) => (a.startTimeUnixNano < b.startTimeUnixNano ? -1 : 1));
  for (const r of roots) assignDepth(r, 0);

  let minStart = flat[0]!.startTimeUnixNano;
  let maxEnd = flat[0]!.endTimeUnixNano;
  for (const s of flat) {
    if (s.startTimeUnixNano < minStart) minStart = s.startTimeUnixNano;
    if (s.endTimeUnixNano > maxEnd) maxEnd = s.endTimeUnixNano;
  }

  return {
    traceId,
    spans: flat,
    roots,
    minStartNs: minStart,
    maxEndNs: maxEnd,
    warnings,
    sourceFormat: 'otlp-json',
  };
}
