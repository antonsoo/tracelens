import { isModelCall, isTokenCount, modelOutputTokens, reportedModel } from './cost.js';
import { buildCostReport } from './cost-report.js';
import type { TraceCostReport } from './cost-report.js';
import type { PriceEntry } from './pricing.js';
import { spanDurationMs } from './types.js';
import type { ParsedSpan, ParsedTrace } from './types.js';
import { computeCriticalPath } from './critical-path.js';
import { buildTiming, selfIntervals } from './timing.js';
import type { TraceTiming } from './timing.js';
import { isKnownStatusCode } from './status.js';

export interface ModelUsageRow {
  model: string;
  provider?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  missingInputCalls: number;
  missingOutputCalls: number;
  uncostedCalls: number;
  costUsd?: number; // undefined if no call for this model had a price match
}

export interface TraceSummary {
  totalDurationMs: number;
  llmSelfTimeMs: number;
  toolSelfTimeMs: number;
  otherSelfTimeMs: number;
  spanCount: number;
  errorCount: number;
  /** Present only when retained spans lack a decodable status outcome. */
  unknownStatusCount?: number;
  retryCount: number;
  /** Repetitions whose preceding outcome is unreadable or ambiguous among timestamp peers. */
  unknownRetryCount?: number;
  modelUsage: ModelUsageRow[];
  /** Known subtotal; consult costReport.estimatedCostUsd for full-estimate availability. */
  totalCostUsd?: number;
  uncostedCalls: number;
  criticalPath: ParsedSpan[];
  timing: TraceTiming;
  costReport: TraceCostReport;
}

/** Self time = a span's duration minus the union of its children's
 * durations — the time this span spent NOT inside a child, i.e. the time
 * actually attributable to it rather than to whatever it called. */
export function selfTimeNs(span: ParsedSpan): bigint {
  return selfIntervals(span).reduce((sum, piece) => sum + piece.end - piece.start, 0n);
}

/** A possible retry follows a failed, completed same-parent tool call.
 * The trace cannot prove identical intent; successful repetitions and
 * overlapping calls alone are not evidence of a retry. */
function countRetries(spans: ParsedSpan[]): { count: number; unknown: number } {
  let retries = 0;
  let unknown = 0;
  const byTool = new Map<string, ParsedSpan[]>();
  for (const s of spans) {
    if (s.agentKind !== 'tool') continue;
    const key = JSON.stringify([s.traceId, s.parentSpanId ?? '', s.genai?.toolName ?? s.name]);
    const list = byTool.get(key) ?? [];
    list.push(s);
    byTool.set(key, list);
  }
  for (const calls of byTool.values()) {
    calls.sort((a, b) => (a.startTimeUnixNano < b.startTimeUnixNano ? -1 : a.startTimeUnixNano > b.startTimeUnixNano ? 1 : 0));
    let previous: ParsedSpan[] = [];
    for (let i = 0; i < calls.length;) {
      const start = calls[i]!.startTimeUnixNano;
      let end = i + 1;
      while (end < calls.length && calls[end]!.startTimeUnixNano === start) end++;
      // Equal-start peers have no order. Each call in this batch must see the
      // same preceding batch, rather than whichever record happened to be last.
      let yes = false;
      let no = false;
      let unreadable = false;
      for (const candidate of previous) {
        if (candidate.endTimeUnixNano > start) no = true;
        else if (candidate.status.code === 'ERROR') yes = true;
        else if (isKnownStatusCode(candidate.status.code)) no = true;
        else unreadable = true;
      }
      if (unreadable || (yes && no)) unknown += end - i;
      else if (yes) retries += end - i;
      previous = calls.slice(i, end);
      i = end;
    }
  }
  return { count: retries, unknown };
}

export function buildSummary(trace: ParsedTrace, priceTable: PriceEntry[]): TraceSummary {
  let llmSelf = 0n;
  let toolSelf = 0n;
  let otherSelf = 0n;
  let errorCount = 0;
  let unknownStatusCount = 0;
  const usageByModel = new Map<string, ModelUsageRow>();
  const costReport = buildCostReport(trace, priceTable);
  const costBySpan = new Map(costReport.rows.map((row) => [row.spanId, row.result]));

  for (const span of trace.spans) {
    const self = selfTimeNs(span);
    if (span.agentKind === 'llm') llmSelf += self;
    else if (span.agentKind === 'tool') toolSelf += self;
    else otherSelf += self;

    if (span.status.code === 'ERROR') errorCount += 1;
    if (!isKnownStatusCode(span.status.code)) unknownStatusCount += 1;

    if (isModelCall(span.agentKind)) {
      const genai = span.genai ?? {};
      const model = reportedModel(genai) ?? '(unknown model)';
      const key = JSON.stringify([model, genai.provider ?? '']);
      const row = usageByModel.get(key) ?? {
        model,
        ...(genai.provider ? { provider: genai.provider } : {}),
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        missingInputCalls: 0,
        missingOutputCalls: 0,
        uncostedCalls: 0,
      };
      row.calls += 1;
      if (isTokenCount(genai.usage?.inputTokens)) row.inputTokens += genai.usage.inputTokens;
      else row.missingInputCalls++;
      const output = modelOutputTokens(genai, span.agentKind);
      if (isTokenCount(output)) row.outputTokens += output;
      else row.missingOutputCalls++;
      const cost = costBySpan.get(span.spanId);
      if (cost?.status === 'priced') {
        row.costUsd = (row.costUsd ?? 0) + cost.costUsd;
      } else {
        row.uncostedCalls += 1;
      }
      usageByModel.set(key, row);
    }
  }

  const totalCostUsd = costReport.knownCostUsd ?? undefined;
  const retries = countRetries(trace.spans);

  return {
    totalDurationMs: Number(trace.maxEndNs - trace.minStartNs) / 1_000_000,
    llmSelfTimeMs: Number(llmSelf) / 1_000_000,
    toolSelfTimeMs: Number(toolSelf) / 1_000_000,
    otherSelfTimeMs: Number(otherSelf) / 1_000_000,
    spanCount: trace.spans.length,
    errorCount,
    ...(unknownStatusCount ? { unknownStatusCount } : {}),
    retryCount: retries.count,
    ...(retries.unknown ? { unknownRetryCount: retries.unknown } : {}),
    modelUsage: [...usageByModel.values()].sort((a, b) => b.calls - a.calls),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    uncostedCalls: costReport.unpricedCalls,
    criticalPath: computeCriticalPath(trace),
    timing: buildTiming(trace),
    costReport,
  };
}

export { spanDurationMs };
