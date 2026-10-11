import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';

const directory = 'studies/dropped-evidence/fixtures';
const oracle = JSON.parse(await readFile(`${directory}/oracle.json`, 'utf8'));
async function download(page, name) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}

for (const format of ['otlp', 'proto', 'proto-snake']) {
  test(`${format} keeps SDK omissions through import, trace switching and offline evidence downloads`, async ({ page, context }, testInfo) => {
    const errors = []; const external = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => { if (new URL(request.url()).origin !== new URL(testInfo.project.use.baseURL).origin) external.push(request.url()); });
    await page.goto('./');
    await page.locator('#tl-file-input').setInputFiles(`${directory}/capture.${format}.json`);
    await expect(page.locator('#tl-trace-picker option')).toHaveCount(3);
    const results = [];
    await context.setOffline(true);
    for (const record of oracle.spans) {
      await page.locator('#tl-trace-picker').selectOption(record.traceId);
      await expect(page.locator('.tl-wf-row').first()).toContainText(record.name);
      await page.locator('.tl-wf-row').first().click();
      await expect(page.locator('.tl-detail-title')).toHaveText(record.name);
      const evidence = await download(page, 'Download span JSON');
      expect(evidence.attributes).toEqual(record.attributes);
      expect(evidence.events.map(event => ({ ...event, droppedAttributesCount: event.droppedAttributesCount ?? 0 }))).toEqual(record.events);
      expect(evidence.droppedAttributesCount ?? 0).toBe(record.droppedAttributesCount);
      expect(evidence.droppedEventsCount ?? 0).toBe(record.droppedEventsCount);
      const warningCount = Number(record.droppedAttributesCount > 0) + Number(record.droppedEventsCount > 0) + record.events.filter(e => e.droppedAttributesCount > 0).length;
      let warnings = [];
      if (warningCount) {
        const details = page.locator('.tl-compare-warnings');
        await expect(details.locator('summary')).toHaveText(`${warningCount} parser warnings`);
        if (await details.getAttribute('open') === null) await details.locator('summary').click();
        await expect(details).toContainText(`reports ${record.droppedEventsCount} dropped events`);
        warnings = await download(page, 'Download warnings JSON');
        expect(warnings).toHaveLength(warningCount);
        expect(warnings.every(w => w.traceId === record.traceId && w.spanId === record.spanId)).toBe(true);
      } else await expect(page.locator('.tl-compare-warnings')).toHaveCount(0);
      if (record.events.length) {
        await page.getByRole('tab', { name: 'Events', exact: true }).click();
        const events = page.getByRole('region', { name: 'Events', exact: true });
        await expect(events.locator('.tl-msg')).toHaveCount(record.events.length);
        for (const event of record.events) await expect(events).toContainText(event.name);
      } else await expect(page.getByRole('tab', { name: 'Events', exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (record.droppedAttributesCount > 0) {
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        if (process.env.CAPTURE_DROPPED_EVIDENCE === '1' && format === 'otlp') {
          await mkdir('docs/assets/dropped-evidence', { recursive: true });
          const details = page.locator('.tl-compare-warnings');
          if (await details.getAttribute('open') === null) await details.locator('summary').click();
          await page.screenshot({ path: `docs/assets/dropped-evidence/${testInfo.project.name}-1440.png`, fullPage: true });
          await page.setViewportSize({ width: 375, height: 900 });
          if (await details.getAttribute('open') === null) await details.locator('summary').click();
          await page.screenshot({ path: `docs/assets/dropped-evidence/${testInfo.project.name}-375.png`, fullPage: true });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.setViewportSize({ width: 1440, height: 900 });
        }
      }
      results.push({ traceId: record.traceId, span: evidence, warnings });
    }
    expect(errors).toEqual([]); expect(external).toEqual([]);
    if (process.env.CAPTURE_DROPPED_EVIDENCE === '1' && format === 'otlp') {
      await writeFile(`studies/dropped-evidence/browser-${testInfo.project.name}.json`, JSON.stringify({ offline: true, pageErrors: errors, externalRequests: external, results }, null, 2) + '\n');
    }
  });
}
