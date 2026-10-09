import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

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
const native = (path) => {
  const result = spawnSync(process.execPath, ['dist-cli/cli/index.js', 'timing', path, '--json'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
};
async function download(page, button) {
  const pending = page.waitForEvent('download');
  await button.click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}
const id = (n) => n.toString(16).padStart(16, '0');
const file = (rows) => ({ name: 'timing.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: rows.map(([start, end], i) => ({
  traceId: 'a'.repeat(32), spanId: id(i + 1), name: i ? `tool ${i}` : '<img src=x onerror=alert(1)>',
  startTimeUnixNano: String(1790000000000000000n + BigInt(start) * 1000000n),
  endTimeUnixNano: String(1790000000000000000n + BigInt(end) * 1000000n),
  attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } }],
})) }] }] })) });

test('comparison explains overlap, exports native accounting and links back to its source spans', async ({ page }) => {
  await page.goto('./?example=compare');
  const panel = page.locator('.tl-timing').first();
  await panel.locator('summary').click();
  await expect(panel.locator('.tl-timing-equation')).toHaveText('6.20 s elapsed = 7.00 s summed self time − 800.0 ms overlap excess + 0 µs uncovered');
  expect(await download(page, panel.getByRole('button', { name: 'Download timing JSON', exact: true }))).toEqual(native('examples/comparison-baseline.json'));
  await panel.locator('.tl-timing-window').first().click();
  await expect(panel.locator('.tl-timing-source h3')).toContainText('2 active self-time spans');
  const name = await panel.locator('.tl-timing-source .tl-call-link').first().innerText();
  await panel.locator('.tl-timing-source .tl-call-link').first().click();
  await expect(page.locator('.tl-detail-title')).toHaveText(name);
  await page.getByRole('button', { name: 'Back to comparison' }).click();
  await expect(panel).toHaveAttribute('open', '');
  await expect(panel.locator('.tl-timing-source h3')).toContainText('2 active');
  await page.getByRole('button', { name: 'Swap runs' }).click();
  const report = await download(page, page.getByRole('button', { name: 'Export JSON', exact: true }));
  expect(report.timing.candidate).toEqual(native('examples/comparison-baseline.json'));
  expect(report.timing.baseline).toEqual(native('examples/comparison-candidate.json'));
});

test('the SDK-captured local request example is discoverable and retains exact timestamps', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Parallel vs sequential (local capture)' }).click();
  await expect(page.locator('.tl-run-names')).toContainText('controlled local capture');
  const panels = page.locator('.tl-timing');
  await expect(panels.first().locator('summary')).toContainText('peak 3');
  await expect(panels.last().locator('summary')).toContainText('peak 1');
  const report = await download(page, page.getByRole('button', { name: 'Export JSON', exact: true }));
  expect(report.timing.baseline).toEqual(native('examples/timing-parallel.json'));
  expect(report.timing.candidate).toEqual(native('examples/timing-sequential.json'));
});

test('large concurrency has bounded rendering and complete selected-interval evidence', async ({ page, context }) => {
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles(file(Array.from({ length: 1200 }, (_, i) => [i, 2400 - i])));
  const panel = page.locator('.tl-timing');
  await panel.locator('summary').click();
  await expect(panel.locator('.tl-timing-window')).toHaveCount(10);
  await panel.locator('.tl-timing-window').first().click();
  await expect(panel.locator('.tl-timing-source h3')).toContainText('1,200 active');
  await expect(panel.locator('.tl-timing-source .tl-call-link')).toHaveCount(20);
  expect(await page.locator('.tl-timing-source img').count()).toBe(0);
  const result = await download(page, panel.getByRole('button', { name: 'Download timing JSON', exact: true }));
  const peak = result.intervals.find((part) => part.activeCount === 1200);
  expect(peak.spanIds).toHaveLength(8);
  expect(peak.omittedSpanCount).toBe(1192);
  const complete = await download(page, panel.getByRole('button', { name: 'Download interval span IDs' }));
  expect(complete.spanIds).toHaveLength(1200);
  expect(new Set(complete.spanIds).size).toBe(1200);
  expect(complete.omittedSpanCount).toBe(0);
  const input = panel.getByRole('spinbutton', { name: 'Trace interval spans page' });
  await input.fill('60');
  await input.press('Tab');
  await expect(panel.locator('.tl-timing-source .tl-call-link').last()).toHaveText('tool 1199');
  await page.getByRole('button', { name: 'Toggle dark mode' }).click();
  await expect(input).toHaveValue('60');
  await context.setOffline(true);
  expect((await download(page, panel.getByRole('button', { name: 'Download interval span IDs' }))).spanIds).toHaveLength(1200);
});

test('uncovered time is inspectable without inventing an idle cause', async ({ page }) => {
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles(file([[0, 100], [300, 500]]));
  const panel = page.locator('.tl-timing');
  await panel.locator('summary').click();
  await expect(panel.locator('summary')).toContainText('200.0 ms uncovered');
  await panel.locator('.tl-timing-window').click();
  await expect(panel.locator('.tl-timing-source')).toContainText('No span covers this interval');
  const report = await download(page, panel.getByRole('button', { name: 'Download interval span IDs' }));
  expect(report.offsetNs).toBe('100000000');
  expect(report.durationNs).toBe('200000000');
  expect(report.spanIds).toEqual([]);
});

for (const theme of ['light', 'dark']) {
  test(`timing controls and evidence are keyboard accessible at 320px in ${theme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 320, height: 812 });
    await page.goto('./?example=timing');
    const panel = page.locator('.tl-timing').first();
    await panel.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(panel).toHaveAttribute('open', '');
    await panel.getByLabel('Baseline interval filter').selectOption('all');
    await expect(panel.getByLabel('Baseline interval filter')).toBeFocused();
    await panel.locator('.tl-timing-window').first().focus();
    await page.keyboard.press('Enter');
    await expect(panel.locator('.tl-timing-source h3')).toBeFocused();
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
    expect(audit.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
