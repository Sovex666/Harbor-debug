// Every export is serialized into the benchmark page with Function#toString, so
// each function must be self-contained. Only counts, durations, booleans and
// one-way hashes leave the page; never titles, URLs or storage values.

export function activeLayer() {
  return (
    [...document.querySelectorAll(".harbor-layer-active")].find(
      (el) => !el.closest("[data-layer-inactive]") && el.childElementCount > 0,
    ) ?? null
  );
}

export function activateView(view) {
  const navId = view === "collections-hub" ? "collections" : view;
  const el = [...document.querySelectorAll("[data-harbor-nav]")].find(
    (e) =>
      e.dataset.harborNav === navId &&
      !e.closest("[data-layer-inactive],[inert]") &&
      e.getClientRects().length > 0 &&
      getComputedStyle(e).display !== "none" &&
      getComputedStyle(e).visibility !== "hidden",
  );
  const control = el?.matches("button,[role=button]")
    ? el
    : el?.querySelector("button,[role=button]");
  if (!control || control.disabled || control.getAttribute("aria-disabled") === "true") return null;
  control.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const bench = window.__harborBench;
  // The previous view's layer must be replaced; otherwise its artwork could
  // be attributed to the destination.
  bench.previousLayer =
    [...document.querySelectorAll(".harbor-layer-active")].find(
      (e) => !e.closest("[data-layer-inactive]") && e.childElementCount > 0,
    ) ?? null;
  bench.coverage = null;
  window.__HARBOR_DEBUG__?.clear();
  if (bench.frames) bench.frames.clickAt = null;
  const at = performance.now();
  control.click();
  return at;
}

// Center of a nav control for real pointer input (hover intent, then click).
export function navControlPoint(view) {
  const navId = view === "collections-hub" ? "collections" : view;
  const el = [...document.querySelectorAll("[data-harbor-nav]")].find(
    (e) =>
      e.dataset.harborNav === navId &&
      !e.closest("[data-layer-inactive],[inert]") &&
      e.getClientRects().length > 0,
  );
  const control = el?.matches("button,[role=button]")
    ? el
    : el?.querySelector("button,[role=button]");
  if (!control || control.disabled) return null;
  control.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const r = control.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const x = r.left + r.width / 2,
    y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(hit === control || control.contains(hit))) return null;
  const bench = window.__harborBench;
  bench.previousLayer =
    [...document.querySelectorAll(".harbor-layer-active")].find(
      (e) => !e.closest("[data-layer-inactive]") && e.childElementCount > 0,
    ) ?? null;
  bench.coverage = null;
  window.__HARBOR_DEBUG__?.clear();
  return { x, y };
}

export function configuredControls() {
  return [...document.querySelectorAll("[data-harbor-nav]")]
    .filter((el) => !el.closest("[data-layer-inactive],[inert]") && el.getClientRects().length)
    .map((el) => {
      const control = el.matches("button,[role=button]")
        ? el
        : el.querySelector("button,[role=button]");
      return {
        id: el.dataset.harborNav,
        control: Boolean(control),
        disabled: Boolean(control?.disabled || control?.getAttribute("aria-disabled") === "true"),
      };
    });
}

// Settings hides the navigation chrome; leave it through its real Back control.
export function leaveSettings() {
  const back =
    document.querySelector(".harbor-layer-active [data-settings-back]") ??
    document.querySelector("[data-floating-back]");
  if (!back) return null;
  back.click();
  return performance.now();
}

// Vite can reload on the first lazy dependency discovery. Re-establish only the
// fixture shell; a reload during an actual measurement is never a valid sample.
export async function preparePage() {
  const root = document.getElementById("root");
  if (!root?.querySelector("[data-harbor-nav]")) return false;
  root.removeAttribute("data-startup-hidden");
  root.inert = false;
  document.getElementById("harbor-boot")?.remove();
  document.getElementById("harbor-boot-chrome")?.remove();
  if (!window.__HARBOR_DEBUG__) (await import("/src/lib/perf/diagnostics.ts")).installDiagnostics();
  return Boolean(window.__HARBOR_DEBUG__ && window.__HARBOR_BROWSER_PROFILE__?.libraryItems);
}

