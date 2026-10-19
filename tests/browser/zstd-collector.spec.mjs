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
