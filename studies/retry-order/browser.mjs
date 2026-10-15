// Check real production workers and visible summaries before/after, offline at first import.
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
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(outArg), images = resolve(here, '../../docs/assets/retry-order');
await mkdir(out, { recursive: true });
await mkdir(images, { recursive: true });
const native = JSON.parse(await readFile(resolve(here, 'fixtures/native.json'), 'utf8'));
const oracle = JSON.parse(await readFile(resolve(here, 'fixtures/oracle.json'), 'utf8'));
const failed = oracle.observations.find(o => o.outcome === 'ERROR').spanId;
const spans = native.resourceSpans[0].scopeSpans[0].spans;
const root = spans.find(s => !s.parentSpanId), tools = spans.filter(s => s.parentSpanId);
const permutations = values => values.length ? values.flatMap((v, i) =>
  permutations(values.filter((_, j) => i !== j)).map(rest => [v, ...rest])) : [[]];
const hash = raw => createHash('sha256').update(raw).digest('hex');
const observations = [];
for (const [phase, directory] of [['before', beforeArg], ['after', afterArg]]) {
  const dist = resolve(directory);
  for (const [name, engine] of Object.entries({ chromium, firefox })) {
    const browser = await engine.launch();
    try {
      for (const [width, theme] of [[1440, 'dark'], [375, 'light']]) {
        const served = {}, loaded = {}, pending = [], errors = [], external = [], late = [];
        let offline = false;
        const server = createServer(async (request, response) => {
          const name = new URL(request.url, 'http://localhost').pathname.replace(/^\/tracelens\//, '') || 'index.html';
          const path = resolve(dist, name);
          if (!path.startsWith(dist + sep)) { response.writeHead(403); response.end(); return; }
          try {
            const raw = await readFile(path); served[name] = hash(raw);
            response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript',
              '.css': 'text/css', '.woff2': 'font/woff2' })[extname(path)] ?? 'application/octet-stream' });
            response.end(raw);
          } catch { response.writeHead(404); response.end(); }
        });
        await new Promise(done => server.listen(0, '127.0.0.1', done));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme,
          reducedMotion: 'reduce' });
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
              loaded[name] = hash(await response.body());
              assert.equal(loaded[name], hash(await readFile(resolve(dist, name))));
            })());
          });
          await page.addInitScript(() => {
            window.policyViolations = [];
            document.addEventListener('securitypolicyviolation', event => window.policyViolations.push(event.violatedDirective));
          });
          await page.goto(origin + '/tracelens/');
          await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.fonts].map(f => f.load())); });
          await context.setOffline(true); offline = true;
          server.closeAllConnections(); await new Promise(done => server.close(done));
          const values = [];
          for (const [i, order] of permutations(tools).entries()) {
            if (i) await page.getByRole('button', { name: 'Load another trace', exact: true }).click();
            const doc = structuredClone(native);
            doc.resourceSpans[0].scopeSpans[0].spans = [root, ...order];
            await page.locator('#tl-file-input').setInputFiles({ name: `order-${i}.json`,
              mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
            await page.waitForFunction(() => !document.querySelector('.tl-load-notice') &&
              document.querySelectorAll('.tl-wf-row').length === 4);
            const cell = page.locator('.tl-summary-cell').filter({
              has: page.locator('.tl-summary-label', { hasText: 'Possible retries' }),
            });
            const value = await cell.locator('.tl-summary-value').innerText();
            const text = await cell.innerText();
            if (phase === 'after') { assert.equal(value, 'Unknown'); assert.match(text, /0 observed; 1 predecessor\(s\) uncertain/); }
            values.push({ order: order.map(s => s.spanId), value, text });
          }
          if (phase === 'before') assert.deepEqual([...new Set(values.map(v => v.value))].sort(), ['0', '1']);
          const errorCell = await page.locator('.tl-summary-cell').filter({
            has: page.locator('.tl-summary-label', { hasText: 'Spans / errors' }),
          }).innerText();
          assert.match(errorCell, /4 \/ 1/);
          await page.locator('.tl-wf-row.status-error').click();
          const download = page.waitForEvent('download');
          await page.getByRole('button', { name: 'Download span JSON', exact: true }).click();
          const raw = await readFile(await (await download).path(), 'utf8');
          const selected = JSON.parse(raw);
          assert.equal(selected.spanId, failed);
          assert.equal(selected.status.code, 'ERROR');
          assert.equal(selected.startTimeUnixNano, oracle.observations[0].startTimeUnixNano);
          await writeFile(resolve(out, `${phase}-${name}-${width}-span.json`), raw);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
          const csp = await page.evaluate(() => window.policyViolations);
          const axe = (await new AxeBuilder({ page }).analyze()).violations.map(v => v.id);
          assert(!overflow); assert.deepEqual(errors, []); assert.deepEqual(external, []);
          assert.deepEqual(late, []); assert.deepEqual(csp, []); assert.deepEqual(axe, []);
          await page.screenshot({ path: resolve(images, `${phase}-${name}-${width}.png`), fullPage: true });
          await Promise.all(pending);
          for (const [asset, digest] of Object.entries(loaded)) assert.equal(digest, served[asset]);
          observations.push({ phase, browser: name, version: browser.version(), width, theme, firstImportOffline: true,
            values, errorCell, selectedSpanSha256: hash(raw), served, loaded, errors, external, late, csp, axe, overflow });
          console.log(`${phase} ${name} ${width}: all six imports, summary, raw download and offline checks passed`);
        } finally {
          server.closeAllConnections(); server.close(); await context.close();
        }
      }
    } finally { await browser.close(); }
  }
}
await writeFile(resolve(out, 'browser.json'), JSON.stringify({ imports: observations.length * 6, observations }, null, 2) + '\n');
