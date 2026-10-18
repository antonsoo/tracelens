import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';

const directory = 'studies/otlp-binary/fixtures';
const oracle = JSON.parse(await readFile(`${directory}/oracle.json`, 'utf8'));
const workflow = oracle.spans.find(span => span.name === 'inspect a document digest');
const consumer = oracle.spans.find(span => span.name === 'consume the digest');
const tool = oracle.spans.find(span => span.name === 'sha256');
const formats = {
  collector: ['collector.traces.otlp', 'collector.logs.otlp'],
  raw: oracle.requests.map(request => request.file),
};
async function download(page, name) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const bytes = await readFile(await (await pending).path());
  return { value: JSON.parse(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
}

for (const [format, files] of Object.entries(formats)) for (const width of [1440, 375]) {
  test(`${format} protobuf preserves native spans, logs and offline trace navigation at ${width}px`, async ({ page, context }, info) => {
    const errors = [], external = [], late = [];
    let offline = false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (!/^https?:/.test(request.url())) return;
      if (new URL(request.url()).origin !== new URL(info.project.use.baseURL ?? 'http://127.0.0.1:4319').origin) external.push(request.url());
      if (offline) late.push(request.url());
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: width === 375 ? 'light' : 'dark', reducedMotion: 'reduce' });
    await page.goto('./');
    await page.evaluate(async () => { await document.fonts.ready; });
    await context.setOffline(true); offline = true;
    await page.locator('#tl-file-input').setInputFiles(files.map(name => `${directory}/${name}`));
    await expect(page.locator('.tl-wf-row')).toHaveCount(4);
    await expect(page.locator('#tl-trace-picker')).toHaveValue(workflow.traceId);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('treeitem', { name: /^sha256 / }).click();
    const span = await download(page, 'Download span JSON');
    expect(span.value.traceId).toBe(tool.traceId);
    expect(span.value.spanId).toBe(tool.spanId);
    expect(span.value.startTimeUnixNano).toBe(tool.start);
    expect(span.value.endTimeUnixNano).toBe(tool.end);
    expect(span.value.attributes).toEqual(tool.attributes);
    await page.getByRole('tab', { name: 'Attributes', exact: true }).click();
    await expect(page.locator('#tl-detail-content')).toContainText('9223372036854775807');
    await expect(page.locator('#tl-detail-content')).toContainText('-9223372036854775808');
    await page.getByRole('treeitem', { name: /^chat scripted-response / }).first().click();
    const model = await download(page, 'Download span JSON');
    expect(model.value.logs).toHaveLength(1);
    const nativeLog = oracle.logs.find(log => log.spanId === model.value.spanId);
    expect(model.value.logs[0].timeUnixNano).toBeUndefined();
    expect(model.value.logs[0].observedTimeUnixNano).toBe(nativeLog.observedTimestamp);
    expect(model.value.logs[0].source.line).toBeUndefined();
    await page.getByRole('tab', { name: 'Messages', exact: true }).click();
    await expect(page.locator('#tl-detail-content')).toContainText('Compute the SHA-256 of receipt-17.');
    await expect(page.locator('#tl-detail-content')).toContainText('sha256');
    if (format === 'collector') await page.screenshot({ path: info.outputPath('binary.png'), fullPage: true });
    const violations = (await new AxeBuilder({ page }).analyze()).violations;
    expect(violations).toEqual([]);
    await page.locator('#tl-trace-picker').selectOption(consumer.traceId);
    await expect(page.locator('.tl-wf-row')).toHaveCount(2);
    await page.locator('.tl-links summary').click();
    const links = await download(page, 'Download links JSON');
    expect(links.value.sourceFormat).toBe(format === 'collector' ? 'otlp-protobuf-framed' : 'otlp-protobuf');
    expect(links.value.linkCount).toBe(1);
    await page.locator('.tl-links').getByRole('button', { name: 'consume the digest', exact: true }).click();
    await page.getByRole('button', { name: 'Inspect inspect a document digest', exact: true }).click();
    await expect(page.locator('#tl-trace-picker')).toHaveValue(workflow.traceId);
    await expect(page.locator('.tl-detail-title')).toHaveText('inspect a document digest');
    await page.getByRole('button', { name: 'Back to source span', exact: true }).click();
    await expect(page.locator('#tl-trace-picker')).toHaveValue(consumer.traceId);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
    expect(errors).toEqual([]); expect(external).toEqual([]); expect(late).toEqual([]);
    await writeFile(info.outputPath('receipt.json'), JSON.stringify({ format, width,
      browser: info.project.name, files, spanDownloadSha256: span.sha256,
      modelDownloadSha256: model.sha256, linksDownloadSha256: links.sha256,
      nativeTraceIds: [workflow.traceId, consumer.traceId], spans: 6, logs: 2,
      firstImportOffline: true, observedTimePreserved: true, missingEventTimePreserved: true,
      crossTraceRoundTrip: true, errors, externalRequests: external, lateRequests: late,
      accessibilityViolations: violations, horizontalOverflow: false }, null, 2) + '\n');
  });
}

test('a malformed binary replacement preserves the complete comparison and a retry recovers', async ({ page, context }) => {
  await page.goto('./');
  await context.setOffline(true);
  const paths = formats.collector.map(name => `${directory}/${name}`);
  await page.locator('#tl-file-input').setInputFiles(paths);
  await expect(page.locator('.tl-wf-row')).toHaveCount(4);
  await page.getByLabel('Candidate trace file', { exact: true }).setInputFiles(['collector-traces.jsonl', 'collector-logs.jsonl'].map(name => `${directory}/${name}`));
  await expect(page.locator('.tl-comparison')).toBeVisible();
  const before = (await download(page, 'Export JSON')).value;
  expect(before.metrics.calls.baseline.value).toBe(4);
  expect(before.metrics.calls.candidate.value).toBe(4);
  expect(before.inputFiles.baseline[0].sourceFormat).toBe('otlp-protobuf-framed');
  expect(before.inputFiles.candidate[0].sourceFormat).toBe('otlp-json');
  await page.getByLabel('Replace candidate trace', { exact: true }).setInputFiles('studies/otlp-binary/controls/nested-length-overrun.traces.pb');
  await expect(page.getByRole('alert')).toContainText('enclosing message');
  expect((await download(page, 'Export JSON')).value).toEqual(before);
  await page.getByLabel('Replace candidate trace', { exact: true }).setInputFiles(paths);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(async () => (await download(page, 'Export JSON')).value.inputFiles.candidate[0].sourceFormat).toBe('otlp-protobuf-framed');
});
