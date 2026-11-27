#!/usr/bin/env node
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  bigimgs,
  clear,
  counts,
  contextIdentity,
  evalInPage,
  layers,
  navigate,
  pages,
  performanceSummary,
  rss,
  snapshot,
  state,
  VIEWS,
  watch,
} from "./harbor-diag.mjs";

const object = (properties = {}, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const none = object();
const TOOLS = [
  {
    name: "harbor_pages",
    description:
      "List Harbor targets without titles, URLs, or target identifiers. Requires exactly one Harbor target for other page commands.",
    inputSchema: none,
  },
  {
    name: "harbor_identity",
    description:
      "Select the single context-review main WebView using a run nonce; page identity alone does not prove process ownership.",
    inputSchema: object({ nonce: { type: "string", minLength: 1, maxLength: 128 } }, ["nonce"]),
  },
  {
    name: "harbor_state",
    description:
      "Read the redacted Harbor diagnostics API v1 snapshot. No arbitrary page evaluation.",
    inputSchema: none,
  },
  {
    name: "harbor_clear",
    description:
      "Clear the app diagnostics event buffer and counters, without changing app settings or user data.",
    inputSchema: none,
  },
  {
    name: "harbor_navigate",
    description:
      "Request navigation to an allowlisted Harbor view using the app API. Does not accept URLs or content identifiers; read state after navigation settles.",
    inputSchema: object({ view: { type: "string", enum: VIEWS } }, ["view"]),
  },
  {
    name: "harbor_perf",
    description:
      "Aggregate browser timing/heap metrics plus projected API v1 app events and metric summaries when available; no resource URLs or content names.",
    inputSchema: none,
  },
  {
    name: "harbor_counts",
    description:
      "DOM, image, video, canvas, and optional JS heap totals; decoded image memory is an estimate.",
    inputSchema: none,
  },
  {
    name: "harbor_layers",
    description:
      "Per-layer active/parked state, visibility, DOM/image counts and estimated memory, without content text.",
    inputSchema: none,
  },
  {
    name: "harbor_bigimgs",
    description:
      "Top 25 loaded images by estimated decoded size and dimensions, without image URLs.",
    inputSchema: none,
  },
  {
    name: "harbor_rss",
    description:
      "Best-effort native Harbor process memory on Windows, macOS, and Linux. Shared WebKit services may be excluded.",
    inputSchema: none,
  },
  {
    name: "harbor_watch",
    description: "Bounded samples of memory/DOM/image totals and deltas (up to 120 seconds).",
    inputSchema: object({
      seconds: { type: "number", minimum: 1, maximum: 120 },
      interval: { type: "number", minimum: 1, maximum: 30 },
    }),
  },
  {
    name: "harbor_eval",
    description:
      "UNSAFE: arbitrary JavaScript in the Harbor page. Can expose credentials/private data and mutate the app. Explicit HARBOR_DIAG_UNSAFE=1 required.",
    inputSchema: object({ expression: { type: "string", minLength: 1, maxLength: 65536 } }, [
      "expression",
    ]),
    unsafe: true,
  },
  {
    name: "harbor_snapshot",
    description:
      "UNSAFE: collect garbage and write a sensitive V8 heap snapshot to .diag. Can contain credentials and private data. Explicit HARBOR_DIAG_UNSAFE=1 required.",
    inputSchema: none,
    unsafe: true,
  },
];

export function availableTools() {
  return TOOLS.filter((tool) => !tool.unsafe || process.env.HARBOR_DIAG_UNSAFE === "1").map(
    ({ unsafe: _unsafe, ...tool }) => tool,
  );
}

export async function runTool(name, args = {}) {
  const tool = availableTools().find((candidate) => candidate.name === name);
  if (!tool)
    throw new Error("Unknown or disabled diagnostics tool; list tools for available commands");
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Tool arguments must be an object");
  const { properties, required } = tool.inputSchema;
  if (Object.keys(args).some((key) => !Object.hasOwn(properties, key)))
    throw new Error("Unexpected tool argument");
  for (const key of required)
    if (!Object.hasOwn(args, key)) throw new Error(`Missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const schema = properties[key];
    if (typeof value !== schema.type) throw new Error(`Invalid type for ${key}`);
    if (schema.enum && !schema.enum.includes(value))
      throw new Error(`Invalid ${key}; use a view from the tool schema`);
    if (
      schema.type === "number" &&
      (!Number.isFinite(value) || value < schema.minimum || value > schema.maximum)
    )
      throw new Error(`Invalid range for ${key}`);
    if (
      schema.type === "string" &&
      ((schema.minLength && value.length < schema.minLength) ||
        (schema.maxLength && value.length > schema.maxLength))
    )
      throw new Error(`Invalid length for ${key}`);
  }
  switch (name) {
    case "harbor_pages":
      return pages();
    case "harbor_identity":
      return contextIdentity(args.nonce);
    case "harbor_state":
      return state();
    case "harbor_clear":
      return clear();
    case "harbor_navigate":
      return navigate(args.view);
    case "harbor_perf":
      return performanceSummary();
    case "harbor_eval":
      return evalInPage(args.expression);
    case "harbor_counts":
      return counts();
    case "harbor_layers":
      return layers();
    case "harbor_bigimgs":
      return bigimgs();
    case "harbor_rss":
      return rss();
    case "harbor_watch":
      return watch(args.seconds ?? 30, args.interval ?? 5);
    case "harbor_snapshot":
      return snapshot();
    default:
      throw new Error("Unknown diagnostics tool");
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

export function serve() {
  let active = 0;
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    if (line.length > 1024 * 1024) {
      replyError(null, -32600, "Request exceeds 1 MiB");
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      replyError(null, -32700, "Parse error");
      return;
    }
    if (
      !message ||
      Array.isArray(message) ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string" ||
      (Object.hasOwn(message, "id") &&
        typeof message.id !== "string" &&
        typeof message.id !== "number")
    ) {
      replyError(null, -32600, "Invalid request");
      return;
    }
    const { id, method, params } = message;
    // MCP initialization/cancellation notifications do not receive JSON-RPC replies.
    if (id === undefined) return;
    if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) {
      replyError(id, -32602, "Invalid params");
      return;
    }
    if (active >= 4) {
      replyError(
        id,
        -32000,
        "Too many active requests; wait for a diagnostics request to complete",
      );
      return;
    }
    active++;
    try {
      if (method === "initialize") {
        const versions = ["2024-11-05", "2025-03-26", "2025-06-18"];
        reply(id, {
          protocolVersion: versions.includes(params?.protocolVersion)
            ? params.protocolVersion
            : versions[0],
          capabilities: { tools: {} },
          serverInfo: { name: "harbor-diag", version: "2.0.0" },
        });
      } else if (method === "tools/list") {
        reply(id, { tools: availableTools() });
      } else if (method === "tools/call") {
        if (typeof params?.name !== "string") {
          replyError(id, -32602, "Tool name is required");
          return;
        }
        const data = await runTool(
          params.name,
          params.arguments === undefined ? {} : params.arguments,
        );
        reply(id, { content: [{ type: "text", text: JSON.stringify(data ?? null, null, 2) }] });
      } else if (method === "ping") {
        reply(id, {});
      } else {
        replyError(id, -32601, "Method not found");
      }
    } catch (error) {
      if (method === "tools/call")
        reply(id, {
          content: [{ type: "text", text: String(error?.message ?? "Diagnostics failed") }],
          isError: true,
        });
      else replyError(id, -32603, "Internal error");
    } finally {
      active--;
    }
  });
  return rl;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve();
