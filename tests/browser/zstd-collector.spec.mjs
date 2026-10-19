import { test } from "@playwright/test";
import { exercise } from "../../studies/zstd-collector/browser.mjs";

for (const [mode, format, width] of [
  ["native", "proto", 375],
  ["legacy", "json", 1440],
]) {
  test(`${mode} compressed ${format} imports offline, preserves evidence and recovers from a damaged replacement`, async ({
    page,
    context,
    baseURL,
  }, info) => {
    await exercise(page, context, { url: baseURL, mode, format, width, engine: info.project.name });
  });
}

const { exerciseSample } = await import('../../studies/zstd-collector/sample-browser.mjs');
for (const entry of ['button', 'link']) {
  test(`native Collector sample from ${entry} preserves the SDK span after disconnecting`, async ({ page, context, baseURL }, info) => {
    await exerciseSample(page, context, { url: baseURL, entry, width: info.project.name === 'firefox' ? 375 : 1440 });
  });
}
