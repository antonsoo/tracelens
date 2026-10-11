import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

async function download(page, name) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}

test('a partial Jaeger export preserves known timing and event evidence, with offline warning downloads', async ({ page, context }, testInfo) => {
  const errors = []; const external = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (new URL(request.url()).origin !== new URL(testInfo.project.use.baseURL).origin) external.push(request.url()); });
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles('studies/import-integrity/jaeger-partial.json');
  await expect(page.locator('.tl-wf-row')).toHaveCount(3);
  await expect(page.getByText('4 parser warnings', { exact: true })).toHaveText('4 parser warnings');
  await context.setOffline(true);
  await page.locator('.tl-wf-row').filter({ hasText: 'retained event evidence' }).click();
  const span = await download(page, 'Download span JSON');
  expect(span.durationNs).toBe('20000000');
  expect(span.events).toEqual([{ name: 'retained checkpoint', timeUnixNano: '1700000000025000000', attributes: {} }]);
  await page.getByRole('tab', { name: 'Events', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Events', exact: true }).locator('.tl-msg')).toHaveCount(1);
  await page.getByText('4 parser warnings', { exact: true }).click();
  const warnings = await download(page, 'Download warnings JSON');
  expect(warnings).toHaveLength(4);
  expect(warnings.some(w => w.message.includes('clock skew'))).toBe(false);
  expect(warnings.some(w => w.message.includes('unknown duration') && w.message.includes('invalid timestamps'))).toBe(true);
  if (process.env.CAPTURE_IMPORT_INTEGRITY === '1') {
    if (testInfo.project.name === 'chromium') {
      await mkdir('docs/assets/import-integrity', { recursive: true });
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: `docs/assets/import-integrity/jaeger-${width}.png`, fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
    await writeFile(`studies/import-integrity/browser-${testInfo.project.name}.json`, JSON.stringify({ offline: true, span, warnings }, null, 2) + '\n');
  }
  await page.locator('.tl-wf-row').filter({ hasText: 'measured zero duration' }).click();
  expect((await download(page, 'Download span JSON')).durationNs).toBe('0');
  expect(errors).toEqual([]); expect(external).toEqual([]);
});
