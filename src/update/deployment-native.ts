import { readFileSync, realpathSync } from "node:fs";
import { type DeploymentCli, hcDeploymentCli, herdrDeploymentCli } from "./deployment-cli.ts";
import { runtimeBinary } from "./deployment-config.ts";
import { readPaneState } from "../../skills/cataly-mode/scripts/src/lane-state.ts";
import type { Exec } from "../runtime/exec.ts";
import { HcTerminalChanged, requireHcTerminal } from "./deployment-hc.ts";
import { discardHcExit } from "./deployment-hc-exit.ts";
import type { LegacyRollbackForeground } from "./deployment-legacy-monitors.ts";
import { attestMonitorForeground } from "./deployment-monitor-receipts.ts";
import { assertMonitorStopSafe } from "./deployment-monitors.ts";
import {
  assertNativeUiIdle,
  assertRetryDeadline,
  forwardStopStarted,
  requestNativeUiExit,
} from "./deployment-native-ui.ts";
import {
  actorEnv,
  DeploymentBusy,
  DeploymentHeld,
  processIdentity,
  sameProcess,
  underProcess,
} from "./deployment-process.ts";
import { consumeQuiesceCheckpoint, verifyQuiesceCheckpoint } from "./deployment-quiesce.ts";
import { requireShell } from "./deployment-shell.ts";
import { terminateBoundProcess } from "./deployment-signal.ts";
import type {
  DeploymentConfig,
  DeploymentRecord,
  MonitorProcessIdentity,
  RuntimeIdentity,
} from "./deployment-types.ts";
import { digest, sourceManifest } from "./source.ts";
import { procExe } from "./proc.ts";

const executableHashes = new Map<string, string>();

