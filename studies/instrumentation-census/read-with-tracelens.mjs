// Reads the captured spans with one build of tracelens and writes what it shows for each span.
//
//   node read-with-tracelens.mjs <build-dir containing core/> <out.json> <capture.jsonl>...
//
// Input lines are {emitter, test, doc}: doc is an OTLP/JSON export of one batch of spans. All the
// batches of one (emitter, test) are joined into one export and read as a user would read a file.
// For every span the output has the fields the viewer shows: kind, convention, models, token
// counts, tool calls in the output messages, finish reasons, estimated cost, and the parent the
// viewer put it under. A parse that throws is recorded as a crash, not skipped.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [buildDir, outFile, ...inputs] = process.argv.slice(2);
const core = await import(pathToFileURL(resolve(buildDir, 'core/index.js')).href);
const { parseOtlpJson, estimateSpanCost, DEFAULT_PRICE_TABLE } = core;

const groups = new Map();
for (const file of inputs) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const key = `${row.emitter}\u0000${row.test}`;
    if (!groups.has(key)) groups.set(key, { emitter: row.emitter, test: row.test, resourceSpans: [] });
    groups.get(key).resourceSpans.push(...row.doc.resourceSpans);
  }
}

function toolCalls(genai) {
  const names = [];
  for (const m of genai?.outputMessages ?? []) for (const p of m.parts) if (p.type === 'tool_call' && p.name) names.push(p.name);
  return names;
}
function hasText(genai) {
  return (genai?.outputMessages ?? []).some((m) => m.parts.some((p) => p.type === 'text' && p.content));
}

const results = [];
for (const g of groups.values()) {
  const entry = { emitter: g.emitter, test: g.test, crash: null, spans: [] };
  try {
    const doc = { resourceSpans: g.resourceSpans };
    const traces = parseOtlpJson(doc).traces;
    for (const t of traces) {
      const trace = parseOtlpJson(doc, { traceId: t.traceId });
      for (const s of trace.spans) {
        const cost = s.genai ? estimateSpanCost(s.genai, DEFAULT_PRICE_TABLE) : undefined;
        const parent = s.parentSpanId && trace.spans.find((p) => p.spanId === s.parentSpanId);
        entry.spans.push({
          traceId: s.traceId,
          spanId: s.spanId,
          name: s.name,
          startNs: s.startTimeUnixNano.toString(),
          agentKind: s.agentKind,
          convention: s.convention,
          requestModel: s.genai?.requestModel ?? null,
          responseModel: s.genai?.responseModel ?? null,
          usage: s.genai?.usage ?? null,
          toolCalls: toolCalls(s.genai),
          hasText: hasText(s.genai),
          finishReasons: s.genai?.finishReasons ?? null,
          costUsd: cost ? cost.costUsd : null,
          costModel: cost ? cost.matchedModel : null,
          parentShown: s.parentSpanId ? (parent ? s.parentSpanId : null) : undefined,
          depth: s.depth,
          isRoot: trace.roots.includes(s),
          warnings: trace.warnings.length,
        });
      }
    }
  } catch (error) {
    entry.crash = String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ');
  }
  results.push(entry);
}
writeFileSync(outFile, JSON.stringify({ priceTable: DEFAULT_PRICE_TABLE, groups: results }));
console.log(`${results.length} groups, ${results.reduce((n, r) => n + r.spans.length, 0)} spans, ${results.filter((r) => r.crash).length} crashes`);
