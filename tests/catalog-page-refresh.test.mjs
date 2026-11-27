import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function loadHelper() {
  const code = ts.transpileModule(readFileSync("src/lib/catalog-page-refresh.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const api = {};
  new Function("exports", code)(api);
  return api;
}

test("refresh replaces first page while retaining loaded tail, state, and removing duplicates", () => {
  const { replaceCatalogFirstPage } = loadHelper();
  const row = {
    key: "trending",
    metas: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
    firstPageLength: 2,
    page: 2,
    hasMore: true,
  };
  const refreshed = replaceCatalogFirstPage(row, [{ id: "new" }, { id: "c" }, { id: "c" }]);
  assert.deepEqual(refreshed.metas, [{ id: "new" }, { id: "c" }, { id: "d" }, { id: "e" }]);
  assert.equal(refreshed.firstPageLength, 2);
  assert.equal(refreshed.page, 2);
  assert.equal(refreshed.hasMore, true);
});

test("empty refresh preserves the visible row", () => {
  const { replaceCatalogFirstPage } = loadHelper();
  const row = {
    key: "row",
    metas: [{ id: "a" }, { id: "b" }],
    firstPageLength: 2,
    page: 1,
    hasMore: false,
  };
  assert.equal(replaceCatalogFirstPage(row, []), row);
});

test("refresh respects the row cap and preserves terminal pagination state", () => {
  const { replaceCatalogFirstPage } = loadHelper();
  const row = {
    metas: Array.from({ length: 30 }, (_, id) => ({ id })),
    firstPageLength: 20,
    page: 2,
    hasMore: false,
  };
  const refreshed = replaceCatalogFirstPage(
    row,
    Array.from({ length: 25 }, (_, id) => ({ id: id + 40 })),
  );
  assert.equal(refreshed.metas.length, 30);
  assert.deepEqual(
    refreshed.metas.slice(25).map((meta) => meta.id),
    [20, 21, 22, 23, 24],
  );
  assert.equal(refreshed.page, 2);
  assert.equal(refreshed.hasMore, false);
});
