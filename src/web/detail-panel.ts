import type { NormalizedMessage, NormalizedMessagePart, ParsedSpan, PriceEntry } from '../core/index.js';
import { hasCostEvidence, spanCostEvidence, spanDurationMs } from '../core/index.js';
import { renderCostReceipt } from './cost-panel.js';
import { h, mount } from './dom.js';
import { fmtInt, fmtMs, jsonPreview, textPreview } from './format.js';
import { kindClass, KIND_LABEL } from './kind-colors.js';
import { pagedEvidence } from './paged-evidence.js';
import { downloadEvidence, spanEvidence } from './evidence.js';
import type { SpanLink } from '../core/types.js';
import { hasLinks } from '../core/links.js';
import { renderSpanLinks } from './links-panel.js';

export type DetailTab = 'overview' | 'messages' | 'tool' | 'attributes' | 'events' | 'logs' | 'links';

export function availableTabs(span: ParsedSpan): DetailTab[] {
  const tabs: DetailTab[] = ['overview'];
  if (span.genai?.inputMessages || span.genai?.outputMessages || span.genai?.systemInstructions) tabs.push('messages');
  if (span.genai?.toolArguments !== undefined || span.genai?.toolResult !== undefined) tabs.push('tool');
  tabs.push('attributes');
  if (span.events.length > 0) tabs.push('events');
  if (span.logs?.length) tabs.push('logs');
  if (hasLinks(span)) tabs.push('links');
  return tabs;
}

const TAB_LABEL: Record<DetailTab, string> = {
  overview: 'Overview',
  messages: 'Messages',
  tool: 'Tool I/O',
  attributes: 'Attributes',
  events: 'Events',
  logs: 'Logs',
  links: 'Links',
};

