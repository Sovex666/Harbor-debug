import { useEffect, useRef, type RefObject } from "react";
import type { PlayerBridge, PlayerSnapshot } from "@/lib/player/bridge";
import { getPlaybackPosition } from "@/lib/player/playback-clock";
import { isLocalUrl } from "@/lib/player/local-url";
import { isLivePlaybackSrc } from "@/lib/player/live-src";
import type { PlayerSrc } from "@/lib/view";
import { recordDiagnostic } from "@/lib/perf/diagnostics";
import { tracePlayback } from "@/lib/player/pause-trace";

const WAKE_GAP_MS = 30_000;
const TICK_MS = 2_000;

export function useWakeReconnect(params: {
  bridgeRef: RefObject<PlayerBridge | null>;
  src: PlayerSrc;
  snap: PlayerSnapshot;
}) {
  const { bridgeRef, src, snap } = params;
  const srcRef = useRef(src);
  srcRef.current = src;
  const snapRef = useRef(snap);
  snapRef.current = snap;

  useEffect(() => {
    let last = Date.now();
    let previousPosition = getPlaybackPosition();
    let previousSource = srcRef.current;
    let previousBridge = bridgeRef.current;
    let pending: {
      source: PlayerSrc;
      bridge: PlayerBridge;
      position: number;
      at: number;
      gap: number;
    } | null = null;
    const id = window.setInterval(() => {
      const now = Date.now();
      const gap = now - last;
      last = now;
      const s = srcRef.current;
      const snap = snapRef.current;
      const b = bridgeRef.current;
      const pos = getPlaybackPosition();
      const sameSource = previousSource.url === s.url && previousSource.meta.id === s.meta.id;
      const advanced = pos > previousPosition + 0.1;
      const eligible =
        !!b && !isLocalUrl(s.url) && snap.status === "playing" && (snap.durationSec > 0 || pos > 0);
      const candidate = pending;
      pending = null;
      const recover =
        candidate &&
        candidate.bridge === b &&
        candidate.source.url === s.url &&
        candidate.source.meta.id === s.meta.id &&
        eligible &&
        Math.abs(pos - candidate.position) <= 0.1 &&
        now - candidate.at >= TICK_MS;
      if (!recover && gap >= WAKE_GAP_MS && eligible && sameSource && previousBridge === b) {
        recordDiagnostic("playback:timer-gap", {
          elapsedMs: gap,
          advancing: advanced,
          position: pos,
        });
        // WebView timers may be throttled while native mpv keeps playing. Let
        // queued native time-pos events catch up before replacing the stream.
        if (!advanced) pending = { source: s, bridge: b, position: pos, at: now, gap };
      }
      previousPosition = pos;
      previousSource = s;
      previousBridge = b;
      if (!recover || !candidate || !b) return;
      const live = isLivePlaybackSrc(s);
      recordDiagnostic("playback:wake-reconnect", {
        elapsedMs: candidate.gap,
        position: pos,
        live,
      });
      tracePlayback(
        `reload cause=wake-stalled gapMs=${candidate.gap} position=${pos} live=${live}`,
      );
      console.warn(
        "[player] network playback remained stalled after a timer gap — reconnecting stream",
      );
      void b
        .load({
          url: s.url,
          subtitles: s.subtitles,
          notWebReady: s.notWebReady,
          isLive: live,
          headers: s.headers,
          startAtSec: !live && pos > 1 ? pos : undefined,
        })
        .catch(() => recordDiagnostic("playback:wake-reconnect-error", { error: true }));
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [bridgeRef]);
}
