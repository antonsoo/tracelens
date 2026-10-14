// Native worker imports, visible measurement states and actual downloads in both production builds.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const [beforeArg, afterArg, outArg] = process.argv.slice(2);
assert(beforeArg && afterArg && outArg, 'Expected BEFORE_DIST AFTER_DIST OUTPUT');
const here = dirname(fileURLToPath(import.meta.url)), out = resolve(outArg);
const screenshots = resolve(here, '../../docs/assets/status-evidence');
const oracle = JSON.parse(await readFile(resolve(here, 'fixtures/oracle.json'), 'utf8'));
const errorId = oracle.spans.find(span => span.status === 'ERROR').spanId;
const baseline = await readFile(resolve(here, 'fixtures/native-integers.json'));
const hash = raw => createHash('sha256').update(raw).digest('hex');
const file = (name, raw) => ({ name, mimeType: 'application/json', buffer: Buffer.isBuffer(raw) ? raw : Buffer.from(raw) });
const cases = ['quoted-integer', 'invalid-name', 'unknown-future-code'];
const rows = [], views = [];
await mkdir(out, { recursive: true });
await mkdir(screenshots, { recursive: true });

async function download(page, name) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return readFile(await (await event).path(), 'utf8');
}
const ready = page => page.waitForFunction(() => !document.querySelector('.tl-load-notice') && document.querySelectorAll('.tl-wf-row').length === 3);
const stat = (page, label) => page.locator('.tl-summary-cell').filter({ has: page.locator('.tl-summary-label', { hasText: label }) }).innerText();

