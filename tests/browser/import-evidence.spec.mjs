import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

const span = (id, extra = {}) => ({ traceId: 'aa'.repeat(16), spanId: String(id), name: `span ${id}`, startTimeUnixNano: '1790000000000000000', endTimeUnixNano: '1790000010000000000', ...extra });
const attr = (key, value) => ({ key, value: { stringValue: value } });
const doc = (spans, resource = []) => ({ resourceSpans: [{ resource: { attributes: resource }, scopeSpans: [{ spans }] }] });
const file = (name, data) => ({ name, mimeType: 'application/json', buffer: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)) });

test.beforeEach(async ({ page }) => {
  page.errors = [];
  page.externalRequests = [];
  page.on('pageerror', (error) => page.errors.push(String(error)));
  page.context().on('request', (request) => {
    if (new URL(request.url()).origin !== 'http://127.0.0.1:4319') page.externalRequests.push(request.url());
  });
  await page.addInitScript(() => {
    window.violations = [];
    window.rejections = [];
    document.addEventListener('securitypolicyviolation', (event) => window.violations.push(event.violatedDirective));
    addEventListener('unhandledrejection', (event) => window.rejections.push(String(event.reason)));
    window.liveWorkers = new Set();
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); window.liveWorkers.add(this); }
      terminate() { window.liveWorkers.delete(this); super.terminate(); }
    };
  });
});
test.afterEach(async ({ page }) => {
  expect(page.errors).toEqual([]);
  expect(page.externalRequests).toEqual([]);
  expect(await page.evaluate(() => window.violations)).toEqual([]);
  expect(await page.evaluate(() => window.rejections)).toEqual([]);
  expect(await page.evaluate(() => window.liveWorkers.size)).toBe(0);
});

for (const failure of ['constructor', 'postMessage', 'error', 'messageerror', 'malformed', 'timeout']) {
  test(`parser ${failure} failure preserves a comparison and can be retried`, async ({ page }) => {
    await page.addInitScript((failure) => {
      const WorkingWorker = Worker;
      window.failParser = false;
      window.Worker = class extends WorkingWorker {
        constructor(...args) {
          if (window.failParser && failure === 'constructor') throw new Error('startup probe');
          super(...args);
        }
        postMessage(request) {
          if (!window.failParser) { super.postMessage(request); return; }
          if (failure === 'postMessage') throw new Error('send probe');
          if (failure === 'timeout') return;
          queueMicrotask(() => {
            if (failure === 'error') this.onerror?.(new ErrorEvent('error', { message: 'parser probe', cancelable: true }));
            else if (failure === 'messageerror') this.onmessageerror?.(new MessageEvent('messageerror'));
            else this.onmessage?.(new MessageEvent('message', { data: { ok: true, trace: {}, source: null } }));
          });
        }
      };
    }, failure);
    await page.goto('./?example=compare');
    await expect(page.getByRole('heading', { name: 'Compare runs', exact: true })).toBeVisible();
    const original = await page.locator('.tl-compare-metrics').first().innerText();
    await page.evaluate(() => { window.failParser = true; });
    if (failure === 'timeout') await page.clock.install();
    await page.getByLabel('Replace candidate trace').setInputFiles(file('failed.json', doc([span(1)])));
    if (failure === 'timeout') await page.clock.fastForward(30_001);
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await page.locator('.tl-compare-metrics').first().innerText()).toBe(original);
    expect(await page.evaluate(() => window.liveWorkers.size)).toBe(0);
    await page.evaluate(() => { window.failParser = false; });
    await page.getByLabel('Replace candidate trace').setInputFiles(file('retried.json', doc([span(1)])));
    await expect(page.locator('.tl-run-names')).toContainText('retried.json');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('a busy parsing worker can be canceled while the UI remains usable', async ({ page }) => {
  await page.addInitScript(() => {
    const WorkerClass = window.Worker;
    window.busyParser = true;
    window.Worker = class extends WorkerClass {
      constructor(url, options) {
        if (window.busyParser) {
          const busy = URL.createObjectURL(new Blob(['self.onmessage = () => { while (true) {} };'], { type: 'application/javascript' }));
          super(busy, options);
          this.busyUrl = busy;
        } else super(url, options);
      }
      terminate() { super.terminate(); if (this.busyUrl) URL.revokeObjectURL(this.busyUrl); }
    };
  });
  await page.goto('./');
  await page.locator('#tl-file-input').setInputFiles(file('busy.json', doc([span(1)])));
  await expect(page.locator('.tl-load-notice')).toContainText('busy.json');
  await page.getByRole('button', { name: 'Toggle dark mode' }).click({ timeout: 3000 });
  await page.getByRole('button', { name: 'Cancel loading' }).click({ timeout: 3000 });
  await expect(page.locator('.tl-load-notice')).toHaveCount(0);
  expect(await page.evaluate(() => window.liveWorkers.size)).toBe(0);
  await page.evaluate(() => { window.busyParser = false; });
  await page.locator('#tl-file-input').setInputFiles(file('recovered.json', doc([span(2)])));
  await expect(page.locator('.tl-active-file')).toHaveText('recovered.json');
});

test('6000 levels of ancestry survive real worker transport and remain searchable', async ({ page }) => {
  await page.goto('./');
  const spans = Array.from({ length: 6000 }, (_, i) => span(i, i ? { parentSpanId: String(i - 1) } : {}));
  await page.locator('#tl-file-input').setInputFiles(file('deep-tree.json', doc(spans)));
  await page.getByRole('searchbox', { name: 'Find spans' }).fill('span 5999');
  await expect(page.locator('#tl-span-filter-count')).toContainText('1 of 6,000 spans match');
  await expect(page.locator('#tl-span-filter-count')).toContainText('5,999');
  expect(await page.locator('.tl-wf-row').count()).toBeLessThan(200);
});

test('worker imports retain BOM decoding for UTF-8 and both UTF-16 byte orders', async ({ page }) => {
  const text = JSON.stringify(doc([span(1, { name: 'Unicode α 水 😀' })]));
  const utf16 = Buffer.from(text, 'utf16le');
  const inputs = [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]), Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf16).swap16()])];
  for (const buffer of inputs) {
    await page.goto('./');
    await page.locator('#tl-file-input').setInputFiles({ name: 'unicode.json', mimeType: 'application/json', buffer });
    await page.locator('.tl-wf-row').first().click();
    await expect(page.locator('.tl-detail-title')).toHaveText('Unicode α 水 😀');
  }
});

