# Agent debugging

## Isolated native suite status

`pnpm diag:build` preserves the prior debug artifact, checks staged resources,
then builds and stages a hash-identified review artifact. `pnpm diag:self-test`
does not build or install: it checks the stage and launches the same executable
three times by default. It records navigation and available session/export smoke
results in a unique `.diag/runs/.../report.json`. Fixture-dependent cases remain
`not-run`. It does not clear caches, so the first iteration is not a cold-cache
test and later iterations do not prove cache hits.

The required native and frontend integration, safe staging and process ownership
gates are specified in [diagnostics-runner-api.md](diagnostics-runner-api.md).
The CDP identity probe uses a fixed expression and selects a unique main role
with the supplied nonce, keeping the selected socket open. This is not proof of
PID or listener ownership; the native runner separately checks those properties.
The older commands below are
legacy single-page development inspection, not an isolated native suite.

Harbor's dependency-free CLI and MCP server use a local Chrome DevTools Protocol
(CDP) endpoint for frontend inspection. They require Node.js 22 or newer. Safe
commands return aggregate metrics and a projected diagnostics snapshot; they do
not return page titles, URLs, image sources, DOM text, or arbitrary app objects.

## Start a supported target

- Windows native WebView2: run `scripts/dev-diag.ps1`. This sets
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` before
  starting Harbor. Close older Harbor instances first.
- Chromium frontend preview on Windows/macOS/Linux: start the normal Vite dev
  server, then open `http://localhost:1420` in a dedicated Chromium profile
  launched with `--remote-debugging-port=9333`. Use a temporary profile and keep
  exactly one Harbor tab open. This exercises the frontend; native Tauri/mpv
  integrations will not behave like the desktop app.
- Native macOS WKWebView and Linux WebKitGTK **do not expose CDP**. These scripts
  cannot attach to them. Use platform web inspectors for manual native debugging,
  Chromium preview for these automated frontend tools, and `rss` for native
  process memory. Do not set WebView2 flags expecting them to enable WKWebView.

For the Windows native workflow, from a PowerShell terminal at the repository
root:

```powershell
# Close existing Harbor windows so a fresh WebView2 receives the flags.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev-diag.ps1
# In a second terminal, once the app is open:
node scripts/harbor-diag.mjs pages
node scripts/harbor-diag.mjs navigate calendar
node scripts/harbor-diag.mjs state
node scripts/harbor-diag.mjs perf
node scripts/harbor-diag.mjs watch 30 5
```

The wrapper launches `pnpm tauri dev`; it is Windows-only and not needed for the
MCP process itself. The MCP process must inherit the same `HARBOR_CDP_PORT` if you
change ports. To use another port manually, set
`$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9444"` before
`pnpm tauri dev`, and `$env:HARBOR_CDP_PORT="9444"` in the diagnostics terminal.
`pages` returning no targets usually means an existing WebView2 process did not
receive the startup flags, or the app is not open yet. Reconnect by rerunning a
CLI command; each command establishes and closes its own connection.

Keep the endpoint on loopback. A debugging port gives other local processes
control of the page even when these tools' unsafe commands are disabled. Use
only trusted local agents. Do not expose the port over the network.

The scripts only select page targets at `tauri://localhost`,
`http(s)://tauri.localhost`, or `http://localhost:1420` (including loopback IP
variants). Origin checks are exact, not substring matches. These are Harbor's
configured origins, not proof of application identity: run a dedicated diagnostics
browser, with Harbor serving that port. There is no fallback to another page.
Multiple Harbor targets produce an actionable error instead of guessing.
Advertised WebSocket endpoints must use the configured local CDP port.

`HARBOR_CDP_PORT` defaults to `9333` and must be an integer from 1 to 65535.
`HARBOR_CDP_TIMEOUT_MS` defaults to `5000` and accepts 100–30000. Discovery,
WebSocket connection, and each CDP request have deadlines; connection close
rejects every pending request. Increase the deadline for slow heap snapshots.