export function pageState(view) {
  const probeStart = performance.now();
  const diag = window.__HARBOR_DEBUG__?.snapshot();
  const layer =
    [...document.querySelectorAll(".harbor-layer-active")].find(
      (el) => !el.closest("[data-layer-inactive]") && el.childElementCount > 0,
    ) ?? null;
  const inViewport = (el) => {
    if (el.closest("[data-layer-inactive],[inert]")) return false;
    const r = el.getBoundingClientRect(),
      s = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.top < innerHeight &&
      r.right > 0 &&
      r.left < innerWidth &&
      s.visibility !== "hidden" &&
      s.display !== "none"
    );
  };
  // Decorative animations (the Music hero's sound glyph) keep their spinner
  // mounted at opacity 0; only a visible indicator means the view is loading.
  const transparent = (el) => {
    for (let e = el; e && e !== layer; e = e.parentElement)
      if (getComputedStyle(e).opacity === "0") return true;
    return false;
  };
  const state = window.__harborBench;
  state.decoded ??= new WeakMap();
  const idOf = (el) => {
    if (!state.images.has(el)) state.images.set(el, ++state.nextImage);
    return state.images.get(el);
  };
  const images = layer ? [...layer.querySelectorAll("img")].filter(inViewport) : [];
  const imageStates = images.map((img) => {
    if (img.complete && img.naturalWidth > 0 && !state.decoded.has(img)) {
      state.decoded.set(img, "pending");
      if (typeof img.decode === "function")
        img.decode().then(
          () => state.decoded.set(img, "done"),
          () => state.decoded.set(img, "failed"),
        );
      else state.decoded.set(img, "done");
    }
    return {
      id: idOf(img),
      loaded: img.complete && img.naturalWidth > 0 && state.decoded.get(img) === "done",
      failed:
        (img.complete && img.naturalWidth === 0 && Boolean(img.currentSrc || img.src)) ||
        state.decoded.get(img) === "failed",
      pending: !img.complete || !img.currentSrc || state.decoded.get(img) === "pending",
    };
  });
  // Posters render no <img> until a source resolves, so their wrapper state
  // is the only way to see artwork that is still waiting for a source.
  const posters = layer
    ? [...layer.querySelectorAll("[data-poster-state]")].filter(inViewport)
    : [];
  const posterStates = posters.map((p) => ({
    id: idOf(p),
    loaded: p.dataset.loaded === "1",
    unavailable: p.dataset.loaded !== "1" && p.dataset.posterState === "unavailable",
  }));
  const pendingPosters = posterStates.filter((p) => !p.loaded && !p.unavailable).length;
  const unavailablePosters = posterStates.filter((p) => p.unavailable).length;
  const busy = layer
    ? [
        ...layer.querySelectorAll(
          '[role="progressbar"],.animate-spin,.animate-pulse,.harbor-skel,[aria-label="Loading settings"]',
        ),
      ].some((el) => !el.closest(".harbor-poster") && inViewport(el) && !transparent(el))
    : true;
  const calendarRoot = layer?.querySelector("[data-calendar-complete]");
  let calendar = null;
  if (calendarRoot) {
    const days = [...calendarRoot.querySelectorAll("[data-calendar-day]")];
    const sum = (list, key) => list.reduce((n, d) => n + (Number(d.dataset[key]) || 0), 0);
    const month = days.filter((d) => d.dataset.calendarDay === "month");
    const gridPosters = days.flatMap((d) => [...d.querySelectorAll("[data-poster-state]")]);
    calendar = {
      complete: calendarRoot.dataset.calendarComplete === "true",
      error: calendarRoot.dataset.calendarError === "true",
      loading: calendarRoot.dataset.calendarLoading === "true",
      items: Number(calendarRoot.dataset.calendarItems),
      days: days.length,
      monthItems: sum(month, "calendarDayItems"),
      expectedThumbnails: sum(days, "calendarDayShown"),
      expectedMonthThumbnails: sum(month, "calendarDayShown"),
      hiddenBehindMore: sum(days, "calendarDayItems") - sum(days, "calendarDayShown"),
      renderedThumbnails: gridPosters.length,
      loadedThumbnails: gridPosters.filter((p) => p.dataset.loaded === "1").length,
      unavailableThumbnails: gridPosters.filter(
        (p) => p.dataset.loaded !== "1" && p.dataset.posterState === "unavailable",
      ).length,
    };
  }
  const navId = view === "collections-hub" ? "collections" : view;
  const markers = {
    calendar: "[data-calendar-complete]",
    library: "[data-harbor-library]",
    live: "[data-live-page]",
    ebook: "[data-ebook-page]",
    music: "[data-music-view]",
    settings: ".harbor-settings-shell",
    games: ".games-view",
  };
  const text = layer?.textContent ?? "";
  return {
    now: performance.now(),
    probeMs: performance.now() - probeStart,
    timeOrigin: performance.timeOrigin,
    visibility: document.visibilityState,
    activeView: diag?.activeView ?? null,
    diagnosticsOverwritten: diag?.retention?.overwritten ?? 0,
    layerReplaced: Boolean(layer && layer !== state.previousLayer),
    mounted: Boolean(text.trim()),
    navActive: Boolean(document.querySelector(`[data-harbor-nav="${navId}"][data-active]`)),
    viewMarker: markers[view] ? Boolean(layer?.querySelector(markers[view])) : null,
    startPage: Boolean(layer?.querySelector("[data-media-start]")),
    homeSections: ["Continue Watching", "Popular: Movies", "Popular: Series"].filter(
      (s) => text.includes(s) || text.includes(s.replace(":", "")),
    ),
    images: imageStates,
    posters: posterStates,
    pendingPosters,
    unavailablePosters,
    busy,
    calendar,
    tasks: state.longTasks,
    gaps: state.gaps,
    frames: state.frames,
    errors: state.errors,
    rejections: state.rejections,
    calendarEvents: diag?.events
      .filter((e) => e.name.startsWith("calendar."))
      .map((e) => ({ sequence: e.sequence, name: e.name, fields: e.fields })),
  };
}

