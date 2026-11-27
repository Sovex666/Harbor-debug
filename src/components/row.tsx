import {
  Children,
  createContext,
  isValidElement,
  memo,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { observeResize, observeWithin } from "@/lib/visibility";
import { isScrollActive } from "@/lib/scroll-activity";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ThreeLiquidGlassSurface } from "@/components/ThreeLiquidGlassSurface";
import { NavChevron } from "./nav-arrow";
import { useT, useUiLanguage, isRtl as checkRtl } from "@/lib/i18n";
import { useSettings } from "@/lib/settings";
import { useViewActions } from "@/lib/view";
import { resetPosterDock as resetPosterDockItems, updatePosterDock } from "@/lib/poster-dock";
import { scrollDeltaToRevealCard } from "@/lib/poster-backdrop-expansion";
import { RowCardExpansionProvider } from "@/components/row-card-expansion";

const GAP = 20;

function columnSpan(value?: string): number {
  const span = value?.match(/span\s+(\d+)/)?.[1];
  return span ? Math.max(1, Number(span)) : 1;
}
const NEAR_MARGIN = "300px";
const PAGE_MARGIN = "800px 0px";
const FAR_RELEASE_MS = 15000;
const RESIZE_SETTLE_MS = 150;
// Mounts and artwork updates compete for the same scroll frame. At rest the queue
// can fill more cards at once.
const CARD_UPDATES_DURING_SCROLL = 1;
const CARD_UPDATES_AT_REST = 6;
const pendingCardUpdates = new Map<() => void, RefObject<boolean> | undefined>();
let cardUpdateFrame: number | undefined;

// Cards of rows on screen go first, then updates that name no row, then cards that are only prepared.
function nextCardUpdate(prepare: boolean): (() => void) | undefined {
  let other: (() => void) | undefined;
  for (const [update, rowOnScreen] of pendingCardUpdates) {
    if (rowOnScreen?.current) return update;
    if (!rowOnScreen) other ??= update;
  }
  return other ?? (prepare ? pendingCardUpdates.keys().next().value : undefined);
}

function updateQueuedCards() {
  cardUpdateFrame = undefined;
  const perFrame = isScrollActive() ? CARD_UPDATES_DURING_SCROLL : CARD_UPDATES_AT_REST;
  startTransition(() => {
    for (let i = 0; i < perFrame; i++) {
      // A prepared card gets a frame of its own, so that it holds up nothing the user looks at.
      const update = nextCardUpdate(i === 0);
      if (!update) break;
      pendingCardUpdates.delete(update);
      update();
    }
  });
  if (pendingCardUpdates.size) cardUpdateFrame ??= requestAnimationFrame(updateQueuedCards);
}

export function queueRowCardUpdate(
  update: () => void,
  rowOnScreen?: RefObject<boolean>,
): () => void {
  pendingCardUpdates.set(update, rowOnScreen);
  cardUpdateFrame ??= requestAnimationFrame(updateQueuedCards);
  return () => {
    pendingCardUpdates.delete(update);
    if (pendingCardUpdates.size || cardUpdateFrame === undefined) return;
    cancelAnimationFrame(cardUpdateFrame);
    cardUpdateFrame = undefined;
  };
}

export type RowShape = "portrait" | "landscape" | "service" | "rank" | "tile" | "square" | "cta";

export const TV_CARD_MIN = 318;

function holdsPosterCards(children: React.ReactNode): boolean {
  const first = Children.toArray(children)[0];
  if (!isValidElement(first)) return false;
  const type = first.type as { isPosterCard?: boolean };
  if (!type?.isPosterCard) return false;
  return (first.props as { kids?: boolean; meta?: { type?: string } }).kids !== true;
}

export function usePosterRow(min = 144, kids = false): { min: number; shape: RowShape } {
  const { settings } = useSettings();
  return settings.rowCardStyle === "tv" && !kids
    ? { min: TV_CARD_MIN, shape: "landscape" }
    : { min, shape: "portrait" };
}

// A theme can give the track columns of its own. Without a fixed width nobody can say what it shows.
function trackColumn(track: HTMLElement | null, cellWidth: number): number | null {
  const own = track ? getComputedStyle(track).gridAutoColumns : undefined;
  if (!own || own === "auto") return cellWidth;
  return /^[\d.]+px$/.test(own) ? parseFloat(own) : null;
}

const RowTrackContext = createContext<HTMLDivElement | null>(null);
/** Width a card has in its row, for a card the row shows. Known before the row is on screen. */
export const RowCardWidthContext = createContext<number | null>(null);
export const ScrollRootContext = createContext<
  HTMLElement | React.RefObject<HTMLElement | null> | null
>(null);

export function resolveRowScrollRoot(
  root: React.ContextType<typeof ScrollRootContext>,
  element: HTMLElement,
): HTMLElement | undefined {
  const scrollRoot = root && "current" in root ? root.current : root;
  // A portal can inherit the page context while living outside its scroller.
  return scrollRoot?.contains(element) ? scrollRoot : undefined;
}

