import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function contract() {
  const code = ts.transpileModule(
    `${read("src/lib/diagnostics/contract.ts")}\nexport const __lists = { EVENTS, FIELDS };`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const exports = {};
  new Function("require", "exports", code)(() => ({}), exports);
  return exports.__lists;
}

function diagScript() {
  const source = read("scripts/harbor-diag.mjs");
  const slice = (start, end) => {
    const at = source.indexOf(start);
    assert.ok(at >= 0, start);
    return source.slice(at, source.indexOf(end, at) + end.length);
  };
  const views = slice("const VIEWS", "]);");
  const keys = slice("const SAFE_KEYS", ");");
  const events = slice("const SAFE_EVENT_NAMES", "]);");
  return new Function(`${views}\n${keys}\n${events}\nreturn { SAFE_KEYS, SAFE_EVENT_NAMES };`)();
}

test("the diagnostics export keeps every event and field the app records", () => {
  const { EVENTS, FIELDS } = contract();
  const { SAFE_KEYS, SAFE_EVENT_NAMES } = diagScript();
  assert.deepEqual([...EVENTS].filter((name) => !SAFE_EVENT_NAMES.has(name)), []);
  assert.deepEqual([...FIELDS].filter((name) => !SAFE_KEYS.has(name)), []);
});

test("native diagnostic sessions accept the same fields as the app", () => {
  const { FIELDS } = contract();
  const rust = read("src-tauri/src/diagnostics_sessions.rs");
  const at = rust.indexOf("const KEYS");
  const keys = new Set([...rust.slice(at, rust.indexOf("];", at)).matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...FIELDS].filter((name) => !keys.has(name)).sort(), []);
  assert.deepEqual([...keys].filter((name) => !FIELDS.has(name)).sort(), []);
});
