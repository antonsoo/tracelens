import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** A run of `count` spans under one agent: turns of a model call and three tool calls. */
function longRun(count) {
  const traceId = 'ab'.repeat(16);
  const id = (n) => n.toString(16).padStart(16, '0');
  const start = 1_790_000_000_000_000_000n;
  let clock = start;
  const spans = [{ traceId, spanId: id(1), name: 'invoke_agent long-run', kind: 1, startTimeUnixNano: String(start), attributes: [], status: { code: 0 } }];
  while (spans.length < count) {
    const tool = spans.length % 4 !== 1;
    const from = clock;
    clock += tool ? 300_000_000n : 1_500_000_000n;
    spans.push({
      traceId,
      spanId: id(spans.length + 1),
      parentSpanId: id(1),
      name: tool ? `execute_tool step_${spans.length}` : `chat turn_${spans.length}`,
      kind: tool ? 1 : 3,
      startTimeUnixNano: String(from),
      endTimeUnixNano: String(clock),
      attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: tool ? 'execute_tool' : 'chat' } }],
      status: { code: 0 },
    });
  }
  spans[0].endTimeUnixNano = String(clock);
  return JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: 'test' }, spans }] }] });
}

const file = (name, text) => ({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** Real browser regressions for the waterfall (width, scroll, focus, long traces) and for files of several traces. */
export async function auditWaterfall(browser, target, root) {
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, colorScheme: 'dark' });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(String(error))));
  try {
    const page = await context.newPage();
    await page.goto(target);

    // The timeline fills its track: the root span of the sample runs the whole trace.
    await page.locator('#tl-file-input').setInputFiles(root + '/examples/genai-semconv-trace.json');
    await page.locator('.tl-wf-row').first().waitFor();
    const fit = await page.evaluate(() => {
      const row = document.querySelector('.tl-wf-row');
      return { track: row.querySelector('.tl-wf-track').clientWidth, bar: parseFloat(row.querySelector('.tl-wf-bar').style.width) };
    });
    assert.ok(fit.track > 800, `a 1600px window leaves the track more than its 600px minimum (got ${fit.track})`);
    assert.ok(Math.abs(fit.bar - fit.track) < 1, `the root span's bar (${fit.bar}px) spans the track (${fit.track}px)`);

    // A long run: only the rows in view exist, and selecting one far down keeps the place.
    await page.getByRole('button', { name: 'Load another trace' }).click();
    await page.locator('#tl-file-input').setInputFiles(file('long-run.json', longRun(6000)));
    await page.locator('.tl-wf-row').first().waitFor();
    assert.match(await page.locator('.tl-summary').innerText(), /6,000/);
    assert.ok((await page.locator('.tl-wf-row').count()) < 200, 'rows out of view are not rendered');
    const scroller = page.locator('.tl-waterfall-scroll');
    await scroller.evaluate((el) => { el.scrollTop = 100_000; });
    await settle(page);
    const target4000 = page.locator('.tl-wf-row[data-index="4010"]');
    await target4000.waitFor();
    const before = await scroller.evaluate((el) => el.scrollTop);
    const started = Date.now();
    await target4000.click();
    await page.locator('.tl-wf-row.selected[data-index="4010"]').waitFor();
    assert.ok(Date.now() - started < 2000, 'selecting a span in a 6,000-span trace is immediate');
    assert.equal(await scroller.evaluate((el) => el.scrollTop), before, 'a selection leaves the scroll position alone');
    assert.match(await page.locator('.tl-detail-pane').innerText(), /step_4010|turn_4010/);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-index')), '4010', 'the selected row keeps the focus');
    // Zooming rebuilds the view too, and keeps the place as well.
    await page.locator('button[title="Zoom in"]').click();
    await settle(page);
    assert.equal(await scroller.evaluate((el) => el.scrollTop), before);
    await page.locator('button[title="Reset zoom"]').click();

    // The keyboard walks the tree: arrows move, Home and End jump, left and right fold and open.
    await page.locator('.tl-wf-row[data-index="4010"]').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-index')), '4012');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-index')), '5999');
    await page.keyboard.press('Enter');
    await page.locator('.tl-wf-row.selected[data-index="5999"]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-index')), '5999');
    await page.keyboard.press('Home');
    const rootRow = page.locator('.tl-wf-row[data-index="0"]');
    assert.equal(await rootRow.getAttribute('aria-expanded'), 'true');
    assert.equal(await rootRow.getAttribute('aria-level'), '1');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelectorAll('.tl-wf-row').length === 1);
    assert.equal(await page.locator('.tl-wf-row').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-index')), '0', 'folding keeps the focus on the folded row');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelectorAll('.tl-wf-row').length > 1);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-index')), '1');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-index')), '0');

    // On a phone the page scrolls, not the pane; rows are still rendered only where they show.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForTimeout(250); // The app debounces resize by 120ms.
    await page.evaluate(() => window.scrollTo(0, 60_000));
    await settle(page);
    const phone = await page.evaluate(() => ({ rows: document.querySelectorAll('.tl-wf-row').length, first: Number(document.querySelector('.tl-wf-row')?.getAttribute('data-index')), y: window.scrollY }));
    assert.ok(phone.rows > 10 && phone.rows < 200 && phone.first > 2000, `rows follow the page scroll (${JSON.stringify(phone)})`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'page must not overflow at 375px');
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForTimeout(250);

    // A collector's file: an export per line, three runs in it.
    const genai = JSON.parse(await readFile(root + '/examples/genai-semconv-trace.json', 'utf8'));
    const spans = genai.resourceSpans[0].scopeSpans[0].spans;
    const batch = (part) => JSON.stringify({ resourceSpans: [{ ...genai.resourceSpans[0], scopeSpans: [{ ...genai.resourceSpans[0].scopeSpans[0], spans: part }] }] });
    const oneLine = async (name) => JSON.stringify(JSON.parse(await readFile(`${root}/examples/${name}`, 'utf8')));
    const collector = [batch(spans.slice(0, 7)), await oneLine('comparison-baseline.json'), batch(spans.slice(7)), await oneLine('comparison-candidate.json')].join('\n') + '\n';
    await page.getByRole('button', { name: 'Load another trace' }).click();
    await page.locator('#tl-file-input').setInputFiles(file('collector.jsonl', collector));
    const picker = page.getByLabel('This file holds 3 traces. Showing');
    await picker.waitFor();
    assert.equal(await page.locator('.tl-wf-row').count(), 16, 'the largest trace is shown, whole, though it arrived in two batches');
    assert.match(await page.locator('.tl-summary').innerText(), /31\.80 s/);
    const options = await picker.locator('option').allInnerTexts();
    assert.equal(options.length, 3);
    assert.match(options.find((text) => text.includes('16 spans')), /invoke_agent incident-analyst · 16 spans · 31\.80 s/);
    const sixSpans = await picker.locator('option').evaluateAll((all) => all.filter((o) => o.textContent.includes('· 6 spans')).map((o) => o.value));
    assert.equal(sixSpans.length, 2);
    await picker.selectOption(sixSpans[0]);
    await page.waitForFunction(() => document.querySelectorAll('.tl-wf-row').length === 6);
    assert.equal(await page.getByLabel('This file holds 3 traces. Showing').inputValue(), sixSpans[0]);
    // Compare it with the other six-span run of the same file: the candidate is that file again.
    await page.getByLabel('Candidate trace file').setInputFiles(file('collector.jsonl', collector));
    await page.getByRole('heading', { name: 'Compare runs', exact: true }).waitFor();
    const names = await page.locator('.tl-comparison-shell').innerText();
    assert.match(names, new RegExp(`collector\\.jsonl · trace ${sixSpans[0].slice(0, 8)} of 3`));
    assert.match(names, /collector\.jsonl · trace [0-9a-f]{8} of 3/);

    // A cut-off last line is skipped with a warning; a file that is not a trace says so.
    await page.getByRole('button', { name: 'Close comparison' }).click();
    await page.getByRole('button', { name: 'Load another trace' }).click();
    await page.locator('#tl-file-input').setInputFiles(file('cut.jsonl', `${batch(spans.slice(0, 7))}\n${batch(spans.slice(7)).slice(0, 300)}`));
    await page.locator('.tl-compare-warnings').waitFor();
    assert.match(await page.locator('.tl-compare-warnings').innerText(), /parser warnings/);
    assert.equal(await page.locator('.tl-wf-row').count(), 7);
    await page.getByRole('button', { name: 'Load another trace' }).click();
    await page.locator('#tl-file-input').setInputFiles(file('page.json', '<html>\n<body></body>\n</html>\n'));
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /^Not valid JSON: /);
  } finally {
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: timeline width, 6,000-span trace (rows in view only, scroll and focus kept through select and zoom), keyboard tree navigation, phone-width page scroll, collector JSON Lines with a trace picker.');
}