// One bounded coverage step: finish the current horizontal row, then any
// unvisited rows in view, then advance the vertical scroller. The caller waits
// for artwork to settle between steps.
export function coverageStep(limits) {
  const layer = [...document.querySelectorAll(".harbor-layer-active")].find(
    (el) => !el.closest("[data-layer-inactive]") && el.childElementCount > 0,
  );
  if (!layer) return { done: true, reason: "layer-missing" };
  const bench = window.__harborBench;
  const c = (bench.coverage ??= {
    vSteps: 0,
    hSteps: 0,
    rows: new WeakSet(),
    rowsScanned: 0,
    rowsReachedEnd: 0,
    rowsBounded: 0,
    rowsSkipped: 0,
    skipped: new WeakSet(),
    row: null,
    rowSteps: 0,
    bottomHeight: null,
    reachedBottom: false,
    verticalBounded: false,
    vertical: false,
  });
  const summary = (extra) => ({
    vSteps: c.vSteps,
    hSteps: c.hSteps,
    rowsScanned: c.rowsScanned,
    rowsReachedEnd: c.rowsReachedEnd,
    rowsBounded: c.rowsBounded,
    rowsSkipped: c.rowsSkipped,
    reachedBottom: c.reachedBottom,
    verticalBounded: c.verticalBounded,
    verticalScroller: c.vertical,
    ...extra,
  });
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    return r.width > 0 && r.height > 0 && cy > 0 && cy < innerHeight && r.right > 0;
  };
  // Size checks first: computing styles for every element would add probe
  // work to the very main thread being measured.
  const scrollable = (el, axis) => {
    const sized =
      axis === "x"
        ? el.scrollWidth > el.clientWidth + 4 && el.clientHeight >= 60
        : el.scrollHeight > el.clientHeight + 4 && el.clientHeight >= 200;
    if (!sized) return false;
    const s = getComputedStyle(el);
    const overflow = axis === "x" ? s.overflowX : s.overflowY;
    return ["auto", "scroll"].includes(overflow) && s.visibility !== "hidden";
  };
  const stepRow = (row) => {
    const atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 2;
    if (atEnd || c.rowSteps >= limits.horizontalStepsPerRow) {
      if (atEnd) c.rowsReachedEnd++;
      else c.rowsBounded++;
      c.rows.add(row);
      c.row = null;
      return false;
    }
    const before = row.scrollLeft;
    row.scrollLeft = before + Math.max(120, row.clientWidth * 0.85);
    if (row.scrollLeft === before) {
      c.rowsReachedEnd++;
      c.rows.add(row);
      c.row = null;
      return false;
    }
    c.rowSteps++;
    c.hSteps++;
    return true;
  };
  if (c.row && c.row.isConnected && stepRow(c.row)) return summary({ moved: "horizontal" });
  c.row = null;
  const rows = [...layer.querySelectorAll("*")].filter(
    (el) => !c.rows.has(el) && scrollable(el, "x") && inView(el),
  );
  for (const row of rows) {
    if (c.rowsScanned >= limits.rows) {
      if (!c.skipped.has(row)) {
        c.skipped.add(row);
        c.rowsSkipped++;
      }
      continue;
    }
    c.rowsScanned++;
    c.row = row;
    c.rowSteps = 0;
    if (stepRow(row)) return summary({ moved: "horizontal" });
  }
  const hosts = [...layer.querySelectorAll("*")].filter((el) => scrollable(el, "y"));
  const host =
    hosts.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ??
    (document.scrollingElement.scrollHeight > innerHeight + 4 ? document.scrollingElement : null);
  if (!host) return summary({ done: true, reason: "no-vertical-scroll" });
  c.vertical = true;
  if (host.scrollTop + host.clientHeight >= host.scrollHeight - 2) {
    // An infinite feed may append after the bottom settles; only a bottom
    // whose height did not grow since the previous step is final.
    if (c.bottomHeight === host.scrollHeight) {
      c.reachedBottom = true;
      return summary({ done: true, reason: "bottom" });
    }
    c.bottomHeight = host.scrollHeight;
    return summary({ moved: "wait-bottom" });
  }
  if (c.vSteps >= limits.verticalSteps) {
    c.verticalBounded = true;
    return summary({ done: true, reason: "vertical-limit" });
  }
  host.scrollTop += Math.max(100, host.clientHeight * 0.8);
  c.vSteps++;
  return summary({ moved: "vertical" });
}

