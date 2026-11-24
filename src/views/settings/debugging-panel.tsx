import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { useT } from "@/lib/i18n";
import { SettingRow } from "./kit";
import { Section, ToggleRow, useSettingsActiveContext } from "./shared";
import { useSubTabs } from "./sub-tabs";
import { SButton } from "./ui";
import {
  exportDiagnosticsSession,
  getDiagnosticsSessionStatus,
  listDiagnosticsSessions,
  openDiagnosticsSessionFolder,
  readDiagnosticsPreferences,
  startDiagnosticsSession,
  stopDiagnosticsSession,
  writeDiagnosticsPreferences,
  type DiagnosticsPreferences,
  type Session,
  type SessionStatus,
} from "@/lib/diagnostics/session";
import {
  initialSelfTestSteps,
  runDiagnosticsSelfTest,
  type SelfTestStep,
} from "@/lib/diagnostics/self-test";

type Tab = "capture" | "sessions" | "self-test";

export function DebuggingPanel() {
  const t = useT();
  const { openPage } = useSettingsActiveContext();
  const [tab, setTab] = useState<Tab>("capture");
  const [prefs, setPrefs] = useState<DiagnosticsPreferences>({
    enabled: false,
    autoStart: false,
    mode: "basic",
    domains: 63,
  });
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selfTest, setSelfTest] = useState<{
    steps: SelfTestStep[];
    result: "idle" | "running" | "passed" | "failed";
  }>(() => ({ steps: initialSelfTestSteps(), result: "idle" }));
  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    const [p, s, list] = await Promise.all([
      readDiagnosticsPreferences(),
      getDiagnosticsSessionStatus(),
      listDiagnosticsSessions(),
    ]);
    setPrefs(p);
    setStatus(s);
    setSessions(list);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, [refresh, tab]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = (next: DiagnosticsPreferences) => run(() => writeDiagnosticsPreferences(next));
  const capture = (enabled: boolean) =>
    run(async () => {
      if (enabled) await startDiagnosticsSession(prefs.mode, prefs.domains);
      else if (status?.active) await stopDiagnosticsSession(status.active.sessionId);
      await writeDiagnosticsPreferences({ ...prefs, enabled });
    });
  const runSelfTest = async () => {
    setBusy(true);
    setSelfTest({ steps: initialSelfTestSteps(), result: "running" });
    try {
      const { passed, steps } = await runDiagnosticsSelfTest((steps) =>
        setSelfTest({ steps, result: "running" }),
      );
      setSelfTest({ steps, result: passed ? "passed" : "failed" });
      await refresh().catch((e) => setError(String(e)));
    } finally {
      setBusy(false);
    }
  };
  useSubTabs(
    [
      { id: "capture", label: t("Capture") },
      { id: "sessions", label: t("Sessions") },
      { id: "self-test", label: t("Self-test") },
    ],
    tab,
    (id) => setTab(id as Tab),
  );

  const unavailable = isTauri()
    ? t("The diagnostics session service is not available in this build.")
    : t("Diagnostic sessions are not supported in the browser.");
  const locked = !isTauri() || busy;
  const lockReason = locked ? (busy ? t("Please wait") : unavailable) : undefined;

  return (
    <div key={tab} className="harbor-cascade flex flex-col gap-10">
      {tab === "capture" && (
        <Section
          title={t("Capture")}
          subtitle={
            error ??
            (isTauri()
              ? t("Preferences apply to new sessions. Legacy logs are unchanged.")
              : unavailable)
          }
        >
          <ToggleRow
            label={t("Enable diagnostics")}
            value={prefs.enabled}
            onChange={(value) => void capture(value)}
            lockReason={lockReason}
          />
          <SettingRow
            label={t("Capture mode")}
            desc={t("Detailed capture returns to Basic after 15 minutes.")}
          >
            <SButton
              disabled={locked}
              variant={prefs.mode === "basic" ? "primary" : "secondary"}
              onClick={() => void save({ ...prefs, mode: "basic" })}
            >
              {t("Basic")}
            </SButton>
            <SButton
              disabled={locked}
              variant={prefs.mode === "detailed" ? "primary" : "secondary"}
              onClick={() => void save({ ...prefs, mode: "detailed" })}
            >
              {t("Detailed")}
            </SButton>
          </SettingRow>
          <ToggleRow
            label={t("Start on launch")}
            value={prefs.autoStart}
            onChange={(autoStart) => void save({ ...prefs, autoStart })}
            lockReason={lockReason}
          />
          {["Playback", "Navigation", "Network", "Cache", "Images", "Runtime"].map(
            (domain, index) => (
              <ToggleRow
                key={domain}
                label={t(domain)}
                value={!!(prefs.domains & (1 << index))}
                onChange={(value) =>
                  void save({
                    ...prefs,
                    domains: value ? prefs.domains | (1 << index) : prefs.domains & ~(1 << index),
                  })
                }
                lockReason={lockReason}
              />
            ),
          )}
          <SettingRow
            label={t("Session status")}
            desc={status?.active ? status.active.sessionId : t("No active session")}
          >
            <SButton disabled={locked || !!status?.active} onClick={() => void capture(true)}>
              {t("Start")}
            </SButton>
            <SButton disabled={locked || !status?.active} onClick={() => void capture(false)}>
              {t("Stop")}
            </SButton>
            <SButton
              disabled={locked || !status?.active}
              onClick={() =>
                void run(() => startDiagnosticsSession(prefs.mode, prefs.domains, true))
              }
            >
              {t("New session")}
            </SButton>
          </SettingRow>
          <SettingRow
            label={t("Bug report diagnostics")}
            desc={t("Review the information included with a bug report.")}
          >
            <SButton onClick={() => openPage("bug")}>{t("Open bug report")}</SButton>
          </SettingRow>
        </Section>
      )}
      {tab === "sessions" && (
        <Section
          title={t("Sessions")}
          subtitle={error ?? (!isTauri() ? unavailable : t("Saved local sessions"))}
        >
          {sessions.map((session) => (
            <SettingRow
              key={session.sessionId}
              label={session.sessionId}
              desc={`${session.events} events · ${Math.round(session.bytes / 1024)} KB`}
            >
              <SButton
                disabled={locked}
                onClick={() =>
                  void run(async () => {
                    await exportDiagnosticsSession(session.sessionId);
                    await openDiagnosticsSessionFolder();
                  })
                }
              >
                {t("Export ZIP")}
              </SButton>
              <SButton
                disabled={locked}
                onClick={() => void run(() => openDiagnosticsSessionFolder(session.sessionId))}
              >
                {t("Open folder")}
              </SButton>
            </SettingRow>
          ))}
          <SettingRow
            label={t("Saved sessions")}
            desc={sessions.length ? t("Export a session above.") : t("No saved sessions.")}
          >
            <SButton
              disabled={locked}
              onClick={() => void run(() => openDiagnosticsSessionFolder())}
            >
              {t("Open folder")}
            </SButton>
          </SettingRow>
          <SettingRow label={t("Retention")} desc={t("Up to 8 sessions, 256 MB, and 7 days.")} />
        </Section>
      )}
      {tab === "self-test" && (
        <Section
          title={t("Self-test")}
          subtitle={
            isTauri()
              ? t(
                  "Checks that diagnostic capture works on this device. It starts a short test session, writes events to disk, stops it, exports it as a ZIP and checks that it is listed. Your capture settings are not changed, and the test session is kept under Sessions like any other.",
                )
              : unavailable
          }
        >
          <SettingRow
            label={t("Self-test progress")}
            desc={
              selfTest.result === "running"
                ? t("Running…")
                : selfTest.result === "passed"
                  ? t("All checks passed")
                  : selfTest.result === "failed"
                    ? t("A check failed")
                    : status?.active
                      ? t("Stop the active capture session first.")
                      : t("Not run")
            }
          >
            <SButton disabled={locked || !!status?.active} onClick={() => void runSelfTest()}>
              {t("Run self-test")}
            </SButton>
          </SettingRow>
          {selfTest.steps.map((step) => (
            <SettingRow
              key={step.id}
              label={t(step.label)}
              desc={[
                step.state === "running"
                  ? t("Running…")
                  : step.state === "passed"
                    ? t("Passed")
                    : step.state === "failed"
                      ? t("Failed")
                      : t("Not run"),
                step.detail,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          ))}
        </Section>
      )}
    </div>
  );
}
