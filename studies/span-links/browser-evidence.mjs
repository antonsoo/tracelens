import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const url = process.argv[2] ?? 'http://127.0.0.1:4320/tracelens/';
const browser = await chromium.launch();
const observations = [];
try {
  for (const [theme, width, height] of [['dark', 1440, 1080], ['light', 1440, 1080], ['dark', 320, 812], ['light', 375, 812]]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
    const page = await context.newPage();
    const errors = [];
    const external = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('request', (r) => { if (new URL(r.url()).origin !== new URL(url).origin) external.push(r.url()); });
    await page.goto(url);
    await page.getByRole('button', { name: 'Follow queued jobs (local SDK capture)' }).click();
    await page.locator('.tl-links summary').click();
    await page.locator('.tl-links').getByRole('button', { name: 'process invoice batch', exact: true }).click();
    await page.getByRole('tabpanel').waitFor();
    await mkdir('docs/assets', { recursive: true });
    await page.screenshot({ path: `docs/assets/links-${theme}-${width}.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download span JSON' }).click();
    const span = JSON.parse(await readFile(await (await pending).path(), 'utf8'));
    assert.equal(span.links.length, 3);
    assert.equal(span.droppedLinksCount, 1);
    if (width === 1440 && theme === 'dark') await writeFile('studies/span-links/browser-span.json', JSON.stringify(span, null, 2) + '\n');
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Inspect enqueue job 2', exact: true }).click();
    await page.locator('.tl-detail-title').filter({ hasText: /^enqueue job 2$/ }).waitFor();
    const target = await page.locator('.tl-detail-title').innerText();
    observations.push({ theme, width, height, spanLinks: span.links.length, reportedDropped: span.droppedLinksCount, offlineTarget: target, overflow, errors, external });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    await context.close();
  }
  await writeFile('studies/span-links/browser-observations.json', JSON.stringify({ browser: browser.version(), observations }, null, 2) + '\n');
} finally { await browser.close(); }