## CLI

Run from the repository root:

```sh
node scripts/harbor-diag.mjs pages
node scripts/harbor-diag.mjs state
node scripts/harbor-diag.mjs navigate calendar
node scripts/harbor-diag.mjs perf
node scripts/harbor-diag.mjs counts
node scripts/harbor-diag.mjs layers
node scripts/harbor-diag.mjs bigimgs
node scripts/harbor-diag.mjs rss
node scripts/harbor-diag.mjs watch 30 5
node scripts/harbor-diag.mjs clear
```

`pages` reports a countable list of Harbor targets without titles, URLs, or
identifiers. `state` reads the app's diagnostics API. `clear` clears only app
instrumentation, not library, settings, credentials, browser timings, or user
data. `navigate` calls the app navigation API and returns acceptance; it does
not wait for network requests, rendering, or playback to settle. Read `state`
afterwards to observe the actual view and loading counters.

`perf` reads aggregate browser navigation/paint/resource timing, optional
Chromium heap metrics, and the projected app diagnostics snapshot when API v1 is
available. Without the API, it reports that app diagnostics are unsupported
while still returning browser timings. Resource timing is limited by the
browser's timing buffer and cross-origin restrictions; it is not a complete network trace.
It does not install observers or claim to measure React commits, FPS, native
mpv frames, or long tasks retroactively. App-specific timings belong in `state`.
The numeric DOM/image/layer commands work without the frontend debug API.
Decoded image and canvas MB are estimates, not GPU allocation measurements.
`bigimgs` reports only dimensions and estimated memory, never source URLs.

`watch` accepts finite seconds from 1–120 and interval from 1–30, with interval
no greater than seconds. It samples immediately, then at each whole interval
within the requested horizon (the final partial interval is omitted). Reported
`t` is the actual elapsed sample-start time. No new sample starts after the
horizon (apart from 10 ms timer tolerance), so slow collection may return fewer
samples. An in-progress collection may finish after it; each CDP phase and OS
query still has its own timeout. Errors are visible per sample, and missing values do not contribute
to deltas. It never silently clamps invalid inputs.

`rss` works without CDP. Windows uses PowerShell to group Harbor.exe and
Harbor-associated WebView2 processes by role. macOS/Linux use `ps` for the Harbor
executable and its descendants; shared/reparented WebKit services and a separately
launched Chromium preview are excluded. RSS can double-count shared pages and is
not private allocation. No native process found yields an empty process list,
not proof of zero memory use. Process commands and paths are not returned.

Package scripts:

```json
{
  "diag": "node scripts/harbor-diag.mjs",
  "diag:mcp": "node scripts/harbor-diag-mcp.mjs",
  "test:diag": "node --test scripts/diagnostics/diagnostics.test.mjs"
}
```

Then use `pnpm diag navigate calendar`, `pnpm diag state`, and `pnpm test:diag`.
The tooling tests live under `scripts/diagnostics`; run `pnpm test:diag` alongside
the main app test suite.

## MCP setup

Configure a stdio server using absolute paths. Replace the example paths:

```json
{
  "mcpServers": {
    "harbor": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/Harbor/scripts/harbor-diag-mcp.mjs"],
      "env": { "HARBOR_CDP_PORT": "9333", "HARBOR_CDP_TIMEOUT_MS": "5000" }
    }
  }
}
```

The server speaks newline-delimited JSON-RPC on stdio and writes only protocol
responses to stdout. It supports initialize, initialized notifications, ping,
tools/list, and tools/call. Tool errors set `isError`; malformed JSON and invalid
requests use JSON-RPC errors. Input schemas reject unknown properties and invalid
argument types/ranges. At most four requests run concurrently. Cancellation
notifications receive no response; running operations finish within their bounds
rather than implementing cooperative cancellation.