export function nativeCli(config: DeploymentConfig, signal?: AbortSignal): DeploymentCli {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const exec: Exec = async (cmd, argv) => {
    if (signal?.aborted) throw new DeploymentHeld("native observation interrupted");
    const environment = actorEnv(config);
    // lstart has no offset; its ps producer and Date.parse observer must use the same zone.
    if (cmd === "ps") environment["TZ"] = timezone;
    const proc = Bun.spawn([cmd === (config.runtime ?? "herdr") ? runtimeBinary(config) : cmd, ...argv], {
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const stop = (): void => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 15_000);
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return { code, stdout, stderr: "" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  };
  return config.runtime === "hc" ? hcDeploymentCli(exec) : herdrDeploymentCli(exec, config.herdrSession ?? "");
}

export async function captureRuntime(
  config: DeploymentConfig,
  cli: DeploymentCli,
  allowWorking = false,
  quiesce?: DeploymentRecord,
  rollback?: LegacyRollbackForeground,
): Promise<RuntimeIdentity> {
  const state = readPaneState(config.stateDir, config.pane);
  const current = await cli.probe(config.pane, "deployment held", config.stateDir);
  if (
    state?.role !== "cataly" ||
    state.sessionId !== config.sessionId ||
    state.paneId !== config.pane ||
    current.pid !== state.pid ||
    current.sessionId !== state.sessionId ||
    (state.approvalPending && !allowWorking) ||
    (current.status !== "idle" &&
      current.status !== "done" &&
      current.status !== "working" &&
      !(allowWorking && current.status === "blocked" && state.approvalPending)) ||
    typeof state.sessionFile !== "string" ||
    !state.sessionFile ||
    typeof state.cwd !== "string"
  )
    throw new DeploymentHeld("native Cataly identity, idle state or approval boundary did not match");
  const identity = processIdentity(state.pid);
  if (!identity) throw new DeploymentHeld("native PID identity is unavailable");
  const terminal =
    config.runtime === "hc" ? (await cli.foreground(config.pane, "deployment held")).hcTerminal : undefined;
  if (
    config.runtime === "hc" &&
    (!terminal ||
      terminal.root.pid !== current.rootPid ||
      terminal.root.pid === state.pid ||
      !underProcess(state.pid, terminal.root.pid) ||
      !sameProcess(terminal.root))
  )
    throw new HcTerminalChanged("hc native owner has no recoverable terminal/root shell identity");
  const key = JSON.stringify(identity);
  let executableHash = executableHashes.get(key);
  if (!executableHash) {
    executableHash = digest(readFileSync(procExe(identity.pid)));
    if (!sameProcess(identity)) throw new DeploymentHeld("native executable changed during capture");
    executableHashes.set(key, executableHash);
  }
  const runtime: RuntimeIdentity = {
    ...identity,
    pane: config.pane,
    role: "cataly",
    sessionId: state.sessionId,
    sessionFile: state.sessionFile,
    startedAt: state.startedAt,
    cwd: state.cwd,
    executableHash,
    ...(terminal ? { hcTerminal: terminal } : {}),
  };
  if (
    rollback &&
    (!sameProcess(rollback.runtime, runtime) ||
      rollback.runtime.pane !== runtime.pane ||
      rollback.runtime.role !== runtime.role ||
      rollback.runtime.sessionId !== runtime.sessionId ||
      rollback.runtime.sessionFile !== runtime.sessionFile ||
      rollback.runtime.startedAt !== runtime.startedAt ||
      rollback.runtime.cwd !== runtime.cwd)
  )
    throw new DeploymentHeld("native runtime differs from the controller-owned legacy rollback receipt");
  if (current.shellInFront) {
    try {
      attestMonitorForeground(config, runtime, current, rollback);
    } catch (error) {
      if (error instanceof DeploymentHeld) throw error;
      throw new DeploymentHeld("native foreground monitor attestation is unavailable");
    }
  }
  const latest = readPaneState(config.stateDir, config.pane);
  if (
    !latest ||
    latest.pid !== state.pid ||
    latest.role !== "cataly" ||
    latest.paneId !== config.pane ||
    latest.sessionId !== state.sessionId ||
    latest.startedAt !== state.startedAt ||
    latest.sessionFile !== state.sessionFile ||
    latest.cwd !== state.cwd
  )
    throw new DeploymentHeld("native identity changed during observation");
  if (!allowWorking && latest.approvalPending)
    throw new DeploymentHeld("native approval became pending during observation");
  const busy = current.status === "working" || latest.agentStatus === "working";
  if (busy && !allowWorking) {
    if (!quiesce) throw new DeploymentBusy("native Cataly is busy; waiting for its idle boundary");
    verifyQuiesceCheckpoint(config, quiesce, runtime);
  }
  return { ...runtime, busy, approvalPending: latest.approvalPending };
}

/** One identity-bound forward stop; rollback cleanup retains its bound signal path. */
export async function stopRuntime(
  config: DeploymentConfig,
  cli: DeploymentCli,
  record: DeploymentRecord,
  persist: (record: DeploymentRecord) => void,
  allowQuiesce = false,
  finalAdmission?: () => void,
): Promise<void> {
  const expected = record.oldRuntime;
  if (!expected) throw new DeploymentHeld("native stop has no journaled owner identity");
  if (!sameProcess(expected)) {
    if (processIdentity(expected.pid)) throw new DeploymentHeld("native PID has been reused");
    await requireShell(config, cli, expected, undefined, expected.hcTerminal);
    assertRetryDeadline(config, record);
    if (!forwardStopStarted(config, record)) finalAdmission?.();
    record.stopRequestedAt ??= new Date().toISOString();
    record.nativeExitObservedAt ??= new Date().toISOString();
    persist(record);
    consumeQuiesceCheckpoint(config, record);
    return;
  }
  const ui = config.nativeStopMode === "ui";
  let uiFailure: DeploymentHeld | undefined;
  let exitToken: string | undefined;
  let until = Date.now() + config.stopTimeoutMs;
  if (!ui || !record.nativeUiExitRequestedAt) {
    const actual = await captureRuntime(config, cli, false, allowQuiesce ? record : undefined);
    if (config.runtime === "hc") requireHcTerminal(expected.hcTerminal, actual.hcTerminal);
    if (
      !sameProcess(expected, actual) ||
      actual.startedAt !== expected.startedAt ||
      actual.sessionFile !== expected.sessionFile
    )
      throw new DeploymentHeld("native runtime changed before stop");
    if (expected.pid === process.pid)
      throw new DeploymentHeld("replacement controller must run outside the target actor");
    for (const monitor of record.oldMonitors ?? []) {
      if (!sameProcess(monitor) || monitor.pid === expected.pid || !underProcess(monitor.pid, expected.pid))
        throw new DeploymentHeld("monitor identity changed before native stop");
    }
    if (record.oldSourceHash && sourceManifest(realpathSync(config.liveSource)).hash !== record.oldSourceHash)
      throw new DeploymentHeld("previous source changed after its handoff journal");
    const offer = ui ? await assertNativeUiIdle(config, cli, expected, record) : undefined;
    assertMonitorStopSafe(config, record);
    assertRetryDeadline(config, record);
    if (!forwardStopStarted(config, record)) finalAdmission?.();
    record.stopRequestedAt ??= new Date().toISOString();
    persist(record);
    consumeQuiesceCheckpoint(config, record);
    if (ui) {
      record.nativeUiExitRequestedAt = new Date().toISOString();
      persist(record);
      exitToken = offer?.token;
      until = Date.now() + config.stopTimeoutMs;
      uiFailure = await requestNativeUiExit(cli, config, expected, offer, until);
      // Keep herdr's shell observation window independent of its key acknowledgement.
      if (!offer) until = Date.now() + config.stopTimeoutMs;
    } else {
      terminateBoundProcess(expected);
      until = Date.now() + config.stopTimeoutMs;
    }
  }
  try {
    while (sameProcess(expected) && Date.now() < until) await Bun.sleep(50);
    if (sameProcess(expected)) throw uiFailure ?? new DeploymentHeld("native runtime did not stop within its bound");
    if (processIdentity(expected.pid)) throw new DeploymentHeld("native PID was reused after stop");
    await requireShell(config, cli, expected, until, expected.hcTerminal);
  } finally {
    if (exitToken) discardHcExit(config.stateDir, exitToken);
  }
}

export async function stopRecordedMonitors(
  config: DeploymentConfig,
  monitors: readonly MonitorProcessIdentity[],
): Promise<void> {
  for (const monitor of monitors) {
    if (!sameProcess(monitor)) continue;
    terminateBoundProcess(monitor);
  }
  const until = Date.now() + config.stopTimeoutMs;
  while (monitors.some((identity) => sameProcess(identity)) && Date.now() < until) await Bun.sleep(50);
  if (monitors.some((identity) => sameProcess(identity))) throw new DeploymentHeld("owned old monitors did not stop");
}
