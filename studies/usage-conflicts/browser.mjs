// Replay native SDK exports through the production worker, UI and download path.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep, extname } from 'node:path';
import { chromium, firefox, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const [artifactArg, outputArg, mode] = process.argv.slice(2);
assert.ok(artifactArg && outputArg && ['before', 'after'].includes(mode), 'ARTIFACT OUTPUT before|after');
const artifact = resolve(artifactArg), dist = resolve(artifact, 'dist'), output = resolve(outputArg);
await mkdir(output, { recursive: true });
const fixtureDir = new URL('./fixtures/', import.meta.url).pathname;
const prices = JSON.parse(await readFile(resolve(fixtureDir, 'prices.json')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cases = ['focused', 'equal-zero', 'reasoning', 'invalid'].map(name => {
  const run = spawnSync(process.execPath, [resolve(artifact, 'dist-cli/cli/index.js'), 'cost',
    resolve(fixtureDir, `${name}.json`), '--prices', resolve(fixtureDir, 'prices.json'), '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return { name, expected: JSON.parse(run.stdout) };
});
const results = [];
for (const [engineName, engine] of Object.entries({ chromium, firefox })) {
  const browser = await engine.launch();
  try {
    for (const width of [1440, 375]) {
      const errors = [], external = [], offlineRequests = [], assets = {}, pending = [], assetErrors = [];
      let disconnected = false, captureAssets = true;
      const server = createServer(async (request, response) => {
        const file = new URL(request.url, 'http://localhost').pathname.replace(/^\/tracelens\//, '') || 'index.html';
        const path = resolve(dist, file);
        if (!path.startsWith(dist + sep)) { response.writeHead(403); response.end(); return; }
        try {
          const bytes = await readFile(path);
          response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(path)] ?? 'application/octet-stream' });
          response.end(bytes);
        } catch { response.writeHead(404); response.end(); }
      });
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      const origin = process.env.TRACELENS_BROWSER_ORIGIN ?? `http://127.0.0.1:${server.address().port}`;
      const context = await browser.newContext({ viewport: { width, height: 1050 }, colorScheme: width === 375 ? 'light' : 'dark' });
      const prefix = `${engineName}-${width}`;
      try {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
          if (!/^https?:/.test(request.url())) return;
          if (disconnected) offlineRequests.push(request.url());
          if (new URL(request.url()).origin !== origin) external.push(request.url());
        });
        page.on('response', response => {
          if (!captureAssets || response.status() !== 200 || !response.url().startsWith(origin)) return;
          pending.push((async () => {
            const file = new URL(response.url()).pathname.replace(/^\/tracelens\//, '') || 'index.html';
            const bytes = await response.body();
            assert.equal(hash(bytes), hash(await readFile(resolve(dist, file))));
            assets[file] = { bytes: bytes.length, sha256: hash(bytes) };
          })().catch(error => assetErrors.push(error.message)));
        });
        await page.addInitScript(table => {
          localStorage.setItem('tracelens.priceTable.v1', JSON.stringify(table));
          window.usageCsp = [];
          document.addEventListener('securitypolicyviolation', event => window.usageCsp.push(event.violatedDirective));
        }, prices);
        await page.goto(`${origin}/tracelens/`);
        await page.locator('#tl-file-input').waitFor({ state: 'attached' });
        await page.evaluate(async () => { await Promise.allSettled(Array.from(document.fonts, face => face.load())); await document.fonts.ready; });
        for (let settled = 0; settled < pending.length;) {
          const batch = pending.slice(settled); settled = pending.length; await Promise.all(batch);
        }
        captureAssets = false;
        assert.deepEqual(assetErrors, []);
        await context.setOffline(true); disconnected = true;
        const downloads = [];
        async function download(button, stage) {
          const pending = page.waitForEvent('download'); await button.click();
          const item = await pending; assert.equal(await item.failure(), null);
          const file = `${prefix}-${stage}.json`; await item.saveAs(resolve(output, file));
          const bytes = await readFile(resolve(output, file));
          downloads.push({ file, bytes: bytes.length, sha256: hash(bytes) });
          return JSON.parse(bytes);
        }
        const observations = [];
        for (const [index, item] of cases.entries()) {
          if (index) await page.getByRole('button', { name: 'Load another trace', exact: true }).click();
          await page.locator('#tl-file-input').setInputFiles(resolve(fixtureDir, `${item.name}.json`));
          const panel = page.locator('.tl-cost-ledger');
          await expect(panel.locator(':scope > summary')).toContainText(`${item.expected.pricedCalls} priced / ${item.expected.unpricedCalls} unpriced`);
          await panel.locator(':scope > summary').click();
          const report = await download(panel.getByRole('button', { name: 'Download cost JSON', exact: true }), `${item.name}-cost`);
          assert.deepEqual(report, item.expected, 'Browser/CLI receipt mismatch');
          const row = report.rows.find(row => row.kind === 'llm');
          const tokenHeader = page.locator('.tl-summary-cell').filter({ hasText: 'Tokens in / out' });
          const tokenText = await tokenHeader.locator('.tl-summary-value').innerText();
          if (row.usage.inputTokens === undefined) assert.ok(tokenText.startsWith('Unknown /'));
          else assert.ok(!tokenText.startsWith('Unknown /'));
          await panel.getByRole('button', { name: row.name, exact: true }).click();
          const receipt = page.getByRole('region', { name: 'Selected span cost calculation' });
          const selected = await download(receipt.getByRole('button', { name: 'Download cost receipt' }), `${item.name}-receipt`);
          assert.deepEqual(selected, { schemaVersion: 1, format: 'tracelens-span-cost', traceId: report.traceId, priceTable: prices, ...row });
          await receipt.getByText('Recorded usage attributes', { exact: true }).click();
          const text = await receipt.innerText();
          assert.ok(text.includes('gen_ai.usage.'));
          observations.push({ name: item.name, result: row.result, usage: row.usage, warnings: report.warnings, tokenHeader: tokenText, receiptText: text });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          if (!index) {
            assert.ok(text.includes('gen_ai.usage.prompt_tokens') && text.includes('1000000'));
            const violations = (await new AxeBuilder({ page }).analyze()).violations;
            assert.deepEqual(violations, []);
            // Capture the headline and selected calculation together, at both sizes.
            await page.evaluate(() => { document.querySelector('.tl-detail-pane').scrollTop = 0; scrollTo(0, 0); });
            await page.screenshot({ path: resolve(output, `${prefix}.png`), fullPage: true });
          }
        }
        const csp = await page.evaluate(() => window.usageCsp);
        assert.deepEqual(errors, []); assert.deepEqual(csp, []);
        assert.deepEqual(external, []); assert.deepEqual(offlineRequests, []);
        results.push({ engine: engineName, width, offlineBeforeFirstInput: true, observations, downloads, assets,
          pageErrors: errors, csp, externalRequests: external, offlineRequests });
        console.log(JSON.stringify({ mode, engine: engineName, width, cases: observations.length, downloads: downloads.length }));
      } finally { await context.close(); await new Promise(done => server.close(done)); }
    }
  } finally { await browser.close(); }
}
await writeFile(resolve(output, 'browser.json'), JSON.stringify({ mode, results }, null, 2) + '\n');
