// Constructed visual-ambiguity control from the retained synthetic Jaeger fixture.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium, firefox, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const [url, output, phase] = process.argv.slice(2);
assert.ok(url && output && ['before', 'after'].includes(phase), 'URL OUTPUT before|after');
await mkdir(output, { recursive: true });
const short = ['1234567890abcdef', '1234567890abcdee'];
const full = short.map(id => id.padStart(32, '0'));
const original = JSON.parse(await readFile(new URL('./fixtures/gateway.jaeger.json', import.meta.url), 'utf8'));
const source = JSON.stringify({ data: short.map((traceID, index) => ({ ...original.data[0], traceID,
  spans: [{ ...original.data[0].spans[0], traceID, spanID: String(index + 1).padStart(16, '0') }] })) });
const rows = [];
for (const [engine, launcher] of [['chromium', chromium], ['firefox', firefox]]) {
  const browser = await launcher.launch();
  try {
    for (const width of [1440, 375]) {
      const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: width === 375 ? 'light' : 'dark', reducedMotion: 'reduce' });
      try {
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(url); await page.evaluate(() => document.fonts.ready); await context.setOffline(true);
        await page.locator('#tl-file-input').setInputFiles({ name: 'two-jaeger-traces.json', mimeType: 'application/json', buffer: Buffer.from(source) });
        await expect(page.locator('#tl-trace-picker option')).toHaveCount(2);
        const options = await page.locator('#tl-trace-picker option').evaluateAll(options => options.map(option => ({ text: option.textContent, value: option.value, title: option.title })));
        assert.deepEqual(options.map(option => option.value).sort(), [...full].sort());
        if (phase === 'before') { assert.equal(options[0].text, options[1].text); assert.ok(options[0].text.endsWith('00000000')); }
        else {
          assert.notEqual(options[0].text, options[1].text);
          for (const option of options) { const i = full.indexOf(option.value); assert.ok(option.text.startsWith(short[i])); assert.equal(option.title, full[i]); }
        }
        const inspected = [];
        for (let i = 0; i < full.length; i++) {
          await page.locator('#tl-trace-picker').selectOption(full[i]);
          await expect(page.locator('#tl-trace-picker')).toHaveValue(full[i]);
          await expect(page.locator('.tl-load-notice')).toHaveCount(0);
          await page.getByRole('treeitem', { name: /^dispatch request / }).click();
          const id = await page.locator('.tl-detail-meta .mono.faint').textContent();
          assert.equal(id, phase === 'before' ? '000000000000' : String(i + 1).padStart(16, '0'));
          const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download span JSON', exact: true }).click();
          const bytes = await readFile(await (await pending).path()); const evidence = JSON.parse(bytes);
          assert.equal(evidence.traceId, full[i]); assert.equal(evidence.spanId, String(i + 1).padStart(16, '0'));
          inspected.push({ visibleSpanId: id, traceId: evidence.traceId, spanId: evidence.spanId, downloadSha256: createHash('sha256').update(bytes).digest('hex') });
        }
        await page.screenshot({ path: `${output}/${engine}-${width}.png`, fullPage: true });
        await page.locator('#tl-trace-picker').selectOption(full[0]);
        await expect(page.locator('#tl-trace-picker')).toHaveValue(full[0]);
        await expect(page.locator('.tl-load-notice')).toHaveCount(0);
        await page.getByLabel('Candidate trace file', { exact: true }).setInputFiles({ name: 'candidate-jaeger-traces.json', mimeType: 'application/json', buffer: Buffer.from(source) });
        await expect(page.getByRole('heading', { name: 'Compare runs', exact: true })).toBeVisible();
        const comparisonLabels = await page.locator('.tl-run-names strong').allTextContents();
        assert.deepEqual(comparisonLabels, [
          `two-jaeger-traces.json · trace ${phase === 'before' ? '00000000' : short[0]} of 2`,
          `candidate-jaeger-traces.json · trace ${phase === 'before' ? '00000000' : short[1]} of 2`,
        ]);
        await page.screenshot({ path: `${output}/${engine}-${width}-comparison.png`, fullPage: true });
        assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
        assert.deepEqual(errors, []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        rows.push({ engine, width, phase, options, inspected, comparisonLabels, offline: true, pageErrors: errors, accessibilityViolations: [], horizontalOverflow: false });
        console.log(`${engine}/${width}: ${phase} labels observed; complete downloaded identities retained`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${output}/browser.json`, JSON.stringify({ url, phase, scope: 'Two explicitly constructed Jaeger traces have identical names, clocks and measurements but distinct valid 64-bit trace and span IDs. Real UI labels, canonical selection values and actual offline span downloads are checked. No native Jaeger capture or source measurement change is claimed.', sourceSha256: createHash('sha256').update(source).digest('hex'), rows }, null, 2) + '\n');
