import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { first, second } from '../../studies/export-containers/cases.mjs';

test('damaged export containers remain visible through offline trace selection and downloads', async ({ page, context }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles('studies/export-containers/partial.json');
  await expect(page.locator('#tl-trace-picker option')).toHaveCount(2);
  await context.setOffline(true);
  const results = [];
  for (const traceId of [first, second]) {
    await page.locator('#tl-trace-picker').selectOption(traceId);
    await page.waitForFunction(() => !document.querySelector('.tl-load-notice'));
    await expect(page.locator('.tl-wf-row')).toHaveCount(1);
    const warnings = page.locator('.tl-compare-warnings');
    await expect(warnings.locator('summary')).toHaveText('4 parser warnings');
    if (await warnings.getAttribute('open') === null) await warnings.locator('summary').click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download warnings JSON', exact: true }).click();
    const downloaded = JSON.parse(await readFile(await (await pending).path(), 'utf8'));
    expect(downloaded).toHaveLength(4);
    expect(downloaded.every(warning => warning.traceId === undefined)).toBe(true);
    expect(downloaded.map(w => w.message.split(':')[0])).toEqual([
      'resourceSpans[1]', 'resourceSpans[2].scopeSpans', 'resourceSpans[3].scopeSpans[0]', 'resourceSpans[4].scopeSpans[0].spans',
    ]);
    results.push({ traceId, visibleSpans: 1, warnings: downloaded });
  }
  expect(errors).toEqual([]);
  if (process.env.CAPTURE_CONTAINER_EVIDENCE === '1') await writeFile(
    `studies/export-containers/browser-${testInfo.project.name}.json`, JSON.stringify({ offline: true, pageErrors: errors, results }, null, 2) + '\n');
});
