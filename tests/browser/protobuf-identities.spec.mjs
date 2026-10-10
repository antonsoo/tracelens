import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const first = '00000000000000000000000000000001';
const second = '68000000000000000000000000000001';
const directory = 'studies/protobuf-identities/fixtures';
const reference = JSON.parse(spawnSync(process.execPath, ['dist-cli/cli/index.js', 'links', `${directory}/all.otlp.json`, '--trace', second, '--json'], { encoding: 'utf8' }).stdout);

async function download(page, button) {
  const pending = page.waitForEvent('download');
  await button.click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}

for (const format of ['proto', 'proto-snake', 'otlp']) {
  test(`${format} preserves byte identities through import, links, offline navigation and downloads`, async ({ page, context }, testInfo) => {
    const errors = [];
    const external = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('request', (request) => {
      if (new URL(request.url()).origin !== 'http://127.0.0.1:4319') external.push(request.url());
    });
    await page.goto('./');
    await page.locator('#tl-file-input').setInputFiles(`${directory}/all.${format}.json`);
    await expect(page.locator('#tl-trace-picker option')).toHaveCount(2);
    await expect(page.locator('#tl-trace-picker')).toHaveValue(first);
    await page.locator('#tl-trace-picker').selectOption(second);
    await page.locator('.tl-links summary').click();
    expect(await download(page, page.getByRole('button', { name: 'Download links JSON' }))).toEqual(reference);
    await page.locator('.tl-links').getByRole('button', { name: 'second workflow', exact: true }).click();
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Inspect first tool', exact: true }).click();
    await expect(page.locator('#tl-trace-picker')).toHaveValue(first);
    await expect(page.locator('.tl-detail-title')).toHaveText('first tool');
    const evidence = await download(page, page.getByRole('button', { name: 'Download span JSON' }));
    expect([evidence.traceId, evidence.spanId, evidence.parentSpanId]).toEqual([first, '6800000000000001', '0000000000000001']);
    expect(evidence.agentKind).toBe('tool');
    expect(evidence.attributes).toMatchObject({
      'fixture.enabled': true, 'fixture.attempt': 3, 'fixture.ratio': 0.25, 'fixture.ids': [1, 2],
      'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'inspect',
    });
    await page.getByRole('tab', { name: 'Attributes', exact: true }).click();
    await expect(page.locator('#tl-detail-content')).toContainText('fixture.enabled');
    if (process.env.CAPTURE_PROTOBUF_EVIDENCE === '1' && format === 'proto-snake') {
      const assets = 'docs/assets/protobuf-identities';
      await mkdir(assets, { recursive: true });
      await page.screenshot({ path: `${assets}/${testInfo.project.name}-1440.png` });
      await page.setViewportSize({ width: 375, height: 900 });
      await page.screenshot({ path: `${assets}/${testInfo.project.name}-375.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await writeFile(`studies/protobuf-identities/browser-${testInfo.project.name}.json`, `${JSON.stringify({ links: reference, span: evidence, offline: true }, null, 2)}\n`);
    }
    await page.getByRole('button', { name: 'Back to source span' }).click();
    await expect(page.locator('#tl-trace-picker')).toHaveValue(second);
    await expect(page.locator('.tl-detail-title')).toHaveText('second workflow');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
}