Safe tools: `harbor_pages`, `harbor_state`, `harbor_clear`, `harbor_navigate`,
`harbor_perf`, `harbor_counts`, `harbor_layers`, `harbor_bigimgs`, `harbor_rss`,
and `harbor_watch`. Start with state/perf/counts, navigate with an allowlisted
view, then compare state/perf or a short watch. No selector clicking, arbitrary
URL navigation, or content search is exposed.

## Frontend integration contract

The frontend installs this API via `main.tsx`, implemented in
`src/lib/perf/diagnostics.ts`. `ViewProvider` registers navigation. The shared contract is:

```ts
interface HarborDebug {
  version: 1;
  snapshot(): object;
  clear(): void;
  navigate(view: string): { requested: string };
  views: readonly string[];
}
```

The tooling also accepts promise-returning methods. Absent API/version/method
produces an actionable unsupported error. The frontend must revalidate navigation and use
its existing view actions; tooling never uses `location`, DOM clicks, or a
second router. A successful navigate call means accepted, not settled.
Navigation uses the exact `View` union in `src/lib/view.tsx`:

```text
home settings anime discover catalogs plugins addons calendar movies shows
music games kids library collections-hub live sports vod downloads wrapped
manga ebook people
```

The current snapshot schema is:

```json
{
  "version": 1,
  "startedAt": 1700000000000,
  "capturedAt": 1700000001200,
  "activeView": "calendar",
  "retention": { "capacity": 2000, "overwritten": 0, "events": 1 },
  "metrics": [
    {
      "name": "calendar.load",
      "count": 1,
      "errors": 0,
      "totalMs": 24,
      "maxMs": 24,
      "p50Ms": 24,
      "p95Ms": 24,
      "samples": 1
    }
  ],
  "events": [
    {
      "sequence": 1,
      "at": 1700000001200,
      "name": "calendar.load",
      "fields": { "elapsedMs": 24, "error": false, "cancelled": false, "items": 42 }
    }
  ]
}
```

`recordDiagnostic` and `measureDiagnostic` create numeric/boolean fields and
fixed event names. The native app retains up to 2000 events and 128 metric names;
the CLI/MCP response keeps only the latest 200 events. `retention.events` reports
the source ring count, which can exceed the returned event count. Metrics retain
count/errors/total/max and recent p50/p95, even when individual events roll out.
`activeView` can be null before navigation mounts. Navigation timings measure a
shell paint after two animation frames, not provider data or image readiness.
`clear()` resets the app ring and metric aggregates.

The frontend must exclude titles, identifiers, content names, user-entered
searches, error messages/stacks, tokens, URLs, request headers, and user data
before exposing the API. Prefer numeric counters and fixed enums. Keep the
event ring bounded and reset it with `clear()`.

The transport applies an additional fixed key projection (`SAFE_KEYS` in
`scripts/harbor-diag.mjs`), eight levels of nesting, 200 entries per array, and
finite-number checks. Free-text strings are dropped. Only fixed enums under
`activeView`, `view`, `topKind`, `stackKinds`, `kind`, `type`, `state`, or `status`
survive. `name` supports a separate fixed event allowlist: current calendar,
navigation, bridge, resource, image, runtime, long-task, and event-loop-stall
names. Numeric/boolean `fields` use reviewed keys, including `elapsedMs`, `error`,
`cancelled`, `items`, `hit`, `candidates`, `series`, `movies`, `bytes`, and `cached`.
Unknown fields are omitted, not passed through; coordinate additions to snapshot
field names, event names, and fixed enums with this projection. No event message
strings or arbitrary histogram keys survive. This deliberately limits future API additions
until they have been reviewed for safe output.

## Sensitive commands

Existing arbitrary `eval` and V8 heap `snapshot` are retained behind the exact
opt-in `HARBOR_DIAG_UNSAFE=1`. Without it, they fail before connecting and the MCP
server omits them from tools/list. Restart the MCP server after changing its env.

