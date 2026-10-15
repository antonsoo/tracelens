import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';

const directory = 'studies/attribute-values/fixtures';
const oracle = JSON.parse(await readFile(`${directory}/oracle.json`, 'utf8'));
const prices = JSON.parse(await readFile(`${directory}/prices.json`, 'utf8'));
async function download(page, name) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}

test('typed values survive worker import, offline trace selection and cost/evidence downloads', async ({ page, context }, testInfo) => {
  test.setTimeout(90_000);
  const errors = []; const external = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => {
    if (new URL(request.url()).origin !== 'http://127.0.0.1:4319') external.push(request.url());
  });
  await page.addInitScript(table => localStorage.setItem('tracelens.priceTable.v1', JSON.stringify(table)), prices);
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles(`${directory}/capture.json`);
  await expect(page.locator('#tl-trace-picker option')).toHaveCount(oracle.cases.length);
  await context.setOffline(true);
  const results = [];
  for (const expected of oracle.cases) {
    await page.locator('#tl-trace-picker').selectOption(expected.traceId);
    await expect(page.locator('.tl-wf-row').first()).toContainText(expected.name);
    await page.locator('.tl-wf-row').first().click();
    const evidence = await download(page, 'Download span JSON');
    expect(evidence.genai.usage.inputTokens ?? null).toBe(expected.expectedInputTokens);
    const panel = page.locator('.tl-cost-ledger');
    if (await panel.getAttribute('open') === null) await panel.locator(':scope > summary').click();
    const report = await download(page, 'Download cost JSON');
    if (expected.expectedCostUsd === null) expect(report.estimatedCostUsd).toBeNull();
    else expect(report.estimatedCostUsd).toBeCloseTo(expected.expectedCostUsd, 12);
    const cli = spawnSync(process.execPath, ['dist-cli/cli/index.js', 'cost', `${directory}/capture.json`,
      '--trace', expected.traceId, '--json', '--prices', `${directory}/prices.json`], { encoding: 'utf8' });
    expect(cli.status, cli.stderr).toBe(0);
    expect(report).toEqual(JSON.parse(cli.stdout));
    let warnings = [];
    if (expected.expectedWarning) {
      const details = page.locator('.tl-compare-warnings');
      await expect(details.locator('summary')).toHaveText('1 parser warnings');
      if (await details.getAttribute('open') === null) await details.locator('summary').click();
      warnings = await download(page, 'Download warnings JSON');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].traceId).toBe(expected.traceId);
      expect(warnings[0].message).toContain('gen_ai.usage.input_tokens');
      expect(evidence.attributes['gen_ai.usage.input_tokens']).toEqual(expected.name === 'duplicate input count'
        ? { duplicateAttributeValues: [{ intValue: '1200' }, { intValue: '0' }] }
        : { invalidAnyValue: expected.sourceValue });
    } else await expect(page.locator('.tl-compare-warnings')).toHaveCount(0);
    results.push({ name: expected.name, span: evidence, cost: report, warnings });
  }
  await page.locator('#tl-trace-picker').selectOption(oracle.cases.find(c => c.name === 'empty integer').traceId);
  await expect(page.locator('.tl-wf-row').first()).toContainText('empty integer');
  await page.locator('.tl-wf-row').first().click();
  await page.getByRole('tab', { name: 'Attributes', exact: true }).click();
  const warnings = page.locator('.tl-compare-warnings');
  if (await warnings.getAttribute('open') === null) await warnings.locator('summary').click();
  await expect(page.locator('#tl-detail-content')).toContainText('invalidAnyValue');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  if (process.env.CAPTURE_ATTRIBUTE_EVIDENCE === '1') {
    await mkdir('docs/assets/attribute-values', { recursive: true });
    await page.screenshot({ path: `docs/assets/attribute-values/${testInfo.project.name}-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 375, height: 900 });
    await page.screenshot({ path: `docs/assets/attribute-values/${testInfo.project.name}-375.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await writeFile(`studies/attribute-values/browser-${testInfo.project.name}.json`,
      JSON.stringify({ offline: true, pageErrors: errors, externalRequests: external, results }, null, 2) + '\n');
  }
  expect(errors).toEqual([]); expect(external).toEqual([]);
});
