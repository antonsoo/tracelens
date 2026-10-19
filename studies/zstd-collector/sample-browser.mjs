import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium, firefox, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
const sdk = JSON.parse(gunzipSync(await readFile(join(here, 'load/sdk-spans.json.gz'))));
const original = sdk.find(span => span.attributes['document.index'] === 4999);
export async function exerciseSample(page, context, { url, entry, width, output }) {
  const errors = [], csp = [], late = [], sampleRequests = [];
  let offline = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().endsWith('/examples/collector-digest.traces.otlp.zst')) sampleRequests.push(request.url());
    if (offline && /^https?:/.test(request.url())) late.push(request.url());
  });
  await page.exposeFunction('sampleCsp', directive => csp.push(directive));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => window.sampleCsp(event.violatedDirective)));
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(entry === 'link' ? new URL('?example=collector-zstd', url).href : url);
  if (entry === 'button') {
    await expect(page.getByRole('button', { name: 'Collector Zstandard (5,001-span local SDK capture)' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (output && width === 375) await page.screenshot({ path: join(output, 'sample-home-phone.png'), fullPage: true });
    await page.getByRole('button', { name: 'Collector Zstandard (5,001-span local SDK capture)' }).click();
  }
  await expect(page.locator('#tl-span-filter-count')).toContainText('5,001');
  assert.equal(sampleRequests.length, 1);
  assert((await page.locator('.tl-wf-row').count()) < 200);
  await context.setOffline(true); offline = true;
  await page.getByRole('searchbox', { name: 'Find spans' }).fill(original.spanId);
  await expect(page.locator('.tl-wf-row')).toHaveCount(2);
  await page.getByRole('treeitem', { name: /^sha256 / }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download span JSON', exact: true }).click();
  const span = JSON.parse(await readFile(await (await pending).path()));
  assert.equal(span.spanId, original.spanId);
  assert.equal(span.traceId, original.traceId);
  assert.equal(span.startTimeUnixNano, original.start);
  assert.equal(span.endTimeUnixNano, original.end);
  assert.deepEqual(span.attributes, original.attributes);
  assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []); assert.deepEqual(csp, []); assert.deepEqual(late, []);
  if (output && entry === 'link') await page.screenshot({ path: join(output, `sample-${width}.png`), fullPage: true });
  return { entry, width, spans: 5001, sampleRequests: sampleRequests.length, sdkClockAndAttributesMatch: true, searchAndDownloadOffline: true, errors, csp, late, overflow: false };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [url, output] = process.argv.slice(2);
  assert(url && output, 'Usage: sample-browser.mjs URL OUTPUT_DIR');
  await mkdir(output, { recursive: true });
  const workflows = [];
  for (const [engine, type, width] of [['chromium', chromium, 1440], ['firefox', firefox, 375]]) {
    const browser = await type.launch();
    try {
      for (const entry of ['button', 'link']) {
        const context = await browser.newContext({ colorScheme: width === 375 ? 'light' : 'dark', reducedMotion: 'reduce' });
        try { workflows.push({ engine, version: browser.version(), ...await exerciseSample(await context.newPage(), context, { url, entry, width, output }) }); }
        finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
  await writeFile(join(output, 'sample-browser.json'), JSON.stringify({ scope: 'Actual native-compressed Collector sample, from its visible button and direct query link. Search and original SDK span download run after disconnecting. No responses are mocked.', workflows }, null, 2) + '\n');
  console.log(JSON.stringify({ workflows: workflows.length, allMatchSdk: true }));
}
