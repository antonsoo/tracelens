import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { messageWorkload } from '../../studies/message-decoding/workloads.mjs';

for (const kind of ['history', 'system']) for (const width of [1440, 375]) {
  test(`${kind} message workload survives first offline import and complete download at ${width}px`, async ({ page, context }, info) => {
    const errors = [], external = [], late = [];
    let offline = false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (!/^https?:/.test(request.url())) return;
      if (new URL(request.url()).origin !== 'http://127.0.0.1:4319') external.push(request.url());
      if (offline) late.push(request.url());
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: width === 375 ? 'light' : 'dark', reducedMotion: 'reduce' });
    await page.goto('./');
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.fonts].map(font => font.load())); });
    await context.setOffline(true); offline = true;
    const text = messageWorkload(kind), input = JSON.parse(text);
    const expected = input.resourceSpans[0].scopeSpans[0].spans.length;
    const started = performance.now();
    await page.locator('#tl-file-input').setInputFiles({ name: `${kind}-synthetic.json`,
      mimeType: 'application/json', buffer: Buffer.from(text) });
    const counts = page.locator('.tl-summary-cell').filter({ has: page.locator('.tl-summary-label', { hasText: 'Spans / errors' }) });
    await expect(counts.locator('.tl-summary-value')).toHaveText(`${expected} / 0`);
    const importMs = performance.now() - started;
    if (width === 375) {
      const distance = await page.evaluate(() => document.querySelector('.tl-detail-pane').getBoundingClientRect().top -
        document.querySelector('.tl-center').getBoundingClientRect().top);
      expect(distance).toBeLessThanOrEqual(1000);
      const track = await page.evaluate(() => document.querySelector('.tl-waterfall-scroll').clientWidth - document.querySelector('.tl-wf-label').getBoundingClientRect().width);
      expect(track).toBeGreaterThanOrEqual(125);
    }
    await page.locator('.tl-wf-row[data-index="1"]').click();
    await page.getByRole('tab', { name: 'Messages', exact: true }).click();
    const region = page.getByRole('region', { name: kind === 'history' ? 'Input messages' : 'System messages', exact: true });
    const label = kind === 'history' ? 'Input messages page' : 'System messages message 1 parts page';
    const lastPage = kind === 'history' ? '40' : '25';
    await page.getByRole('spinbutton', { name: label, exact: true }).fill(lastPage);
    await page.getByRole('spinbutton', { name: label, exact: true }).press('Tab');
    await expect(region).toContainText(kind === 'history' ? 'Local observation 799 for controlled step 0' : 'Controlled instruction 0/499.');
    await expect(region.locator('.tl-msg-body')).toHaveCount(20);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download span JSON', exact: true }).click();
    const raw = await readFile(await (await download).path(), 'utf8'), selected = JSON.parse(raw);
    expect(selected.genai.inputMessages).toHaveLength(kind === 'history' ? 800 : 10);
    expect(selected.genai.outputMessages[0].parts[0].content).toBe('A controlled local answer.');
    expect(selected.genai.finishReasons).toEqual(['stop']);
    expect(selected.genai.systemInstructions?.[0]?.parts.length ?? 0).toBe(kind === 'system' ? 500 : 0);
    expect(JSON.parse(selected.attributes['gen_ai.input.messages'])).toEqual(selected.genai.inputMessages);
    const violations = (await new AxeBuilder({ page }).analyze()).violations;
    expect(violations).toEqual([]); expect(errors).toEqual([]); expect(external).toEqual([]); expect(late).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
    const receipt = { kind, width, browser: info.project.name, inputBytes: Buffer.byteLength(text),
      inputSha256: createHash('sha256').update(text).digest('hex'), spans: expected, importMs,
      selectedSpanSha256: createHash('sha256').update(raw).digest('hex'),
      inputMessages: selected.genai.inputMessages.length, systemParts: selected.genai.systemInstructions?.[0]?.parts.length ?? 0,
      lastPage, pageErrors: errors, externalRequests: external, lateRequests: late, accessibilityViolations: violations };
    await writeFile(info.outputPath('receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    await page.screenshot({ path: info.outputPath('messages.png'), fullPage: true });
  });
}
