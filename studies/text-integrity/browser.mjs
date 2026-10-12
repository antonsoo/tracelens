// node browser.mjs DIST OUTPUT_DIR [--baseline]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium, firefox } from 'playwright';
const [distArg, outputArg, mode] = process.argv.slice(2);
const dist = resolve(distArg), output = resolve(outputArg), baseline = mode === '--baseline';
const manifest = await readFile(new URL('./cases.json', import.meta.url));
const cases = JSON.parse(manifest).cases.filter(c => c.format !== 'prices');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const control = cases.find(c => c.id === 'otlp-utf-8-unicode');
const inputFile = c => ({ name: `${c.id}.json`, mimeType: 'application/json', buffer: Buffer.from(c.base64, 'base64') });
await mkdir(output, { recursive: true });
const captures = [];

for (const [engine, launcher] of Object.entries({ chromium, firefox })) {
  const browser = await launcher.launch();
  try {
    for (const width of [1440, 375]) {
      let closed = false;
      const errors = [], lateRequests = [], assets = {}, pending = [];
      const server = createServer(async (request, response) => {
        const name = new URL(request.url, 'http://localhost').pathname.replace(/^\/tracelens\//, '') || 'index.html';
        const path = resolve(dist, name);
        if (!path.startsWith(dist + sep)) { response.writeHead(403); response.end(); return; }
        try {
          const bytes = await readFile(path);
          response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' })[extname(path)] ?? 'application/octet-stream' });
          response.end(bytes);
        } catch { response.writeHead(404); response.end(); }
      });
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      const close = async () => { if (!closed) { closed = true; server.closeAllConnections(); await new Promise(done => server.close(done)); } };
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: 'dark' });
      try {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', r => { if (closed && /^https?:/.test(r.url())) lateRequests.push(r.url()); });
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
        await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.fonts].map(f => f.load())); });
        await Promise.all(pending); await close(); await context.setOffline(true);
        await page.locator('#tl-file-input').setInputFiles(inputFile(control));
        await page.locator('.tl-wf-row').first().waitFor();
        // Enter comparison through the actual hidden input used by its button.
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Compare with another run', exact: true }).click();
        await (await chooser).setFiles(inputFile(control));
        await page.getByRole('heading', { name: 'Compare runs', exact: true }).waitFor();
        const download = async () => {
          const pendingDownload = page.waitForEvent('download');
          await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
          return JSON.parse(await readFile(await (await pendingDownload).path(), 'utf8'));
        };
        const rows = [];
        let previousReport = await download();
        for (const c of cases) {
          await page.getByLabel('Replace candidate trace').setInputFiles(inputFile(c));
          await page.waitForFunction(name => !document.querySelector('.tl-load-notice') && (
            document.querySelector('[role="alert"]')?.textContent.includes(name) ||
            document.body.textContent.includes(name)), `${c.id}.json`);
          // The report button becomes available only after the import completes.
          await page.getByRole('button', { name: 'Export JSON', exact: true }).waitFor();
          const error = await page.getByRole('alert').count() ? await page.getByRole('alert').innerText() : null;
          const report = await download();
          const retained = JSON.stringify(report) === JSON.stringify(previousReport);
          const name = report.operations.flatMap(o => o.candidateCalls).map(call => call.name);
          const expectedName = c.valid && (c.id.includes('literal-replacement') ? 'operation �' : 'operation café 東京 🔥');
          const matches = c.valid ? !error && name.length === 1 && name[0] === expectedName
            : !!error && /Invalid UTF-(8|16LE|16BE) text\. Re-export/.test(error) && retained;
          rows.push({ id: c.id, valid: c.valid, error, retainedPreviousReport: retained,
            candidateNames: name, downloadedReportSha256: hash(JSON.stringify(report)), matches });
          previousReport = report;
          // Chromium limits automatic downloads; keep this evidence replay below
          // that rate while retaining an actual download for every input.
          await page.waitForTimeout(250);
        }
        // End on the same damaged UTF-8 replacement in both versions, then
        // recover through the same candidate picker with valid UTF-16 text.
        const damaged = cases.find(c => c.id === 'otlp-utf-8-continuation-80');
        await page.getByLabel('Replace candidate trace').setInputFiles(inputFile(damaged));
        await page.waitForFunction(() => !document.querySelector('.tl-load-notice'));
        const screenshot = `${engine}-${width}.png`;
        await page.screenshot({ path: resolve(output, screenshot), fullPage: true });
        const recovery = cases.find(c => c.id === 'otlp-utf-16be-unicode');
        await page.getByLabel('Replace candidate trace').setInputFiles(inputFile(recovery));
        await page.waitForFunction(() => !document.querySelector('[role="alert"]') && !document.querySelector('.tl-load-notice'));
        const recovered = await download();
        assert.deepEqual(recovered.operations.flatMap(o => o.candidateCalls).map(c => c.name), ['operation café 東京 🔥']);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        const violations = await page.evaluate(() => window.violations);
        assert.equal(overflow, 0); assert.deepEqual(errors, []); assert.deepEqual(lateRequests, []); assert.deepEqual(violations, []);
        captures.push({ engine, browser: browser.version(), width, rows, matches: rows.filter(r => r.matches).length,
          total: rows.length, recovered: true, screenshot, assets, errors, lateRequests, violations, overflow });
        console.log(`${engine} ${width}: ${rows.filter(r => r.matches).length}/${rows.length} correct imports/rejections`);
      } finally { await context.close(); await close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(resolve(output, 'browser.json'), JSON.stringify({ synthetic: true, baseline,
  manifestSha256: hash(manifest), captures }, null, 2) + '\n');
if (!baseline) assert.ok(captures.every(c => c.matches === c.total));
