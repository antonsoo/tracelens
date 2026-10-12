import { buildLinksReport, hasLinks, linkTargetLabel } from '../core/links.js';
import type { ParsedSpan, ParsedTrace, SpanLink } from '../core/types.js';
import { h } from './dom.js';
import { downloadEvidence } from './evidence.js';
import { jsonPreview, textPreview } from './format.js';
import { pagedEvidence } from './paged-evidence.js';

export function renderLinksPanel(trace: ParsedTrace, inspect: (spanId: string) => void): HTMLElement | null {
  const spans = trace.spans.filter(hasLinks);
  if (!spans.length) return null;
  const count = spans.reduce((sum, span) => sum + (span.links?.length ?? 0), 0);
  return h('details', { className: 'tl-links tl-compare-warnings' },
    h('summary', {}, `${count} span links across ${spans.length} source spans`),
    h('p', {}, 'Follow queued or batched work across imported traces. Links retain recorded relationships; they do not add time or cost to this run.'),
    h('button', { className: 'tl-btn', onClick: () => downloadEvidence(buildLinksReport(trace), 'tracelens-links.json') }, 'Download links JSON'),
    pagedEvidence(trace, 'Spans with links', spans, (page) => h('ul', {}, ...page.map((span) => h('li', {},
      h('button', { className: 'tl-call-link', onClick: () => inspect(span.spanId) }, textPreview(span.name, 200)),
      `: ${span.links?.length ?? 0} recorded; ${span.droppedLinksCount ?? 0} reported dropped; ${span.invalidLinkCount ?? 0} malformed skipped`,
    ))), 20));
}

export function renderSpanLinks(span: ParsedSpan, navigate?: (link: SpanLink) => void): HTMLElement {
  const dropped = span.droppedLinksCount ?? 0;
  return h('div', {},
    h('p', {}, `${dropped} ${dropped === 1 ? 'link' : 'links'} reported dropped by the exporter; ${span.invalidLinkCount ?? 0} malformed records skipped. Other unreadable evidence appears in parser warnings.`),
    h('p', {}, 'Missing targets can be unsampled, unexported or omitted. The imported data does not establish why. Link order is the recorded order, not an execution timeline.'),
    pagedEvidence(span, 'Links', span.links ?? [], (page, start) => h('div', {}, ...page.map((link, offset) => h('article', { className: 'tl-msg tl-link-record' },
      h('div', { className: 'tl-msg-role' }, `Link ${start + offset + 1}`),
      h('div', {}, link.target?.status === 'available' && navigate
        ? h('button', { className: 'tl-call-link', 'data-focus-key': `span-link-${start + offset}`, onClick: () => navigate(link) }, `Inspect ${textPreview(linkTargetLabel(link), 200)}`)
        : h('strong', {}, linkTargetLabel(link))),
      h('p', { className: 'mono' }, `Trace: ${textPreview(link.traceId)}\nSpan: ${textPreview(link.spanId)}`),
      ...(link.traceState ? [h('p', { className: 'mono' }, `Trace state: ${textPreview(link.traceState)}`)] : []),
      ...(link.flags !== undefined ? [h('p', {}, `Recorded flags: ${link.flags}`)] : []),
      ...(link.droppedAttributesCount ? [h('p', {}, `${link.droppedAttributesCount} link attributes reported dropped`)] : []),
      h('pre', { className: 'tl-pre mono' }, jsonPreview(link.attributes)),
    ))), 20));
}