function messagePart(p: NormalizedMessagePart): HTMLElement {
  if (p.type === 'tool_call') {
    return h('div', { className: 'tl-msg-body mono' }, `→ ${textPreview(p.name ?? 'tool', 200)}(${p.id ? `#${textPreview(p.id, 200)}` : ''})\n${jsonPreview(p.arguments)}`);
  }
  if (p.type === 'tool_call_response') {
    return h('div', { className: 'tl-msg-body mono' }, `← ${p.id ? `#${textPreview(p.id, 200)}` : ''}\n${jsonPreview(p.response)}`);
  }
  return h('div', { className: 'tl-msg-body' }, textPreview(p.content ?? '(empty)'));
}

function messageBlock(owner: ParsedSpan, label: string, messages: NormalizedMessage[]): HTMLElement {
  return pagedEvidence(owner, label, messages, (page, start) => h('div', {}, ...page.map((m, index) => {
    const parts = (slice: readonly NormalizedMessagePart[]): HTMLElement => h('div', {}, ...slice.map(messagePart));
    return h('div', { className: 'tl-msg' },
      h('div', { className: 'tl-msg-role' }, textPreview(m.role, 100)),
      m.parts.length > 20 ? pagedEvidence(m, `${label} message ${start + index + 1} parts`, m.parts, parts, 20) : parts(m.parts));
  })), 20);
}

function kvTable(rows: [string, string][]): HTMLElement {
  return h(
    'table',
    { className: 'tl-kv' },
    h(
      'tbody',
      {},
      ...rows.map(([k, v]) => h('tr', {}, h('td', {}, textPreview(k, 200)), h('td', {}, textPreview(v)))),
    ),
  );
}

export function renderDetailPanel(
  container: HTMLElement,
  span: ParsedSpan | null,
  activeTab: DetailTab,
  onTabChange: (tab: DetailTab) => void,
  prices: PriceEntry[] = [],
  onNavigateLink?: (link: SpanLink) => void,
): void {
  if (!span) {
    mount(container, h('div', { className: 'tl-detail-empty' }, 'Select a span in the waterfall to inspect its attributes, messages and tool calls.'));
    return;
  }

  const tabs = availableTabs(span);
  const tab = tabs.includes(activeTab) ? activeTab : 'overview';

  const header = h(
    'div',
    { className: 'tl-detail-header' },
    h(
      'div',
      { className: 'tl-detail-title', tabindex: '-1' },
      h('span', { className: `tl-kind-dot ${kindClass(span.agentKind)}`, style: 'margin-right:6px' }),
      textPreview(span.name, 400),
    ),
    h(
      'div',
      { className: 'tl-detail-meta' },
      h('span', {}, KIND_LABEL[span.agentKind]),
      h('span', { className: 'mono' }, fmtMs(spanDurationMs(span))),
      h('span', {}, span.status.code === 'ERROR' ? h('span', { style: 'color:var(--accent-error)' }, 'error') : span.status.code.toLowerCase()),
      h('span', { className: 'mono faint' }, span.spanId.slice(0, 12)),
    ),
    h('div', { className: 'tl-evidence-download' },
      h('button', { className: 'tl-btn', 'data-focus-key': 'download-span', onClick: () => downloadEvidence(spanEvidence(span), 'tracelens-span.json') }, 'Download span JSON'),
      h('span', { className: 'dim' }, 'Decoded attributes, messages, events, logs and links. Long values below are previews.')),
  );

  const tabBar = h(
    'div',
    { className: 'tl-tabs', role: 'tablist', 'aria-label': 'Span details' },
    ...tabs.map((t, index) => h('button', {
      className: `tl-tab${t === tab ? ' active' : ''}`, id: `tl-detail-tab-${t}`,
      role: 'tab', 'aria-selected': t === tab, 'aria-controls': 'tl-detail-content',
      tabindex: t === tab ? '0' : '-1', 'data-focus-key': `detail-${t}`,
      onClick: () => onTabChange(t),
      onKeydown: (event: Event) => {
        const e = event as KeyboardEvent;
        const next = e.key === 'ArrowRight' ? (index + 1) % tabs.length
          : e.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
            : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
        if (next < 0) return;
        e.preventDefault();
        onTabChange(tabs[next]!);
        document.getElementById(`tl-detail-tab-${tabs[next]!}`)?.focus({ preventScroll: true });
      },
    }, TAB_LABEL[t])),
  );

  const panel = h('div', { className: 'tl-tab-panel', id: 'tl-detail-content', role: 'tabpanel', 'aria-labelledby': `tl-detail-tab-${tab}`, tabindex: '0', 'data-focus-key': 'detail-panel' });

  if (tab === 'overview') {
    if (hasCostEvidence(span)) panel.appendChild(renderCostReceipt(spanCostEvidence(span, prices), span.traceId, prices));
    const rows: [string, string][] = [
      ...(span.sourceFile ? [['source file', `${span.sourceFile.index}: ${span.sourceFile.name}`] as [string, string]] : []),
      ['operation', span.genai?.operationName ?? '—'],
      ['provider', span.genai?.provider ?? '—'],
      ['request model', span.genai?.requestModel ?? '—'],
      ['response model', span.genai?.responseModel ?? '—'],
      ['input tokens', fmtInt(span.genai?.usage?.inputTokens)],
      ['output tokens', fmtInt(span.genai?.usage?.outputTokens)],
      ['cache read tokens', fmtInt(span.genai?.usage?.cacheReadTokens)],
      ['cache write tokens', fmtInt(span.genai?.usage?.cacheWriteTokens)],
      ['finish reasons', span.genai?.finishReasons?.join(', ') ?? '—'],
      ['convention', span.convention],
      ['span kind (OTel)', span.kind],
      ['trace id', span.traceId],
      ['span id', span.spanId],
      ['parent span id', span.parentSpanId ?? '(root)'],
    ];
    if (span.status.message) rows.push(['status message', span.status.message]);
    panel.appendChild(kvTable(rows));
  } else if (tab === 'messages') {
    if (span.genai?.systemInstructions) {
      panel.appendChild(h('div', { className: 'faint', style: 'margin-bottom:6px' }, 'System'));
      panel.appendChild(messageBlock(span, 'System messages', span.genai.systemInstructions));
    }
    if (span.genai?.inputMessages) {
      panel.appendChild(h('div', { className: 'faint', style: 'margin:10px 0 6px' }, 'Input'));
      panel.appendChild(messageBlock(span, 'Input messages', span.genai.inputMessages));
    }
    if (span.genai?.outputMessages) {
      panel.appendChild(h('div', { className: 'faint', style: 'margin:10px 0 6px' }, 'Output'));
      panel.appendChild(messageBlock(span, 'Output messages', span.genai.outputMessages));
    }
  } else if (tab === 'tool') {
    panel.appendChild(
      kvTable([
        ['tool', span.genai?.toolName ?? '—'],
        ['type', span.genai?.toolType ?? '—'],
        ['call id', span.genai?.toolCallId ?? '—'],
        ['description', span.genai?.toolDescription ?? '—'],
      ]),
    );
    if (span.genai?.toolArguments !== undefined) {
      panel.appendChild(h('div', { className: 'faint', style: 'margin:10px 0 4px' }, 'Arguments'));
      panel.appendChild(h('pre', { className: 'tl-pre mono' }, jsonPreview(span.genai.toolArguments)));
    }
    if (span.genai?.toolResult !== undefined) {
      panel.appendChild(h('div', { className: 'faint', style: 'margin:10px 0 4px' }, 'Result'));
      panel.appendChild(h('pre', { className: 'tl-pre mono' }, jsonPreview(span.genai.toolResult)));
    }
    if (span.genai?.errorType) {
      panel.appendChild(h('div', { className: 'faint', style: 'margin:10px 0 4px' }, 'error.type'));
      panel.appendChild(h('pre', { className: 'tl-pre mono' }, textPreview(span.genai.errorType)));
    }
  } else if (tab === 'attributes') {
    const entries = Object.entries(span.attributes);
    panel.appendChild(entries.length > 0 ? pagedEvidence(span, 'Attributes', entries, (page) => kvTable(page.map(([k, v]) => [k, jsonPreview(v, 800)]))) : h('div', { className: 'faint' }, 'No attributes on this span.'));
    panel.appendChild(pagedEvidence(span, 'Resource attributes', Object.entries(span.resourceAttributes), (page) => kvTable(page.map(([k, v]) => [k, jsonPreview(v, 400)]))));
  } else if (tab === 'links') {
    panel.appendChild(renderSpanLinks(span, onNavigateLink));
  } else if (tab === 'logs') {
    panel.appendChild(h('p', { className: 'dim' }, 'Joined by trace ID and span ID. These records were exported separately from span events.'));
    panel.appendChild(pagedEvidence(span, 'Logs', span.logs ?? [], page => h('div', {}, ...page.map(log => h('div', { className: 'tl-msg tl-log-record' },
      h('div', { className: 'tl-msg-role' }, textPreview(log.eventName ?? 'Log record', 200)),
      h('p', { className: 'dim' }, textPreview(`${log.source.file ? `File ${log.source.file.index}: ${log.source.file.name}; ` : ''}${log.source.line ? `line ${log.source.line}; ` : ''}${log.source.path}`)),
      h('pre', { tabIndex: 0, 'aria-label': 'Decoded log record',
        'data-focus-key': `log-${span.spanId}-${log.source.file?.index ?? 0}-${log.source.line ?? 0}-${log.source.path}` }, jsonPreview({
        attributes: log.attributes, body: log.body,
        timeUnixNano: log.timeUnixNano, observedTimeUnixNano: log.observedTimeUnixNano,
        scopeName: log.scopeName, scopeVersion: log.scopeVersion,
        resourceAttributes: log.resourceAttributes, droppedAttributesCount: log.droppedAttributesCount,
      })),
      h('p', { className: 'dim' }, 'Download span JSON includes the complete decoded record and original export fields.'),
    ))), 20));
  } else if (tab === 'events') {
    panel.appendChild(pagedEvidence(span, 'Events', span.events, (page) => h('div', {}, ...page.map((ev) => {
      const isException = ev.name === 'exception';
      return h(
          'div',
          { className: isException ? 'tl-event' : 'tl-msg' },
          h('div', { className: isException ? 'tl-event-name' : 'tl-msg-role' }, textPreview(ev.name, 200)),
          h('pre', {}, jsonPreview(ev.attributes)),
        );
    })), 20));
  }

  mount(container, header, tabBar, panel);
}
