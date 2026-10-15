import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';

const native = await readFile('tests/fixtures/small-genai-semconv-trace.json', 'utf8');
const compact = JSON.stringify(JSON.parse(native));
const damaged = compact.replace(/"code":(?:2|"STATUS_CODE_ERROR")/, '"code":2,"\\u0063ode":1');
const file = (name, text) => ({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
const hash = value => createHash('sha256').update(value).digest('hex');

for (const width of [1440, 375]) {
  test(`ambiguous JSON cannot replace retained evidence on the first offline import at ${width}px`, async ({ page, context }, info) => {
    const errors = [], external = [], late = []; let offline = false;
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
    const input = page.locator('#tl-file-input');
    await input.setInputFiles(file('ambiguous-first.json', damaged));
    await expect(page.getByRole('alert')).toContainText('Duplicate JSON object field');
    await expect(page.locator('.tl-wf-row')).toHaveCount(0);
    await input.setInputFiles(file('native.json', native));
    const counts = page.locator('.tl-summary-cell').filter({ has: page.locator('.tl-summary-label', { hasText: 'Spans / errors' }) });
    await expect(counts.locator('.tl-summary-value')).toHaveText('8 / 2');
    await expect(page.getByRole('alert')).toHaveCount(0);

    const attempts = [
      [file('ambiguous.json', damaged)],
      [file('ambiguous-last.jsonl', '{"resourceSpans":[]}\n' + damaged)],
      [file('native.json', native), file('ambiguous-logs.json', '{"resourceLogs":[],"resourceLogs":[]}')],
    ];
    const messages = [];
    for (const files of attempts) {
      await page.getByLabel('Candidate trace file').setInputFiles(files);
      await expect(page.getByRole('alert')).toContainText('Duplicate JSON object field');
      await expect(counts.locator('.tl-summary-value')).toHaveText('8 / 2');
      messages.push(await page.getByRole('alert').innerText());
    }
    expect(messages[1]).toContain('Line 2:'); expect(messages[2]).toContain('File 2 (ambiguous-logs.json):');
    await page.locator('.tl-wf-row').filter({ hasText: 'execute_tool calculator' }).first().click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download span JSON', exact: true }).click();
    const raw = await readFile(await (await pending).path(), 'utf8');
    const selected = JSON.parse(raw);
    expect(selected.spanId).toBe('8f5ff93df22ebb1b'); expect(selected.status.code).toBe('ERROR');
    expect(selected.status.message).toBe('calculator backend did not respond within 2000ms (upstream timeout)');
    expect(selected.durationNs).toBe('20615462');
    const violations = (await new AxeBuilder({ page }).analyze()).violations;
    expect(violations).toEqual([]);
    await page.screenshot({ path: info.outputPath('retained-error.png'), fullPage: true });

    await page.getByRole('button', { name: 'Load another trace', exact: true }).click();
    await input.setInputFiles(file('native-retry.json', native));
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(counts.locator('.tl-summary-value')).toHaveText('8 / 2');
    await page.getByRole('button', { name: 'Load another trace', exact: true }).click();
    await input.setInputFiles(file('unfinished.jsonl', compact + '\n{"resourceSpans":['));
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('1 parser warnings', { exact: true })).toBeVisible();
    await expect(counts.locator('.tl-summary-value')).toHaveText('8 / Unknown');
    await expect(counts).toContainText('2 reported; partial import');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
    expect(errors).toEqual([]); expect(external).toEqual([]); expect(late).toEqual([]);
    await writeFile(info.outputPath('receipt.json'), JSON.stringify({ browser: info.project.name, width,
      offlineBeforeFirstImport: true, nativeSha256: hash(native), damagedSha256: hash(damaged),
      refusedReplacementMessages: messages, retainedSpanId: selected.spanId, retainedStatus: selected.status,
      selectedSpanSha256: hash(raw), completeControl: { spans: 8, errors: 2 },
      genuinelyUnfinishedTailWarnings: 1, pageErrors: errors, externalRequests: external,
      lateRequests: late, accessibilityViolations: violations }, null, 2) + '\n');
  });
}
