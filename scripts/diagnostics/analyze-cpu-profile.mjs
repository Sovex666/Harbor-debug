// Summarizes a .cpuprofile written by the benchmark (HARBOR_BENCHMARK_PROFILE).
// Usage: node scripts/diagnostics/analyze-cpu-profile.mjs <file> [fromMs] [lengthMs]
// Prints self time by function, inclusive time of app (/src/) functions, and
// the hottest leaf stacks with the app frames above them. Native DOM getters
// such as "get offsetParent" or "getBoundingClientRect" with large self time
// are forced layouts; the app frame above them is the code that forced it.
import { readFileSync } from "node:fs";

const [file, fromArg = "0", lengthArg = "2500"] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node scripts/diagnostics/analyze-cpu-profile.mjs <file> [fromMs] [lengthMs]");
  process.exit(1);
}
const profile = JSON.parse(readFileSync(file, "utf8"));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

// Module paths only: app files as /src/..., dependencies by file name.
const label = (cf) => {
  const source =
    /\/src\/[^?#]+/.exec(cf.url)?.[0] ??
    /\/deps\/([^?#]+)/.exec(cf.url)?.[1] ??
    (cf.url ? "other" : "native");
  return `${cf.functionName || "(anonymous)"} ${source}:${cf.lineNumber + 1}`;
};
const add = (map, key, ms) => map.set(key, (map.get(key) ?? 0) + ms);

const from = Number(fromArg);
const to = from + Number(lengthArg);
const self = new Map();
const app = new Map();
const stacks = new Map();
let elapsed = 0;
let sampled = 0;
profile.samples.forEach((id, i) => {
  elapsed += profile.timeDeltas[i] / 1000;
  if (elapsed < from || elapsed > to) return;
  const ms = (profile.timeDeltas[i + 1] ?? 0) / 1000;
  sampled += ms;
  const leaf = label(byId.get(id).callFrame);
  add(self, leaf, ms);
  const chain = [];
  const seen = new Set();
  for (let cur = id; cur != null; cur = parent.get(cur)) {
    const cf = byId.get(cur).callFrame;
    if (!/\/src\//.test(cf.url)) continue;
    const key = label(cf);
    if (!seen.has(key)) {
      seen.add(key);
      add(app, key, ms);
    }
    if (chain.length < 4) chain.push(key);
  }
  add(stacks, `${leaf}  <=  ${chain.join("  <  ") || "(no app frame)"}`, ms);
});

const top = (map, n) =>
  [...map]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, ms]) => `${ms.toFixed(0).padStart(6)} ms  ${key}`)
    .join("\n");
console.log(`Window ${from}-${to} ms of the profile, ${sampled.toFixed(0)} ms sampled.`);
console.log(`\nSelf time:\n${top(self, 15)}`);
console.log(`\nApp functions (inclusive):\n${top(app, 20)}`);
console.log(`\nHottest leaf stacks:\n${top(stacks, 15)}`);
