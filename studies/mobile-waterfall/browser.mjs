// Real worker imports and navigation in a long trace; no model/collector requests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium, firefox } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const [distArg, outArg] = process.argv.slice(2);
assert(distArg && outArg, 'Expected DIST OUTPUT [--expect-bounded]');
const bounded = process.argv.includes('--expect-bounded');
const dist = resolve(distArg), out = resolve(outArg), served = {};
await mkdir(out, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const server = createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.replace(/^\/tracelens\//, '') || 'index.html';
  const path = resolve(dist, name);
  if (!path.startsWith(dist + sep)) { response.writeHead(403); response.end(); return; }
  try {
    const bytes = await readFile(path); served[name] = hash(bytes);
    response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(path)] ?? 'application/octet-stream' });
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
function longTrace(count) {
  const traceId = 'ad'.repeat(16), root = 'ff'.repeat(8);
  const spans = Array.from({ length: count }, (_, i) => ({ traceId,
    spanId: i ? i.toString(16).padStart(16, '0') : root, ...(i ? { parentSpanId: root } : {}),
    name: i ? `call ${i}` : 'Synthetic long trace', startTimeUnixNano: String(i * 2000),
    endTimeUnixNano: String(i ? i * 2000 + 1000 : count * 2000) }));
  return JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
}
const records = [];
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox })) {
    const browser = await launcher.launch();
    try {
      for (const width of [375, 768, 1440]) {
        const context = await browser.newContext({ viewport: { width, height: 800 },
          colorScheme: width === 375 ? 'light' : 'dark', reducedMotion: 'reduce' });
        const errors = [], external = [], late = [], loaded = {}, pending = [];
        let offline = false;
        try {
          const page = await context.newPage();
          page.on('pageerror', error => errors.push(error.message));
          context.on('request', request => {
            if (!/^https?:/.test(request.url())) return;
            if (!request.url().startsWith(origin)) external.push(request.url());
            if (offline) late.push(request.url());
          });
          page.on('response', response => {
            if (!response.url().startsWith(origin)) return;
            pending.push((async () => { const name = new URL(response.url()).pathname.replace(/^\/tracelens\//, '') || 'index.html';
              loaded[name] = hash(await response.body()); })());
          });
          await page.addInitScript(() => {
            window.policyViolations = [];
            document.addEventListener('securitypolicyviolation', event => window.policyViolations.push(event.violatedDirective));
          });
          await page.goto(origin + '/tracelens/');
          await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.fonts].map(font => font.load())); });
          await context.setOffline(true); offline = true;
          for (const count of [160, 6000]) {
            if (count !== 160) await page.getByRole('button', { name: 'Load another trace', exact: true }).click();
            const text = longTrace(count);
            await page.locator('#tl-file-input').setInputFiles({ name: `synthetic-${count}.json`, mimeType: 'application/json', buffer: Buffer.from(text) });
            await page.waitForFunction(count => !document.querySelector('.tl-load-notice') &&
              document.querySelector('.tl-summary')?.textContent.includes(`${count.toLocaleString('en-US')} / 0`), count);
            await page.locator('.tl-wf-row[data-index="1"]').click();
            await page.waitForFunction(() => document.querySelector('.tl-detail-title')?.textContent.trim() === 'call 1');
            const geometry = await page.evaluate(() => {
              const center = document.querySelector('.tl-center').getBoundingClientRect();
              const detail = document.querySelector('.tl-detail-pane').getBoundingClientRect();
              const scroll = document.querySelector('.tl-waterfall-scroll');
              return { viewportHeight: innerHeight, centerHeight: center.height,
                documentHeight: document.documentElement.scrollHeight,
                detailDocumentTop: detail.top + scrollY, detailDistanceFromTimeline: detail.top - center.top,
                scrollerHeight: scroll.clientHeight, scrollerContentHeight: scroll.scrollHeight,
                visibleTimelineWidth: scroll.clientWidth - document.querySelector('.tl-wf-label').getBoundingClientRect().width,
                renderedRows: document.querySelectorAll('.tl-wf-row').length,
                overflow: document.documentElement.scrollWidth > innerWidth + 1 };
            });
            const withinOneViewport = geometry.centerHeight <= geometry.viewportHeight &&
              geometry.detailDistanceFromTimeline <= geometry.viewportHeight;
            if (bounded) assert(withinOneViewport, JSON.stringify({ engine, width, count, geometry }));
            if (bounded) assert(geometry.visibleTimelineWidth >= width / 3, JSON.stringify({ engine, width, count, geometry }));
            assert(!geometry.overflow);
            if (count === 160 && (width === 375 || bounded && width === 1440)) {
              if (width === 375) {
                await page.evaluate(() => window.scrollTo(0, 360));
                await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
              }
              await page.screenshot({ path: resolve(out, `${engine}-${width}.png`) });
            }
            // A bounded pane still has every span, and preserves navigation and source evidence.
            await page.locator('.tl-wf-row.selected').focus();
            await page.keyboard.press('End'); await page.keyboard.press('Enter');
            await page.waitForFunction(index => document.querySelector('.tl-detail-title')?.textContent.trim() === `call ${index}`, count - 1);
            const download = page.waitForEvent('download');
            await page.getByRole('button', { name: 'Download span JSON', exact: true }).click();
            const raw = await readFile(await (await download).path(), 'utf8'), selected = JSON.parse(raw);
            assert.equal(selected.spanId, (count - 1).toString(16).padStart(16, '0'));
            assert.equal(selected.startTimeUnixNano, String((count - 1) * 2000));
            const oldScroll = await page.locator('.tl-waterfall-scroll').evaluate(el => el.scrollTop);
            await page.getByRole('button', { name: '+', exact: true }).click();
            assert.equal(await page.locator('.tl-waterfall-scroll').evaluate(el => el.scrollTop), oldScroll);
            assert.equal(await page.locator('.tl-detail-title').innerText(), `call ${count - 1}`);
            const axe = (await new AxeBuilder({ page }).analyze()).violations.map(v => v.id);
            assert.deepEqual(axe, []);
            records.push({ engine, version: browser.version(), width, count, firstImportOffline: count === 160,
              inputBytes: Buffer.byteLength(text), inputSha256: hash(text), geometry, withinOneViewport,
              lastSpanReached: true, selectedSpanSha256: hash(raw), zoomPreservedScroll: true, axe });
          }
          await Promise.all(pending);
          for (const [name, digest] of Object.entries(loaded)) assert.equal(digest, served[name]);
          assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(late, []);
          assert.deepEqual(await page.evaluate(() => window.policyViolations), []);
          records.push({ engine, width, loaded, errors, external, late, csp: [] });
          console.log(`${engine} ${width}: both counts, keyboard, download and zoom checked`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
await writeFile(resolve(out, 'receipt.json'), JSON.stringify({ checkedAt: new Date().toISOString(), boundedExpected: bounded,
  served, records }, null, 2) + '\n');
