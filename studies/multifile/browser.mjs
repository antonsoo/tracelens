import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, firefox, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const { values: args } = parseArgs({ options: {
  build: { type: 'string', default: 'dist' }, output: { type: 'string' }, after: { type: 'boolean', default: false },
} });
const build = resolve(args.build);
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const oracle = JSON.parse(await readFile(join(fixtures, 'oracle.json')));
const inputs = await Promise.all(['worker.json', 'gateway.jsonl', 'audit.jsonl'].map(async name => ({ name, text: await readFile(join(fixtures, name), 'utf8') })));
await mkdir(args.output, { recursive: true });
const results = [];
async function download(page, name) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}
const sha = data => createHash('sha256').update(data).digest('hex');
for (const [engine, driver] of Object.entries({ chromium, firefox })) {
  const browser = await driver.launch();
  try {
    for (const width of [1440, 375]) {
      const server = createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const relative = pathname.replace(/^\/tracelens\//, '') || 'index.html';
        const path = resolve(build, relative);
        if (!path.startsWith(build + '/')) { response.writeHead(404).end(); return; }
        try {
          const bytes = await readFile(path);
          response.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' })[extname(path)] ?? 'application/octet-stream');
          response.end(bytes);
        } catch { response.writeHead(404).end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: width === 1440 ? 'dark' : 'light' });
      const page = await context.newPage();
      const errors = [], external = [], late = [], assets = {}, reads = [];
      let offline = false;
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => { window.csp = []; addEventListener('securitypolicyviolation', event => window.csp.push(event.violatedDirective)); });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { external.push(url.href); return route.abort(); }
        if (offline) late.push(url.pathname);
        return route.continue();
      });
      page.on('response', response => {
        if (response.status() !== 200) return;
        const path = new URL(response.url()).pathname.replace(/^\/tracelens\//, '') || 'index.html';
        reads.push(response.body().then(async bytes => {
          assert.equal(sha(bytes), sha(await readFile(join(build, path))));
          assets[path] = { bytes: bytes.length, sha256: sha(bytes) };
        }));
      });
      try {
        await page.goto(origin + '/tracelens/');
        await expect(page.locator('.tl-dropzone-card')).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await Promise.all(reads);
        await new Promise(resolve => server.close(resolve));
        offline = true;
        const transfer = await page.evaluateHandle(inputs => {
          const transfer = new DataTransfer();
          for (const input of inputs) transfer.items.add(new File([input.text], input.name, { type: 'application/json' }));
          return transfer;
        }, inputs);
        await page.locator('.tl-dropzone-card').dispatchEvent('drop', { dataTransfer: transfer });
        await expect(page.locator('.tl-wf-row')).toHaveCount(args.after ? 7 : 4);
        if (args.after) await page.locator('.tl-wf-row').filter({ hasText: 'sha256' }).first().click();
        // Inspect stable rendered colors, not an intermediate frame of the 420ms entrance animation.
        await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
        const body = await page.locator('body').innerText();
        assert.ok(body.includes(args.after ? 'run document checks' : 'POST /digest'));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const axe = await new AxeBuilder({ page }).analyze();
        const violations = axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) }));
        await page.screenshot({ path: join(args.output, `${engine}-${width}.png`), fullPage: true });
        if (args.after) assert.deepEqual(violations, []);
        const evidence = {};
        if (args.after) {
          const tool = await download(page, 'Download span JSON');
          assert.equal(tool.sourceFile.name, 'worker.json');
          assert.equal(tool.depth, 3);
          const sdkTool = oracle.spans.find(span => span.spanId === tool.spanId);
          assert.deepEqual(tool.attributes, sdkTool.attributes);
          evidence.tool = tool;
          await page.locator('#tl-trace-picker').selectOption(oracle.audit.traceId);
          await expect(page.locator('.tl-wf-row')).toHaveCount(2);
          await page.locator('.tl-links summary').click();
          evidence.links = await download(page, 'Download links JSON');
          assert.equal(evidence.links.inputFiles.length, 3);
          assert.equal(evidence.links.linkCount, 2);
          assert.ok(evidence.links.spans[0].links.every(link => link.target.status === 'available'));
          await page.locator('.tl-links').getByRole('button', { name: 'commit audit batch', exact: true }).click();
          await page.getByRole('button', { name: 'Inspect POST /digest', exact: true }).first().focus();
          await page.keyboard.press('Enter');
          await expect(page.locator('.tl-detail-title')).toHaveText('POST /digest');
          await expect(page.locator('.tl-detail-title')).toBeFocused();
          const target = await download(page, 'Download span JSON');
          assert.equal(target.traceId, oracle.run.traceId);
          assert.equal(target.sourceFile.name, 'worker.json');
          assert.equal(target.depth, 2);
          evidence.linkTarget = target;
          await page.getByRole('button', { name: 'Back to source span', exact: true }).click();
          await expect(page.locator('.tl-detail-title')).toHaveText('commit audit batch');
          await page.locator('#tl-trace-picker').selectOption(oracle.run.traceId);
          await expect(page.locator('.tl-wf-row')).toHaveCount(7);
          const payloads = inputs.map(input => ({ name: input.name, mimeType: 'application/json', buffer: Buffer.from(input.text) }));
          await page.getByLabel('Candidate trace file', { exact: true }).setInputFiles(payloads);
          await expect(page.locator('.tl-comparison')).toBeVisible();
          evidence.comparison = await download(page, 'Export JSON');
          assert.equal(evidence.comparison.metrics.calls.baseline.value, 7);
          assert.equal(evidence.comparison.metrics.calls.candidate.value, 7);
          assert.equal(evidence.comparison.wallTimeMs.delta, 0);
          assert.deepEqual(evidence.comparison.inputFiles.baseline, evidence.comparison.inputFiles.candidate);
          await page.getByLabel('Replace candidate trace', { exact: true }).setInputFiles([...payloads, payloads[0]]);
          await expect(page.getByRole('alert')).toContainText('Duplicate span identity');
          assert.deepEqual(await download(page, 'Export JSON'), evidence.comparison);
          await page.getByLabel('Replace candidate trace', { exact: true }).setInputFiles([payloads[0], { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{}') }]);
          await expect(page.getByRole('alert')).toContainText('File 2 (broken.json)');
          assert.deepEqual(await download(page, 'Export JSON'), evidence.comparison);
          await page.getByLabel('Replace candidate trace', { exact: true }).setInputFiles([payloads[0]]);
          await expect(page.getByRole('alert')).toHaveCount(0);
          evidence.partialCandidate = await download(page, 'Export JSON');
          assert.equal(evidence.partialCandidate.metrics.calls.baseline.value, 7);
          assert.equal(evidence.partialCandidate.metrics.calls.candidate.value, 4);
          assert.equal(evidence.partialCandidate.warnings.length, 2);
          // Choosing a new group also uses the native multi-file input, not just drag/drop.
          await page.getByRole('button', { name: 'Load another trace', exact: true }).click();
          await page.locator('#tl-file-input').setInputFiles(payloads);
          await expect(page.locator('.tl-wf-row')).toHaveCount(7);
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        assert.deepEqual(late, []);
        assert.deepEqual(await page.evaluate(() => window.csp), []);
        results.push({ engine, browser: browser.version(), width, sdkSpansInDroppedFiles: oracle.spans.length,
          visibleSpans: await page.locator('.tl-wf-row').count(), inputs: inputs.map(input => input.name),
          body, evidence, assets, pageErrors: errors, externalRequests: external, lateRequests: late, axeViolations: violations });
      } finally {
        if (server.listening) await new Promise(resolve => server.close(resolve));
        await context.close();
      }
    }
  } finally { await browser.close(); }
}
await writeFile(join(args.output, 'observations.json'), JSON.stringify({ after: args.after, cases: results }, null, 2) + '\n');
console.log(`${results.length} offline browser imports inspected`);
