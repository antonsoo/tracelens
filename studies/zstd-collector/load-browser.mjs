import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium, firefox, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const [url, output] = process.argv.slice(2);
assert(url && output, "Usage: load-browser.mjs URL OUTPUT_DIR");
const load = fileURLToPath(new URL("./load/", import.meta.url));
const oracle = JSON.parse(await readFile(join(load, "oracle.json"))),
  sdkBytes = gunzipSync(await readFile(join(load, "sdk-spans.json.gz")));
const sha = (b) => createHash("sha256").update(b).digest("hex");
assert.equal(sha(sdkBytes), oracle.sdkSpansSha256);
const original = JSON.parse(sdkBytes).find((span) => span.attributes["document.index"] === 4999);
const results = [];
await mkdir(output, { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["firefox", firefox],
]) {
  const browser = await type.launch();
  try {
    for (const row of oracle.files) {
      const width = engine === "firefox" ? 375 : 1440,
        context = await browser.newContext({
          viewport: { width, height: 1000 },
          colorScheme: width === 375 ? "light" : "dark",
          reducedMotion: "reduce",
        }),
        page = await context.newPage();
      const errors = [],
        late = [];
      let offline = false;
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("request", (r) => {
        if (offline && /^https?:/.test(r.url())) late.push(r.url());
      });
      const file = join(load, row.file);
      assert.equal(sha(await readFile(file)), row.sha256);
      await page.goto(url);
      await page.locator("#tl-file-input").waitFor({ state: "attached" });
      await page.evaluate(() => document.fonts.ready);
      await context.setOffline(true);
      offline = true;
      const started = performance.now();
      await page.locator("#tl-file-input").setInputFiles(file);
      await expect(page.locator("#tl-span-filter-count")).toContainText("5,001");
      const loadMs = performance.now() - started;
      assert((await page.locator(".tl-wf-row").count()) < 200);
      await page.getByRole("searchbox", { name: "Find spans" }).fill(original.spanId);
      await expect(page.locator(".tl-wf-row")).toHaveCount(2);
      await page.getByRole("treeitem", { name: /^sha256 / }).click();
      const pending = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download span JSON", exact: true }).click();
      const downloaded = await readFile(await (await pending).path()),
        span = JSON.parse(downloaded);
      assert.equal(span.spanId, original.spanId);
      assert.equal(span.traceId, original.traceId);
      assert.equal(span.startTimeUnixNano, original.start);
      assert.equal(span.endTimeUnixNano, original.end);
      assert.deepEqual(span.attributes, original.attributes);
      const accessibility = (await new AxeBuilder({ page }).analyze()).violations;
      assert.deepEqual(accessibility, []);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(late, []);
      if (row.file === "traces.jsonl.zst")
        await page.screenshot({ path: join(output, `${engine}-load.png`), fullPage: true });
      results.push({
        engine,
        version: browser.version(),
        width,
        file: row.file,
        encodedBytes: row.bytes,
        spans: 5001,
        firstImportOffline: true,
        loadThroughVisibleUiMs: loadMs,
        lastToolDownloadSha256: sha(downloaded),
        originalSdkClockAndAttributesMatch: true,
        renderedRowsBounded: true,
        errors,
        late,
        accessibilityViolations: accessibility,
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
await writeFile(
  join(output, "load-browser.json"),
  JSON.stringify(
    {
      scope:
        "Actual controlled local SDK workload; observed file-input-to-visible-count wall time includes browser automation, I/O, worker and UI. Four observations, not a performance guarantee.",
      workflows: results,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    results.map((row) => ({
      engine: row.engine,
      file: row.file,
      spans: row.spans,
      loadMs: row.loadThroughVisibleUiMs,
    })),
  ),
);
