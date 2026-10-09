// The fixture is data. No generated code, tools, or provider endpoints are executed.
// node replay.mjs <response.chunks.txt> <trace.json> <receipt.json>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { context, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const [input, traceFile, receiptFile] = process.argv.slice(2);
assert.ok(input && traceFile && receiptFile, 'Usage: node replay.mjs <response.chunks.txt> <trace.json> <receipt.json>');
const body = readFileSync(input, 'utf8');
const sha256 = createHash('sha256').update(body).digest('hex');
assert.equal(sha256, '2907e69401c95a1c32bf495032c0bb4916a41b80d4a8cd49cbf97b2570633d84');
const events = body.split('\n').filter(Boolean).map((line) => JSON.parse(line));
const response = events.findLast((event) => event.type === 'response.completed').response;
assert.equal(response.model, 'gpt-5-nano-2025-08-07');
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
trace.setGlobalTracerProvider(provider);
let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const client = createOpenAI({ baseURL: origin, apiKey: 'unused-local-replay', fetch: (url, init) => {
    assert.equal(new URL(url).origin, origin, 'SDK attempted a non-loopback request');
    return fetch(url, init);
  } });
  const result = streamText({ model: client.responses(response.model), prompt: 'Hello', maxRetries: 0,
    experimental_telemetry: { isEnabled: true, functionId: 'cost-evidence-replay' } });
  const streamErrors = [];
  for await (const event of result.fullStream) if (event.type === 'error') streamErrors.push(String(event.error));
  assert.deepEqual(streamErrors, []);
  const usage = await result.totalUsage;
  assert.equal(usage.inputTokens, response.usage.input_tokens);
  assert.equal(usage.outputTokens, response.usage.output_tokens);
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  assert.equal(requests, 1);
  assert.equal(spans.length, 2); // one request plus its SDK wrapper
  const doc = JSON.parse(Buffer.from(JsonTraceSerializer.serializeRequest(spans)).toString('utf8'));
  writeFileSync(traceFile, JSON.stringify(doc, null, 2) + '\n');
  const dependencies = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).dependencies;
  writeFileSync(receiptFile, JSON.stringify({
    source: 'https://github.com/vercel/ai/blob/5028fa46b4b4e695bf0d80e968db43268e9ec5ef/packages/openai/src/responses/__fixtures__/openai-code-interpreter-tool.1.chunks.txt',
    fixtureSha256: sha256, traceSha256: createHash('sha256').update(readFileSync(traceFile)).digest('hex'),
    dependencies, node: process.version, loopbackRequests: requests, providerRequests: 0,
    sourceResponse: { model: response.model, usage: response.usage },
    sdkUsage: usage, spans: spans.map((span) => ({ name: span.name, spanId: span.spanContext().spanId })),
    scope: 'Replayed provider response through the real SDK. Timestamps measure local replay, not model latency. Token charges exclude the recorded code-interpreter tool fees.',
  }, null, 2) + '\n');
  console.log(JSON.stringify({ loopbackRequests: requests, providerRequests: 0, model: response.model, usage: response.usage, spans: spans.length }));
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  await provider.shutdown();
  manager.disable();
}