// Kept-alive views restore their scroll position, so each visit leaves the
// view at its origin for the next comparable sample.
export function resetScroll() {
  const layer = [...document.querySelectorAll(".harbor-layer-active")].find(
    (el) => !el.closest("[data-layer-inactive]") && el.childElementCount > 0,
  );
  if (!layer) return false;
  for (const el of layer.querySelectorAll("*")) {
    if (el.scrollTop) el.scrollTop = 0;
    if (el.scrollLeft) el.scrollLeft = 0;
  }
  document.scrollingElement.scrollTop = 0;
  return true;
}

// Content identity without exporting content: headings and image sources are
// reduced to short one-way hashes so restarted runs can be compared.
export async function contentEvidence() {
  const layer = [...document.querySelectorAll(".harbor-layer-active")].find(
    (el) => !el.closest("[data-layer-inactive]") && el.childElementCount > 0,
  );
  if (!layer) return null;
  const hash = async (value) => {
    const bytes = new TextEncoder().encode(value);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return digest
      .slice(0, 6)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };
  const headings = [...layer.querySelectorAll("h1,h2,h3,[role=heading]")]
    .map((h) => h.textContent.trim())
    .filter(Boolean)
    .sort();
  const sources = [
    ...new Set(
      [...layer.querySelectorAll("img")]
        .map((img) => img.currentSrc || img.getAttribute("src") || "")
        .filter((src) => src && !src.startsWith("data:")),
    ),
  ];
  return {
    headingCount: headings.length,
    headingHash: await hash(headings.join("\n")),
    posterCount: layer.querySelectorAll("[data-poster-state]").length,
    imageSourceHashes: await Promise.all(sources.map(hash)),
  };
}