for (const [phase, arg] of [['before', beforeArg], ['after', afterArg]]) {
  const dist = resolve(arg);
  for (const [engine, launcher] of Object.entries({ chromium, firefox })) {
    const browser = await launcher.launch();
    try {
      for (const width of [1440, 375]) {
        const served = {}, loaded = {}, pending = [], errors = [], late = [], external = [];
        let offline = false;
        const server = createServer(async (request, response) => {
          const name = new URL(request.url, 'http://localhost').pathname.replace(/^\/tracelens\//, '') || 'index.html';
          const path = resolve(dist, name);
          if (!path.startsWith(dist + sep)) { response.writeHead(403); response.end(); return; }
          try {
            const raw = await readFile(path); served[name] = hash(raw);
            response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(path)] ?? 'application/octet-stream' });
            response.end(raw);
          } catch { response.writeHead(404); response.end(); }
        });
        await new Promise(done => server.listen(0, '127.0.0.1', done));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: 'dark', reducedMotion: 'reduce' });
        try {
          const page = await context.newPage();
          page.on('pageerror', error => errors.push(error.message));
          context.on('request', request => {
            if (!/^https?:/.test(request.url())) return;
            if (!request.url().startsWith(origin)) external.push(request.url());
            if (offline) late.push(request.url());
          });
          context.on('response', response => {
            if (!response.url().startsWith(origin)) return;
            pending.push((async () => {
              const name = new URL(response.url()).pathname.replace(/^\/tracelens\//, '') || 'index.html';
              const raw = await response.body(); assert.equal(hash(raw), hash(await readFile(resolve(dist, name))));
              loaded[name] = hash(raw);
            })());
          });
          await page.addInitScript(() => {
            window.policyViolations = [];
            document.addEventListener('securitypolicyviolation', event => window.policyViolations.push(event.violatedDirective));
          });
          await page.goto(origin + '/tracelens/');
          await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.fonts].map(font => font.load())); });
          await context.setOffline(true); offline = true;
          server.closeAllConnections(); await new Promise(done => server.close(done));

          // First trace import in this fresh context is already disconnected.
          await page.locator('#tl-file-input').setInputFiles(file('baseline.json', baseline));
          await ready(page);
          assert.match(await stat(page, 'Spans / errors'), /3 \/ 1/);
          const chooser = page.waitForEvent('filechooser');
          await page.getByRole('button', { name: 'Compare with another run', exact: true }).click();
          await (await chooser).setFiles(file('candidate.json', baseline));
          await page.getByRole('heading', { name: 'Compare runs', exact: true }).waitFor();
          for (const id of cases) {
            const raw = await readFile(resolve(here, `fixtures/${id}.json`));
            await page.getByLabel('Replace candidate trace').setInputFiles(file(`${id}.json`, raw));
            await page.waitForFunction(() => !document.querySelector('.tl-load-notice'));
            assert.equal(await page.getByRole('alert').count(), 0);
            const captured = await download(page, 'Export JSON');
            const report = JSON.parse(captured);
            const unknown = id !== 'quoted-integer';
            const agrees = report.metrics.errors.candidate.missing === (unknown ? 1 : 0)
              && report.metrics.errors.delta === (unknown ? null : 0)
              && report.metrics.calls.delta === 0 && report.wallTimeMs.delta === 0;
            if (phase === 'after') assert(agrees, `${engine}/${width}/${id}`);
            const errorRow = page.locator('.tl-compare-metrics tbody tr').filter({ has: page.locator('th', { hasText: /^Errors$/ }) }).first();
            const rowText = await errorRow.innerText();
            if (phase === 'after') assert(unknown ? rowText.includes('Unknown') : !rowText.includes('-100.0%'));
            await writeFile(resolve(out, `${phase}-${engine}-${width}-${id}-comparison.json`), captured);
            if (id === 'invalid-name') await page.screenshot({ path: resolve(screenshots, `${phase}-${engine}-${width}-comparison.png`), fullPage: true });
            rows.push({ phase, engine, width, id, inputSha256: hash(raw), reportSha256: hash(captured),
              errorRow: rowText, errors: report.metrics.errors, agrees });
          }

          const operation = page.locator('details.tl-operation').filter({ has: page.locator(`button[title="Inspect span ${errorId}"]`) });
          if (await operation.getAttribute('open') === null) await operation.locator('summary').click();
          await operation.locator(`button[title="Inspect span ${errorId}"]`).nth(1).click();
          await ready(page);
          const errorsText = await stat(page, 'Spans / errors');
          const retriesText = await stat(page, 'Possible retries');
          if (phase === 'after') { assert(errorsText.includes('Unknown')); assert(retriesText.includes('Unknown')); }
          const selected = await download(page, 'Download span JSON');
          const span = JSON.parse(selected);
          assert.equal(span.spanId, errorId);
          if (phase === 'after') {
            assert.equal(span.status.code, 'UNKNOWN');
            assert.equal(span.status.raw.code, 3);
          }
          await writeFile(resolve(out, `${phase}-${engine}-${width}-span.json`), selected);
          await page.screenshot({ path: resolve(screenshots, `${phase}-${engine}-${width}-summary.png`), fullPage: true });
          const violations = (await new AxeBuilder({ page }).analyze()).violations.map(v => v.id);
          const policy = await page.evaluate(() => window.policyViolations);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
          assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(late, []);
          assert.deepEqual(policy, []); assert.deepEqual(violations, []); assert(!overflow);
          await Promise.all(pending);
          for (const [name, sha] of Object.entries(loaded)) assert.equal(sha, served[name]);
          views.push({ phase, engine, width, browser: browser.version(), firstImportOffline: true,
            errorsText, retriesText, rawSpanSha256: hash(selected), served, loaded, pageErrors: errors,
            externalRequests: external, lateRequests: late, policyViolations: policy, axeViolations: violations, overflow });
          console.log(`PASS ${phase} ${engine} ${width}px: offline comparisons, summary and raw span download`);
        } finally { server.closeAllConnections(); server.close(); await context.close(); }
      }
    } finally { await browser.close(); }
  }
}
await writeFile(resolve(out, 'receipt.json'), JSON.stringify({ rows, views,
  beforeDisagreements: rows.filter(row => row.phase === 'before' && !row.agrees).length,
  afterDisagreements: rows.filter(row => row.phase === 'after' && !row.agrees).length }, null, 2) + '\n');
