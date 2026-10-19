import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const sample = 'examples/cost-nano-stream.json';
const cli = (...args) => {
  const result = spawnSync(process.execPath, ['dist-cli/cli/index.js', ...args], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};
async function download(page, button) {
  const pending = page.waitForEvent('download');
  await button.click();
  const artifact = await pending;
  return JSON.parse(await readFile(await artifact.path(), 'utf8'));
}

test.beforeEach(async ({ page }) => {
  page.errors = [];
  page.external = [];
  page.on('pageerror', (error) => page.errors.push(String(error)));
  page.on('request', (request) => { if (new URL(request.url()).origin !== 'http://127.0.0.1:4319') page.external.push(request.url()); });
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

test('recorded cost example agrees with CLI and exposes the complete calculation offline', async ({ page, context }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Inspect token cost (recorded SDK replay)' }).click();
  const panel = page.locator('.tl-cost-ledger');
  await panel.locator(':scope > summary').click();
  await expect(panel.locator(':scope > summary')).toContainText('1 priced / 0 unpriced / 1 excluded');
  const report = await download(page, panel.getByRole('button', { name: 'Download cost JSON' }));
  expect(report).toEqual(cli('cost', sample, '--json'));
  await panel.getByRole('button', { name: 'ai.streamText.doStream', exact: true }).click();
  const receipt = page.getByRole('region', { name: 'Selected span cost calculation' });
  await expect(receipt.getByRole('heading')).toBeFocused();
  await expect(receipt).toContainText('$0.00081907');
  await expect(receipt).toContainText('3,103');
  await expect(receipt).toContainText('2,944');
  await expect(receipt.getByRole('link', { name: 'Rate source' })).toHaveAttribute('href', 'https://developers.openai.com/api/docs/models/gpt-5-nano');
  await context.setOffline(true);
  const selected = await download(page, receipt.getByRole('button', { name: 'Download cost receipt' }));
  expect(selected.result.components.map((part) => part.tokens)).toEqual([3103, 2944, 0, 1623]);
  expect(selected.spanId).toBe(report.rows.find((row) => row.kind === 'llm').spanId);
  await panel.getByLabel('Trace cost status').selectOption('excluded');
  await panel.getByRole('button', { name: 'ai.streamText', exact: true }).click();
  await expect(receipt).toContainText('Excluded from total');
  await expect(receipt).toContainText('Wrapper usage can repeat child-call totals');
});

test('editing a provider makes a call unpriced; saved price export reproduces that decision in the CLI', async ({ page }, testInfo) => {
  await page.goto('./?example=cost');
  await page.locator('.tl-cost-ledger > summary').click();
  await page.getByRole('button', { name: 'Prices', exact: true }).click();
  const dialog = page.getByRole('dialog');
  // Model identity locates its table row; its index changes when another model is added.
  const match = dialog.locator('input[value="gpt-5-nano"]');
  const priceRow = match.locator('..').locator('..');
  await priceRow.getByLabel(/provider/).fill('azure');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const panel = page.locator('.tl-cost-ledger');
  await expect(panel.locator(':scope > summary')).toContainText('0 priced / 1 unpriced / 1 excluded');
  await panel.getByRole('button', { name: 'ai.streamText.doStream', exact: true }).click();
  await expect(page.locator('.tl-cost-reason')).toContainText('recorded provider does not');
  await page.getByRole('button', { name: 'Prices', exact: true }).click();
  const prices = await download(page, page.getByRole('button', { name: 'Export saved prices' }));
  const file = testInfo.outputPath('edited-prices.json');
  await writeFile(file, JSON.stringify(prices));
  const native = cli('cost', sample, '--prices', file, '--json');
  expect(native.rows[0].result.reason).toBe('provider-mismatch');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await download(page, panel.getByRole('button', { name: 'Download cost JSON' }))).toEqual(native);
  // The vendor URL must not survive a user edit to its assumptions.
  expect(prices.find((price) => price.matchModel === 'gpt-5-nano').sourceUrl).toBe('');
});

test('comparison cost ledgers export and inspect the correct source run', async ({ page }) => {
  const expected = cli('compare', 'examples/comparison-baseline.json', 'examples/comparison-candidate.json', '--json');
  await page.goto('./?example=compare');
  for (const side of ['baseline', 'candidate']) {
    const title = `${side[0].toUpperCase()}${side.slice(1)} cost evidence`;
    const panel = page.locator('.tl-cost-ledger').filter({ hasText: title });
    await panel.locator(':scope > summary').click();
    expect(await download(page, panel.getByRole('button', { name: 'Download cost JSON' }))).toEqual(expected.costEvidence[side]);
    const row = expected.costEvidence[side].rows.find((row) => row.result.status === 'priced');
    await panel.getByRole('button', { name: row.name, exact: true }).first().click();
    const receipt = await download(page, page.getByRole('button', { name: 'Download cost receipt' }));
    expect(receipt.traceId).toBe(expected.costEvidence[side].traceId);
    expect(receipt.spanId).toBe(row.spanId);
    expect(receipt.result).toEqual(row.result);
    await page.getByRole('button', { name: 'Back to comparison' }).click();
  }
});

for (const theme of ['light', 'dark']) {
  test(`cost evidence and price controls remain usable at 320px in ${theme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 320, height: 812 });
    await page.goto('./?example=cost');
    const panel = page.locator('.tl-cost-ledger');
    await panel.locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    await expect(panel).toHaveAttribute('open', '');
    await panel.getByRole('button', { name: 'ai.streamText.doStream', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.tl-cost-receipt h2')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Rate source' })).toBeFocused();
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
    expect(audit.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Prices', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Whole model names');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Prices', exact: true })).toBeFocused();
  });
}

test('large cost ledgers retain every record in exports while allowing the last call to be inspected', async ({ page, context }) => {
  const input = JSON.parse(await readFile(sample, 'utf8'));
  const group = input.resourceSpans[0].scopeSpans[0];
  const template = group.spans.find((span) => span.name === 'ai.streamText.doStream');
  group.spans = Array.from({ length: 1001 }, (_, i) => ({
    ...template, name: `call-${i}`, spanId: (i + 1).toString(16).padStart(16, '0'), parentSpanId: undefined,
    attributes: template.attributes.filter((a) => !a.key.startsWith('ai.prompt') && !a.key.startsWith('ai.response')),
  }));
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles({ name: 'many-calls.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(input)) });
  const panel = page.locator('.tl-cost-ledger');
  await panel.locator(':scope > summary').click();
  await expect(panel.locator('.tl-cost-records li')).toHaveCount(20);
  await panel.getByLabel('Trace cost records page', { exact: true }).fill('51');
  await panel.getByLabel('Trace cost records page', { exact: true }).press('Enter');
  await panel.getByRole('button', { name: 'call-1000', exact: true }).click();
  await expect(page.locator('.tl-detail-title')).toHaveText('call-1000');
  await context.setOffline(true);
  const report = await download(page, panel.getByRole('button', { name: 'Download cost JSON' }));
  expect(report.rows).toHaveLength(1001);
  expect(report.rows.at(-1).name).toBe('call-1000');
  const receipt = await download(page, page.getByRole('button', { name: 'Download cost receipt' }));
  expect(receipt.spanId).toBe(report.rows.at(-1).spanId);
});

test('a user-supplied source URL cannot become executable markup', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tracelens.priceTable.v1', JSON.stringify([{
    id: 'custom', matchModel: 'gpt-5-nano', provider: 'openai', inputPerMTok: 1,
    outputPerMTok: 2, sourceDate: '2026-10-09', sourceUrl: 'javascript:window.badPriceLink=true',
  }])));
  await page.goto('./?example=cost');
  await page.locator('.tl-cost-ledger > summary').click();
  await page.getByRole('button', { name: 'ai.streamText.doStream', exact: true }).click();
  await expect(page.locator('.tl-cost-receipt')).toContainText('javascript:window.badPriceLink=true');
  await expect(page.locator('.tl-cost-receipt a')).toHaveCount(0);
  expect(await page.evaluate(() => window.badPriceLink)).toBeUndefined();
});
