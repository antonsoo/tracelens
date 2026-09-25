import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseOtlpJson } from '../src/core/otlp-parser.js';
import { buildSummary } from '../src/core/summary.js';
import { DEFAULT_PRICE_TABLE } from '../src/core/pricing.js';
import { computeCriticalPath } from '../src/core/critical-path.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
function loadTrace(name: string) {
  return parseOtlpJson(JSON.parse(readFileSync(FIXTURES + name, 'utf8')));
}

describe('buildSummary on the genai-semconv example trace', () => {
  const trace = loadTrace('small-genai-semconv-trace.json');
  const summary = buildSummary(trace, DEFAULT_PRICE_TABLE);

  it('counts the two failed execute_tool spans as errors', () => {
    expect(summary.errorCount).toBe(2);
  });

  it('counts exactly one retried tool call (calculator) and not the three sequential chat turns', () => {
    expect(summary.retryCount).toBe(1);
  });

  it('aggregates token usage per model across all three chat spans', () => {
    expect(summary.modelUsage.length).toBe(1);
    expect(summary.modelUsage[0]!.calls).toBe(3);
    expect(summary.modelUsage[0]!.inputTokens).toBeGreaterThan(0);
  });

  it('splits self time between llm and tool buckets without double-counting nested time', () => {
    // self time is bounded by total wall clock, since children can't exceed their parent
    expect(summary.llmSelfTimeMs + summary.toolSelfTimeMs + summary.otherSelfTimeMs).toBeLessThanOrEqual(
      summary.totalDurationMs + 0.01,
    );
    expect(summary.llmSelfTimeMs).toBeGreaterThan(0);
    expect(summary.toolSelfTimeMs).toBeGreaterThan(0);
  });

  it('produces a total cost once a known model matches the price table', () => {
    expect(summary.totalCostUsd).toBeGreaterThan(0);
  });
});

describe('computeCriticalPath', () => {
  it('starts at the longest root and always descends into the longest child', () => {
    const trace = loadTrace('small-genai-semconv-trace.json');
    const path = computeCriticalPath(trace);
    expect(path[0]).toBe(trace.roots[0]);
    for (let i = 1; i < path.length; i++) {
      const parent = path[i - 1]!;
      const longestChild = [...parent.children].sort((a, b) => (b.durationNs > a.durationNs ? 1 : -1))[0];
      expect(path[i]).toBe(longestChild);
    }
  });

  it('returns an empty path for a trace with no roots', () => {
    expect(computeCriticalPath({ roots: [] } as unknown as Parameters<typeof computeCriticalPath>[0])).toEqual([]);
  });
});
