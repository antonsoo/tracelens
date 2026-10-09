import type { CostRow, TraceCostReport } from '../core/cost-report.js';
import { h, mount } from './dom.js';
import { fmtInt, fmtUsd, jsonPreview, textPreview } from './format.js';
import { downloadEvidence } from './evidence.js';
import { pagedEvidence } from './paged-evidence.js';
import type { ParsedTrace, PriceEntry } from '../core/index.js';

const componentNames = { input: 'Fresh input', 'cache-read': 'Cache read', 'cache-write': 'Cache write', output: 'Output' };

function sourceLink(url: string): HTMLElement {
  // Price files and localStorage are editable input, including their citation URLs.
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return h('a', { href: parsed.href, target: '_blank', rel: 'noopener noreferrer' }, 'Rate source');
  } catch { /* show an invalid URL as text, never an executable link */ }
  return h('span', {}, url ? `Source URL: ${textPreview(url, 300)}` : 'User-supplied rate; no source URL.');
}

export function renderCostReceipt(row: CostRow, traceId: string, prices: PriceEntry[]): HTMLElement {
  const cost = row.result;
  const section = h('section', { className: 'tl-cost-receipt', 'aria-label': 'Selected span cost calculation' },
    h('h2', { tabindex: '-1', 'data-focus-key': 'selected-cost-heading' }, 'Token cost calculation'),
    h('p', { className: 'tl-cost-amount mono' }, cost.status === 'priced' ? fmtUsd(cost.costUsd) : cost.status === 'unpriced' ? 'Unpriced' : 'Excluded from total'));
  if (cost.status === 'priced') {
    section.append(
      h('p', {}, h('code', {}, textPreview(cost.entry.id, 200)), ` / ${cost.match} model match / ${cost.entry.provider || 'any provider'}`),
      h('p', { className: 'dim' }, sourceLink(cost.entry.sourceUrl), `; source date: ${cost.entry.sourceDate || 'not supplied'}`),
      h('div', { className: 'tl-cost-scroll', role: 'region', 'aria-label': 'Token charge components', tabindex: '0' },
        h('table', { className: 'tl-cost-table' },
          h('caption', {}, 'Tokens multiplied by USD per million tokens'),
          h('thead', {}, h('tr', {}, ...['Component', 'Tokens', 'Rate', 'Charge'].map((name) => h('th', { scope: 'col' }, name)))),
          h('tbody', {}, ...cost.components.map((part) => h('tr', {},
            h('th', { scope: 'row' }, componentNames[part.kind]), h('td', { className: 'mono' }, fmtInt(part.tokens)),
            h('td', { className: 'mono' }, fmtUsd(part.perMillionUsd)), h('td', { className: 'mono' }, fmtUsd(part.costUsd))))))),
      cost.assumptions.length ? h('ul', { className: 'tl-cost-assumptions dim' }, ...cost.assumptions.map((note) => h('li', {}, note))) : h('span'),
    );
  } else {
    section.append(h('p', { className: 'tl-cost-reason' }, cost.message));
  }
  section.append(
    h('p', { className: 'dim' }, 'Token charges at the supplied rates. Context premiums, service tiers and tool fees are outside this estimate.'),
    h('details', {}, h('summary', {}, 'Recorded usage attributes'), h('pre', { className: 'tl-pre mono' }, jsonPreview(row.usageAttributes))),
    h('button', { className: 'tl-btn', 'data-focus-key': 'download-cost-receipt', onClick: () => downloadEvidence({
      schemaVersion: 1, format: 'tracelens-span-cost', traceId, priceTable: prices, ...row,
    }, 'tracelens-span-cost.json') }, 'Download cost receipt'),
  );
  return section;
}

interface CostView { open: boolean; filter: string }
const views = new WeakMap<ParsedTrace, Map<string, CostView>>();

export function renderCostPanel(trace: ParsedTrace, report: TraceCostReport, inspect: (id: string) => void, label = 'Trace'): HTMLElement {
  let labels = views.get(trace);
  if (!labels) { labels = new Map(); views.set(trace, labels); }
  let view = labels.get(label);
  if (!view) { view = { open: false, filter: 'all' }; labels.set(label, view); }
  const state = view;
  const body = h('div', { className: 'tl-cost-body' });
  const panel = h('details', { className: 'tl-cost-ledger', open: state.open },
    h('summary', { 'data-focus-key': `cost-${label}-open` }, h('strong', {}, `${label} cost evidence`),
      h('span', { className: 'dim' }, `${report.pricedCalls} priced / ${report.unpricedCalls} unpriced / ${report.excludedSpans} excluded`)), body);
  const draw = (): void => {
    const rows = report.rows.filter((row) => state.filter === 'all' || row.result.status === state.filter);
    mount(body,
      h('p', {}, report.unpricedCalls ? 'Some model calls could not be priced. The headline is a known subtotal.' : 'Inspect the token charges and rate assumptions behind the estimate.'),
      h('div', { className: 'tl-cost-controls' },
        h('label', {}, 'Show ', h('select', { 'aria-label': `${label} cost status`, 'data-focus-key': `cost-${label}-filter`, onChange: (event: Event) => {
          state.filter = (event.target as HTMLSelectElement).value;
          draw();
          body.querySelector<HTMLSelectElement>('select')?.focus();
        } }, ...[['all', 'All cost evidence'], ['priced', 'Priced calls'], ['unpriced', 'Unpriced calls'], ['excluded', 'Excluded spans']]
          .map(([value, title]) => h('option', { value, selected: value === state.filter }, title)))),
        h('button', { className: 'tl-btn', 'data-focus-key': `cost-${label}-download`, onClick: () => downloadEvidence(report, `tracelens-${label.toLowerCase()}-cost.json`) }, 'Download cost JSON')),
      pagedEvidence(state, `${label} cost records`, rows, (page) => h('ul', { className: 'tl-cost-records' }, ...page.map((row) => h('li', {},
        h('div', {}, h('button', { className: 'tl-call-link', 'data-focus-key': `cost-${label}-${row.spanId}`, title: `Inspect span ${row.spanId}`, onClick: () => inspect(row.spanId) }, textPreview(row.name, 140)),
          h('div', { className: 'dim' }, `${textPreview(row.model ?? '(no model)', 150)} / ${textPreview(row.provider ?? 'provider not recorded', 100)} / ${row.kind}`)),
        h('div', { className: 'tl-cost-status' }, row.result.status === 'priced' ? h('span', { className: 'mono' }, fmtUsd(row.result.costUsd))
          : h('span', {}, row.result.status === 'unpriced' ? `Unpriced: ${row.result.reason}` : 'Excluded: not a model call'))))), 20),
      rows.length ? null : h('p', {}, 'No records match this cost status.'),
      h('details', { className: 'tl-cost-notes' }, h('summary', {}, 'Estimation scope and assumptions'), h('ul', {}, ...report.notes.map((note) => h('li', {}, note)))),
      report.warnings.length ? h('p', {}, `${report.warnings.length} parsing or accounting warning(s); see the full JSON export and source trace.`) : null,
    );
  };
  panel.addEventListener('toggle', () => { state.open = (panel as HTMLDetailsElement).open; if (state.open) draw(); });
  if (state.open) draw();
  return panel;
}
