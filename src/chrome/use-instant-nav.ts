import { useCallback, useEffect, useRef } from "react";
import { useView, type View } from "@/lib/view";

/**
 * Returns a view switch for nav items. A mouse click marks the clicked element and switches after
 * the next paint, so the click shows at once. Keyboard, remote and gamepad activation (detail 0),
 * modified clicks, clicks on the active item and calls without an event keep the synchronous path.
 */
export function useInstantNav() {
  const { view, setView } = useView();
  const pendingNav = useRef<{ raf: number; timer: number } | null>(null);
  // Stable per view, so callers that capture it in an effect pick up the current view.
  const selectView = useCallback(
    (target: View, e?: React.MouseEvent<HTMLElement>, mark?: string) => {
      const previous = pendingNav.current;
      if (previous) {
        cancelAnimationFrame(previous.raf);
        clearTimeout(previous.timer);
        pendingNav.current = null;
      }
      document
        .querySelectorAll("[data-nav-pending]")
        .forEach((el) => el.removeAttribute("data-nav-pending"));
      if (
        !e ||
        e.detail === 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey ||
        target === view
      ) {
        setView(target);
        return;
      }
      // Each theme shows its active item differently, so the mark selects the matching pending style.
      e.currentTarget.setAttribute("data-nav-pending", mark ?? "");
      const pending = { raf: 0, timer: 0 };
      pending.raf = requestAnimationFrame(() => {
        pending.timer = window.setTimeout(() => {
          if (pendingNav.current === pending) pendingNav.current = null;
          setView(target);
        }, 0);
      });
      pendingNav.current = pending;
    },
    [view, setView],
  );
  useEffect(() => {
    document
      .querySelectorAll("[data-nav-pending]")
      .forEach((el) => el.removeAttribute("data-nav-pending"));
  }, [view]);
  useEffect(
    () => () => {
      const pending = pendingNav.current;
      if (!pending) return;
      cancelAnimationFrame(pending.raf);
      clearTimeout(pending.timer);
    },
    [],
  );
  return selectView;
}
