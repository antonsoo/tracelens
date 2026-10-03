import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  page.errors = [];
  page.externalRequests = [];
  page.on('pageerror', (error) => page.errors.push(String(error)));
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4319/')) page.externalRequests.push(request.url());
  });
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => window.cspViolations.push(event.violatedDirective));
  });
});
test.afterEach(async ({ page }) => {
  expect(page.errors).toEqual([]);
  expect(page.externalRequests).toEqual([]);
  expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
});

const id = (n) => n.toString(16).padStart(16, '0');
function run(traceId, count, nested = false) {
  return Array.from({ length: count }, (_, i) => ({
    traceId, spanId: id(i + 1), ...(i ? { parentSpanId: id(nested ? i : 1) } : {}),
    name: i ? `step ${i}` : 'agent root',
    startTimeUnixNano: '1790000000000000000', endTimeUnixNano: '1790000010000000000',
    status: { code: i === 5 ? 2 : 0 },
    attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: i ? 'execute_tool' : 'invoke_agent' } }],
  }));
}
const file = (name, spans) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] })) });
const good = 'aa'.repeat(16);
const deep = 'bb'.repeat(16);

for (const side of [0, 1]) {
test(`a rejected trace switch preserves the ${side === 0 ? 'baseline' : 'candidate'} comparison`, async ({ page }) => {
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles(file('collector.json', [...run(good, 260), ...run(deep, 257, true)]));
  await page.getByLabel('Candidate trace file').setInputFiles(file('candidate.json', [...run(good, 260), ...run(deep, 257, true)]));
  await page.locator('.tl-operation summary').first().click();
  await page.locator('.tl-compare-evidence').nth(side).getByRole('button').first().click();
  const selected = await page.locator('.tl-detail-title').innerText();
  await page.locator('#tl-trace-picker').focus();
  await page.locator('#tl-trace-picker').selectOption(deep);
  await expect(page.getByRole('alert')).toContainText('256 nesting levels');
  await expect(page.locator('#tl-trace-picker')).toHaveValue(good);
  await expect(page.locator('#tl-trace-picker')).toBeFocused();
  await expect(page.locator('.tl-detail-title')).toHaveText(selected);
  await page.getByRole('button', { name: 'Back to comparison' }).click();
  await expect(page.getByRole('heading', { name: 'Compare runs', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Swap runs' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const report = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(report.baselineTraceId).toBe(good);
  expect(report.candidateTraceId).toBe(good);
  expect(report.metrics.calls.baseline.value).toBe(260);
  expect(report.metrics.calls.candidate.value).toBe(260);
});
}

test('timeline drag follows every mouse movement', async ({ page }) => {
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles(file('run.json', run(good, 6)));
  await page.getByTitle('Zoom in', { exact: true }).click();
  await page.getByTitle('Zoom in', { exact: true }).click();
  const track = await page.locator('.tl-wf-ruler .tl-wf-track').boundingBox();
  const offset = () => page.locator('.tl-wf-row .tl-wf-bar').first().evaluate((el) => parseFloat(el.style.left));
  await page.mouse.move(track.x + 300, track.y + 10);
  await page.mouse.down();
  await page.mouse.move(track.x + 250, track.y + 10);
  const first = await offset();
  await page.mouse.move(track.x + 150, track.y + 10);
  const second = await offset();
  await page.mouse.up();
  expect(first).toBeLessThan(-40);
  expect(second).toBeLessThan(first - 90);
  await page.mouse.move(track.x + 50, track.y + 10);
  expect(await offset()).toBe(second);
});

test('detail tabs support keyboard selection and retain focus', async ({ page }) => {
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles(file('run.json', run(good, 6)));
  await page.locator('.tl-wf-row').first().click();
  await page.getByRole('tab', { name: 'Overview' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Attributes' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Attributes' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName('Attributes');
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Attributes' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tabpanel')).toBeFocused();
});

test('keyboard file selection and an empty search stay accessible', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Choose a trace.json file' }).focus();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles(file('keyboard.json', run(good, 6)));
  const search = page.getByRole('searchbox', { name: 'Find spans' });
  await expect(search).toBeFocused();
  await search.fill('no-match');
  await expect(page.getByRole('tree')).toHaveCount(0);
  await expect(page.getByText('No matching spans.', { exact: false })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(search).toBeFocused();
  await expect(page.getByRole('tree')).toBeVisible();
  await expect(page.locator('.tl-wf-row[tabindex="0"]')).toHaveCount(1);
});

test('search reveals ancestors, preserves folds and leaves totals unchanged', async ({ page }) => {
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles(file('run.json', run(good, 6)));
  const total = await page.locator('.tl-summary').textContent();
  await page.locator('.tl-wf-row').first().focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.tl-wf-row')).toHaveCount(1);
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  const search = page.getByRole('searchbox', { name: 'Find spans' });
  await search.pressSequentially('STEP');
  await expect(search).toHaveValue('STEP');
  await expect(search).toBeFocused();
  await expect(page.locator('#tl-span-filter-count')).toContainText('5 of 6 spans match; 1 ancestors shown');
  await page.getByRole('checkbox', { name: 'Errors only' }).check();
  await expect(page.locator('.tl-wf-row')).toHaveCount(2);
  await expect(page.locator('.tl-wf-row').first()).toContainText('ancestor');
  await expect(page.locator('.tl-wf-row').last()).toContainText('step 5');
  await expect(page.locator('.tl-summary')).toHaveText(total);
  await search.fill('STEP 5');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(200);
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('STEP 5');
  await expect(page.locator('.tl-wf-row')).toHaveCount(2);
  await search.fill('unmatched');
  await expect(page.getByText('No matching spans.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(search).toBeFocused();
  await expect(page.locator('.tl-wf-row')).toHaveCount(1);
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => location.search)).toBe('');
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});

test('search locates a distant span and keeps only a bounded number of rows', async ({ page }) => {
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles(file('long.json', run(good, 6000)));
  await expect(page.locator('#tl-span-filter-count')).toContainText('6,000');
  const start = Date.now();
  await page.getByRole('searchbox', { name: 'Find spans' }).fill(id(6000));
  await expect(page.locator('.tl-wf-row')).toHaveCount(2);
  await expect(page.locator('.tl-wf-row').last()).toContainText('step 5999');
  expect(Date.now() - start).toBeLessThan(2000);
  await page.locator('.tl-wf-row').last().click();
  await expect(page.locator('.tl-detail-title')).toHaveText('step 5999');
  await page.getByRole('searchbox', { name: 'Find spans' }).fill('step 2');
  await expect(page.locator('#tl-span-filter-count')).toContainText('Selected span is outside this filter.');
  await page.getByRole('button', { name: 'Toggle dark mode' }).click();
  await expect(page.getByRole('searchbox', { name: 'Find spans' })).toHaveValue('step 2');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  expect(await page.locator('.tl-wf-row').count()).toBeLessThan(200);
});

test('canceled or superseded file reads never parse or replace current state', async ({ page }) => {
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer;
    window.pendingReads = {};
    File.prototype.arrayBuffer = function () {
      if (!this.name.startsWith('slow')) return read.call(this);
      return new Promise((resolve, reject) => {
        window.pendingReads[this.name] = async (fail = false) => fail ? reject(new Error('late read error')) : resolve(await read.call(this));
      });
    };
    const parse = JSON.parse;
    window.obsoleteParsed = 0;
    JSON.parse = function (text, ...rest) {
      if (typeof text === 'string' && text.includes('obsolete-probe')) window.obsoleteParsed++;
      return parse(text, ...rest);
    };
  });
  await page.goto('./');
  const obsolete = run(good, 6);
  obsolete[0].name = 'obsolete-probe';
  await page.locator('#tl-file-input').setInputFiles(file('slow-first.json', obsolete));
  await expect(page.getByRole('status')).toHaveText('Loading slow-first.json...');
  await page.getByRole('button', { name: 'Cancel loading' }).click();
  await expect(page.getByRole('button', { name: 'Choose a trace.json file' })).toBeFocused();
  await page.evaluate(() => window.pendingReads['slow-first.json']());
  expect(await page.evaluate(() => window.obsoleteParsed)).toBe(0);
  await expect(page.locator('.tl-wf-row')).toHaveCount(0);
  await page.locator('#tl-file-input').setInputFiles(file('slow-next.json', obsolete));
  await page.locator('#tl-file-input').setInputFiles(file('current.json', run(good, 6)));
  await expect(page.locator('.tl-active-file')).toHaveText('current.json');
  await page.evaluate(() => window.pendingReads['slow-next.json']());
  expect(await page.evaluate(() => window.obsoleteParsed)).toBe(0);
  await expect(page.locator('.tl-active-file')).toHaveText('current.json');
  await page.getByLabel('Candidate trace file').setInputFiles(file('slow-candidate.json', obsolete));
  await page.getByRole('button', { name: 'Load another trace' }).click();
  await page.evaluate(() => window.pendingReads['slow-candidate.json'](true));
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose a trace.json file' })).toBeVisible();
});

test('sample failures recover and cancellation aborts both requests', async ({ page }) => {
  await page.route('**/examples/genai-semconv-trace.json', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('./');
  await page.getByRole('button', { name: 'GenAI semconv example', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('HTTP 503');
  await expect(page.getByRole('button', { name: 'GenAI semconv example', exact: true })).toBeFocused();
  await page.unroute('**/examples/genai-semconv-trace.json');
  await page.getByRole('button', { name: 'GenAI semconv example', exact: true }).click();
  await expect(page.locator('.tl-wf-row').first()).toBeVisible();
  await page.getByRole('button', { name: 'Load another trace' }).click();
  const pending = [];
  await page.route('**/examples/comparison-*.json', (route) => { pending.push(route); });
  await page.getByRole('button', { name: 'Compare two runs (synthetic)' }).click();
  await expect.poll(() => pending.length).toBe(2);
  const canceled = [];
  page.on('requestfailed', (request) => canceled.push(request.url()));
  await page.getByRole('button', { name: 'Cancel loading' }).click();
  for (const route of pending) await route.continue();
  await expect.poll(() => canceled.length).toBe(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.tl-comparison')).toHaveCount(0);
});

test('leaving inspection disposes all global waterfall handlers', async ({ page }) => {
  await page.addInitScript(() => {
    window.viewSignals = [];
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if ((this === window || this === document) && options?.signal) window.viewSignals.push(options.signal);
      return add.call(this, type, listener, options);
    };
  });
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles(file('run.json', run(good, 6)));
  const live = () => page.evaluate(() => new Set(window.viewSignals.filter((signal) => !signal.aborted)).size);
  for (let i = 0; i < 4; i++) {
    await page.locator('.tl-wf-row').nth(i).click();
    expect(await live()).toBe(1);
  }
  await page.getByLabel('Candidate trace file').setInputFiles(file('candidate.json', run(good, 6)));
  await expect(page.getByRole('heading', { name: 'Compare runs', exact: true })).toBeVisible();
  expect(await live()).toBe(0);
  await page.getByRole('button', { name: 'Close comparison' }).click();
  expect(await live()).toBe(1);
  await page.getByTitle('Zoom in', { exact: true }).click();
  const track = await page.locator('.tl-wf-ruler .tl-wf-track').boundingBox();
  await page.mouse.move(track.x + 300, track.y + 10);
  await page.mouse.down();
  await page.mouse.move(track.x + 250, track.y + 10);
  expect(await live()).toBe(2);
  // Leave while the pointer is still down, without a click's implicit mouseup.
  await page.getByRole('button', { name: 'Load another trace' }).evaluate((button) => button.click());
  expect(await live()).toBe(0);
  await page.mouse.move(900, 300);
  await page.mouse.up();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('button', { name: 'Choose a trace.json file' })).toBeVisible();
});

test('price dialog has a name and recovers focus after save, validation and cancel', async ({ page }) => {
  await page.goto('./');
  const prices = page.getByRole('button', { name: 'Prices', exact: true });
  await prices.click();
  await expect(page.getByRole('dialog', { name: 'Price table' })).toBeVisible();
  await page.getByLabel('Row 1 input rate', { exact: true }).fill('-1');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByLabel('Row 1 input rate', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prices).toBeFocused();
  await prices.click();
  await page.getByRole('button', { name: '+ Add row', exact: true }).click();
  const last = page.locator('.tl-price-table tbody tr').last();
  await expect(last.getByLabel(/model match/)).toBeFocused();
  await last.getByLabel(/model match/).fill('custom');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(prices).toBeFocused();
  await prices.click();
  await page.keyboard.press('Escape');
  await expect(prices).toBeFocused();
});

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 375]) {
    test(`accessible layouts: ${theme} at ${width}px`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      const audit = async () => {
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
        expect(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => ({ target: n.target, failure: n.failureSummary })) }))).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      };
      await page.goto('./');
      await audit();
      await page.getByRole('button', { name: 'GenAI semconv example', exact: true }).click();
      await page.getByRole('checkbox', { name: 'Errors only' }).check();
      await page.locator('.tl-wf-row.status-error').first().click();
      await audit();
      if (process.env.CAPTURE_SCREENSHOTS === '1' && testInfo.project.name === 'chromium') {
        await page.screenshot({ path: `docs/assets/span-search-${theme}-${width}.png`, fullPage: true });
      }
      await page.getByRole('button', { name: 'Prices', exact: true }).click();
      await audit();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Load another trace' }).click();
      const kinds = ['AGENT', 'LLM', 'TOOL', 'CHAIN', 'RETRIEVER', 'EMBEDDING', 'RERANKER', 'GUARDRAIL', 'EVALUATOR', 'UNKNOWN'];
      const colored = run(good, kinds.length).map((span, i) => ({ ...span,
        name: kinds[i], attributes: [{ key: 'openinference.span.kind', value: { stringValue: kinds[i] } }],
      }));
      await page.locator('#tl-file-input').setInputFiles(file('all-kinds.json', colored));
      await audit();
      await page.getByRole('button', { name: 'Load another trace' }).click();
      await page.getByRole('button', { name: 'Compare two runs (synthetic)' }).click();
      await expect(page.getByRole('heading', { name: 'Compare runs', exact: true })).toBeVisible();
      await audit();
    });
  }
}
