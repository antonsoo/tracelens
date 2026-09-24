import type { NormalizedMessage, ParsedSpan } from '../core/index.js';
import { spanDurationMs } from '../core/index.js';
import { h, mount } from './dom.js';
import { fmtInt, fmtMs, jsonPreview } from './format.js';
import { kindClass, KIND_LABEL } from './kind-colors.js';

export type DetailTab = 'overview' | 'messages' | 'tool' | 'attributes' | 'events';

export function availableTabs(span: ParsedSpan): DetailTab[] {
  const tabs: DetailTab[] = ['overview'];
  if (span.genai?.inputMessages || span.genai?.outputMessages || span.genai?.systemInstructions) tabs.push('messages');
  if (span.genai?.toolArguments !== undefined || span.genai?.toolResult !== undefined) tabs.push('tool');
  tabs.push('attributes');
  if (span.events.length > 0) tabs.push('events');
  return tabs;
}

const TAB_LABEL: Record<DetailTab, string> = {
  overview: 'Overview',
  messages: 'Messages',
  tool: 'Tool I/O',
  attributes: 'Attributes',
  events: 'Events',
};

function messageBlock(messages: NormalizedMessage[]): HTMLElement {
  return h(
    'div',
    {},
    ...messages.map((m) =>
      h(
        'div',
        { className: 'tl-msg' },
        h('div', { className: 'tl-msg-role' }, m.role),
        ...m.parts.map((p) => {
          if (p.type === 'tool_call') {
            return h('div', { className: 'tl-msg-body mono' }, `→ ${p.name ?? 'tool'}(${p.id ? `#${p.id}` : ''})\n${jsonPreview(p.arguments)}`);
          }
          if (p.type === 'tool_call_response') {
            return h('div', { className: 'tl-msg-body mono' }, `← ${p.id ? `#${p.id}` : ''}\n${jsonPreview(p.response)}`);
          }
          return h('div', { className: 'tl-msg-body' }, p.content ?? '(empty)');
        }),
      ),
    ),
  );
}

function kvTable(rows: [string, string][]): HTMLElement {
  return h(
    'table',
    { className: 'tl-kv' },
    h(
      'tbody',
      {},
      ...rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))),
    ),
  );
}

export function renderDetailPanel(
  container: HTMLElement,
  span: ParsedSpan | null,
  activeTab: DetailTab,
  onTabChange: (tab: DetailTab) => void,
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
      { className: 'tl-detail-title' },
      h('span', { className: `tl-kind-dot ${kindClass(span.agentKind)}`, style: 'margin-right:6px' }),
      span.name,
    ),
    h(
      'div',
      { className: 'tl-detail-meta' },
      h('span', {}, KIND_LABEL[span.agentKind]),
      h('span', { className: 'mono' }, fmtMs(spanDurationMs(span))),
      h('span', {}, span.status.code === 'ERROR' ? h('span', { style: 'color:var(--accent-error)' }, 'error') : span.status.code.toLowerCase()),
      h('span', { className: 'mono faint' }, span.spanId.slice(0, 12)),
    ),
  );

  const tabBar = h(
    'div',
    { className: 'tl-tabs' },
    ...tabs.map((t) => h('button', { className: `tl-tab${t === tab ? ' active' : ''}`, onClick: () => onTabChange(t) }, TAB_LABEL[t])),
  );

  const panel = h('div', { className: 'tl-tab-panel' });

  if (tab === 'overview') {
    const rows: [string, string][] = [
      ['operation', span.genai?.operationName ?? '—'],
      ['provider', span.genai?.provider ?? '—'],
      ['request model', span.genai?.requestModel ?? '—'],
      ['response model', span.genai?.responseModel ?? '—'],
      ['input tokens', fmtInt(span.genai?.usage?.inputTokens)],
      ['output tokens', fmtInt(span.genai?.usage?.outputTokens)],
      ['cache read tokens', fmtInt(span.genai?.usage?.cacheReadTokens)],
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
      panel.appendChild(messageBlock(span.genai.systemInstructions));
    }
    if (span.genai?.inputMessages) {
      panel.appendChild(h('div', { className: 'faint', style: 'margin:10px 0 6px' }, 'Input'));
      panel.appendChild(messageBlock(span.genai.inputMessages));
    }
    if (span.genai?.outputMessages) {
      panel.appendChild(h('div', { className: 'faint', style: 'margin:10px 0 6px' }, 'Output'));
      panel.appendChild(messageBlock(span.genai.outputMessages));
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
      panel.appendChild(h('pre', { className: 'tl-pre mono' }, span.genai.errorType));
    }
  } else if (tab === 'attributes') {
    const entries = Object.entries(span.attributes).map(([k, v]): [string, string] => [k, jsonPreview(v, 800)]);
    panel.appendChild(entries.length > 0 ? kvTable(entries) : h('div', { className: 'faint' }, 'No attributes on this span.'));
    panel.appendChild(h('div', { className: 'faint', style: 'margin:14px 0 4px' }, 'Resource'));
    panel.appendChild(kvTable(Object.entries(span.resourceAttributes).map(([k, v]): [string, string] => [k, jsonPreview(v, 400)])));
  } else if (tab === 'events') {
    for (const ev of span.events) {
      const isException = ev.name === 'exception';
      panel.appendChild(
        h(
          'div',
          { className: isException ? 'tl-event' : 'tl-msg' },
          h('div', { className: isException ? 'tl-event-name' : 'tl-msg-role' }, ev.name),
          h('pre', {}, jsonPreview(ev.attributes)),
        ),
      );
    }
  }

  mount(container, header, tabBar, panel);
}
