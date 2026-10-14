// Serve both real production builds and exercise native worker imports offline.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { comparisonCases } from './cases.mjs';

const [beforeArg, afterArg, outArg] = process.argv.slice(2);
assert(beforeArg && afterArg && outArg, 'Expected BEFORE_DIST AFTER_DIST OUTPUT');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), out = resolve(outArg);
const cases = comparisonCases(root);
const selected = ['missing-endTimeUnixNano', 'invalid-parent-42', 'reversed-interval', 'missing-parent',
  'nonobject-resource', 'nonarray-spans', 'truncated-jsonl-tail', 'jaeger-missing-duration'];
const native = cases.find(item => item.id === 'missing-endTimeUnixNano').baseline;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const file = (name, text) => ({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
await mkdir(out, { recursive: true });
const views = [], records = [];
for (const [phase, distArg] of [['before', beforeArg], ['after', afterArg]]) {
  const dist = resolve(distArg);
  for (const [engine, launcher] of Object.entries({ chromium, firefox })) {
    const browser = await launcher.launch();
    try {
      for (const width of [1440, 375]) {
        const served = {}, loaded = {}, pending = [], errors = [], external = [], late = [];
        let offline = false;
        const server = createServer(async (request, response) => {
          const name = new URL(request.url, 'http://localhost').pathname.replace(/^\/tracelens\//, '') || 'index.html';
          const path = resolve(dist, name);
          if (!path.startsWith(dist + sep)) { response.writeHead(403); response.end(); return; }
          try {
            const bytes = await readFile(path); served[name] = { bytes: bytes.length, sha256: hash(bytes) };
            response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
            response.end(bytes);
          } catch { response.writeHead(404); response.end(); }
        });
        await new Promise(done => server.listen(0, '127.0.0.1', done));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: 'dark' });
        try {
          const page = await context.newPage();
          page.on('pageerror', error => errors.push(error.message));
          page.on('request', request => {
            if (!/^https?:/.test(request.url())) return;
            if (new URL(request.url()).origin !== origin) external.push(request.url());
            if (offline) late.push(request.url());
          });
          page.on('response', response => {
            if (!response.url().startsWith(origin)) return;
            pending.push((async () => {
              const name = new URL(response.url()).pathname.replace(/^\/tracelens\//, '') || 'index.html';
              const bytes = await response.body(); assert.equal(hash(bytes), hash(await readFile(resolve(dist, name))));
              loaded[name] = { bytes: bytes.length, sha256: hash(bytes) };
            })());
          });
          await page.addInitScript(() => {
            window.policyViolations = [];
            document.addEventListener('securitypolicyviolation', event => window.policyViolations.push(event.violatedDirective));
          });
          await page.goto(origin + '/tracelens/');
          await page.locator('#tl-file-input').setInputFiles(file('baseline.json', native));
          await page.waitForFunction(() => document.querySelectorAll('.tl-wf-row').length === 6);
          await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.fonts].map(font => font.load())); });
          const chooser = page.waitForEvent('filechooser');
          await page.getByRole('button', { name: 'Compare with another run', exact: true }).click();
          await (await chooser).setFiles(file('candidate.json', native));
          await page.getByRole('heading', { name: 'Compare runs', exact: true }).waitFor();
          const download = async () => {
            const event = page.waitForEvent('download');
            await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
            return JSON.parse(await readFile(await (await event).path(), 'utf8'));
          };
          const original = await download();
          await Promise.all(pending);
          await context.setOffline(true); offline = true;
          server.closeAllConnections(); await new Promise(done => server.close(done));
          for (const id of selected) {
            const item = cases.find(item => item.id === id);
            await page.getByLabel('Replace candidate trace').setInputFiles(file('candidate.json', item.candidate));
            await page.waitForFunction(() => !document.querySelector('.tl-load-notice'));
            const alert = await page.getByRole('alert').allTextContents();
            const report = await download();
            const preserved = JSON.stringify(report) === JSON.stringify(original);
            const agrees = alert.some(text => text.includes('Cannot compare candidate:')) && preserved;
            if (phase === 'after') assert(agrees, `${engine}/${width}/${id}`);
            records.push({ phase, engine, width, id, inputSha256: hash(item.candidate), agrees,
              rejection: alert, previousComparisonPreserved: preserved, report });
            if (id === selected[0]) {
              const path = `${phase}-${engine}-${width}.png`;
              await page.screenshot({ path: resolve(out, path), fullPage: true });
            }
          }
          await page.getByLabel('Replace candidate trace').setInputFiles(file('candidate.json', native));
          await page.waitForFunction(() => !document.querySelector('.tl-load-notice') && !document.querySelector('[role="alert"]'));
          const recovered = await download(); assert.deepEqual(recovered, original);
          const violations = (await new AxeBuilder({ page }).analyze()).violations.map(row => row.id);
          const policy = await page.evaluate(() => window.policyViolations);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
          assert.deepEqual(violations, []); assert.deepEqual(errors, []); assert.deepEqual(external, []);
          assert.deepEqual(late, []); assert.deepEqual(policy, []); assert(!overflow);
          await Promise.all(pending);
          views.push({ phase, engine, browser: browser.version(), width, recovered: true, served, loaded,
            pageErrors: errors, externalRequests: external, lateRequests: late, policyViolations: policy,
            axeViolations: violations, overflow });
        } finally { server.closeAllConnections(); server.close(); await context.close(); }
      }
    } finally { await browser.close(); }
  }
}
const result = { node: process.version, workflows: records.length,
  beforeDisagreements: records.filter(row => row.phase === 'before' && !row.agrees).length,
  afterDisagreements: records.filter(row => row.phase === 'after' && !row.agrees).length, records, views };
await writeFile(resolve(out, 'observations.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ workflows: result.workflows, beforeDisagreements: result.beforeDisagreements,
  afterDisagreements: result.afterDisagreements, views: views.length }));
