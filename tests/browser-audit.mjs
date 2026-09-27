import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** Real browser regressions for storage failures, editor validation and inspection state. */
export async function auditBrowser(browser, target, root, capture) {
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(String(error))));
  try {
    const page = await context.newPage();
    await page.goto(target + '?example=compare');
    await page.getByRole('heading', { name: 'Compare runs', exact: true }).waitFor();
    await page.getByRole('searchbox').fill('search_DOCS');
    await page.getByRole('combobox').selectOption('costUsd');
    await page.locator('.tl-operation summary').click();
    await page.getByRole('button', { name: 'Toggle dark mode' }).click();
    assert.equal(await page.getByRole('button', { name: 'Toggle dark mode' }).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.getByRole('searchbox').inputValue(), 'search_DOCS');
    assert.equal(await page.getByRole('combobox').inputValue(), 'costUsd');
    assert.equal(await page.locator('.tl-operation').evaluate((el) => el.open), true);
    await page.getByRole('searchbox').focus();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(200); // The app deliberately debounces resize by 120ms.
    assert.equal(await page.getByRole('searchbox').inputValue(), 'search_DOCS');
    assert.equal(await page.getByRole('searchbox').evaluate((el) => document.activeElement === el), true);
    await page.locator('.tl-call-link').first().click();
    await page.getByRole('button', { name: 'Back to comparison' }).click();
    assert.equal(await page.getByRole('searchbox').inputValue(), 'search_DOCS');
    assert.equal(await page.getByRole('combobox').inputValue(), 'costUsd');
    assert.equal(await page.locator('.tl-operation').evaluate((el) => el.open), true);
    await page.getByRole('searchbox').fill('nothing');
    await page.getByRole('searchbox').fill('search_DOCS');
    assert.equal(await page.locator('.tl-operation').evaluate((el) => el.open), true);
    await page.locator('.tl-comparison-shell').evaluate((el) => { el.scrollTop = 150; });
    const scrollTop = await page.locator('.tl-comparison-shell').evaluate((el) => el.scrollTop);
    assert.ok(scrollTop > 0);
    await page.getByRole('button', { name: 'Toggle dark mode' }).click();
    assert.equal(await page.locator('.tl-comparison-shell').evaluate((el) => el.scrollTop), scrollTop);

    // Validation must happen before Save changes either calculations or storage.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'Prices', exact: true }).click();
    await page.getByLabel('Row 1 input rate', { exact: true }).fill('2');
    await page.getByRole('button', { name: '+ Add row', exact: true }).click();
    const lastRow = page.locator('.tl-price-table tbody tr').last();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('dialog').getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /enter a model match/);
    assert.equal(await page.evaluate(() => localStorage.getItem('tracelens.priceTable.v1')), null);
    await lastRow.getByLabel(/model match/).fill('custom-model');
    for (const invalidRate of ['-1', 'NaN', 'Infinity', '']) {
      await lastRow.getByLabel(/input rate/).fill(invalidRate);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      assert.equal(await page.getByRole('dialog').count(), 1);
    }
    if (capture) await page.screenshot({ path: root + '/docs/assets/price-validation.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isVisible(), true);
    await lastRow.getByLabel(/input rate/).fill('0');
    await lastRow.getByLabel(/cache write rate/).fill('3');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tracelens.priceTable.v1')));
    assert.equal(saved.at(-1).cacheWritePerMTok, 3);
    assert.equal(saved.at(-1).inputPerMTok, 0);
    assert.equal(saved[0].sourceUrl, '', 'edited prices must not keep the original vendor citation');

    const malformed = JSON.parse(await readFile(root + '/examples/comparison-baseline.json', 'utf8'));
    malformed.resourceSpans[0].scopeSpans[0].spans[1].startTimeUnixNano = 'invalid';
    await page.getByRole('button', { name: 'Load another trace' }).click();
    await page.locator('#tl-file-input').setInputFiles({ name: 'invalid-time.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(malformed)) });
    await page.getByText('1 parser warnings', { exact: true }).click();
    assert.match(await page.locator('.tl-compare-warnings').innerText(), /invalid timestamps/);
  } finally {
    await context.close();
  }

  for (const stored of ['[null]', '[{"matchModel":""}]', 'not json', '[]']) {
    const isolated = await browser.newContext();
    try {
      const page = await isolated.newPage();
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(target);
      await page.evaluate((raw) => localStorage.setItem('tracelens.priceTable.v1', raw), stored);
      await page.goto(target + '?example=compare');
      await page.getByRole('heading', { name: 'Compare runs', exact: true }).waitFor();
      assert.equal(await page.getByRole('alert').count(), 0);
      await page.getByRole('button', { name: 'Prices', exact: true }).click();
      const rowCount = await page.locator('.tl-price-table tbody tr').count();
      assert.equal(rowCount === 0, stored === '[]', 'an intentional empty table must survive reload');
    } finally {
      await isolated.close();
    }
  }

  const blocked = await browser.newContext({ colorScheme: 'dark' });
  try {
    await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } }));
    const page = await blocked.newPage();
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(target + '?example=compare');
    await page.getByRole('heading', { name: 'Compare runs', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Toggle dark mode' }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.getByRole('button', { name: 'Prices', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('alert').count(), 0);
  } finally {
    await blocked.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: blocked/corrupt storage, empty price tables, invalid price edits, cache-write edits, parser warnings, ARIA state, preserved filter/sort/expansion/focus/scroll.');
}
