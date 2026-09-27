import { estimateSpanCost } from './cost.js';
import type { PriceEntry } from './pricing.js';
import { spanDurationMs } from './types.js';
import type { ParsedSpan, ParsedTrace } from './types.js';
import { computeCriticalPath } from './critical-path.js';

export interface ModelUsageRow {
  model: string;
  provider?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number; // undefined if no call for this model had a price match
}

export interface TraceSummary {
  totalDurationMs: number;
  llmSelfTimeMs: number;
  toolSelfTimeMs: number;
  otherSelfTimeMs: number;
  spanCount: number;
  errorCount: number;
  retryCount: number;
  modelUsage: ModelUsageRow[];
  totalCostUsd?: number;
  uncostedCalls: number;
  criticalPath: ParsedSpan[];
}

/** Self time = a span's duration minus the union of its children's
 * durations — the time this span spent NOT inside a child, i.e. the time
 * actually attributable to it rather than to whatever it called. */
export function selfTimeNs(span: ParsedSpan): bigint {
  if (span.children.length === 0) return span.durationNs;
  // Clock skew and detached work can put children outside their parent.
  // Only the intersection can consume the parent's time.
  const sorted = span.children.map((child) => ({
    start: child.startTimeUnixNano > span.startTimeUnixNano ? child.startTimeUnixNano : span.startTimeUnixNano,
    end: child.endTimeUnixNano < span.endTimeUnixNano ? child.endTimeUnixNano : span.endTimeUnixNano,
  })).filter((child) => child.end > child.start)
    .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  if (sorted.length === 0) return span.durationNs;
  let covered = 0n;
  let curStart = sorted[0]!.start;
  let curEnd = sorted[0]!.end;
  for (const child of sorted.slice(1)) {
    if (child.start <= curEnd) {
      if (child.end > curEnd) curEnd = child.end;
    } else {
      covered += curEnd - curStart;
      curStart = child.start;
      curEnd = child.end;
    }
  }
  covered += curEnd - curStart;
  const self = span.durationNs - covered;
  return self > 0n ? self : 0n;
}

/** A tool-call span is treated as a retry when a same-parent, same-tool-name
 * sibling *tool* span precedes it — the shape produced by "attempt, fail,
 * attempt again" in the example traces, and a common real pattern. Only
 * `tool` spans are considered: repeated `llm` calls in a conversation are
 * normal turns, not retries, even though they often share a span name. */
function countRetries(spans: ParsedSpan[]): number {
  let retries = 0;
  const byParent = new Map<string, ParsedSpan[]>();
  for (const s of spans) {
    if (s.agentKind !== 'tool') continue;
    const key = s.parentSpanId ?? '';
    const list = byParent.get(key) ?? [];
    list.push(s);
    byParent.set(key, list);
  }
  for (const siblings of byParent.values()) {
    const seen = new Map<string, number>();
    const sorted = [...siblings].sort((a, b) => (a.startTimeUnixNano < b.startTimeUnixNano ? -1 : 1));
    for (const s of sorted) {
      const label = s.genai?.toolName ?? s.name;
      const count = seen.get(label) ?? 0;
      if (count > 0) retries += 1;
      seen.set(label, count + 1);
    }
  }
  return retries;
}

export function buildSummary(trace: ParsedTrace, priceTable: PriceEntry[]): TraceSummary {
  let llmSelf = 0n;
  let toolSelf = 0n;
  let otherSelf = 0n;
  let errorCount = 0;
  const usageByModel = new Map<string, ModelUsageRow>();
  let uncostedCalls = 0;

  for (const span of trace.spans) {
    const self = selfTimeNs(span);
    if (span.agentKind === 'llm') llmSelf += self;
    else if (span.agentKind === 'tool') toolSelf += self;
    else otherSelf += self;

    if (span.status.code === 'ERROR') errorCount += 1;

    if (span.agentKind === 'llm' && span.genai) {
      const model = span.genai.responseModel ?? span.genai.requestModel ?? '(unknown model)';
      const row = usageByModel.get(model) ?? {
        model,
        ...(span.genai.provider ? { provider: span.genai.provider } : {}),
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      row.calls += 1;
      row.inputTokens += span.genai.usage?.inputTokens ?? 0;
      row.outputTokens += span.genai.usage?.outputTokens ?? 0;
      const cost = estimateSpanCost(span.genai, priceTable);
      if (cost) {
        row.costUsd = (row.costUsd ?? 0) + cost.costUsd;
      } else {
        uncostedCalls += 1;
      }
      usageByModel.set(model, row);
    }
  }

  const totalCostUsd = [...usageByModel.values()].some((r) => r.costUsd !== undefined)
    ? [...usageByModel.values()].reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
    : undefined;

  return {
    totalDurationMs: Number(trace.maxEndNs - trace.minStartNs) / 1_000_000,
    llmSelfTimeMs: Number(llmSelf) / 1_000_000,
    toolSelfTimeMs: Number(toolSelf) / 1_000_000,
    otherSelfTimeMs: Number(otherSelf) / 1_000_000,
    spanCount: trace.spans.length,
    errorCount,
    retryCount: countRetries(trace.spans),
    modelUsage: [...usageByModel.values()].sort((a, b) => b.calls - a.calls),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    uncostedCalls,
    criticalPath: computeCriticalPath(trace),
  };
}

export { spanDurationMs };
