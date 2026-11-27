import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainArgs = (file) => {
  const config = JSON.parse(readFileSync(new URL(`../src-tauri/${file}`, import.meta.url), "utf8"));
  return config.app.windows.find((w) => w.label === "main").additionalBrowserArgs.split(/\s+/);
};

for (const file of ["tauri.conf.json", "tauri.context-review.conf.json"]) {
  test(`${file} keeps Skia Graphite off so a page's first paint does not compile shaders`, () => {
    const args = mainArgs(file);
    // Graphite compiled GPU pipelines on the first few switches after launch: 230-280 ms freezes.
    const disabled = args.filter((arg) => arg.startsWith("--disable-features="));
    assert.equal(disabled.length, 1, "WebView2 does not merge repeated --disable-features switches");
    const features = disabled[0].slice("--disable-features=".length).split(",");
    assert.ok(features.includes("SkiaGraphite"));
    assert.ok(features.includes("HardwareMediaKeyHandling"));
  });
}