function LazyChild({
  children,
  eager,
  active,
  measured,
  column,
  columns,
  shownWidth,
  isSkipped,
  rowOnScreen,
  shape,
  span,
  expansion,
}: {
  children: ReactNode;
  eager: boolean;
  active: boolean;
  measured: boolean;
  column: number;
  columns: number;
  shownWidth: (column: number, columns: number, rendered?: boolean) => number | null;
  isSkipped: (now?: boolean) => boolean;
  rowOnScreen: RefObject<boolean>;
  shape: RowShape;
  span?: string;
  expansion?: {
    index: number;
    baseWidth: number;
    expandedWidth?: number;
    expanded: boolean;
    onExpand: (index: number, width: number) => void;
    onCollapse: (index: number) => void;
  };
}) {
  const root = useContext(RowTrackContext);
  const [visible, setVisible] = useState(eager);
  const [cardWidth, setCardWidth] = useState<number | null>(null);
  const mounted = useRef(eager);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!root || !el || eager) return;
    let releaseTimer: number | undefined;
    const cancelRelease = () => {
      if (releaseTimer !== undefined) window.clearTimeout(releaseTimer);
      releaseTimer = undefined;
    };
    const release = () => {
      if (!mounted.current || releaseTimer !== undefined) return;
      releaseTimer = window.setTimeout(() => {
        releaseTimer = undefined;
        if (el.contains(document.activeElement)) return;
        mounted.current = false;
        setVisible(false);
      }, FAR_RELEASE_MS);
    };
    // The row's observer controls the vertical range. The track's observer then only
    // mounts cells around the current horizontal offset, including restored offsets.
    if (!active) {
      release();
      return cancelRelease;
    }
    let cancelMount: (() => void) | undefined;
    let rendered = false;
    const mount = () => {
      cancelMount = undefined;
      mounted.current = true;
      // Arrow keys find the cards a row shows, not the ones it prepares.
      el.toggleAttribute("data-tv-skip", !rendered);
      setCardWidth(shownWidth(column, columns, rendered));
      setVisible(true);
    };
    const queueMount = () => {
      cancelMount?.();
      cancelMount = queueRowCardUpdate(mount, rowOnScreen);
    };
    // content-visibility skips a near row until it is on screen, and an observer in a skipped row
    // sees nothing. Waiting for it would build the cards the row shows in front of the user.
    if (measured && !mounted.current && isSkipped() && shownWidth(column, columns) !== null)
      queueMount();
    const stop = observeWithin(
      el,
      NEAR_MARGIN,
      (entry) => {
        rendered = entry.isIntersecting;
        if (!rendered) {
          if (isSkipped(true) && shownWidth(column, columns) !== null) {
            // The row is skipped. Its cards get prepared all the same, after what is queued by now.
            if (cancelMount) queueMount();
            return;
          }
          cancelMount?.();
          cancelMount = undefined;
          release();
          return;
        }
        cancelRelease();
        el.removeAttribute("data-tv-skip");
        if (!mounted.current && !cancelMount) queueMount();
      },
      root,
    );
    return () => {
      stop();
      cancelMount?.();
      cancelRelease();
    };
  }, [root, eager, active, measured, column, columns, shownWidth, isSkipped, rowOnScreen]);

  return (
    <div
      ref={ref}
      data-row-card-index={expansion?.index}
      data-poster-card-cell={expansion ? "" : undefined}
      data-tv-nav-base-width={expansion?.baseWidth}
      className={
        expansion
          ? "relative min-w-0 transition-[flex-basis] duration-[480ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
          : undefined
      }
      style={
        expansion
          ? {
              flex: "0 0 auto",
              flexBasis: `${expansion.expandedWidth ?? expansion.baseWidth}px`,
            }
          : span
            ? { gridColumn: span }
            : undefined
      }
    >
      {eager || visible ? (
        <RowCardWidthContext.Provider value={cardWidth}>
          {expansion ? (
            <RowCardExpansionProvider
              index={expansion.index}
              enabled
              expanded={expansion.expanded}
              onExpand={expansion.onExpand}
              onCollapse={expansion.onCollapse}
            >
              {children}
            </RowCardExpansionProvider>
          ) : (
            children
          )}
        </RowCardWidthContext.Provider>
      ) : (
        <RowSkeletonCard shape={shape} />
      )}
    </div>
  );
}

let pendingWrites: Array<() => void> = [];

function batchWrite(fn: () => void): void {
  pendingWrites.push(fn);
  if (pendingWrites.length > 1) return;
  queueMicrotask(() => {
    const fns = pendingWrites;
    pendingWrites = [];
    // No flushSync here. This runs from every row's ResizeObserver rAF, and forcing a synchronous
    // commit there turned a no-op measurement into a full render pass per row — the layout storm
    // the long-frame profiler kept attributing to this file. React batches these on its own.
    for (const f of fns) f();
  });
}

export const RowSkeletonCard = memo(function RowSkeletonCard({ shape }: { shape: RowShape }) {
  const { settings } = useSettings();
  const radius = settings.posterRadius;
  if (shape === "service") {
    return <div className="h-20 w-full rounded-xl bg-elevated/40" />;
  }
  if (shape === "rank") {
    return (
      <div className="aspect-[228/246] w-full bg-elevated/30" style={{ borderRadius: radius }} />
    );
  }
  if (shape === "tile") {
    return <div className="aspect-[5/4] w-full rounded-2xl bg-elevated/30" />;
  }
  if (shape === "cta") {
    return <div className="h-[108px] w-full rounded-[14px] bg-elevated/40" />;
  }
  const aspect =
    shape === "landscape" ? "aspect-[16/9]" : shape === "square" ? "aspect-square" : "aspect-[2/3]";
  const hideText = shape === "landscape" || (shape === "portrait" && settings.hidePosterTitles);
  return (
    <div className="flex w-full min-w-0 flex-col gap-2.5">
      <div className={`${aspect} bg-elevated/40`} style={{ borderRadius: radius }} />
      {!hideText && (
        <div className="flex flex-col gap-1.5 h-9">
          <div className="h-3 w-3/5 rounded bg-elevated/35" />
          <div className="h-3 w-2/5 rounded bg-elevated/25" />
        </div>
      )}
    </div>
  );
});

