import { invoke, isTauri } from "@tauri-apps/api/core";
import { projectDiagnostic } from "./contract";
export type Session = {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  mode: string;
  domains: number;
  events: number;
  bytes: number;
  dropped: number;
  rotated: number;
  interrupted: boolean;
};
export type SessionStatus = {
  active: Session | null;
  nativeDrops: number;
  nativeMonoMs: number;
  nativeWallMs: number;
  schemaVersion: number;
  buildIdentity: string;
};
export type DiagnosticsPreferences = {
  enabled: boolean;
  autoStart: boolean;
  mode: "basic" | "detailed";
  domains: number;
};
type Entry = {
  seq: number;
  monoMs: number;
  wallMs: number;
  name: string;
  fields: Record<string, number | boolean>;
};
const producer = globalThis.crypto?.randomUUID?.() ?? "00000000-0000-4000-8000-000000000001";
let seq = 0;
let pending: Entry[] = [];
let pendingBytes = 0;
let dropped = 0;
let sessionId: string | null = null;
let inflight: Promise<void> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let detailedTimer: ReturnType<typeof setTimeout> | undefined;
let transportError = false;
let generation = 0;
let domainMask = 63;
let accepting = true;
const clockSamples: Array<{ offsetMs: number; uncertaintyMs: number }> = [];
export function diagnosticsTransportStatus() {
  return {
    pending: pending.length,
    pendingBytes,
    dropped,
    transportError,
    clockSamples: clockSamples.slice(),
  };
}
function domain(name: string) {
  return name.startsWith("playback:")
    ? 1
    : name.startsWith("navigation:") || name.startsWith("ui:")
      ? 2
      : name.startsWith("bridge:") || name.startsWith("resource:")
        ? 4
        : name.startsWith("calendar")
          ? 8
          : name.startsWith("image:")
            ? 16
            : 32;
}
export function enqueueDiagnostic(name: string, fields: Record<string, unknown>) {
  if (!accepting || !sessionId || !(domainMask & domain(name))) return;
  const projected = projectDiagnostic(name, fields);
  if (!projected) return;
  const entry = { seq: ++seq, monoMs: performance.now(), wallMs: Date.now(), ...projected };
  const bytes = JSON.stringify(entry).length * 2;
  if (bytes > 4096 || pending.length >= 4096 || pendingBytes + bytes > 1024 * 1024) {
    dropped++;
    return;
  }
  pending.push(entry);
  pendingBytes += bytes;
  if (pending.length >= 128) void flushDiagnostics().catch(() => {});
}
export async function flushDiagnostics(): Promise<void> {
  if (inflight) return inflight;
  if (!sessionId || !pending.length) return;
  const current = sessionId;
  const token = generation;
  const batch: Entry[] = [];
  let bytes = 0;
  for (const entry of pending) {
    const size = JSON.stringify(entry).length * 2;
    if (batch.length >= 128 || bytes + size > 60000) break;
    batch.push(entry);
    bytes += size;
  }
  inflight = invoke<{ acceptedThroughSeq: number; persistedThroughSeq: number }>(
    "diagnostics_append_batch",
    { batch: { sessionId: current, producer, droppedBefore: dropped, events: batch } },
  )
    .then((ack) => {
      if (token !== generation) return;
      pending = pending.filter((entry) => entry.seq > ack.persistedThroughSeq);
      pendingBytes = pending.reduce((sum, entry) => sum + JSON.stringify(entry).length * 2, 0);
      transportError = false;
    })
    .catch((error: unknown) => {
      transportError = true;
      throw error;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}
export const getDiagnosticsSessionStatus = () =>
  invoke<SessionStatus>("diagnostics_session_status");
export const listDiagnosticsSessions = () => invoke<Session[]>("diagnostics_sessions_list");
export const openDiagnosticsSessionFolder = (id?: string) =>
  invoke<void>("diagnostics_session_open_folder", { sessionId: id ?? null });
export const pruneDiagnosticsSessions = () => invoke("diagnostics_sessions_prune");
export async function exportDiagnosticsSession(id: string) {
  if (id === sessionId) await flushAll();
  return invoke<{ sessionId: string; path: string; bytes: number }>("diagnostics_session_export", {
    sessionId: id,
  });
}
async function flushAll() {
  for (let i = 0; i < 40 && pending.length; i++) await flushDiagnostics();
  if (pending.length) throw new Error("Capture flush incomplete; session retained");
}
export async function startDiagnosticsSession(
  mode: "basic" | "detailed" = "basic",
  domains = 63,
  rotateCurrent = false,
) {
  if (sessionId && rotateCurrent) {
    await stopDiagnosticsSession();
  }
  const status = await invoke<SessionStatus>("diagnostics_session_start", {
    mode,
    domains,
    rotateCurrent,
  });
  if (status.active?.sessionId !== sessionId) {
    generation++;
    seq = 0;
    pending = [];
    pendingBytes = 0;
    dropped = 0;
  }
  sessionId = status.active?.sessionId ?? null;
  domainMask = status.active?.domains ?? domains;
  if (!timer)
    timer = setInterval(() => {
      void flushDiagnostics().catch(() => {});
    }, 500);
  if (detailedTimer) clearTimeout(detailedTimer);
  if (status.active?.mode === "detailed")
    detailedTimer = setTimeout(() => {
      void stopDiagnosticsSession()
        .then(() => startDiagnosticsSession("basic", domainMask))
        .catch(() => {});
    }, 15 * 60_000);
  const before = performance.now();
  const clock = await invoke<{ monoMs: number }>("diagnostics_clock_sample").catch(() => null);
  const after = performance.now();
  if (clock)
    clockSamples.push({
      offsetMs: clock.monoMs - (before + after) / 2,
      uncertaintyMs: (after - before) / 2,
    });
  if (clockSamples.length > 16) clockSamples.shift();
  enqueueDiagnostic("runtime:started", { active: true });
  return status;
}
export async function stopDiagnosticsSession(id = sessionId ?? "") {
  const local = id === sessionId;
  if (local) accepting = false;
  try {
    if (local) await flushAll();
    const result = await invoke<SessionStatus>("diagnostics_session_stop", { sessionId: id });
    if (local) {
      generation++;
      sessionId = null;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (detailedTimer) clearTimeout(detailedTimer);
      detailedTimer = undefined;
    }
    return result;
  } finally {
    if (local) accepting = true;
  }
}
export const readDiagnosticsPreferences = () =>
  invoke<DiagnosticsPreferences>("diagnostics_preferences_read");
export const writeDiagnosticsPreferences = (value: DiagnosticsPreferences) =>
  invoke<DiagnosticsPreferences>("diagnostics_preferences_write", { value });
export async function initializeDiagnosticsSessions() {
  if (!isTauri()) return;
  try {
    const prefs = await readDiagnosticsPreferences();
    if (prefs.enabled && prefs.autoStart) await startDiagnosticsSession(prefs.mode, prefs.domains);
  } catch {
    transportError = true;
  }
}
