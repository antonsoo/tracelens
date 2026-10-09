// Verify a served build with actual downloads and offline navigation.
// Run from a built checkout; the CLI is the comparison oracle for browser parity.
// Independent SDK/raw-response oracles are separate from this UI check.
import { chromium, firefox } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const [url, directory] = process.argv.slice(2);
if (!url || !directory) throw new Error('Usage: node scripts/verify-site.mjs <site-url> <output-directory>');
const output = resolve(directory);
await mkdir(output, { recursive: true });
const origin = new URL(url).origin;
function cli(...args) {
  const result = spawnSync(process.execPath, ['dist-cli/cli/index.js', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const expected = {
  links: cli('links', 'examples/queue-links.json', '--json'),
  cost: cli('cost', 'examples/cost-nano-stream.json', '--json'),
  timing: cli('compare', 'examples/timing-parallel.json', 'examples/timing-sequential.json', '--json').timing,
};
async function download(page, button) {
  const pending = page.waitForEvent('download');
  await button.click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}
const observations = [];
for (const [browserName, launcher] of Object.entries({ chromium, firefox })) {
  const browser = await launcher.launch();
  try {
    for (const theme of ['dark', 'light']) for (const width of [1440, 375]) {
      const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme });
      const page = await context.newPage();
      const errors = [], external = [], csp = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('request', (request) => { if (new URL(request.url()).origin !== origin) external.push(request.url()); });
      await page.exposeFunction('recordCsp', (directive) => csp.push(directive));
      await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (event) => window.recordCsp(event.violatedDirective)));
      const name = `${browserName}-${theme}-${width}`;
      const overflows = [];
      async function inspect(scenario) {
        if (scenario === 'timing') await page.locator('.tl-timing-title').first().evaluate((element) => element.scrollIntoView({ block: 'start' }));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        overflows.push({ scenario, overflow });
        assert.equal(overflow, false, `${name} ${scenario} overflow`);
        if ((width === 1440 && theme === 'dark') || (width === 375 && theme === 'light')) {
          await page.screenshot({ path: join(output, `${scenario}-${name}.png`), fullPage: true });
        }
      }
      await page.goto(url);
      await page.getByRole('button', { name: 'Follow queued jobs (local SDK capture)' }).click();
      const links = page.locator('.tl-links');
      await links.locator('summary').click();
      assert.deepEqual(await download(page, links.getByRole('button', { name: 'Download links JSON' })), expected.links);
      await links.getByRole('button', { name: 'process invoice batch', exact: true }).click();
      await page.getByRole('tabpanel').waitFor();
      await inspect('links');
      const span = await download(page, page.getByRole('button', { name: 'Download span JSON' }));
      assert.equal(span.links.length, 3);
      assert.equal(span.droppedLinksCount, 1);
      await context.setOffline(true);
      await page.getByRole('button', { name: 'Inspect enqueue job 2', exact: true }).click();
      await page.locator('.tl-detail-title').filter({ hasText: /^enqueue job 2$/ }).waitFor();
      await context.setOffline(false);

      await page.goto(new URL('?example=cost', url).href);
      const ledger = page.locator('.tl-cost-ledger');
      await ledger.locator(':scope > summary').click();
      assert.deepEqual(await download(page, ledger.getByRole('button', { name: 'Download cost JSON' })), expected.cost);
      await ledger.getByRole('button', { name: 'ai.streamText.doStream', exact: true }).click();
      const receipt = page.getByRole('region', { name: 'Selected span cost calculation' });
      await receipt.waitFor();
      assert.match(await receipt.innerText(), /\$0\.00081907/);
      await inspect('cost');
      await context.setOffline(true);
      const cost = await download(page, receipt.getByRole('button', { name: 'Download cost receipt' }));
      assert.deepEqual(cost.result, expected.cost.rows.find((row) => row.kind === 'llm').result);
      await context.setOffline(false);
      await page.getByRole('button', { name: 'Prices', exact: true }).click();
      const prices = await download(page, page.getByRole('button', { name: 'Export saved prices' }));
      assert.equal(prices.find((row) => row.id === 'claude-sonnet-5-5').cacheReadPerMTok, 0.1);
      assert.equal(prices.find((row) => row.id === 'gpt-6-astra').cacheWritePerMTok, 12.5);
      assert.equal(prices.find((row) => row.id === 'gpt-6.1-sol').cacheReadPerMTok, 0.1);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();

      await page.goto(url);
      await page.getByRole('button', { name: 'Parallel vs sequential (local capture)' }).click();
      const panels = page.locator('.tl-timing');
      await panels.first().locator('summary').click();
      await panels.first().locator('.tl-timing-window').first().click();
      await page.locator('.tl-timing-source h3').waitFor();
      await inspect('timing');
      await context.setOffline(true);
      const comparison = await download(page, page.getByRole('button', { name: 'Export JSON', exact: true }));
      assert.deepEqual(comparison.timing, expected.timing);
      const interval = await download(page, page.getByRole('button', { name: 'Download interval span IDs' }));
      assert.equal(interval.omittedSpanCount, 0);
      assert.equal(interval.spanIds.length, interval.activeCount);
      const targetName = await page.locator('.tl-timing-source .tl-call-link').first().innerText();
      await page.locator('.tl-timing-source .tl-call-link').first().click();
      await page.locator('.tl-detail-title').filter({ hasText: targetName }).waitFor();
      await page.getByRole('button', { name: 'Back to comparison' }).click();
      assert.deepEqual(await download(page, page.getByRole('button', { name: 'Export JSON', exact: true })), comparison);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      assert.deepEqual(csp, []);
      observations.push({ browser: browserName, version: browser.version(), theme, width,
        linksEqualCli: true, offlineTarget: 'enqueue job 2', batchLinks: 3, droppedLinks: 1,
        costEqualCli: true, offlineCostReceipt: true, refreshedPrices: true,
        timingEqualCli: true, completeIntervalExport: true, offlineComparisonPreserved: true,
        overflows, errors, external, csp });
      await writeFile(join(output, 'verification.json'), JSON.stringify({ url, observations }, null, 2) + '\n');
      console.log(`${name}: links, cost, prices and timing agree; offline navigation/downloads agree`);
      await context.close();
    }
  } finally { await browser.close(); }
}
