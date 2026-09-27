import type { TraceSummary } from '../core/index.js';
import { h, mount } from './dom.js';
import { fmtInt, fmtMs, fmtPct, fmtUsd } from './format.js';

function cell(label: string, valueEl: HTMLElement | string, extra?: HTMLElement): HTMLElement {
  return h(
    'div',
    { className: 'tl-summary-cell' },
    h('div', { className: 'tl-summary-label' }, label),
    h('div', { className: 'tl-summary-value mono' }, valueEl),
    extra ?? null,
  );
}

export function renderSummaryHeader(container: HTMLElement, summary: TraceSummary): void {
  const total = summary.llmSelfTimeMs + summary.toolSelfTimeMs + summary.otherSelfTimeMs || 1;
  const timebar = h(
    'div',
    { className: 'tl-timebar', title: `LLM ${fmtPct(summary.llmSelfTimeMs / total)} · Tool ${fmtPct(summary.toolSelfTimeMs / total)} · Other ${fmtPct(summary.otherSelfTimeMs / total)}` },
    h('span', { style: `width:${(summary.llmSelfTimeMs / total) * 100}%;background:var(--accent-llm)` }),
    h('span', { style: `width:${(summary.toolSelfTimeMs / total) * 100}%;background:var(--accent-tool)` }),
    h('span', { style: `width:${(summary.otherSelfTimeMs / total) * 100}%;background:var(--accent-other)` }),
  );

  const topModels = summary.modelUsage
    .slice(0, 3)
    .map((r) => `${r.model} ×${r.calls}`)
    .join(', ');
  const inputMissing = summary.modelUsage.some((row) => row.missingInputCalls > 0);
  const outputMissing = summary.modelUsage.some((row) => row.missingOutputCalls > 0);
  const inputTokens = summary.modelUsage.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTokens = summary.modelUsage.reduce((sum, row) => sum + row.outputTokens, 0);

  mount(
    container,
    h('div', { className: 'tl-summary' },
      cell('Total duration', fmtMs(summary.totalDurationMs)),
      cell('LLM vs tool time', `${fmtMs(summary.llmSelfTimeMs)} / ${fmtMs(summary.toolSelfTimeMs)}`, timebar),
      cell('Tokens in / out', h('span', { title: `Known subtotals: ${fmtInt(inputTokens)} input / ${fmtInt(outputTokens)} output` }, `${inputMissing ? 'Unknown' : fmtInt(inputTokens)} / ${outputMissing ? 'Unknown' : fmtInt(outputTokens)}`)),
      cell(summary.uncostedCalls > 0 ? 'Known cost subtotal' : 'Estimated cost', fmtUsd(summary.totalCostUsd), summary.uncostedCalls > 0 ? h('div', { className: 'faint', style: 'font-size:10px;margin-top:2px' }, `${summary.uncostedCalls} call(s) uncosted`) : undefined),
      cell('Spans / errors', `${fmtInt(summary.spanCount)} / ${summary.errorCount}`),
      cell('Possible retries', fmtInt(summary.retryCount)),
      cell('Models', topModels || '—'),
    ),
  );
}
