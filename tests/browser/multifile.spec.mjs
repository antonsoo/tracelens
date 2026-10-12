import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const paths = ['worker.json', 'gateway.jsonl', 'audit.jsonl'].map(name => `studies/multifile/fixtures/${name}`);
const oracle = JSON.parse(await readFile('studies/multifile/fixtures/oracle.json', 'utf8'));
async function report(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}

test('native group selection restores parents and follows cross-file links offline', async ({ page, context }) => {
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles(paths);
  await expect(page.locator('.tl-wf-row')).toHaveCount(7);
  await expect(page.locator('.tl-trace-picker')).toContainText('These 3 files hold 2 traces');
  await context.setOffline(true);
  await page.locator('#tl-trace-picker').selectOption(oracle.audit.traceId);
  await page.locator('.tl-links summary').click();
  await page.locator('.tl-links').getByRole('button', { name: 'commit audit batch' }).click();
  await page.getByRole('button', { name: 'Inspect POST /digest', exact: true }).first().click();
  await expect(page.locator('.tl-detail-title')).toHaveText('POST /digest');
  await expect(page.locator('#tl-detail-content')).toContainText('1: worker.json');
  await expect(page.locator('.tl-wf-row')).toHaveCount(7);
  await page.getByRole('button', { name: 'Back to source span' }).click();
  await expect(page.locator('.tl-detail-title')).toHaveText('commit audit batch');
});

test('group size limits reject before parsing and the picker recovers', async ({ page }) => {
  await page.goto('./');
  const file = (name, buffer) => ({ name, buffer, mimeType: 'application/json' });
  await page.locator('#tl-file-input').setInputFiles(Array.from({ length: 33 }, (_, i) => file(`${i}.json`, Buffer.from('{}'))));
  await expect(page.getByRole('alert')).toContainText('between 1 and 32');
  await page.locator('#tl-file-input').setInputFiles([file('a.json', Buffer.alloc(13 * 1024 * 1024, ' ')), file('b.json', Buffer.alloc(13 * 1024 * 1024, ' '))]);
  await expect(page.getByRole('alert')).toContainText('25 MB in total');
  await page.locator('#tl-file-input').setInputFiles(paths);
  await expect(page.locator('.tl-wf-row')).toHaveCount(7);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('canceling a replacement group retains the complete comparison, then a retry succeeds', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    window.hold = false;
    window.pending = null;
    window.Worker = class extends NativeWorker {
      set onmessage(handler) {
        super.onmessage = handler ? event => {
          if (window.hold) window.pending = () => handler(event);
          else handler(event);
        } : null;
      }
      get onmessage() { return super.onmessage; }
    };
  });
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles(paths);
  await expect(page.locator('.tl-wf-row')).toHaveCount(7);
  await page.getByLabel('Candidate trace file', { exact: true }).setInputFiles(paths);
  await expect(page.locator('.tl-comparison')).toBeVisible();
  const before = await report(page);
  await page.evaluate(() => { window.hold = true; });
  await page.getByLabel('Replace candidate trace', { exact: true }).setInputFiles(paths.slice(0, 2));
  await expect.poll(() => page.evaluate(() => typeof window.pending)).toBe('function');
  await page.getByRole('button', { name: 'Cancel loading', exact: true }).click();
  await page.evaluate(() => window.pending());
  expect(await report(page)).toEqual(before);
  await page.evaluate(() => { window.hold = false; });
  await page.getByLabel('Replace candidate trace', { exact: true }).setInputFiles(paths.slice(0, 2));
  await expect(page.getByRole('status')).toHaveCount(0);
  const after = await report(page);
  expect(after.metrics.calls.candidate.value).toBe(7);
  expect(after.inputFiles.candidate).toHaveLength(2);
  expect(after.inputFiles.baseline).toHaveLength(3);
});
