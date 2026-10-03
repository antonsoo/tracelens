import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { auditBrowser } from './browser-audit.mjs';
import { auditWaterfall } from './browser-waterfall.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.env.TRACELENS_TEST_URL ?? 'http://127.0.0.1:4318/tracelens/';
const server = process.env.TRACELENS_TEST_URL
  ? null
  : spawn(
      process.execPath,
      ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4318', '--strictPort'],
      { cwd: root, stdio: 'pipe' },
    );
let browser;
try {
  if (server) {
    let output = '';
    server.stderr.on('data', (chunk) => {
      output += chunk;
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (server.exitCode !== null) throw new Error(`Preview failed: ${output}`);
      try {
        if ((await fetch(target)).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (attempt === 49) throw new Error('Preview did not become ready');
    }
  }
  const capture = process.env.CAPTURE_SCREENSHOTS === '1';
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(target);
  await page.getByRole('button', { name: 'Compare two runs (synthetic)' }).click();
  await page.getByRole('heading', { name: 'Compare runs', exact: true }).waitFor();
  assert.match(await page.locator('.tl-compare-metrics').first().innerText(), /\+3\.40 s/);
  if (capture) await page.screenshot({ path: root + '/docs/assets/comparison-dark.png' });
  const search = page.locator('.tl-operation').filter({ has: page.locator('strong', { hasText: 'search_docs' }) });
  await search.locator('summary').click();
  await search
    .locator('.tl-compare-evidence')
    .first()
    .getByRole('button', { name: 'search', exact: true })
    .first()
    .click();
  assert.match(await page.locator('.tl-active-file').innerText(), /baseline/);
  assert.match(await page.locator('.tl-detail-pane').innerText(), /search/);
  await page.getByRole('button', { name: 'Back to comparison' }).click();
  await page.getByRole('button', { name: 'Swap runs' }).click();
  assert.match(await page.locator('.tl-compare-metrics').first().innerText(), /-3\.40 s/);
  await page.getByRole('button', { name: 'Swap runs' }).click();
  await page.getByRole('searchbox').fill('no matching operation');
  assert.equal(await page.locator('.tl-operation').count(), 0);
  await page.getByRole('searchbox').fill('search_docs');
  assert.equal(await page.locator('.tl-operation').count(), 1);
  await page.getByRole('searchbox').fill('');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const download = await downloadPromise;
  const report = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(report.wallTimeMs.delta, 3400);
  assert.equal(report.operations.length, 5);
  assert.equal('attributes' in report.operations[0].baselineCalls[0], false);
  await page
    .getByLabel('Replace candidate trace')
    .setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{bad') });
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /Couldn't compare/);
  assert.equal(await page.locator('.tl-operation').count(), 5);
  await page.getByLabel('Replace candidate trace').setInputFiles(root + '/examples/comparison-baseline.json');
  await page.getByRole('alert').waitFor({ state: 'detached' });
  assert.match(await page.locator('.tl-compare-metrics').first().innerText(), /0 µs/);
  await page.getByLabel('Replace candidate trace').setInputFiles(root + '/examples/comparison-candidate.json');
  await page.waitForFunction(() => document.querySelector('.tl-compare-metrics')?.textContent.includes('+3.40 s'));
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Swap runs' }).click();
  assert.match(await page.locator('.tl-compare-metrics').first().innerText(), /-3\.40 s/);
  await page.getByRole('button', { name: 'Swap runs' }).click();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Toggle dark mode' }).click();
  if (capture) await page.screenshot({ path: root + '/docs/assets/comparison-light.png' });
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'page must not overflow at 375px',
  );
  if (capture) await page.screenshot({ path: root + '/docs/assets/comparison-mobile.png' });
  await page.getByRole('button', { name: 'Close comparison' }).click();
  await page.getByRole('button', { name: 'Compare with another run' }).click();
  await page.getByLabel('Candidate trace file').setInputFiles(root + '/examples/comparison-baseline.json');
  await page.getByRole('heading', { name: 'Compare runs', exact: true }).waitFor();
  assert.match(await page.locator('.tl-compare-metrics').first().innerText(), /-3\.40 s/);
  // Treat imported names as text, and keep incomplete usage visibly unknown.
  const malicious = JSON.parse(await readFile(root + '/examples/comparison-candidate.json', 'utf8'));
  const spans = malicious.resourceSpans[0].scopeSpans[0].spans;
  spans[0].name = '<img src=x onerror="window.traceInjection=true">';
  spans[1].attributes = spans[1].attributes.filter((a) => a.key !== 'gen_ai.usage.output_tokens');
  await page.getByLabel('Replace candidate trace').setInputFiles({
    name: 'untrusted.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(malicious)),
  });
  await page.waitForFunction(() => document.querySelector('.tl-compare-metrics')?.textContent.includes('Unknown'));
  assert.equal(await page.locator('.tl-comparison img').count(), 0);
  assert.equal(await page.evaluate(() => window.traceInjection), undefined);
  const summary = page.locator('.tl-operation summary').first();
  await summary.focus();
  await page.keyboard.press('Enter');
  assert.equal(await summary.evaluate((el) => el.parentElement.open), true);
  await page.goto(target + '?example=compare');
  await page.getByRole('heading', { name: 'Compare runs', exact: true }).waitFor();
  assert.match(await page.locator('.tl-compare-metrics').first().innerText(), /\+3\.40 s/);
  // A late demo fetch must not replace a real file chosen in the meantime.
  await page.goto(target);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/examples/comparison-candidate.json', async (route) => {
    await gate;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Compare two runs (synthetic)' }).click();
  const canceled = page.waitForEvent('requestfailed', (request) => request.url().endsWith('/comparison-candidate.json'));
  await page.locator('#tl-file-input').setInputFiles(root + '/examples/comparison-baseline.json');
  await page.locator('.tl-active-file').waitFor();
  release();
  await canceled;
  await page.waitForTimeout(100);
  assert.match(await page.locator('.tl-active-file').innerText(), /comparison-baseline.json/);
  assert.equal(await page.locator('.tl-comparison').count(), 0);
  assert.deepEqual(errors, []);
  await auditBrowser(browser, target, root, capture);
  await auditWaterfall(browser, target, root);
  console.log(
    'PASS: sample, per-side drilldown, swap, filter, JSON export, bad-input recovery, replacement, offline actions, light/dark, 375px, and real file comparison. No browser exceptions.',
  );
} finally {
  await browser?.close();
  server?.kill();
}
