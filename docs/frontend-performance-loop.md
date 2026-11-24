# Frontend performance regression loop

This loop exercises the existing frontend cache, calendar, navigation, and
thumbnail seams without compiling Rust, launching Harbor, touching an install,
or opening a production profile. It is deterministic and reports a single JSON
summary on stdout; failures return exit code `1` and include the failing suite's
last 8,000 output characters on stderr.

From `Harbor-windows-debug`:

```powershell
pnpm run test:performance
```

The command uses `scripts/node-test-environment.mjs` and
`scripts/node-test-loader.mjs`, so TypeScript tests run through the same loader
as the repository's `pnpm test` command. It runs four explicit groups:

- cache restart, invalidation, and prefetch tests;
- calendar cache, source scope, hook, library, and performance tests;
- diagnostic navigation and 500-request rapid-switch coverage;
- thumbnail coalescing, priority, cancellation, and queue bounds.

The JSON contains `schemaVersion`, overall `status`, numeric `durationMs`, and
per-suite `status`, `exitCode`, `durationMs`, `tests`, `passed`, `failed`, and
`skipped` fields. Test diagnostics remain numeric/boolean at the application
seam; no titles, URLs, identifiers, request data, or error messages are added
to the frontend diagnostic contract.

## Browser/Vite HMR loop

For visual or browser-fixture checks, run the existing Vite server and use a
temporary, dedicated Chromium profile:

```powershell
pnpm dev
```

Open `http://localhost:1420` in that profile. `vite.config.ts` already binds to
loopback (`127.0.0.1`), uses port `1420`, keeps HMR on the same local server,
and ignores `src-tauri` and native build trees. Edit frontend files and let Vite
HMR update the page; do not use `tsc -b` during this loop because it emits
`vite.config.js`/`vite.config.d.ts` and can restart the server. Use the required
checks when the change is ready:

```powershell
pnpm run check
pnpm run typecheck
```

The browser fixture validates frontend rendering, cache behavior, navigation,
and image scheduling only. It is not native player validation: mpv, Tauri IPC,
WebView2 storage, window lifecycle, and OS playback behavior require the
separate context-review workflow.

## Native follow-up (later, isolated)

When native validation is needed, an isolated context-review Tauri development
session performs an initial native build and then serves frontend changes via
the configured Vite HMR server:

```powershell
$env:HARBOR_DIAG_RUN_NONCE = 'local-review'
pnpm tauri dev --features context-review --config src-tauri/tauri.context-review.conf.json
```

That path uses the fixed `app.harbor.context-review` identity and
`src-tauri/tauri.context-review.conf.json`; `src-tauri/src/context_review.rs`
attests app/cache/log directories and the WebView data directory are scoped
below that identity, rejects reparse points and traversal, and uses the nonce.
Use this command only in a dedicated shell; close the review app when finished.
Keep its storage isolated from the production Harbor install. Separately,
`pnpm diag:build` stages a review artifact and `pnpm diag:self-test` launches
that staged artifact; neither is part of the HMR loop. Fixture-dependent
native scenarios are explicitly reported as `not-run` until their reset hooks
exist. This is a later validation step, not part of the fast HMR/test loop.

The `test:performance` alias runs `node scripts/diagnostics/test-performance.mjs`.
Test files and suite groups run sequentially to limit local CPU use.
Worker agents defer Node validation until the coordinating final verification.