test('newer trace switches terminate obsolete work and retain picker focus', async ({ page }) => {
  await page.addInitScript(() => {
    window.switches = {};
    const WorkingWorker = Worker;
    window.Worker = class extends WorkingWorker {
      postMessage(request) {
        if (request.source.kind !== 'text') { super.postMessage(request); return; }
        window.switches[request.traceId] = () => super.postMessage(request);
      }
    };
  });
  await page.goto('./');
  const ids = ['aa', 'bb', 'cc'].map((id) => id.repeat(16));
  await page.locator('#tl-file-input').setInputFiles(file('collector.json', doc(ids.map((traceId, i) => span(i, { traceId })))));
  const picker = page.locator('#tl-trace-picker');
  await expect(picker).toHaveValue(ids[0]);
  await picker.focus();
  await picker.selectOption(ids[1]);
  await expect(picker).toHaveValue(ids[0]);
  await picker.selectOption(ids[2]);
  await page.evaluate((id) => window.switches[id](), ids[1]);
  await expect(picker).toHaveValue(ids[0]);
  await page.evaluate((id) => window.switches[id](), ids[2]);
  await expect(picker).toHaveValue(ids[2]);
  await expect(picker).toBeFocused();
});

test('excessive attribute nesting and oversized inputs recover with helpful errors', async ({ page }) => {
  await page.goto('./');
  const value = '{"arrayValue":{"values":['.repeat(6000) + '{"stringValue":"leaf"}' + ']}}'.repeat(6000);
  const text = JSON.stringify(doc([span(1, { attributes: [{ key: 'payload', value: 'REPLACE' }] })])).replace('"REPLACE"', value);
  await page.locator('#tl-file-input').setInputFiles(file('deep-payload.json', text));
  await expect(page.getByRole('alert')).toContainText('128 nested object/array levels');
  await page.locator('#tl-file-input').setInputFiles(file('large.json', ' '.repeat(25 * 1024 * 1024 + 1)));
  await expect(page.getByRole('alert')).toContainText('25 MB or smaller');
  await page.locator('#tl-file-input').setInputFiles(file('valid.json', doc([span(2)])));
  await expect(page.locator('.tl-active-file')).toHaveText('valid.json');
});