// Storage evidence as counts only. Only databases that already exist are
// opened, so the probe cannot create or upgrade one.
export async function cacheEvidence() {
  const result = {
    localStorageEntries: localStorage.length,
    browseCacheSalt: localStorage.getItem("harbor.browse-cache.salt.v1") !== null,
    cacheStorageEntries: (await caches.keys()).length,
    databases: {},
    mediaCacheNamespaces: {},
  };
  const known = await indexedDB.databases();
  for (const { name } of known) {
    if (!name?.startsWith("harbor-")) continue;
    const db = await new Promise((resolve) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onupgradeneeded = () => {
        request.transaction.abort();
        resolve(null);
      };
    });
    if (!db) continue;
    try {
      const stores = {};
      for (const store of db.objectStoreNames) {
        stores[store] = await new Promise((resolve) => {
          const r = db.transaction(store, "readonly").objectStore(store).count();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve(null);
        });
      }
      result.databases[name] = stores;
      if (name === "harbor-media-cache" && db.objectStoreNames.contains("index")) {
        const keys = await new Promise((resolve) => {
          const r = db.transaction("index", "readonly").objectStore("index").getAllKeys();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve([]);
        });
        for (const key of keys) {
          // Some namespaces embed an account-scoped hash; keep only the family.
          const namespace = (String(key).split(":")[1] ?? "unknown").replace(
            /-[0-9a-f]{6,}.*$/i,
            "-*",
          );
          result.mediaCacheNamespaces[namespace] =
            (result.mediaCacheNamespaces[namespace] ?? 0) + 1;
        }
      }
    } finally {
      db.close();
    }
  }
  return result;
}

// Why visible artwork is unresolved. Image URLs go back to the runner only to
// be matched with its network log; the runner never writes them out.
export function artworkDiagnosis(limit = 60) {
  const layer =
    [...document.querySelectorAll(".harbor-layer-active")].find(
      (el) => !el.closest("[data-layer-inactive]") && el.childElementCount > 0,
    ) ?? null;
  if (!layer) return [];
  const inViewport = (el) => {
    if (el.closest("[data-layer-inactive],[inert]")) return false;
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.top < innerHeight &&
      r.right > 0 &&
      r.left < innerWidth
    );
  };
  const imageOf = (img) => ({
    src: img.currentSrc || img.src || "",
    complete: img.complete,
    naturalWidth: img.naturalWidth,
  });
  const items = [];
  for (const p of layer.querySelectorAll("[data-poster-state]")) {
    if (p.dataset.loaded === "1" || p.dataset.posterState === "unavailable" || !inViewport(p))
      continue;
    const img = p.querySelector("img.harbor-poster-img");
    items.push({
      kind: "poster",
      wait: p.dataset.posterWait ?? null,
      fallback: Number(p.dataset.posterFallback) || 0,
      ...(img ? imageOf(img) : { src: null }),
    });
  }
  for (const img of layer.querySelectorAll("img")) {
    if (img.closest(".harbor-poster") || !inViewport(img)) continue;
    if (img.complete && img.naturalWidth > 0) continue;
    items.push({ kind: "image", wait: null, fallback: 0, ...imageOf(img) });
  }
  return items.slice(0, limit);
}

// Which loading indicators keep a view busy: the indicator kind and the class
// names of its container (component code, not content).
export function busyDiagnosis() {
  const layer =
    [...document.querySelectorAll(".harbor-layer-active")].find(
      (el) => !el.closest("[data-layer-inactive]") && el.childElementCount > 0,
    ) ?? null;
  if (!layer) return [];
  const kinds = {
    '[role="progressbar"]': "progressbar",
    ".animate-spin": "spinner",
    ".animate-pulse": "pulse skeleton",
    ".harbor-skel": "skeleton",
    '[aria-label="Loading settings"]': "settings loader",
  };
  const groups = new Map();
  for (const [selector, kind] of Object.entries(kinds))
    for (const el of layer.querySelectorAll(selector)) {
      if (el.closest(".harbor-poster")) continue;
      let hidden = false;
      for (let e = el; e && e !== layer; e = e.parentElement)
        if (getComputedStyle(e).opacity === "0") hidden = true;
      if (hidden) continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight)) continue;
      const container = [...(el.parentElement?.classList ?? [])]
        .filter((c) => /^[a-z][\w-]*$/i.test(c))
        .slice(0, 4)
        .join(".");
      const key = `${kind} in .${container || "?"}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
  return [...groups].map(([indicator, count]) => ({ indicator, count }));
}
