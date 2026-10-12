// node studies/event-messages/browser.mjs <checkout> <report.json> <images-dir> [--baseline]
// Serve actual built bytes, disconnect and stop the server, then use the file picker.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, extname, relative } from 'node:path';
import { chromium, firefox } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { cases, spanOf, hash, json } from './cases.mjs';
const [checkout, output, images, mode] = process.argv.slice(2);
assert(checkout && output && images);
const baseline = mode === '--baseline';
const dist = resolve(checkout, 'dist');
await mkdir(images, { recursive: true });
const selected = ['legacy-control', 'toolUse-string', 'legacy-input-attribute'];
const ordered = [...selected.map(id => cases.find(c => c.id === id)), ...cases.filter(c => !selected.includes(c.id))];
const report = { driverSha256: hash(await readFile(new URL(import.meta.url))), offline: true, serverStopped: true, contexts: [] };
async function download(page, name) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}
for (const [browserName, engine] of Object.entries({ chromium, firefox })) {
  const browser = await engine.launch();
  try {
    for (const width of [1440, 375]) {
      const served = new Map();
      const server = createServer(async (req, res) => {
        try {
          const path = new URL(req.url, 'http://localhost').pathname;
          assert(path.startsWith('/tracelens/'));
          const file = resolve(dist, path.slice('/tracelens/'.length) || 'index.html');
          assert(file.startsWith(dist + '/'));
          const bytes = await readFile(file);
          served.set(path, { path: relative(dist, file), bytes: bytes.length, sha256: hash(bytes) });
          res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[extname(file)] ?? 'application/octet-stream');
          res.end(bytes);
        } catch { res.writeHead(404); res.end(); }
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: 'dark' });
      const page = await context.newPage();
      const errors = [], failedRequests = [], externalRequests = [], lateRequests = [], csp = [], responseChecks = [];
      let offline = false;
      page.on('pageerror', e => errors.push(String(e)));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('requestfailed', r => failedRequests.push({ url: r.url().replace(origin, ''), reason: r.failure()?.errorText }));
      page.on('request', r => {
        if (/^https?:/.test(r.url())) {
          if (new URL(r.url()).origin !== origin) externalRequests.push(r.url());
          if (offline) lateRequests.push(r.url().replace(origin, ''));
        }
      });
      page.on('response', r => {
        if (!r.url().startsWith(origin)) return;
        responseChecks.push((async () => {
          const path = new URL(r.url()).pathname;
          assert.equal(r.status(), 200, path);
          const bytes = await r.body();
          assert.equal(hash(bytes), served.get(path)?.sha256, `${path}: served bytes differ`);
        })());
      });
      await page.exposeFunction('recordCsp', e => csp.push(e));
      await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => window.recordCsp({ blockedURI: e.blockedURI, violatedDirective: e.violatedDirective })));
      try {
        await page.goto(origin + '/tracelens/', { waitUntil: 'networkidle' });
        await page.evaluate(() => document.fonts.ready);
        const fonts = await page.evaluate(() => Array.from(document.fonts, f => ({ family: f.family, weight: f.weight, status: f.status })));
        if (!baseline) assert(fonts.every(f => f.status === 'loaded'), 'bundled fonts must load before disconnecting');
        await Promise.all(responseChecks);
        await context.setOffline(true);
        offline = true;
        await new Promise(r => server.close(r));
        const rows = [];
        for (const c of ordered) {
          const name = `${c.id}.json`;
          if (await page.getByRole('button', { name: 'Load another trace', exact: true }).count()) {
            await page.getByRole('button', { name: 'Load another trace', exact: true }).click();
          }
          await page.locator('#tl-file-input').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(json(c.doc)) });
          await page.waitForFunction(name => document.querySelector('.tl-active-file')?.textContent.includes(name) || document.querySelector('[role="alert"]')?.textContent.includes(name), name);
          const row = { id: c.id };
          if (await page.getByRole('alert').count()) {
            row.error = await page.getByRole('alert').innerText();
            assert(baseline, row.error);
          } else {
            assert.equal(await page.locator('.tl-wf-row').count(), 6);
            await page.locator('.tl-wf-row').filter({ has: page.locator('.tl-wf-name', { hasText: /^chat$/ }) }).first().click();
            await page.getByRole('tab', { name: 'Messages', exact: true }).click();
            const evidence = await download(page, 'Download span JSON');
            assert.equal(evidence.spanId, spanOf(c.doc).spanId);
            row.evidenceSha256 = hash(json(evidence));
            row.input = evidence.genai.inputMessages;
            row.output = evidence.genai.outputMessages;
            row.messagesText = await page.locator('#tl-detail-content').innerText();
            row.warnings = [];
            const warnings = page.locator('.tl-compare-warnings').filter({ has: page.locator('summary', { hasText: /parser warnings/ }) });
            if (await warnings.count()) {
              await warnings.locator('summary').click();
              row.warnings = await download(page, 'Download warnings JSON');
            }
            if (!baseline) {
              assert.deepEqual({ input: row.input, output: row.output, warnings: row.warnings.length }, c.expected);
              for (const [index, event] of evidence.events.entries()) {
                assert.deepEqual(event.attributes, Object.fromEntries(spanOf(c.doc).events[index].attributes.map(a => [a.key, a.value.stringValue])));
              }
              if (c.expected.warnings) assert.match(row.messagesText, /toolUse|toolResult|text/);
              assert(row.messagesText.includes('Output'), `${c.id}: output not visible`);
            }
            if (selected.includes(c.id)) row.downloadedSpan = evidence;
          }
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${c.id}: page overflow`);
          if (c.id === 'toolUse-string' || c.id === 'legacy-input-attribute') {
            const violations = (await new AxeBuilder({ page }).analyze()).violations;
            assert.deepEqual(violations, []);
            row.axeViolations = 0;
            const image = `${browserName}-${width}-${c.id}.png`;
            await page.screenshot({ path: join(images, image), fullPage: true });
            row.screenshot = image;
          }
          rows.push(row);
        }
        report.contexts.push({ browser: browserName, version: browser.version(), width, cases: rows.length,
          fonts, errors, failedRequests, externalRequests, lateRequests, csp, assets: [...served.values()], rows });
        await writeFile(output, JSON.stringify(report, null, 2) + '\n');
        if (!baseline) {
          assert.deepEqual(errors, []); assert.deepEqual(failedRequests, []); assert.deepEqual(lateRequests, []);
        }
        assert.deepEqual(externalRequests, []); assert.deepEqual(csp, []);
        console.log(`${browserName} ${width}: ${rows.length} offline imports, ${rows.filter(r => r.error).length} rejected`);
      } finally {
        if (server.listening) await new Promise(r => server.close(r));
        await context.close();
      }
    }
  } finally { await browser.close(); }
}
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
