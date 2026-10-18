import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
const directory = 'studies/zero-identities/fixtures';
const oracle = JSON.parse(await readFile(`${directory}/oracle.json`, 'utf8'));
const expected = oracle.observations.filter(row => row.sdkIsValid);
async function download(page, name) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}
for (const suffix of ['traces.pb', 'json', 'snake.json']) for (const width of [1440, 375]) {
  test(`${suffix} keeps only SDK-valid identities at ${width}px`, async ({ page, context }, info) => {
    const errors = [], late = [];
    let offline = false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (offline && /^https?:/.test(request.url())) late.push(request.url()); });
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: width === 375 ? 'light' : 'dark', reducedMotion: 'reduce' });
    await page.goto('./'); await page.evaluate(() => document.fonts.ready);
    await context.setOffline(true); offline = true;
    await page.locator('#tl-file-input').setInputFiles(`${directory}/mixed.${suffix}`);
    await expect(page.locator('.tl-wf-row')).toHaveCount(2);
    await expect(page.locator('#tl-trace-picker')).toHaveCount(0);
    const warningsPanel = page.locator('.tl-compare-warnings');
    await warningsPanel.locator('summary').click();
    await expect(warningsPanel.locator('summary')).toHaveText('5 parser warnings');
    const warnings = await download(page, 'Download warnings JSON');
    expect(warnings).toHaveLength(5);
    expect(warnings.every(row => row.comparisonIssue === 'span-inventory' && row.message.includes('all-zero'))).toBe(true);
    await page.getByRole('treeitem', { name: /^valid-1 / }).click();
    const span = await download(page, 'Download span JSON');
    expect(span.traceId).toBe(expected[0].traceId); expect(span.spanId).toBe(expected[0].spanId);
    await page.locator('.tl-cost-ledger > summary').click();
    const cost = await download(page, 'Download cost JSON');
    expect(cost.incompleteInput).toBe(true); expect(cost.estimatedCostUsd).toBeNull();
    expect(cost.rows.map(row => row.name)).toEqual(['valid-1', 'valid-2']);
    expect(cost.rows.reduce((n, row) => n + row.usage.inputTokens, 0)).toBe(20);
    if (suffix === 'traces.pb') await page.screenshot({ path: info.outputPath('identities.png'), fullPage: true });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
    expect(errors).toEqual([]); expect(late).toEqual([]);
    // The same invalid records must not become a measured regression.
    await page.getByLabel('Candidate trace file', { exact: true }).setInputFiles(`${directory}/valid.${suffix}`);
    await expect(page.getByRole('alert')).toContainText('Cannot compare');
    expect(await download(page, 'Download cost JSON')).toEqual(cost);
    await writeFile(info.outputPath('receipt.json'), JSON.stringify({ suffix, width, browser: info.project.name, retainedSpans: 2, invalidContexts: 5, inputTokens: 20, warnings, incompleteInput: true, comparisonRefused: true, offline: true, errors, lateRequests: late, accessibilityViolations: [], horizontalOverflow: false }, null, 2) + '\n');
  });
}
test('a standalone invalid context refuses without replacing an existing valid trace', async ({ page, context }) => {
  await page.goto('./'); await context.setOffline(true);
  await page.locator('#tl-file-input').setInputFiles(`${directory}/valid.traces.pb`);
  await expect(page.locator('.tl-wf-row')).toHaveCount(2);
  await page.getByLabel('Candidate trace file', { exact: true }).setInputFiles(`${directory}/both-zero.traces.pb`);
  await expect(page.getByRole('alert')).toContainText('No valid spans');
  await expect(page.locator('.tl-wf-row')).toHaveCount(2);
  await page.getByRole('treeitem', { name: /^valid-2 / }).click();
  expect((await download(page, 'Download span JSON')).spanId).toBe(expected[1].spanId);
});
