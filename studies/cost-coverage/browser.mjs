// Serve both real production builds and exercise native worker imports offline.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { costCases, illustrativePrices } from './cases.mjs';
import { parseTraceText } from '../../dist-cli/core/index.js';

const [beforeArg, afterArg, outArg] = process.argv.slice(2);
assert(beforeArg && afterArg && outArg, 'Expected BEFORE_DIST AFTER_DIST OUTPUT');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), out = resolve(outArg);
const cases = costCases(root);
const expected = JSON.parse(await readFile(resolve(root, 'studies/cost-coverage/results/after.json'), 'utf8')).records;
const prices = illustrativePrices(parseTraceText(cases.find(item => item.id === 'missing-endTimeUnixNano').baseline));
const selected = ['missing-endTimeUnixNano', 'missing-spanId', 'nonobject-resource', 'nonarray-spans', 'truncated-jsonl-tail', 'missing-parent', 'invalid-parent-42', 'reversed-interval', 'optional-event-warning', 'recorded-zero-duration'];
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
        const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: width === 375 ? 'light' : 'dark' });
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
          await page.addInitScript(prices => {
            localStorage.setItem('tracelens.priceTable.v1', JSON.stringify(prices));
            window.policyViolations = [];
            document.addEventListener('securitypolicyviolation', event => window.policyViolations.push(event.violatedDirective));
          }, prices);
          await page.goto(origin + '/tracelens/');
          await page.locator('#tl-file-input').setInputFiles(file('input-0.json', native));
          await page.waitForFunction(() => document.querySelectorAll('.tl-wf-row').length === 6);
          await page.locator('.tl-cost-ledger > summary').click();
          await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.fonts].map(font => font.load())); });
          const download = async (button = 'Download cost JSON') => {
            const event = page.waitForEvent('download');
            await page.getByRole('button', { name: button, exact: true }).click();
            return JSON.parse(await readFile(await (await event).path(), 'utf8'));
          };
          const original = await download();
          assert.equal(original.estimatedCostUsd, 0.000227);
          await Promise.all(pending);
          await context.setOffline(true); offline = true;
          server.closeAllConnections(); await new Promise(done => server.close(done));
          for (const id of selected) {
            const item = cases.find(item => item.id === id);
            await page.getByRole('button', { name: 'Load another trace', exact: true }).click();
            await page.locator('#tl-file-input').setInputFiles(file('input-0.json', item.candidate));
            await page.waitForFunction(() => !document.querySelector('.tl-load-notice'));
            const ledger = page.locator('.tl-cost-ledger');
            await ledger.locator(':scope > summary').click();
            await ledger.getByRole('button', { name: 'Download cost JSON' }).waitFor();
            const report = await download();
            const header = await page.locator('.tl-summary').textContent();
            const explanation = await ledger.locator('.tl-cost-body > p').first().innerText();
            const agrees = item.incomplete ? report.incompleteInput === true && report.estimatedCostUsd === null
              && header.includes('Known token cost subtotal') && explanation.includes('full token estimate is unknown')
              : !report.incompleteInput && report.estimatedCostUsd === original.estimatedCostUsd && header.includes('Estimated token cost');
            if (phase === 'after') {
              assert(agrees, JSON.stringify({ engine, width, id, incompleteInput: report.incompleteInput, estimatedCostUsd: report.estimatedCostUsd, header, explanation }));
              assert.deepEqual(report, expected.find(row => row.id === id && row.kind === 'core-cost').report);
            }
            records.push({ phase, engine, width, id, inputSha256: hash(item.candidate), agrees, header, explanation, report });
            if (id === selected[0]) {
              await ledger.scrollIntoViewIfNeeded();
              await page.screenshot({ path: resolve(out, `${phase}-${engine}-${width}.png`), fullPage: true });
              await ledger.getByRole('button', { name: 'chat', exact: true }).click();
              const receipt = await download('Download cost receipt');
              assert.deepEqual(receipt.result, report.rows.find(row => row.kind === 'llm').result);
              assert.equal(receipt.result.costUsd, 0.000128);
            }
          }
          await page.getByRole('button', { name: 'Load another trace', exact: true }).click();
          await page.locator('#tl-file-input').setInputFiles(file('input-0.json', native));
          await page.waitForFunction(() => !document.querySelector('.tl-load-notice'));
          await page.locator('.tl-cost-ledger > summary').click();
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
