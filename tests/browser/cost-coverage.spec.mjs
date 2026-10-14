import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const prices = [{ id: 'illustrative', matchModel: 'gpt-4o-mini', provider: 'strands-agents',
  inputPerMTok: 1, outputPerMTok: 2, sourceDate: '', sourceUrl: '' }];
const native = 'tests/fixtures/census/strands-operation-details-events-tool-call.json';
test('partial SDK import retains charges and discloses unknown full cost offline', async ({ page, context }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(prices => localStorage.setItem('tracelens.priceTable.v1', JSON.stringify(prices)), prices);
  await page.goto('./');
  const original = await readFile(native, 'utf8');
  await page.locator('#tl-file-input').setInputFiles({ name: 'input-0.json', mimeType: 'application/json', buffer: Buffer.from(original) });
  await expect(page.locator('.tl-summary')).toContainText('$0.000227');
  await context.setOffline(true);
  const doc = JSON.parse(original);
  delete doc.resourceSpans[0].scopeSpans[0].spans[0].endTimeUnixNano;
  const damaged = JSON.stringify(doc), inputPath = info.outputPath('input-0.json'), pricePath = info.outputPath('prices.json');
  await writeFile(inputPath, damaged); await writeFile(pricePath, JSON.stringify(prices));
  const cli = spawnSync(process.execPath, ['dist-cli/cli/index.js', 'cost', inputPath, '--prices', pricePath, '--json'], { encoding: 'utf8' });
  expect(cli.status, cli.stderr).toBe(0);
  await page.getByRole('button', { name: 'Load another trace', exact: true }).click();
  await page.locator('#tl-file-input').setInputFiles({ name: 'input-0.json', mimeType: 'application/json', buffer: Buffer.from(damaged) });
  await expect(page.locator('.tl-summary')).toContainText('Known token cost subtotal');
  await expect(page.locator('.tl-summary')).toContainText('$0.000128');
  await expect(page.locator('.tl-summary')).toContainText('Incomplete span inventory');
  await page.locator('.tl-cost-ledger > summary').click();
  await expect(page.locator('.tl-cost-body')).toContainText('full token estimate is unknown');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download cost JSON', exact: true }).click();
  const downloaded = JSON.parse(await readFile(await (await pending).path(), 'utf8'));
  expect(downloaded).toEqual(JSON.parse(cli.stdout));
  expect(downloaded).toMatchObject({ incompleteInput: true, estimatedCostUsd: null, pricedCalls: 1, unpricedCalls: 0 });
  await page.getByRole('button', { name: 'Load another trace', exact: true }).click();
  await page.locator('#tl-file-input').setInputFiles({ name: 'input-0.json', mimeType: 'application/json', buffer: Buffer.from(original) });
  await expect(page.locator('.tl-summary')).toContainText('Estimated token cost');
  await expect(page.locator('.tl-summary')).not.toContainText('Incomplete span inventory');
  expect(errors).toEqual([]);
});
