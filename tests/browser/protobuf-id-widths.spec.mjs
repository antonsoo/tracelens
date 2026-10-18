import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const directory = 'studies/protobuf-id-widths/fixtures';
async function comparison(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}
test('wrong-width native identities refuse atomically and a valid retry recovers', async ({ page, context }) => {
  await page.goto('./'); await context.setOffline(true);
  const valid = `${directory}/native-control.traces.pb`;
  await page.locator('#tl-file-input').setInputFiles(valid);
  await expect(page.locator('.tl-wf-row')).toHaveCount(2);
  await page.getByLabel('Candidate trace file', { exact: true }).setInputFiles(valid);
  await expect(page.locator('.tl-comparison')).toBeVisible();
  const before = await comparison(page);
  expect(before.metrics.calls.baseline.value).toBe(2); expect(before.metrics.calls.delta).toBe(0);
  for (const [files, size] of [
    [[`${directory}/trace-short.traces.pb`], 16],
    [[valid, `${directory}/span-short.logs.pb`], 8],
  ]) {
    await page.getByLabel('Replace candidate trace', { exact: true }).setInputFiles(files);
    await expect(page.getByRole('alert')).toContainText(`OTLP requires ${size} bytes`);
    expect(await comparison(page)).toEqual(before);
  }
  await page.getByLabel('Replace candidate trace', { exact: true }).setInputFiles(valid);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await comparison(page)).toEqual(before);
});