export function Row({
  title,
  titleExtra,
  headerDescription,
  className = "",
  min = 144,
  shape = "portrait",
  scrollKey,
  scrollAnchorKey,
  arrowsAlways = false,
  alwaysActive = false,
  children,
  onEndReached,
  onViewAll,
  viewAllLabel = "View all",
  viewAllClassName = "text-ink-subtle hover:text-ink",
  headerRight,
  titleClassName = "text-ink",
  titleScale = 1,
}: {
  title?: React.ReactNode;
  titleExtra?: React.ReactNode;
  headerDescription?: React.ReactNode;
  className?: string;
  min?: number;
  shape?: RowShape;
  alwaysActive?: boolean;
  arrowsAlways?: boolean;
  scrollKey?: string;
  /** Resets the row to its start when the head item changes. */
  scrollAnchorKey?: string;
  children: React.ReactNode;
  onEndReached?: () => void;
  onViewAll?: () => void;
  viewAllLabel?: string;
  viewAllClassName?: string;
  headerRight?: React.ReactNode;
  titleClassName?: string;
  titleScale?: number;
}) {
  const { settings } = useSettings();
  const t = useT();
  const { rememberRowScroll, recallRowScroll } = useViewActions();
  const pageScrollRoot = useContext(ScrollRootContext);
  const lang = useUiLanguage();
  const rtl = checkRtl(lang);
  const tvCards =
    shape === "portrait" && settings.rowCardStyle === "tv" && holdsPosterCards(children);
  const effShape: RowShape = tvCards ? "landscape" : shape;
  const effMin = Math.max(72, Math.round((tvCards ? TV_CARD_MIN : min) * settings.posterScale));
  const expandingCards = effShape === "portrait" && settings.posterBackdropExpansion;
  const dockEnabled = effShape === "portrait" && settings.posterDockMagnification;
  const posterHeightRatio = effShape === "landscape" ? 9 / 16 : effShape === "square" ? 1 : 1.5;
  const containerRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackEl, setTrackEl] = useState<HTMLDivElement | null>(null);
  const trackCb = useCallback((el: HTMLDivElement | null) => {
    trackRef.current = el;
    setTrackEl(el);
  }, []);
  const [cellWidth, setCellWidth] = useState<number | null>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);
  const [expandedCard, setExpandedCard] = useState<{
    index: number;
    widthScale: number;
  } | null>(null);
  const hasEndCallback = onEndReached !== undefined;
  const onEndRef = useRef(onEndReached);
  useEffect(() => {
    onEndRef.current = onEndReached;
  });

  const [near, setNear] = useState(false);
  const nearRef = useRef(false);
  const onScreenRef = useRef(false);
  const skippedRef = useRef<boolean | null>(null);
  const columnRef = useRef<{ cellWidth: number; px: number | null } | null>(null);
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const root = resolveRowScrollRoot(pageScrollRoot, el);
    const stopNear = observeWithin(
      el,
      PAGE_MARGIN,
      (entry) => {
        nearRef.current = entry.isIntersecting;
        columnRef.current = null;
        skippedRef.current = null;
        startTransition(() => setNear(entry.isIntersecting));
      },
      root,
    );
    const stopOnScreen = observeWithin(
      el,
      "0px",
      (entry) => {
        onScreenRef.current = entry.isIntersecting;
      },
      root,
    );
    return () => {
      stopNear();
      stopOnScreen();
    };
  }, [pageScrollRoot]);
  const measuredRef = useRef({ width: 0, effMin: 0 });
  // Width reported by the ResizeObserver for this row's container, so the measurement below does
  // not need a forced layout read.
  const observedWidthRef = useRef(0);
  // The shell is as wide, and it is laid out while the browser still skips the container.
  const shellWidthRef = useRef(0);
  const cellWidthRef = useRef<number | null>(null);
  const measure = () => {
    const container = containerRef.current;
    if (!container) return;
    // Placeholders wait for their container: a saved sideways position belongs to the cards to come.
    const available = alwaysActive
      ? observedWidthRef.current
      : shellWidthRef.current || observedWidthRef.current;
    if (available <= 0) return;
    // The ResizeObserver also fires when the track's height changes, which is posters loading, not
    // a width change. Re-deriving the cell width then wrote the same value and re-laid-out the
    // whole track for nothing.
    const previous = measuredRef.current;
    if (Math.abs(available - previous.width) < 0.5 && effMin === previous.effMin) return;
    measuredRef.current = { width: available, effMin };
    const fits = Math.max(1, Math.floor((available + GAP) / (effMin + GAP)));
    const raw = (available - (fits - 1) * GAP) / fits;
    const next = (Math.ceil(raw * 64) + 1) / 64;
    batchWrite(() => {
      cellWidthRef.current = next;
      setCellWidth(next);
    });
  };
  const lastScrollPosRef = useRef(0);
  // The width of a cell the row shows at its current offset, null for the others. Needs no layout.
  const shownWidth = useCallback((column: number, columns: number, rendered = false) => {
    const cellWidth = cellWidthRef.current;
    if (cellWidth === null) return null;
    if (rendered || columnRef.current?.cellWidth !== cellWidth)
      columnRef.current = { cellWidth, px: trackColumn(trackRef.current, cellWidth) };
    const px = columnRef.current.px;
    if (px === null) return null;
    const stride = px + GAP;
    const left = column * stride - lastScrollPosRef.current;
    const width = columns * stride - GAP;
    return left < measuredRef.current.width && left + width > 0 ? width : null;
  }, []);
  // A row the browser renders needs no preparing, and its observers can be believed.
  const isSkipped = useCallback((now = false) => {
    if (now || skippedRef.current === null)
      skippedRef.current =
        trackRef.current?.checkVisibility?.({ contentVisibilityAuto: true }) === false;
    return skippedRef.current;
  }, []);
  const readPos = (el: HTMLDivElement) => {
    const pos = rtl ? -el.scrollLeft : el.scrollLeft;
    lastScrollPosRef.current = pos;
    return pos;
  };
  const writePos = (el: HTMLDivElement, pos: number) => {
    lastScrollPosRef.current = pos;
    el.scrollLeft = rtl ? -pos : pos;
  };

  const measureScroll = () => {
    const el = trackRef.current;
    if (!el) return;
    const pos = readPos(el);
    const width = el.clientWidth;
    const remaining = el.scrollWidth - width - pos;
    batchWrite(() => {
      setCanPrev(pos > 1);
      setCanNext(remaining > 1);
    });
    if (width > 0 && remaining < 800 && (alwaysActive || nearRef.current)) {
      onEndRef.current?.();
    }
  };

  const measureRef = useRef(() => {
    measure();
    measureScroll();
  });
  useLayoutEffect(() => {
    measureRef.current = () => {
      measure();
      measureScroll();
    };
  });
  const measureFrame = useRef<number | null>(null);
  const scheduleMeasure = useCallback(() => {
    if (measureFrame.current != null) return;
    measureFrame.current = requestAnimationFrame(() => {
      measureFrame.current = null;
      measureRef.current();
    });
  }, []);

  const drag = useRef({
    active: false,
    moved: false,
    startX: 0,
    startScroll: 0,
    pointerId: -1,
    lastX: 0,
    lastT: 0,
    vel: 0,
  });
  const expansionFrameRef = useRef<number | null>(null);
  const expansionSettleRef = useRef<number | null>(null);
  const hadExpandedCardRef = useRef(false);

  const expandRowCard = useCallback(
    (index: number, width: number) => {
      if (!expandingCards) return;
      const baseWidth = cellWidth ?? effMin;
      const widthScale = Math.max(1, width / baseWidth);
      setExpandedCard((current) => {
        if (current?.index === index && Math.abs(current.widthScale - widthScale) < 0.005) {
          return current;
        }
        return { index, widthScale };
      });
    },
    [cellWidth, effMin, expandingCards],
  );
  const collapseRowCard = useCallback((index: number) => {
    setExpandedCard((current) => (current?.index === index ? null : current));
  }, []);

  const revealExpanded = (track: HTMLDivElement, index: number) => {
    const cell = track.querySelector<HTMLElement>(`[data-row-card-index="${index}"]`);
    if (!cell) return;
    const delta = scrollDeltaToRevealCard(
      cell.getBoundingClientRect(),
      track.getBoundingClientRect(),
      GAP,
    );
    if (Math.abs(delta) > 0.5) track.scrollLeft += delta;
  };

  useLayoutEffect(() => {
    const track = trackRef.current;
    const hasExpansion = expandedCard !== null;
    if (!track || (!hasExpansion && !hadExpandedCardRef.current)) return;
    hadExpandedCardRef.current = hasExpansion;
    if (expansionFrameRef.current !== null) cancelAnimationFrame(expansionFrameRef.current);
    if (expansionSettleRef.current !== null) window.clearTimeout(expansionSettleRef.current);
    track.style.scrollSnapType = "none";
    track.style.scrollBehavior = "auto";
    if (expandedCard) {
      const startedAt = performance.now();
      const keepExpandedCardVisible = () => {
        expansionFrameRef.current = null;
        if (!drag.current.active) revealExpanded(track, expandedCard.index);
        if (performance.now() - startedAt < 520) {
          expansionFrameRef.current = requestAnimationFrame(keepExpandedCardVisible);
        }
      };
      expansionFrameRef.current = requestAnimationFrame(keepExpandedCardVisible);
    }
    expansionSettleRef.current = window.setTimeout(() => {
      expansionSettleRef.current = null;
      if (expandedCard && !drag.current.active) revealExpanded(track, expandedCard.index);
      if (!expandedCard) track.style.scrollSnapType = "";
      track.style.scrollBehavior = "";
      measureScroll();
    }, 540);
  }, [expandedCard]);

  useEffect(
    () => () => {
      if (expansionFrameRef.current !== null) cancelAnimationFrame(expansionFrameRef.current);
      if (expansionSettleRef.current !== null) window.clearTimeout(expansionSettleRef.current);
    },
    [],
  );

  const childCount = Children.count(children);
  const memoryKey =
    scrollKey == null
      ? undefined
      : scrollAnchorKey != null
        ? `${scrollKey}:${scrollAnchorKey}`
        : scrollKey;
  const prevAnchorRef = useRef(scrollAnchorKey);
  const prevMemoryRef = useRef(memoryKey);
  const restoredRef = useRef(false);
  const userInteractedRef = useRef(false);
  useEffect(() => {
    scheduleMeasure();
  }, [
    childCount,
    trackEl,
    cellWidth,
    effMin,
    rtl,
    near,
    alwaysActive,
    hasEndCallback,
    scheduleMeasure,
  ]);
  useEffect(
    () => () => {
      if (measureFrame.current != null) cancelAnimationFrame(measureFrame.current);
      measureFrame.current = null;
    },
    [],
  );
  useLayoutEffect(() => {
    if (!trackEl || cellWidth == null) return;
    if (memoryKey && !restoredRef.current && childCount > 0) {
      const n = recallRowScroll(memoryKey);
      // A fresh track is already at zero. Only a saved nonzero position needs
      // synchronous geometry before paint; reading every new track forces layout.
      if (n != null && n > 0) {
        const max = trackEl.scrollWidth - trackEl.clientWidth;
        const target = max > 0 ? Math.min(n, max) : 0;
        writePos(trackEl, target);
      }
      restoredRef.current = true;
      // A restored position is intentional even if another page of cards arrives later.
      userInteractedRef.current = n != null && n > 0;
      return;
    }
    if (!userInteractedRef.current && lastScrollPosRef.current !== 0) {
      writePos(trackEl, 0);
    }
  }, [childCount, cellWidth, trackEl, memoryKey, recallRowScroll]);

  useEffect(() => {
    const container = containerRef.current;
    const track = trackRef.current;
    if (!container || !track) return;
    // One shared ResizeObserver rather than one per row. A view mounts dozens of rows at once, so
    // each private observer was another object created during the click that switched to it — and
    // the entry already carries the width, so the measurement needs no layout read either.
    const stopContainerResize = observeResize(container, (rect) => {
      if (rect.width <= 0) return;
      if (Math.abs(rect.width - observedWidthRef.current) < 0.5) return;
      observedWidthRef.current = rect.width;
      scheduleMeasure();
    });
    let settleTimer: number | undefined;
    const stopShellResize =
      shellRef.current &&
      observeResize(shellRef.current, (rect) => {
        if (rect.width <= 0) return;
        if (Math.abs(rect.width - shellWidthRef.current) < 0.5) return;
        shellWidthRef.current = rect.width;
        window.clearTimeout(settleTimer);
        // On screen the container measures. The other rows follow once the width has settled.
        if (cellWidthRef.current !== null)
          settleTimer = window.setTimeout(scheduleMeasure, RESIZE_SETTLE_MS);
        else if (nearRef.current) scheduleMeasure();
      });
    let trackWidth = 0;
    const stopTrackResize = observeResize(track, (rect) => {
      if (rect.width <= 0) return;
      if (Math.abs(rect.width - trackWidth) < 0.5) return;
      trackWidth = rect.width;
      scheduleMeasure();
    });
    let saveTimer: number | null = null;
    const onScroll = () => {
      readPos(track);
      scheduleMeasure();
      if (!memoryKey) return;
      if (saveTimer != null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        rememberRowScroll(memoryKey, readPos(track));
      }, 200);
    };
    track.addEventListener("scroll", onScroll, { passive: true });
    const markInteracted = () => {
      userInteractedRef.current = true;
    };
    let wheelSettle: number | null = null;
    const onWheel = (e: WheelEvent) => {
      userInteractedRef.current = true;
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      if (rafId.current != null && Math.abs(e.deltaX) < 4) return;
      cancelGlide();
      track.style.scrollSnapType = "none";
      track.style.scrollBehavior = "auto";
      if (wheelSettle != null) window.clearTimeout(wheelSettle);
      wheelSettle = window.setTimeout(() => {
        wheelSettle = null;
        const stride = strideRef.current;
        const max = track.scrollWidth - track.clientWidth;
        if (max <= 0 || stride <= 0) {
          track.style.scrollSnapType = "";
          track.style.scrollBehavior = "";
          return;
        }
        const pos = readPos(track);
        const aligned = Math.max(0, Math.min(Math.round(pos / stride) * stride, max));
        const target = max - pos < stride * 0.5 ? max : aligned;
        glideTo(track, target, true);
      }, 200);
    };
    track.addEventListener("wheel", onWheel, { passive: true });
    track.addEventListener("pointerdown", markInteracted);
    track.addEventListener("keydown", markInteracted);
    let resetRaf: number | null = null;
    // A reset that arrived while this row's page was parked. Writing scrollLeft inside a
    // content-visibility:hidden layer forces style and layout of that locked subtree, so the write
    // waits until the row is reachable again: a parked layer is skipped for hit testing and focus,
    // so the first pointer or focus entering the row (track or arrows) means the page is active.
    let pendingReset = false;
    const applyPendingReset = () => {
      if (!pendingReset) return;
      pendingReset = false;
      if (lastScrollPosRef.current !== 0) writePos(track, 0);
    };
    container.addEventListener("pointerenter", applyPendingReset);
    container.addEventListener("focusin", applyPendingReset);
    const onReset = (e: Event) => {
      const detail = (e as CustomEvent<{ prefix?: string }>).detail;
      if (!scrollKey) return;
      if (!detail?.prefix || !scrollKey.startsWith(detail.prefix)) return;
      // Deferred by one frame. This fires during the commit that switches views (ViewProvider's
      // layout effect), and every matching row used to write scrollLeft and then read scrollWidth
      // right there — a forced layout per row, synchronously inside the switch. Coalescing the
      // writes into a single frame lets the browser lay out once, after the commit. The write below
      // still fires the track's own scroll handler, which is what updates the arrows. It is skipped
      // for rows already at 0, since most rows are, and that write is the expensive part.
      if (resetRaf != null) return;
      resetRaf = requestAnimationFrame(() => {
        resetRaf = null;
        if (saveTimer != null) {
          window.clearTimeout(saveTimer);
          saveTimer = null;
        }
        if (track.closest("[data-layer-inactive]")) pendingReset = lastScrollPosRef.current !== 0;
        else {
          pendingReset = false;
          if (lastScrollPosRef.current !== 0) writePos(track, 0);
        }
        if (memoryKey) rememberRowScroll(memoryKey, 0);
        userInteractedRef.current = false;
      });
    };
    window.addEventListener("harbor:reset-row-scrolls", onReset);
    return () => {
      stopContainerResize();
      stopShellResize?.();
      window.clearTimeout(settleTimer);
      stopTrackResize();
      if (resetRaf != null) cancelAnimationFrame(resetRaf);
      track.removeEventListener("scroll", onScroll);
      track.removeEventListener("wheel", onWheel);
      track.removeEventListener("pointerdown", markInteracted);
      track.removeEventListener("keydown", markInteracted);
      container.removeEventListener("pointerenter", applyPendingReset);
      container.removeEventListener("focusin", applyPendingReset);
      window.removeEventListener("harbor:reset-row-scrolls", onReset);
      if (saveTimer != null) window.clearTimeout(saveTimer);
      if (wheelSettle != null) window.clearTimeout(wheelSettle);
      if (rafId.current != null) cancelAnimationFrame(rafId.current);
      if (memoryKey && lastScrollPosRef.current > 0 && !pendingReset) {
        rememberRowScroll(memoryKey, lastScrollPosRef.current);
      }
    };
  }, [scrollKey, memoryKey, rememberRowScroll, scheduleMeasure]);

  const scroll = (dir: -1 | 1) => {
    const el = trackRef.current;
    if (!el) return;
    userInteractedRef.current = true;
    cancelGlide();
    const cur = rtl ? -el.scrollLeft : el.scrollLeft;
    const max = el.scrollWidth - el.clientWidth;
    const stride = strideRef.current;
    const raw = cur + dir * el.clientWidth;
    const target = Math.max(0, Math.min(max, Math.round(raw / stride) * stride));
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      el.scrollLeft = rtl ? -target : target;
      return;
    }
    el.style.scrollSnapType = "none";
    glideTo(el, target, false);
  };

  const rafId = useRef<number | null>(null);
  const strideRef = useRef(effMin + GAP);
  strideRef.current = (cellWidth ?? effMin) + GAP;

  const dockFrameRef = useRef<number | null>(null);
  const dockPointerXRef = useRef<number | null>(null);
  const resetPosterDock = useCallback(() => {
    const track = trackRef.current;
    if (track) resetPosterDockItems(track);
  }, []);
  const applyPosterDock = useCallback(() => {
    dockFrameRef.current = null;
    const track = trackRef.current;
    const pointerX = dockPointerXRef.current;
    if (!dockEnabled || !track || pointerX === null) {
      resetPosterDock();
      return;
    }
    updatePosterDock({
      track,
      pointerX,
      cellWidth: cellWidth ?? effMin,
      gap: GAP,
      scrollPosition: rtl ? -track.scrollLeft : track.scrollLeft,
      rtl,
      transitionMs: settings.posterDockTransitionMs,
    });
  }, [cellWidth, dockEnabled, effMin, resetPosterDock, rtl, settings.posterDockTransitionMs]);
  const schedulePosterDock = useCallback(
    (clientX: number) => {
      dockPointerXRef.current = clientX;
      if (dockFrameRef.current === null) {
        dockFrameRef.current = requestAnimationFrame(applyPosterDock);
      }
    },
    [applyPosterDock],
  );
  useEffect(
    () => () => {
      if (dockFrameRef.current !== null) cancelAnimationFrame(dockFrameRef.current);
      resetPosterDock();
    },
    [resetPosterDock],
  );
  useEffect(() => {
    if (!dockEnabled) resetPosterDock();
  }, [dockEnabled, resetPosterDock]);

  const cancelGlide = () => {
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
  };

  const glideTo = (el: HTMLDivElement, target: number, snappy = false) => {
    const start = rtl ? -el.scrollLeft : el.scrollLeft;
    const distance = target - start;
    if (Math.abs(distance) < 2) {
      el.style.scrollSnapType = "";
      el.style.scrollBehavior = "";
      return;
    }
    const startTime = performance.now();
    const duration = snappy
      ? Math.max(140, Math.min(300, Math.abs(distance) * 0.9))
      : Math.max(280, Math.min(620, 260 + Math.abs(distance) * 0.45));
    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = start + distance * eased;
      el.scrollLeft = rtl ? -next : next;
      if (t < 1) {
        rafId.current = requestAnimationFrame(tick);
      } else {
        rafId.current = null;
        el.style.scrollSnapType = "";
        el.style.scrollBehavior = "";
      }
    };
    rafId.current = requestAnimationFrame(tick);
  };

  useLayoutEffect(() => {
    const previousAnchor = prevAnchorRef.current;
    const previousMemory = prevMemoryRef.current;
    prevAnchorRef.current = scrollAnchorKey;
    prevMemoryRef.current = memoryKey;
    if (previousAnchor === scrollAnchorKey) return;
    // The head changing means the previous snapshot is no longer relevant.
    // Clear it so switching back to an old head cannot restore a hidden start.
    if (previousMemory) rememberRowScroll(previousMemory, 0);
    const track = trackRef.current;
    if (track) {
      cancelGlide();
      writePos(track, 0);
    }
    if (memoryKey) rememberRowScroll(memoryKey, 0);
    userInteractedRef.current = false;
  }, [scrollAnchorKey, memoryKey, rememberRowScroll]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dockPointerXRef.current = null;
    resetPosterDock();
    if (e.button !== 0 || e.pointerType === "touch") return;
    if (!(e.target as Element).closest("button")) return;
    const el = trackRef.current;
    if (!el) return;
    cancelGlide();
    drag.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startScroll: el.scrollLeft,
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastT: performance.now(),
      vel: 0,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dockEnabled && e.pointerType !== "touch" && e.buttons === 0 && !drag.current.active) {
      schedulePosterDock(e.clientX);
    }
    const d = drag.current;
    const el = trackRef.current;
    if (!d.active || !el) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 6) return;
    if (!d.moved) {
      d.moved = true;
      el.style.scrollSnapType = "none";
      el.style.scrollBehavior = "auto";
      try {
        el.setPointerCapture(d.pointerId);
      } catch {
        /* ignore */
      }
    }
    const now = performance.now();
    const dt = now - d.lastT;
    if (dt > 0) {
      const instant = (e.clientX - d.lastX) / dt;
      d.vel = d.vel * 0.55 + instant * 0.45;
    }
    d.lastX = e.clientX;
    d.lastT = now;
    el.scrollLeft = d.startScroll - dx;
  };

  const endDrag = (e?: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = trackRef.current;
    d.active = false;
    if (!d.moved || !el) {
      setTimeout(() => {
        drag.current.moved = false;
      }, 0);
      return;
    }
    try {
      if (e) el.releasePointerCapture(d.pointerId);
    } catch {
      /* ignore */
    }

    const friction = 0.004;
    const v = d.vel;
    const projection = -((v * Math.abs(v)) / (2 * friction));
    const projectedRaw = el.scrollLeft + projection;
    const projected = rtl ? -projectedRaw : projectedRaw;
    const stride = (cellWidth ?? effMin) + GAP;
    const max = el.scrollWidth - el.clientWidth;
    const targetIdx = Math.round(projected / stride);
    const target = Math.max(0, Math.min(targetIdx * stride, max));
    glideTo(el, target);

    setTimeout(() => {
      drag.current.moved = false;
    }, 0);
  };

  const onClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (drag.current.moved) {
      e.stopPropagation();
      e.preventDefault();
    }
  };

  let nextColumn = 0;
  const trackPad = dockEnabled ? "pb-8 pt-14 -mb-8 -mt-14" : "py-5 -my-5 px-2 -mx-2 scroll-px-2";
  const hasHeader = !!(title || onViewAll || headerRight);
  const shellRoom = hasHeader ? "" : dockEnabled ? "py-14 -my-14" : "py-5 -my-5";

  return (
    <div
      ref={shellRef}
      data-row-near={near ? "" : undefined}
      className={`harbor-row-shell flex min-w-0 flex-col gap-5 ps-[9px] ${shellRoom} ${className}`}
    >
      {hasHeader && (
        <div
          className="relative z-20 flex items-baseline justify-between gap-4 pe-1"
          onPointerEnter={() => {
            if (dockEnabled) {
              dockPointerXRef.current = null;
              resetPosterDock();
            }
          }}
          onPointerMove={() => {
            if (dockEnabled) {
              dockPointerXRef.current = null;
              resetPosterDock();
            }
          }}
        >
          {title && (
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-2">
                <h3
                  className={`truncate font-medium tracking-tight ${titleClassName}`}
                  style={{ fontSize: `${Math.round(17 * settings.rowTitleScale * titleScale)}px` }}
                >
                  {title}
                </h3>
                {titleExtra}
              </div>
              {headerDescription}
            </div>
          )}
          {(onViewAll || headerRight) && (
            <div className="flex shrink-0 items-center gap-3">
              {headerRight}
              {onViewAll && (
                <button
                  type="button"
                  onClick={onViewAll}
                  className={`group/va inline-flex shrink-0 items-center gap-1 text-[12.5px] font-medium transition-colors ${viewAllClassName}`}
                >
                  {t(viewAllLabel)}
                  <ChevronRight
                    size={14}
                    strokeWidth={2.2}
                    className="dir-icon transition-transform duration-200 group-hover/va:translate-x-0.5"
                  />
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <div ref={containerRef} className="group/row relative min-w-0">
        <RowTrackContext.Provider value={trackEl}>
          <div
            ref={trackCb}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => {
              endDrag(event);
              if (dockEnabled && event.pointerType !== "touch") schedulePosterDock(event.clientX);
            }}
            onPointerCancel={(event) => {
              endDrag(event);
              dockPointerXRef.current = null;
              resetPosterDock();
            }}
            onPointerLeave={() => {
              dockPointerXRef.current = null;
              resetPosterDock();
            }}
            onClickCapture={onClickCapture}
            onDragStart={(e) => e.preventDefault()}
            className={`harbor-row-track items-start gap-5 overflow-x-auto overflow-y-hidden ${trackPad} [scroll-snap-type:x_mandatory] [&>*]:[scroll-snap-align:start] [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] [overflow-anchor:none] [overscroll-behavior-x:contain] [&_img]:select-none [&_img]:[-webkit-user-drag:none] ${
              expandingCards
                ? "harbor-expanding-card-scope harbor-expanding-row flex flex-nowrap"
                : "grid grid-flow-col"
            }`}
            style={
              {
                "--row-poster-height": `${(cellWidth ?? effMin) * posterHeightRatio}px`,
                ...(expandingCards
                  ? {}
                  : { gridAutoColumns: cellWidth != null ? `${cellWidth}px` : `${effMin}px` }),
                transform: near ? "translateZ(0)" : undefined,
                contain: expandingCards ? "style" : "layout style",
              } as React.CSSProperties
            }
          >
            {Children.map(children, (child, i) => {
              const span = isValidElement(child)
                ? (child.props as { style?: { gridColumn?: string } }).style?.gridColumn
                : undefined;
              const spanCount = columnSpan(span);
              const column = nextColumn;
              nextColumn += spanCount;
              const baseWidth = (cellWidth ?? effMin) * spanCount + GAP * (spanCount - 1);
              const expanded = expandedCard?.index === i;
              const desiredExpandedWidth =
                expanded && expandedCard
                  ? (cellWidth ?? effMin) * expandedCard.widthScale
                  : undefined;
              const viewportLimit = Math.max(
                baseWidth,
                (observedWidthRef.current || measuredRef.current.width || baseWidth) - GAP * 2,
              );
              const expandedWidth =
                desiredExpandedWidth === undefined
                  ? undefined
                  : Math.max(baseWidth, Math.min(desiredExpandedWidth, viewportLimit));
              return (
                <LazyChild
                  eager={alwaysActive}
                  active={alwaysActive || near}
                  measured={cellWidth !== null}
                  column={column}
                  columns={spanCount}
                  shownWidth={shownWidth}
                  isSkipped={isSkipped}
                  rowOnScreen={onScreenRef}
                  shape={effShape}
                  span={span}
                  expansion={
                    expandingCards
                      ? {
                          index: i,
                          baseWidth,
                          expandedWidth,
                          expanded,
                          onExpand: expandRowCard,
                          onCollapse: collapseRowCard,
                        }
                      : undefined
                  }
                >
                  {child}
                </LazyChild>
              );
            })}
          </div>
        </RowTrackContext.Provider>
        <EdgeArrow side="left" visible={canPrev} always={arrowsAlways} onClick={() => scroll(-1)} />
        <EdgeArrow side="right" visible={canNext} always={arrowsAlways} onClick={() => scroll(1)} />
      </div>
    </div>
  );
}

function EdgeArrow({
  side,
  visible,
  always = false,
  onClick,
}: {
  side: "left" | "right";
  visible: boolean;
  always?: boolean;
  onClick: () => void;
}) {
  const t = useT();
  const { settings } = useSettings();
  const label = t(side === "left" ? "Scroll left" : "Scroll right");
  if (settings.liquidGlass) {
    const sideClass = side === "left" ? "start-0 justify-start" : "end-0 justify-end";
    return (
      <div
        className={`pointer-events-none absolute inset-y-0 z-30 flex w-14 items-center ${sideClass} ${
          always ? `transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}` : ""
        }`}
      >
        <ThreeLiquidGlassSurface
          radius="9999px"
          shaderRadius={0.58}
          intensity={0.9}
          interactive={false}
          alwaysActive
          style={{
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.04)",
          }}
          className={`h-11 w-11 pointer-events-auto border border-white/[0.06] transition-opacity duration-200 ${
            visible
              ? "opacity-85 group-hover/row:opacity-100 focus-within:opacity-100"
              : "pointer-events-none opacity-0"
          }`}
          contentClassName="flex h-full w-full items-center justify-center"
        >
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            tabIndex={visible ? 0 : -1}
            className="flex h-full w-full items-center justify-center rounded-full bg-transparent text-ink outline-none"
          >
            {side === "left" ? (
              <ChevronLeft size={22} strokeWidth={2.2} className="dir-icon" />
            ) : (
              <ChevronRight size={22} strokeWidth={2.2} className="dir-icon" />
            )}
          </button>
        </ThreeLiquidGlassSurface>
      </div>
    );
  }
  const enter = side === "left" ? "-translate-x-2.5" : "translate-x-2.5";
  const chev = !visible
    ? "opacity-0"
    : always
      ? "opacity-100"
      : `opacity-0 ${enter} scale-[0.6] group-hover/edge:opacity-100 group-hover/edge:translate-x-0 group-hover/edge:scale-100 group-focus-visible/edge:opacity-100 group-focus-visible/edge:translate-x-0 group-focus-visible/edge:scale-100`;
  return (
    <div
      className={`pointer-events-none absolute inset-y-0 z-30 flex w-16 -translate-y-[7%] items-center ${
        side === "left" ? "start-[-40px] justify-start" : "end-[-40px] justify-end"
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        tabIndex={visible ? 0 : -1}
        data-tv-skip="true"
        className={`group/edge grid h-full w-full place-items-center ${
          visible ? "pointer-events-auto" : "pointer-events-none"
        }`}
      >
        <span
          className={`grid place-items-center text-white drop-shadow-[0_2px_14px_rgba(0,0,0,0.95)] transition-all duration-[320ms] ease-[cubic-bezier(0.34,1.45,0.5,1)] group-active/edge:scale-90 ${chev}`}
        >
          <NavChevron dir={side} size={54} />
        </span>
      </button>
    </div>
  );
}
