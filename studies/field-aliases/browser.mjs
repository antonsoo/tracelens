// Serve a tested build, then import native and derived captures offline through the actual worker.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';
import { chromium, firefox } from 'playwright';
const [distArg, outArg, mode] = process.argv.slice(2);
const dist = resolve(distArg), out = resolve(outArg), baseline = mode === '--baseline';
const nativeBytes = await readFile(new URL('../../tests/fixtures/census/strands-legacy-events-tool-call.json', import.meta.url));
const native = JSON.parse(nativeBytes), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const file = (name, json) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
const hidden = { resourceSpans: [native.resourceSpans.at(-1)], resource_spans: native.resourceSpans.slice(0, -1) };
const identity = structuredClone(native); identity.resourceSpans[0].scopeSpans[0].spans[0].trace_id = 'ffffffffffffffffffffffffffffffff';
const cases = [['hidden-child-spans.json', hidden], ['competing-identity.json', identity]];
await mkdir(out, { recursive: true });
const captures = [];
for (const [engine, launcher] of Object.entries({ chromium, firefox })) {
  const browser = await launcher.launch();
  try {
    for (const width of [1440, 375]) {
      const assets = {}, pending = [], errors = [], requestsAfterOffline = [];
      let offline = false;
      const server = createServer(async (request, response) => {
        const name = new URL(request.url, 'http://localhost').pathname.replace(/^\/tracelens\//, '') || 'index.html';
        const path = resolve(dist, name);
        if (!path.startsWith(dist + sep)) { response.writeHead(403); response.end(); return; }
        try {
          const bytes = await readFile(path);
          response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(path)] ?? 'application/octet-stream' });
          response.end(bytes);
        } catch { response.writeHead(404); response.end(); }
      });
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: 'dark' });
      try {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', r => { if (offline && /^https?:/.test(r.url())) requestsAfterOffline.push(r.url()); });
        page.on('response', r => {
          if (!/^https?:/.test(r.url())) return;
          pending.push((async () => {
            const name = new URL(r.url()).pathname.replace(/^\/tracelens\//, '') || 'index.html';
            const bytes = await r.body(); assert.equal(hash(bytes), hash(await readFile(resolve(dist, name))));
            assets[name] = { bytes: bytes.length, sha256: hash(bytes) };
          })());
        });
        await page.addInitScript(() => {
          window.violations = [];
          document.addEventListener('securitypolicyviolation', e => window.violations.push(e.violatedDirective));
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/tracelens/`);
        await page.locator('#tl-file-input').waitFor({ state: 'attached' });
        await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.fonts].map(font => font.load())); });
        await Promise.all(pending);
        await context.setOffline(true); offline = true;
        await page.locator('#tl-file-input').setInputFiles(file('native.json', native));
        await page.locator('.tl-wf-row').first().waitFor();
        assert.equal(await page.locator('.tl-wf-row').count(), 6);
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Compare with another run', exact: true }).click();
        await (await chooser).setFiles(file('candidate.json', native));
        await page.getByRole('heading', { name: 'Compare runs', exact: true }).waitFor();
        const download = async () => {
          const pendingDownload = page.waitForEvent('download');
          await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
          return JSON.parse(await readFile(await (await pendingDownload).path(), 'utf8'));
        };
        const previous = await download();
        assert.equal(previous.operations.flatMap(operation => operation.candidateCalls).length, 6);
        const rows = [];
        for (const [name, json] of cases) {
          await page.getByLabel('Replace candidate trace').setInputFiles(file(name, json));
          await page.waitForFunction(name => !document.querySelector('.tl-load-notice') && (
            document.querySelector('[role="alert"]')?.textContent.includes(name) || document.body.textContent.includes(name)), name);
          const alert = page.getByRole('alert');
          const error = await alert.count() ? await alert.innerText() : null;
          const report = await download();
          const preserved = JSON.stringify(previous) === JSON.stringify(report);
          const agrees = Boolean(error?.includes('contains both')) && preserved;
          rows.push({ case: name, error, inputSha256: hash(JSON.stringify(json)),
            candidateCalls: report.operations.flatMap(operation => operation.candidateCalls).length,
            preservedPreviousComparison: preserved, reportSha256: hash(JSON.stringify(report)), agrees });
          await page.waitForTimeout(300);
        }
        const screenshot = `${engine}-${width}.png`;
        await page.screenshot({ path: resolve(out, screenshot), fullPage: true });
        await page.getByLabel('Replace candidate trace').setInputFiles(file('recovered.json', native));
        await page.waitForFunction(() => !document.querySelector('.tl-load-notice') && !document.querySelector('[role="alert"]'));
        const recovered = await download();
        assert.equal(recovered.operations.flatMap(operation => operation.candidateCalls).length, 6);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        const violations = await page.evaluate(() => window.violations);
        assert.equal(overflow, 0); assert.deepEqual(errors, []); assert.deepEqual(requestsAfterOffline, []); assert.deepEqual(violations, []);
        captures.push({ engine, browser: browser.version(), width, rows, screenshot, recovered: true,
          servedAssets: assets, errors, requestsAfterOffline, violations, overflow });
        console.log(`${engine} ${width}: ${rows.filter(row => row.agrees).length}/2 guarded replacements`);
      } finally {
        await context.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
      }
    }
  } finally { await browser.close(); }
}
await writeFile(resolve(out, 'browser.json'), JSON.stringify({ baseline, nativeCaptureSha256: hash(nativeBytes), captures }, null, 2) + '\n');
if (!baseline) assert.ok(captures.every(capture => capture.rows.every(row => row.agrees)));
