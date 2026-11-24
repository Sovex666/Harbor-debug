#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Node's Windows ESM resolver rejects a `G:\...` loader specifier. These
// paths are deliberately relative to the controlled `cwd` below, matching
// the repository's own `pnpm test` command.
const loader = "./scripts/node-test-loader.mjs";
const environment = "./scripts/node-test-environment.mjs";

// Keep this list explicit: it is the fast frontend regression loop, not the
// repository-wide suite (and it never invokes Cargo, Tauri, or a build).
const suites = [
  {
    name: "cache",
    files: [
      "tests/browse-cache-prefetch.test.mjs",
      "tests/media-cache.test.mjs",
      "tests/browse-restart.test.mjs",
      "tests/hero-pool-refresh.test.mjs",
      "tests/library-read-cache.test.mjs",
    ],
  },
  {
    name: "calendar",
    files: [
      "tests/calendar-cache.test.mjs",
      "tests/calendar-failure-completeness.test.mjs",
      "tests/calendar-cache-scope.test.mjs",
      "tests/calendar-data-hook.test.mjs",
      "tests/calendar-library-watched.test.ts",
      "tests/calendar-performance.test.mjs",
      "tests/calendar-sources-cache.test.mjs",
      "tests/calendar-snapshot-cache.test.mjs",
    ],
  },
  {
    name: "navigation",
    files: [
      "tests/app-diagnostics.test.mjs",
      "tests/navigation-performance.test.mjs",
      "tests/catalog-page-refresh.test.mjs",
      "tests/home-row-loading.test.ts",
    ],
  },
  {
    name: "thumbnail",
    files: [
      "tests/thumbnail-scheduler.test.mjs",
      "tests/thumbnail-navigation.test.mjs",
      "tests/poster-crossfade.test.mjs",
    ],
  },
];

function parseTap(output) {
  const number = (pattern) => Number(output.match(pattern)?.[1] ?? 0);
  return {
    tests: number(/^# tests (\d+)$/m),
    passed: number(/^# pass (\d+)$/m),
    failed: number(/^# fail (\d+)$/m),
    skipped: number(/^# skipped (\d+)$/m),
  };
}

const startedAt = performance.now();
const results = [];
let failed = false;

for (const suite of suites) {
  const files = suite.files.map((file) => path.join(root, file));
  const missing = suite.files.filter((_, index) => !existsSync(files[index]));
  const at = performance.now();
  if (missing.length) {
    failed = true;
    results.push({
      name: suite.name,
      status: "failed",
      exitCode: null,
      durationMs: Math.round((performance.now() - at) * 100) / 100,
      tests: 0,
      passed: 0,
      failed: missing.length,
      skipped: 0,
      missing,
    });
    continue;
  }

  const child = spawnSync(
    process.execPath,
    [
      "--import",
      environment,
      "--experimental-loader",
      loader,
      "--test",
      "--test-concurrency=1",
      "--test-reporter=tap",
      ...suite.files,
    ],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
  const counts = parseTap(output);
  const status =
    child.status === 0 && !child.error && counts.tests > 0 && counts.failed === 0
      ? "passed"
      : "failed";
  if (status === "failed") {
    failed = true;
    // Keep stdout machine-readable while retaining enough failure context for
    // a terminal user. The JSON report below remains the source of truth.
    process.stderr.write(`\n[${suite.name}] test output\n${output.slice(-8000)}\n`);
  }
  results.push({
    name: suite.name,
    status,
    exitCode: child.status,
    durationMs: Math.round((performance.now() - at) * 100) / 100,
    ...counts,
    ...(child.error ? { spawnError: String(child.error) } : {}),
  });
}

const report = {
  schemaVersion: 1,
  status: failed ? "failed" : "passed",
  durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  suites: results,
};
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = failed ? 1 : 0;
