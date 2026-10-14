import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const fixture = new URL('../fixtures/census/strands-legacy-events-tool-call.json', import.meta.url);
const input = (name, json) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
const download = async page => {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
};

for (const width of [375, 1440]) test(`ambiguous export fields preserve the prior comparison at ${width}px`, async ({ page, context }) => {
  const native = JSON.parse(await readFile(fixture, 'utf8'));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles(input('native.json', native));
  await expect(page.locator('.tl-wf-row')).toHaveCount(6);
  await context.setOffline(true);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Compare with another run', exact: true }).click();
  await (await chooser).setFiles(input('candidate.json', native));
  await expect(page.getByRole('heading', { name: 'Compare runs', exact: true })).toBeVisible();
  const previous = await download(page);
  const aliasId = structuredClone(native);
  aliasId.resourceSpans[0].scopeSpans[0].spans[0].trace_id = 'ffffffffffffffffffffffffffffffff';
  const cases = [
    ['hidden-child-spans.json', { resourceSpans: [native.resourceSpans.at(-1)], resource_spans: native.resourceSpans.slice(0, -1) }, 'resourceSpans and resource_spans'],
    ['competing-identity.json', aliasId, 'traceId and trace_id'],
  ];
  for (const [name, json, fields] of cases) {
    await page.getByLabel('Replace candidate trace').setInputFiles(input(name, json));
    await expect(page.getByRole('alert')).toContainText(`both ${fields}`);
    expect(await download(page)).toEqual(previous);
  }
  await page.getByLabel('Replace candidate trace').setInputFiles(input('recovered.json', native));
  await expect(page.getByRole('alert')).toHaveCount(0);
  const recovered = await download(page);
  expect(recovered.operations.flatMap(operation => operation.candidateCalls)).toHaveLength(6);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
