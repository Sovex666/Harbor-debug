import {
  exportDiagnosticsSession,
  flushDiagnostics,
  getDiagnosticsSessionStatus,
  listDiagnosticsSessions,
  readDiagnosticsPreferences,
  startDiagnosticsSession,
  stopDiagnosticsSession,
} from "./session";

export type SelfTestStepId =
  | "service"
  | "preferences"
  | "start"
  | "write"
  | "stop"
  | "export"
  | "list";
export type SelfTestState = "pending" | "running" | "passed" | "failed";
export type SelfTestStep = {
  id: SelfTestStepId;
  label: string;
  state: SelfTestState;
  detail?: string;
};

export const SELF_TEST_STEPS: ReadonlyArray<{ id: SelfTestStepId; label: string }> = [
  { id: "service", label: "Diagnostics service responds" },
  { id: "preferences", label: "Capture preferences can be read" },
  { id: "start", label: "Test session starts" },
  { id: "write", label: "Events are written to disk" },
  { id: "stop", label: "Session stops cleanly" },
  { id: "export", label: "Session exports as a ZIP" },
  { id: "list", label: "Session appears in the list" },
];

export function initialSelfTestSteps(): SelfTestStep[] {
  return SELF_TEST_STEPS.map((step) => ({ ...step, state: "pending" }));
}

// Exercises the real capture pipeline end to end with a short Basic session. It refuses to run
// while a capture session is active so it never stops or mixes events into the user's own session,
// and it never writes capture preferences.
export async function runDiagnosticsSelfTest(
  onProgress: (steps: SelfTestStep[]) => void,
): Promise<{ passed: boolean; steps: SelfTestStep[] }> {
  const steps = initialSelfTestSteps();
  const set = (id: SelfTestStepId, state: SelfTestState, detail?: string) => {
    const step = steps.find((s) => s.id === id)!;
    step.state = state;
    step.detail = detail;
    onProgress(steps.map((s) => ({ ...s })));
  };
  let sessionId: string | null = null;
  let stopped = false;
  const check = async (id: SelfTestStepId, body: () => Promise<string | undefined>) => {
    set(id, "running");
    try {
      set(id, "passed", await body());
      return true;
    } catch (error) {
      set(id, "failed", error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  const ok =
    (await check("service", async () => {
      const status = await getDiagnosticsSessionStatus();
      if (status.active) throw new Error("A capture session is already active");
      return status.buildIdentity;
    })) &&
    (await check("preferences", async () => {
      const prefs = await readDiagnosticsPreferences();
      if (!["basic", "detailed"].includes(prefs.mode)) throw new Error("Unexpected capture mode");
      return undefined;
    })) &&
    (await check("start", async () => {
      const status = await startDiagnosticsSession("basic", 63);
      sessionId = status.active?.sessionId ?? null;
      if (!sessionId) throw new Error("No session was started");
      return sessionId;
    })) &&
    (await check("write", async () => {
      // Start writes the native pipeline marker and queues runtime:started from this side.
      await flushDiagnostics();
      const status = await getDiagnosticsSessionStatus();
      const events = status.active?.sessionId === sessionId ? status.active.events : 0;
      if (events < 2) throw new Error(`Only ${events} events were written`);
      return `${events} events`;
    })) &&
    (await check("stop", async () => {
      const status = await stopDiagnosticsSession(sessionId!);
      stopped = true;
      if (status.active) throw new Error("The session is still active");
      return undefined;
    })) &&
    (await check("export", async () => {
      const result = await exportDiagnosticsSession(sessionId!);
      if (!(result.bytes > 0)) throw new Error("The ZIP is empty");
      return `${Math.max(1, Math.round(result.bytes / 1024))} KB`;
    })) &&
    (await check("list", async () => {
      const found = (await listDiagnosticsSessions()).find((s) => s.sessionId === sessionId);
      if (!found) throw new Error("The session is missing");
      if (found.endedAt == null) throw new Error("The session has no end time");
      return `${found.events} events`;
    }));
  if (sessionId && !stopped) await stopDiagnosticsSession(sessionId).catch(() => {});
  return { passed: ok, steps };
}
