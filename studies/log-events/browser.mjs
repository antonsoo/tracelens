import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, firefox, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const port = 4326;
const url = `http://127.0.0.1:${port}/tracelens/`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
const fixture = resolve('studies/log-events/capture-event-only');
const paths = ['traces.json', 'logs.json'].map(name => join(fixture, name));
const rawLogs = JSON.parse(await readFile(paths[1], 'utf8')).resourceLogs[0].scopeLogs[0].logRecords;
const captures = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function download(page, name) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}
try {
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview did not become ready')), 10000);
    server.stdout.on('data', data => { if (data.toString().includes(url)) { clearTimeout(timer); resolveReady(); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}`)); });
  });
  for (const [engine, driver] of Object.entries({ chromium, firefox })) {
    const browser = await driver.launch();
    try {
      for (const width of [1440, 375]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: width === 1440 ? 'dark' : 'light' });
        const page = await context.newPage();
        const errors = [], external = [], served = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => { if (!request.url().startsWith(url) && !request.url().startsWith('blob:')) external.push(request.url()); });
        page.on('response', response => {
          const path = response.url().slice(url.length) || 'index.html';
          // Sample fetches belong to a worker that is terminated after parsing;
          // Chromium cannot read that response body after its target closes.
          if (!response.url().startsWith(url) || path.includes('?') || !response.ok() || path.startsWith('examples/')) return;
          served.push((async () => {
            const bytes = await response.body();
            const local = await readFile(join('dist', path));
            assert.deepEqual(bytes, local, path);
            return { path, bytes: bytes.length, sha256: sha(bytes) };
          })().catch(error => ({ path, error: error.message })));
        });
        try {
          await page.goto(url);
          const samplePath = 'examples/genai-log-events.jsonl';
          const sampleResponse = await context.request.get(url + samplePath);
          assert.equal(sampleResponse.status(), 200);
          const sampleBytes = await sampleResponse.body();
          assert.deepEqual(sampleBytes, await readFile(join('dist', samplePath)));
          served.push(Promise.resolve({ path: samplePath, bytes: sampleBytes.length, sha256: sha(sampleBytes),
            method: 'Independent HTTP fetch; the worker sample is also checked through its evidence download.' }));
          await page.getByRole('button', { name: 'Inspect messages from logs (local SDK capture)' }).click();
          await expect(page.locator('.tl-wf-row')).toHaveCount(4);
          await page.locator('.tl-wf-row').filter({ hasText: 'chat scripted-response' }).nth(0).click();
          const sample = await download(page, 'Download span JSON');
          assert.deepEqual(sample.logs[0].raw, rawLogs[0]);
          assert.equal(sample.logs[0].source.line, 1);
          assert.deepEqual((await Promise.all(served)).filter(asset => asset.error), []);
          await page.getByRole('button', { name: 'Load another trace', exact: true }).click();
          await page.locator('#tl-file-input').setInputFiles(paths);
          await expect(page.locator('.tl-wf-row')).toHaveCount(4);
          await context.setOffline(true);
          const modelRows = page.locator('.tl-wf-row').filter({ hasText: 'chat scripted-response' });
          await modelRows.nth(0).click();
          await page.getByRole('tab', { name: 'Messages', exact: true }).click();
          await expect(page.locator('#tl-detail-content')).toContainText('Compute the SHA-256 of receipt-17.');
          await expect(page.locator('#tl-detail-content')).toContainText('Use the digest tool; do not invent its result.');
          await expect(page.locator('#tl-detail-content')).toContainText('sha256');
          const first = await download(page, 'Download span JSON');
          assert.deepEqual(first.logs[0].raw, rawLogs[0]);
          assert.equal(first.logs[0].source.file.name, 'logs.json');
          assert.equal(first.genai.inputMessages.length, 1);
          await page.screenshot({ path: join(output, `${engine}-${width}-messages.png`), fullPage: true });
          await page.getByRole('tab', { name: 'Logs', exact: true }).click();
          await expect(page.locator('#tl-detail-content')).toContainText('File 2: logs.json');
          await expect(page.locator('#tl-detail-content')).toContainText('resourceLogs[0].scopeLogs[0].logRecords[0]');
          const preview = page.getByLabel('Decoded log record', { exact: true });
          // Font/layout changes can schedule the app's 120 ms resize render.
          // Check keyboard scrolling after that render, not on its old element.
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(200);
          await preview.scrollIntoViewIfNeeded();
          await preview.focus();
          await page.keyboard.press('End');
          await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
          await page.keyboard.press('Home');
          await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBe(0);
          const logViolations = (await new AxeBuilder({ page }).analyze()).violations.map(v => v.id);
          assert.deepEqual(logViolations, []);
          assert.deepEqual((await download(page, 'Download span JSON')).logs[0].raw, rawLogs[0]);
          await page.screenshot({ path: join(output, `${engine}-${width}-logs.png`), fullPage: true });
          await modelRows.nth(1).click();
          await page.getByRole('tab', { name: 'Messages', exact: true }).click();
          await expect(page.locator('#tl-detail-content')).toContainText('3d9b849244959f3c63eab896d824a077a145676a6205fb17b3d23df3a3f560b6');
          assert.deepEqual((await download(page, 'Download span JSON')).logs[0].raw, rawLogs[1]);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          const violations = (await new AxeBuilder({ page }).analyze()).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }));
          assert.deepEqual(violations, []);
          // Loading another local file remains available while offline.
          await page.getByRole('button', { name: 'Load another trace', exact: true }).click();
          const unmatched = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ ...rawLogs[0], spanId: 'ffffffffffffffff' }] }] }] };
          await page.locator('#tl-file-input').setInputFiles([
            { name: 'traces.json', mimeType: 'application/json', buffer: await readFile(paths[0]) },
            { name: 'unmatched.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(unmatched)) },
          ]);
          await expect(page.locator('.tl-wf-row')).toHaveCount(4);
          await page.locator('.tl-compare-warnings summary').click();
          await expect(page.locator('.tl-compare-warnings')).toContainText('could not be matched');
          const unknown = await download(page, 'Download unmatched logs');
          assert.equal(unknown.length, 1);
          assert.deepEqual(unknown[0].raw, unmatched.resourceLogs[0].scopeLogs[0].logRecords[0]);
          assert.deepEqual(errors, []); assert.deepEqual(external, []);
          const servedAssets = await Promise.all(served);
          assert.ok(servedAssets.length > 0);
          assert.deepEqual(servedAssets.filter(asset => asset.error), []);
          captures.push({ engine, browser: browser.version(), width, offline: true,
            matchingDownloads: 4, spanCount: 4, matchedRecords: 2, unmatchedDownload: true,
            sampleDownload: true, keyboardScroll: true, logAxeViolations: logViolations,
            overflow: false, axeViolations: violations, pageErrors: errors, externalRequests: external,
            servedAssets });
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
  await writeFile(join(output, 'observations.json'), JSON.stringify({ cases: captures }, null, 2) + '\n');
  console.log(`${captures.length} offline SDK log workflows and downloads verified`);
} finally { server.kill(); }