```sh
HARBOR_DIAG_UNSAFE=1 node scripts/harbor-diag.mjs eval 'document.title'
HARBOR_DIAG_UNSAFE=1 node scripts/harbor-diag.mjs snapshot
```

These commands can expose credentials, page titles, image/stream URLs, private
library data, and application state. Arbitrary eval can mutate app state and
perform authenticated operations. Heap snapshots force garbage collection,
may stall the app, and write raw sensitive data to `.diag/heap-*.heapsnapshot`.
Do not attach these outputs to issues or share them with an agent without review.
Do not commit heap files. Delete them after use. An interrupted snapshot may
leave a partial file; inspect local `.diag` storage before sharing or archiving.

## Tooling checks

```sh
node --test scripts/diagnostics/diagnostics.test.mjs
pnpm run check scripts/harbor-diag.mjs scripts/harbor-diag-mcp.mjs scripts/diagnostics docs/agent-debugging.md
```

Tests use a local mock discovery server and an event-driven mock CDP socket to
verify timeouts, synchronous responses, close cleanup, origin/socket validation,
API integration/redaction, navigation union parity, unsafe gating, the actual v1
snapshot/metrics shape, and MCP subprocess stdio framing/error responses. They do not prove native renderer,
playback, or OS RSS correctness; verify those on the affected platform.

Repository note: `*.md` is globally ignored here. When integrating this new
document, explicitly use `git add -f docs/agent-debugging.md`.

## Accumulated player logs

Settings → Report a Bug → Export player log writes a uniquely named
`harbor-mpv-log-<uuid>.txt` into Downloads. Native logs accumulate across videos
and player recreation until a successful export. Export flushes the writer and
only clears the captured native messages after the output file is synced.
Failures retain the unexported messages; events queued during export belong to
the next export. The file also includes the current bounded app timing snapshot.

The native writer uses a bounded nonblocking queue and reports dropped-message
counts rather than making mpv wait. Timestamps, session boundaries, lifecycle
commands, buffering transitions and periodic position/cache samples help correlate
freezes and reloads without retaining stream URLs or account credentials. Native
logs remain on disk between exports. To prevent unattended logging from exhausting
disk space, a source exceeding 64 MiB retains its latest 32 MiB of complete
messages and writes a `log-rotated discarded_bytes` marker. The frontend timing ring retains its latest
2,000 events plus aggregate summaries for the current app session.

A long WebView timer gap is recorded separately from a confirmed stalled stream.
Wake recovery waits for a subsequent position sample and does not reload native
playback that continued advancing or a paused/loading/replaced source. This
guards against timer throttling being mistaken for system sleep.

## Windows playback validation

1. Run the updated Windows desktop app with the same source and playback settings
   that showed the freeze. Export once to establish a clean capture interval.
2. Watch without interacting, then play at least one more episode before exporting.
   Note the wall-clock time and media position of any freeze or unexpected reload.
3. Export player logs. Confirm the file contains both media sessions, timestamped
   session boundaries, cache/buffering events, and the runtime diagnostics appendix.
   A second export should contain only events collected after the first capture.
4. Test minimize/restore, ordinary focus changes, and suspend/resume separately.
   Playback that kept advancing while its WebView timer was throttled must not be
   replaced; a paused video must remain paused. A stalled stream after actual
   sleep should reconnect at its observed position.
5. Check `reload cause=` entries against any symptom. They distinguish a truncated
   source EOF, confirmed wake stall, audio resync, and startup recovery. Repeated
   network failures or audio underruns without a Harbor reload remain a separate
   native/source investigation; do not infer the cause from a restart event alone.
6. Exercise the normal Windows export button and its Downloads result. Verify
   repeated exports succeed, old files remain intact, and no earlier messages
   reappear after acknowledgement. Preserve a failed-export interval for retry.

The macOS cargo check and controlled hook tests do not establish Windows WASAPI,
D3D, WebView2 scheduling, or native file-handle behavior. These checks remain
necessary before calling the original unattended Windows symptom resolved.
