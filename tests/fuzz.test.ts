// Structural fuzzing: the three example traces with fields dropped, duplicated, renamed and
// replaced by junk of the wrong type. Whatever comes in, the parser either returns a trace the
// summary and comparison can use, or throws TraceParseError: never a TypeError from deep inside.
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSummary, compareTraces, DEFAULT_PRICE_TABLE, parseOtlpJson, TraceParseError } from '../src/core/index.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), s | 1) + 0x6d2b79f5) >>> 0) / 4294967296);
}
const JUNK = [null, undefined, 0, -1, 1e308, NaN, '', 'x', '123', '-5', '1e9', [], {}, [1], { a: 1 }, true, false, '99999999999999999999999', 'STATUS_CODE_ERROR', 'CHILD_OF', { stringValue: 7 }, { intValue: 'abc' }, { arrayValue: null }, { kvlistValue: { values: 'no' } }];

function mutate(node: unknown, r: () => number, depth = 0): unknown {
  if (r() < 0.012) return JUNK[Math.floor(r() * JUNK.length)];
  if (Array.isArray(node)) {
    let out = node.map((v) => mutate(v, r, depth + 1));
    if (r() < 0.03 && out.length) out.splice(Math.floor(r() * out.length), 1);
    if (r() < 0.03 && out.length) out = out.concat([out[Math.floor(r() * out.length)]]);
    return out;
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (r() < 0.01) continue;
      out[r() < 0.004 ? k + 'X' : k] = mutate(v, r, depth + 1);
    }
    return out;
  }
  return node;
}

it('fuzz: mutated OTLP and Jaeger documents only ever raise TraceParseError', () => {
  const docs = ['genai-semconv-trace.json', 'jaeger-genai-trace.json', 'openinference-trace.json'].map((n) => JSON.parse(readFileSync(new URL(`../examples/${n}`, import.meta.url), 'utf8')) as unknown);
  let parsed = 0, rejected = 0;
  const bad: string[] = [];
  for (let seed = 1; seed <= 1500 && bad.length < 6; seed++) {
    const r = rng(seed);
    const doc = mutate(docs[seed % docs.length], r);
    try {
      const trace = parseOtlpJson(doc);
      const summary = buildSummary(trace, DEFAULT_PRICE_TABLE);
      JSON.stringify(summary.modelUsage);
      compareTraces(trace, trace, DEFAULT_PRICE_TABLE);
      parsed++;
    } catch (err) {
      if (err instanceof TraceParseError) rejected++;
      else bad.push(`seed ${seed}: ${(err as Error).stack?.split('\n').slice(0, 3).join(' | ')}`);
    }
  }
  expect(bad).toEqual([]);
  // Both outcomes have to occur, or the mutations aren't exercising anything.
  expect(parsed).toBeGreaterThan(100);
  expect(rejected).toBeGreaterThan(100);
});
