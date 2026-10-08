// Replays recorded provider responses through the Vercel AI SDK with its OpenTelemetry output on.
//
//   node replay-aisdk.mjs <mode> <ai-sdk repo checkout> <out.jsonl>
//
// mode: v7-otel   `ai` 7 with `OpenTelemetry` from @ai-sdk/otel (GenAI semantic conventions)
//       v7-legacy `ai` 7 with `LegacyOpenTelemetry` (the `ai.*` attributes)
//       v6        `ai` 6 with `experimental_telemetry` (the `ai.*` attributes, as most apps run it)
//
// The responses are the files in each provider package's `__fixtures__` directory in the
// vercel/ai repository: a local HTTP server answers the SDK's one request with the file. A fixture
// is used only when the id the provider issued in it looks provider-made (`resp_<48 hex>`,
// `msg_01...`, `chatcmpl-...`, a Gemini responseId), which leaves out the hand-written ones.
// Spans are written as OTLP/JSON, one line per fixture: {emitter, test, doc}.
import http from 'node:http';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trace, context } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import * as ai from 'ai';
const { generateText, streamText, jsonSchema, tool } = ai;

const [mode, repo, outFile] = process.argv.slice(2);
const label = `aisdk-${mode}`;
writeFileSync(outFile, '');

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(provider);
if (mode.startsWith('v7')) {
  const otel = await import('@ai-sdk/otel');
  ai.registerTelemetry(mode === 'v7-otel' ? new otel.OpenTelemetry({ tracer: provider.getTracer('ai') }) : new otel.LegacyOpenTelemetry({ tracer: provider.getTracer('ai') }));
}

const looksIssued = (text) =>
  /"id":\s*"resp_[0-9a-f]{40,}"/.test(text) || /"id":\s*"msg_01[A-Za-z0-9]{20,}"/.test(text) || /"id":\s*"chatcmpl-[A-Za-z0-9]{16,}"/.test(text) ||
  /"id":\s*"[0-9a-f]{32}"/.test(text) || /"responseId":\s*"[A-Za-z0-9_-]{16,}"/.test(text) || /"id":\s*"[0-9a-f-]{36}"/.test(text);

const PROVIDERS = [
  { dir: 'openai/src/responses', pkg: '@ai-sdk/openai', make: (m, o) => m.createOpenAI(o).responses },
  { dir: 'anthropic/src', pkg: '@ai-sdk/anthropic', make: (m, o) => m.createAnthropic(o) },
  { dir: 'google/src', pkg: '@ai-sdk/google', make: (m, o) => m.createGoogleGenerativeAI(o) },
  { dir: 'mistral/src', pkg: '@ai-sdk/mistral', make: (m, o) => m.createMistral(o) },
  { dir: 'groq/src', pkg: '@ai-sdk/groq', make: (m, o) => m.createGroq(o) },
  { dir: 'deepseek/src/chat', pkg: '@ai-sdk/deepseek', make: (m, o) => m.createDeepSeek(o) },
];

function walk(node, found) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, found));
  if (node && typeof node === 'object') {
    if (['function_call', 'tool_use', 'function'].includes(node.type) && typeof (node.name ?? node.function?.name) === 'string') found.add(node.name ?? node.function.name);
    if (node.functionCall && typeof node.functionCall.name === 'string') found.add(node.functionCall.name);
    if (node.function && typeof node.function.name === 'string') found.add(node.function.name);
    Object.values(node).forEach((n) => walk(n, found));
  }
}

function modelOf(text) {
  const m = /"(?:model|modelVersion)":\s*"([^"]+)"/.exec(text);
  return m ? m[1] : 'unknown-model';
}

for (const p of PROVIDERS) {
  const mod = await import(p.pkg);
  const dir = join(repo, 'packages', p.dir, '__fixtures__');
  for (const file of readdirSync(dir).sort()) {
    const streaming = file.endsWith('.chunks.txt');
    if (!streaming && !file.endsWith('.json')) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    if (!looksIssued(text)) continue;
    let body;
    if (streaming) {
      body = text.split('\n').filter(Boolean).map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n';
    } else {
      try { JSON.parse(text); } catch { continue; }
      body = text;
    }
    const names = new Set();
    try { walk(streaming ? text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : JSON.parse(text), names); } catch { continue; }
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json' });
        res.end(body);
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const model = p.make(mod, { baseURL, apiKey: 'test' })(modelOf(text));
    const tools = Object.fromEntries([...names].map((n) => [n, tool({ description: n, inputSchema: jsonSchema({ type: 'object', additionalProperties: true }), execute: async () => 'ok' })]));
    const telemetry = mode === 'v6' ? { experimental_telemetry: { isEnabled: true, functionId: 'census' } } : { telemetry: { functionId: 'census' } };
    exporter.reset();
    try {
      const call = { model, prompt: 'Hello', tools, ...telemetry };
      if (streaming) {
        const r = streamText(call);
        for await (const _ of r.fullStream) { /* drain */ }
      } else {
        await generateText(call);
      }
    } catch (e) {
      // a fixture the SDK could not complete still leaves its spans; the error is part of the record
    }
    const spans = exporter.getFinishedSpans();
    server.close();
    if (spans.length === 0) continue;
    const doc = JSON.parse(Buffer.from(JsonTraceSerializer.serializeRequest(spans)).toString('utf8'));
    appendFileSync(outFile, JSON.stringify({ emitter: label, test: `${p.dir}::${file}`, doc }) + '\n');
  }
}
console.log('done', label);
