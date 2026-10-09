import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const oracle = JSON.parse(await readFile('examples/queue-links.oracle.json', 'utf8'));
const native = JSON.parse(spawnSync(process.execPath, ['dist-cli/cli/index.js', 'links', 'examples/queue-links.json', '--json'], { encoding: 'utf8' }).stdout);
async function download(page, button) {
  const pending = page.waitForEvent('download');
  await button.click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}
async function sample(page) {
  await page.goto('./');
  await page.getByRole('button', { name: 'Follow queued jobs (local SDK capture)' }).click();
  await page.locator('.tl-links summary').click();
}
test.beforeEach(async ({ page }) => {
  page.errors = [];
  page.external = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('request', (r) => { if (new URL(r.url()).origin !== 'http://127.0.0.1:4319') page.external.push(r.url()); });
  await page.addInitScript(() => {
    window.csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.csp.push(event.violatedDirective));
  });
});
test.afterEach(async ({ page }) => {
  expect(page.errors).toEqual([]);
  expect(page.external).toEqual([]);
  expect(await page.evaluate(() => window.csp)).toEqual([]);
});

const file = (rows) => ({ name: 'links.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: rows }] }] })) });
const row = (spanId, extra = {}) => ({ traceId: 'a'.repeat(32), spanId, name: spanId, startTimeUnixNano: '1000', endTimeUnixNano: '9000', ...extra });

test('large link sets page in the DOM, retain complete downloads and render untrusted text literally', async ({ page }) => {
  await page.goto('./');
  const links = Array.from({ length: 1001 }, (_, i) => ({ traceId: 'a'.repeat(32), spanId: 'source',
    attributes: [{ key: 'index', value: { intValue: String(i) } }, { key: '<img src=x onerror=alert(1)>', value: { stringValue: 'value' } }] }));
  await page.locator('#tl-file-input').setInputFiles(file([row('source', { links })]));
  await page.locator('.tl-links summary').click();
  await page.locator('.tl-links').getByRole('button', { name: 'source', exact: true }).click();
  await expect(page.locator('.tl-link-record')).toHaveCount(20);
  await expect(page.locator('.tl-link-record img')).toHaveCount(0);
  await page.getByRole('spinbutton', { name: 'Links page', exact: true }).fill('51');
  await page.keyboard.press('Tab');
  await expect(page.locator('.tl-link-record')).toHaveCount(1);
  await expect(page.locator('.tl-link-record')).toContainText('1000');
  await page.getByRole('button', { name: 'Toggle dark mode' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Links page', exact: true })).toHaveValue('51');
  const evidence = await download(page, page.getByRole('button', { name: 'Download span JSON' }));
  expect(evidence.links).toHaveLength(1001);
  expect(evidence.links[1000].attributes.index).toBe(1000);
});

test('missing and ambiguous targets have no navigation button; a rejected target leaves the source intact', async ({ page }) => {
  await page.goto('./');
  const b = 'b'.repeat(32), c = 'c'.repeat(32), d = 'd'.repeat(32);
  await page.locator('#tl-file-input').setInputFiles(file([
    row('source', { links: [{ traceId: b, spanId: 'duplicate' }, { traceId: c, spanId: 'absent' }, { traceId: d, spanId: 'cycle' }] }),
    row('filler1'), row('filler2'),
    row('duplicate', { traceId: b }), row('duplicate', { traceId: b }),
    row('cycle', { traceId: d, parentSpanId: 'cycle' }),
  ]));
  await page.locator('.tl-links summary').click();
  await page.locator('.tl-links').getByRole('button', { name: 'source', exact: true }).click();
  await expect(page.locator('.tl-link-record button')).toHaveCount(1);
  await expect(page.locator('#tl-detail-content')).toContainText('Duplicate target span IDs');
  await expect(page.locator('#tl-detail-content')).toContainText('Target trace absent');
  await page.getByRole('button', { name: 'Inspect cycle', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Cyclic span parents');
  await expect(page.locator('.tl-detail-title')).toHaveText('source');
  await expect(page.locator('#tl-trace-picker')).toHaveValue('a'.repeat(32));
});

test('SDK sample downloads complete links, follows a cross-trace target offline and preserves the source file', async ({ page, context }) => {
  await sample(page);
  expect(await download(page, page.getByRole('button', { name: 'Download links JSON' }))).toEqual(native);
  await page.locator('.tl-links').getByRole('button', { name: 'process invoice batch', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Links', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tl-detail-content')).toContainText('1 link reported dropped');
  await expect(page.locator('#tl-detail-content')).toContainText('Target trace absent');
  const evidence = await download(page, page.getByRole('button', { name: 'Download span JSON' }));
  expect(evidence.links).toEqual(native.spans.find((s) => s.name === 'process invoice batch').links);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Inspect enqueue job 2', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.tl-detail-title')).toHaveText('enqueue job 2');
  await expect(page.locator('.tl-detail-title')).toBeFocused();
  const target = oracle.spans.find((s) => s.name === 'enqueue job 2');
  const targetEvidence = await download(page, page.getByRole('button', { name: 'Download span JSON' }));
  expect([targetEvidence.traceId, targetEvidence.spanId]).toEqual([target.traceId, target.spanId]);
  await page.getByRole('button', { name: 'Back to source span' }).click();
  await expect(page.locator('.tl-links summary')).toContainText('8 span links');
  await expect(page.locator('.tl-detail-title')).toHaveText('process invoice batch');
});

for (const side of [0, 1]) test(`following a link while inspecting comparison side ${side} leaves both runs intact`, async ({ page }) => {
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles('examples/queue-links.json');
  await expect(page.locator('.tl-links summary')).toContainText('8 span links');
  await page.getByLabel('Candidate trace file').setInputFiles('examples/queue-links.json');
  const before = await download(page, page.getByRole('button', { name: 'Export JSON', exact: true }));
  await page.locator('.tl-operation summary').first().click();
  await page.locator('.tl-compare-evidence').nth(side).getByRole('button').first().click();
  await page.locator('.tl-links summary').click();
  await page.locator('.tl-links').getByRole('button', { name: 'process invoice batch', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect enqueue job 2', exact: true }).click();
  await expect(page.locator('.tl-detail-title')).toHaveText('enqueue job 2');
  await page.getByRole('button', { name: 'Back to comparison' }).click();
  expect(await download(page, page.getByRole('button', { name: 'Export JSON', exact: true }))).toEqual(before);
});

test('uploaded SDK file follows a same-trace link and keeps totals unchanged', async ({ page }) => {
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles('examples/queue-links.json');
  await page.locator('.tl-links summary').click();
  await page.locator('.tl-links').getByRole('button', { name: 'commit batch', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect process invoice batch' }).click();
  await expect(page.locator('.tl-detail-title')).toHaveText('process invoice batch');
  await expect(page.locator('#tl-trace-picker')).toHaveValue(oracle.batch.traceId);
  const evidence = await download(page, page.getByRole('button', { name: 'Download span JSON' }));
  expect(evidence.parentSpanId).toBeUndefined();
  expect(evidence.children).toHaveLength(5);
});

for (const theme of ['light', 'dark']) test(`links remain usable at 320px in ${theme} mode`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width: 320, height: 812 });
  await sample(page);
  await page.locator('.tl-links').getByRole('button', { name: 'process invoice batch', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Links', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Links', exact: true })).toBeFocused();
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(audit.violations.map((v) => v.id)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
