// Targeted publication replay. Inputs are native captures, declared damage, and
// the same synthetic long trace used in the phone-layout study; no model calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const native = JSON.parse(await readFile('studies/retry-order/fixtures/native.json', 'utf8'));
const oracle = JSON.parse(await readFile('studies/retry-order/fixtures/oracle.json', 'utf8'));
const failedId = oracle.observations.find(row => row.outcome === 'ERROR').spanId;
const successfulId = oracle.observations.find(row => row.role === 'successful-peer').spanId;
const reversed = structuredClone(native);
reversed.resourceSpans[0].scopeSpans[0].spans = reversed.resourceSpans[0].scopeSpans[0].spans.filter(span => span.spanId !== successfulId);
const failed = reversed.resourceSpans[0].scopeSpans[0].spans.find(span => span.spanId === failedId);
failed.endTimeUnixNano = String(BigInt(failed.startTimeUnixNano) - 1n);
const strands = await readFile('tests/fixtures/census/strands-operation-details-events-tool-call.json', 'utf8');
const partial = JSON.parse(strands);
delete partial.resourceSpans[0].scopeSpans[0].spans[0].endTimeUnixNano;
const count = 6000, root = 'ff'.repeat(8), traceId = 'ad'.repeat(16);
const long = { resourceSpans: [{ scopeSpans: [{ spans: Array.from({ length: count }, (_, i) => ({
  traceId, spanId: i ? i.toString(16).padStart(16, '0') : root, ...(i ? { parentSpanId: root } : {}),
  name: i ? `call ${i}` : 'Synthetic long trace', startTimeUnixNano: String(i * 2000),
  endTimeUnixNano: String(i ? i * 2000 + 1000 : count * 2000),
})) }] }] };

export async function verifyInspection({ page, width, download, inspect }) {
  const records = [];
  const cell = label => page.locator('.tl-summary-cell').filter({ has: page.locator('.tl-summary-label', { hasText: label }) });
  async function load(name, input, spans) {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    await page.getByRole('button', { name: 'Load another trace', exact: true }).click();
    await page.locator('#tl-file-input').setInputFiles({ name: `${name}.json`, mimeType: 'application/json', buffer: Buffer.from(text) });
    await page.waitForFunction(spans => !document.querySelector('.tl-load-notice') &&
      document.querySelector('.tl-summary')?.textContent.includes(`${spans.toLocaleString('en-US')} / `), spans);
    records.push({ name, inputSha256: hash(text), spans });
  }
  for (const [name, input, spans] of [['timestamp-peers', native, 4], ['clamped-completion', reversed, 3]]) {
    await load(name, input, spans);
    const retries = cell('Possible retries');
    assert.equal(await retries.locator('.tl-summary-value').innerText(), 'Unknown');
    assert.match(await retries.innerText(), /0 observed; 1 predecessor\(s\) uncertain/);
    assert.equal(await cell('Spans / errors').locator('.tl-summary-value').innerText(), `${spans} / 1`);
    await page.locator('.tl-wf-row.status-error').click();
    const selected = await download(page, page.getByRole('button', { name: 'Download span JSON', exact: true }));
    assert.equal(selected.spanId, failedId);
    assert.equal(selected.status.code, 'ERROR');
    if (name === 'clamped-completion') {
      assert.equal(selected.originalEndTimeUnixNano, failed.endTimeUnixNano);
      assert.equal(selected.endTimeUnixNano, selected.startTimeUnixNano);
    }
    Object.assign(records.at(-1), { retryValue: 'Unknown', knownErrors: 1, selectedSpan: selected });
  }
  for (const [name, input, spans] of [['complete-tokens', strands, 6], ['partial-tokens', partial, 5], ['recovered-tokens', strands, 6]]) {
    await load(name, input, spans);
    const tokens = cell('Tokens in / out');
    const tokenValue = await tokens.locator('.tl-summary-value').innerText();
    assert.equal(tokenValue, spans === 5 ? 'Unknown / Unknown' : '175 / 26');
    if (spans === 5) assert.match(await tokens.innerText(), /104 \/ 12 reported; partial import/);
    Object.assign(records.at(-1), { tokenValue, tokenText: await tokens.innerText() });
  }
  await load('synthetic-long-trace', long, count);
  await page.locator('.tl-wf-row[data-index="1"]').click();
  await page.locator('.tl-wf-row.selected').focus();
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.tl-detail-title')?.textContent.trim() === 'call 5999');
  const selected = await download(page, page.getByRole('button', { name: 'Download span JSON', exact: true }));
  assert.equal(selected.spanId, (count - 1).toString(16).padStart(16, '0'));
  assert.equal(selected.startTimeUnixNano, String((count - 1) * 2000));
  const scroll = page.locator('.tl-waterfall-scroll');
  const before = await scroll.evaluate(el => el.scrollTop);
  await page.getByRole('button', { name: '+', exact: true }).click();
  assert.equal(await scroll.evaluate(el => el.scrollTop), before);
  const geometry = await page.evaluate(() => {
    const center = document.querySelector('.tl-center').getBoundingClientRect();
    return { viewportHeight: innerHeight, centerHeight: center.height,
      detailDistanceFromTimeline: document.querySelector('.tl-detail-pane').getBoundingClientRect().top - center.top,
      visibleTimelineWidth: document.querySelector('.tl-waterfall-scroll').clientWidth - document.querySelector('.tl-wf-label').getBoundingClientRect().width,
      renderedRows: document.querySelectorAll('.tl-wf-row').length };
  });
  assert(geometry.centerHeight <= geometry.viewportHeight);
  assert(geometry.detailDistanceFromTimeline <= geometry.viewportHeight);
  if (width === 375) assert(geometry.visibleTimelineWidth >= width / 3);
  assert(geometry.renderedRows < 100);
  // Capture the selection and nearby details rather than an empty off-screen pane.
  await page.locator('.tl-detail-title').evaluate(el => el.scrollIntoView({ block: 'center' }));
  // A transition canceled by rendering/scrolling is settled too. Its rejected
  // `finished` promise must not abort the subsequent UI/accessibility assertions.
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
  const axe = (await new AxeBuilder({ page }).analyze()).violations.map(row => row.id);
  assert.deepEqual(axe, []);
  await inspect('inspection');
  Object.assign(records.at(-1), { lastSpanReached: true, selectedSpan: selected, zoomPreservedScroll: true, geometry, axe });
  return records;
}