test('sample downloads enforce the response limit despite a small advertised length and recover', async ({ page }) => {
  await page.route('**/examples/genai-semconv-trace.json', (route) => route.fulfill({ contentType: 'application/json', headers: { 'content-length': '1' }, body: ' '.repeat(25 * 1024 * 1024 + 1) }));
  await page.goto('./');
  await page.getByRole('button', { name: 'GenAI semconv example', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('25 MB or smaller');
  await page.unroute('**/examples/genai-semconv-trace.json');
  await page.getByRole('button', { name: 'GenAI semconv example', exact: true }).click();
  await expect(page.locator('.tl-wf-row').first()).toBeVisible();
});

test('sample redirects fail without contacting another origin', async ({ page }) => {
  await page.route('**/examples/genai-semconv-trace.json', (route) => route.fulfill({ status: 302, headers: { location: 'https://example.invalid/redirect-probe' } }));
  await page.goto('./');
  await page.getByRole('button', { name: 'GenAI semconv example', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText("Couldn't load the sample trace");
  await expect(page.getByRole('button', { name: 'GenAI semconv example', exact: true })).toBeFocused();
});

test('attribute pages stay bounded, retain position and download full evidence', async ({ page }) => {
  await page.goto('./');
  const attributes = Array.from({ length: 20000 }, (_, i) => attr(`attribute_${i}`, `captured value ${i}`));
  const full = '<img src=x onerror=alert(1)>'.repeat(400);
  attributes[19999] = attr('last_payload', full);
  await page.locator('#tl-file-input').setInputFiles(file('many.json', doc([span(1, { attributes })], attributes)));
  await page.locator('.tl-wf-row').first().click();
  await page.getByRole('tab', { name: 'Attributes' }).click();
  const section = page.getByRole('region', { name: 'Attributes', exact: true });
  await expect(section.getByRole('status')).toHaveText('Attributes: 1–50 of 20,000');
  await expect(page.locator('.tl-tab-panel tr')).toHaveCount(100);
  await section.getByRole('button', { name: 'Next attributes' }).click();
  await expect(section.getByRole('button', { name: 'Next attributes' })).toBeFocused();
  await section.getByRole('spinbutton').fill('400');
  await section.getByRole('spinbutton').press('Enter');
  await expect(section.getByRole('status')).toHaveText('Attributes: 19,951–20,000 of 20,000');
  await expect(section).toContainText('preview; download for full value');
  await page.getByRole('button', { name: 'Toggle dark mode' }).click();
  await expect(section.getByRole('spinbutton')).toHaveValue('400');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('tab', { name: 'Attributes' }).click();
  await expect(section.getByRole('spinbutton')).toHaveValue('400');
  await page.context().setOffline(true);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download span JSON' }).click();
  const evidence = JSON.parse(await readFile(await (await downloaded).path(), 'utf8'));
  expect(Object.keys(evidence.attributes)).toHaveLength(20000);
  expect(Object.keys(evidence.resourceAttributes)).toHaveLength(20000);
  expect(evidence.attributes.last_payload).toBe(full);
  expect(evidence.startTimeUnixNano).toBe('1790000000000000000');
  expect(evidence.kind).toBe('UNSPECIFIED');
  expect(await page.locator('.tl-detail-pane img').count()).toBe(0);
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
});

test('messages, message parts, events and warnings expose bounded pages and complete downloads', async ({ page }) => {
  await page.goto('./');
  const messages = Array.from({ length: 55 }, (_, i) => ({ role: 'user', parts: [{ type: 'text', content: `message ${i}` }] }));
  messages[0].parts = Array.from({ length: 45 }, (_, i) => ({ type: 'text', content: `part ${i} ` + 'payload '.repeat(1000) }));
  const events = Array.from({ length: 125 }, (_, i) => ({ name: `event ${i}`, timeUnixNano: '1790000000000000000', attributes: [attr('payload', 'captured '.repeat(1000))] }));
  const input = span(1, { parentSpanId: 'missing', attributes: [attr('gen_ai.input.messages', JSON.stringify(messages))], events });
  await page.locator('#tl-file-input').setInputFiles(file('many-messages.json', doc([input, ...Array.from({ length: 125 }, (_, i) => span(i + 2, { parentSpanId: 'absent' }))])));
  await page.locator('.tl-wf-row').first().click();
  await expect(page.locator('.tl-detail-title')).toHaveText('span 1');
  await page.getByRole('tab', { name: 'Messages' }).click();
  const inputs = page.getByRole('region', { name: 'Input messages', exact: true });
  await expect(inputs.getByRole('status').first()).toHaveText('Input messages: 1–20 of 55');
  await expect(inputs.locator('.tl-msg-body')).toHaveCount(39);
  await page.getByRole('button', { name: 'Next input messages message 1 parts', exact: true }).click();
  await expect(inputs).toContainText('part 20');
  await page.getByRole('button', { name: 'Next input messages', exact: true }).click();
  await expect(inputs.getByRole('status')).toHaveText('Input messages: 21–40 of 55');
  await page.getByRole('tab', { name: 'Events' }).click();
  const eventList = page.getByRole('region', { name: 'Events', exact: true });
  await expect(eventList.locator('.tl-msg')).toHaveCount(20);
  await page.getByRole('button', { name: 'Next events', exact: true }).click();
  await expect(eventList).toContainText('event 20');
  await page.locator('.tl-compare-warnings summary').click();
  await expect(page.locator('.tl-compare-warnings li')).toHaveCount(50);
  await page.getByRole('button', { name: 'Next parser warnings' }).click();
  await expect(page.getByRole('region', { name: 'Parser warnings' }).getByRole('status')).toHaveText('Parser warnings: 51–100 of 126');
  const warningsDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download warnings JSON' }).click();
  const warnings = JSON.parse(await readFile(await (await warningsDownload).path(), 'utf8'));
  expect(warnings).toHaveLength(126);
  expect(warnings[125].message).toContain('span 126');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download span JSON' }).click();
  const evidence = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(evidence.genai.inputMessages).toEqual(messages);
  expect(evidence.events).toHaveLength(125);
  expect(evidence.events[124].attributes.payload).toBe('captured '.repeat(1000));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
