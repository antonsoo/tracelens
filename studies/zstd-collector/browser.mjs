import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const here = fileURLToPath(new URL(".", import.meta.url));
const oracle = JSON.parse(
  await readFile(new URL("../otlp-binary/fixtures/oracle.json", import.meta.url)),
);
const workflow = oracle.spans.find((span) => span.name === "inspect a document digest");
const consumer = oracle.spans.find((span) => span.name === "consume the digest");
const tool = oracle.spans.find((span) => span.name === "sha256");

export async function exercise(
  page,
  context,
  { url, mode, format, width, before = false, output, engine },
) {
  const errors = [],
    external = [],
    late = [],
    csp = [];
  let offline = false;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) {
      if (new URL(r.url()).origin !== new URL(url).origin) external.push(r.url());
      if (offline) late.push(r.url());
    }
  });
  await page.addInitScript(() => {
    window.zstdCsp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.zstdCsp.push(e.violatedDirective),
    );
  });
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({
    colorScheme: width === 375 ? "light" : "dark",
    reducedMotion: "reduce",
  });
  await page.goto(url);
  await page.locator("#tl-file-input").waitFor({ state: "attached" });
  await page.evaluate(() => document.fonts.ready);
  await context.setOffline(true);
  offline = true;
  const names =
    format === "json" ? ["traces.jsonl", "logs.jsonl"] : ["traces.traces.otlp", "logs.logs.otlp"];
  const plain = names.map((name) => join(here, "fixtures", mode, name)),
    zipped = plain.map((name) => name + ".zst");
  const input = page.locator("#tl-file-input");
  async function download(name) {
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name, exact: true }).click();
    const bytes = await readFile(await (await pending).path());
    return { value: JSON.parse(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  if (before) {
    await input.setInputFiles(plain);
    await expect(page.locator(".tl-wf-row")).toHaveCount(4);
  }
  if (before) await page.getByLabel("Candidate trace file", { exact: true }).setInputFiles(zipped);
  else await input.setInputFiles(zipped);
  if (before) {
    await expect(page.getByRole("alert")).toContainText("not a text file");
    await expect(page.locator(".tl-wf-row")).toHaveCount(4);
  } else {
    await expect(page.locator(".tl-wf-row")).toHaveCount(4);
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  await expect(page.locator("#tl-trace-picker")).toHaveValue(workflow.traceId);
  await page.getByRole("treeitem", { name: /^sha256 / }).click();
  const span = await download("Download span JSON");
  assert.equal(span.value.traceId, tool.traceId);
  assert.equal(span.value.spanId, tool.spanId);
  assert.equal(span.value.startTimeUnixNano, tool.start);
  assert.equal(span.value.endTimeUnixNano, tool.end);
  assert.deepEqual(span.value.attributes, tool.attributes);
  await page
    .getByRole("treeitem", { name: /^chat scripted-response / })
    .first()
    .click();
  const model = await download("Download span JSON");
  assert.equal(model.value.logs.length, 1);
  const log = oracle.logs.find((row) => row.spanId === model.value.spanId);
  assert.equal(model.value.logs[0].timeUnixNano, undefined);
  assert.equal(model.value.logs[0].observedTimeUnixNano, log.observedTimestamp);
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  await expect(page.locator("#tl-detail-content")).toContainText(
    "Compute the SHA-256 of receipt-17.",
  );
  if (
    output &&
    ((engine === "chromium" && width === 1440 && mode === "native" && format === "proto") ||
      (engine === "firefox" && width === 375 && mode === "legacy" && format === "json"))
  ) {
    await mkdir(output, { recursive: true });
    await page.screenshot({
      path: join(output, width === 375 ? "mobile.png" : "native-proto.png"),
      fullPage: true,
    });
  }
  let report = null;
  if (!before) {
    const accessibility = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(accessibility.violations, []);
    await page.locator("#tl-trace-picker").selectOption(consumer.traceId);
    await expect(page.locator(".tl-wf-row")).toHaveCount(2);
    await page.locator(".tl-links summary").click();
    const links = await download("Download links JSON");
    assert.equal(links.value.linkCount, 1);
    await page
      .locator(".tl-links")
      .getByRole("button", { name: "consume the digest", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Inspect inspect a document digest", exact: true })
      .click();
    await expect(page.locator("#tl-trace-picker")).toHaveValue(workflow.traceId);
    await page.getByRole("button", { name: "Back to source span", exact: true }).click();
    await expect(page.locator("#tl-trace-picker")).toHaveValue(consumer.traceId);
    await page.locator("#tl-trace-picker").selectOption(workflow.traceId);
    await expect(page.locator(".tl-wf-row")).toHaveCount(4);
    await page.getByLabel("Candidate trace file", { exact: true }).setInputFiles(plain);
    await expect(page.locator(".tl-comparison")).toBeVisible();
    const beforeReport = await download("Export JSON");
    assert.equal(beforeReport.value.metrics.calls.baseline.value, 4);
    assert.equal(beforeReport.value.metrics.calls.candidate.value, 4);
    await page
      .getByLabel("Replace candidate trace", { exact: true })
      .setInputFiles(join(here, "controls", `${mode}-checksum.traces.otlp.zst`));
    await expect(page.getByRole("alert")).toContainText("checksum");
    const preserved = await download("Export JSON");
    assert.deepEqual(preserved.value, beforeReport.value);
    await page
      .getByLabel("Replace candidate trace", { exact: true })
      .setInputFiles([1, 2].map((index) => join(here, "controls", `group-${index}.jsonl.zst`)));
    await expect(page.getByRole("alert")).toContainText("text limit");
    assert.deepEqual((await download("Export JSON")).value, beforeReport.value);
    await page.getByLabel("Replace candidate trace", { exact: true }).setInputFiles(zipped);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".tl-load-notice")).toHaveCount(0);
    const recovered = await download("Export JSON");
    assert(recovered.value.inputFiles.candidate.every((file) => file.name.endsWith(".zst")));
    assert.equal(recovered.value.metrics.calls.candidate.value, 4);
    assert.equal(recovered.value.wallTimeMs.delta, 0);
    report = {
      linksDownloadSha256: links.sha256,
      comparisonPreservedAfterCorruptReplacement: true,
      combinedExpandedGroupRefused: true,
      recoveryDownloadSha256: recovered.sha256,
    };
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(late, []);
  assert.deepEqual(await page.evaluate(() => window.zstdCsp), csp);
  return {
    mode,
    format,
    width,
    before,
    firstImportOffline: !before,
    spans: 6,
    traces: 2,
    logs: 2,
    toolDownloadSha256: span.sha256,
    modelDownloadSha256: model.sha256,
    ...report,
    errors,
    external,
    late,
    overflow,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [url, output, revision = "after"] = process.argv.slice(2);
  assert(
    url && output,
    "Usage: node studies/zstd-collector/browser.mjs URL OUTPUT_DIR [before|after]",
  );
  const rows = [];
  for (const [engine, type] of [
    ["chromium", chromium],
    ["firefox", firefox],
  ]) {
    const browser = await type.launch();
    try {
      for (const mode of ["legacy", "native"])
        for (const format of ["json", "proto"])
          for (const width of [1440, 375]) {
            const context = await browser.newContext(),
              page = await context.newPage();
            try {
              rows.push({
                engine,
                version: browser.version(),
                ...(await exercise(page, context, {
                  url,
                  output,
                  mode,
                  format,
                  width,
                  before: revision === "before",
                  engine,
                })),
              });
            } finally {
              await context.close();
            }
          }
    } finally {
      await browser.close();
    }
  }
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "browser.json"),
    JSON.stringify({ revision, workflows: rows }, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      revision,
      workflows: rows.length,
      errors: rows.flatMap((r) => r.errors).length,
    }),
  );
}
