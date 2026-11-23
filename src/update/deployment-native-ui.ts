import { realpathSync } from "node:fs";
import { readPaneState } from "../../skills/cataly-mode/scripts/src/lane-state.ts";
import type { DeploymentCli } from "./deployment-cli.ts";
import { requireHcTerminal } from "./deployment-hc.ts";
import { publishHcExit, validExitToken } from "./deployment-hc-exit.ts";
import { attestMonitorForeground, readRuntimeHealth } from "./deployment-monitor-receipts.ts";
import { DeploymentBusy, DeploymentHeld, sameProcess, underProcess } from "./deployment-process.ts";
import type { DeploymentConfig, DeploymentRecord, RuntimeHealth, RuntimeIdentity } from "./deployment-types.ts";
import { procStat } from "./proc.ts";
import { sourceManifest } from "./source.ts";

/** Only the observed two-row empty native editors; unknown layouts and drafts stay held. */
function emptyNativeInput(screen: string, hasEditorReceipt: boolean): boolean {
  const lines = screen.split("\n");
  while (lines.at(-1) === "") lines.pop();
  const [header, input] = lines.slice(-2);
  return (
    (typeof header === "string" &&
      /^╭─+ .+─+╮$/.test(header) &&
      /^╰─ +(?:⇧⇥ to change thinking effort )?─╯$/.test(input ?? "")) ||
    (typeof header === "string" &&
      /^ π > ⬢ .+ > .+$/.test(header) &&
      (input === "╰─" || (hasEditorReceipt && /^╰─ +⇧⇥ to change thinking effort$/.test(input ?? ""))))
  );
}

/** Plain hc screen rows cannot distinguish a whitespace draft from layout padding. */
function editorToken(health: RuntimeHealth | undefined, expected: RuntimeIdentity): string {
  const age = health ? Date.now() - Date.parse(health.updatedAt) : Infinity;
  if (
    health?.editorEmpty === true &&
    validExitToken(health.hcExitToken) &&
    health.pid === expected.pid &&
    health.startedAt === expected.startedAt &&
    age >= 0 &&
    age <= 1_500
  )
    return health.hcExitToken;
  throw new DeploymentHeld("hc native UI stop requires a fresh empty-editor receipt and exit offer from the same lead");
}

/** A failed acknowledgement cannot disprove delivery; the caller must still observe exit and the bare shell. */
export async function requestNativeUiExit(
  cli: DeploymentCli,
  config: DeploymentConfig,
  owner: RuntimeIdentity,
  offer: Awaited<ReturnType<typeof assertNativeUiIdle>>,
  expires: number,
): Promise<DeploymentHeld | undefined> {
  try {
    if (offer) {
      publishHcExit(config.stateDir, {
        ...offer,
        pid: owner.pid,
        sessionId: owner.sessionId,
        startedAt: owner.startedAt,
        expires,
      });
    } else if (config.runtime !== "hc" && cli.nativeUi?.exit) {
      await cli.nativeUi.exit(config.pane);
    } else throw new Error("missing native UI exit operation");
    return undefined;
  } catch {
    return new DeploymentHeld("native UI exit acknowledgement is unavailable and exit remains unobserved");
  }
}

export function forwardStopStarted(config: DeploymentConfig, record: DeploymentRecord): boolean {
  return Boolean(
    record.nativeExitObservedAt ||
    (config.nativeStopMode === "ui" ? record.nativeUiExitRequestedAt : record.stopRequestedAt),
  );
}

/** A retry window never authorizes a native effect after its durable deadline. */
export function assertRetryDeadline(config: DeploymentConfig, record: DeploymentRecord): void {
  if (forwardStopStarted(config, record) || record.retryDeadlineAt === undefined) return;
  if (!(Date.now() < Date.parse(record.retryDeadlineAt)))
    throw new DeploymentHeld("deployment pre-stop retry deadline expired or is invalid");
}

/** Never certify a possibly exiting old actor as restored; keep both consumers' forward intent resumable. */
export function holdPendingNativeUiExit(record: DeploymentRecord): boolean {
  if (!record.nativeUiExitRequestedAt || record.step !== "stop") return false;
  record.status = "held";
  return true;
}

/** Reobserve immediately before the durable one-shot request; this never interrupts a working actor. */
export async function assertNativeUiIdle(
  config: DeploymentConfig,
  cli: DeploymentCli,
  expected: RuntimeIdentity,
  record?: DeploymentRecord,
) {
  if (!cli.nativeUi) throw new DeploymentHeld("native UI stop requires supported screen and exit operations");
  const current = await cli.probe(config.pane, "deployment held", config.stateDir);
  let health: RuntimeHealth | undefined;
  if (config.runtime === "hc") {
    try {
      health = readRuntimeHealth(config);
    } catch {
      // Malformed health cannot authorize exit.
    }
  }
  const screen = await cli.nativeUi.read(config.pane, 30, current);
  const hc = typeof screen !== "string";
  const group = (pid: number): number => {
    try {
      return procStat(pid).pgid;
    } catch {
      throw new DeploymentHeld("native UI foreground ownership is unavailable");
    }
  };
  if (
    current.pgid !== group(expected.pid) ||
    !current.foreground ||
    current.foreground.filter(({ pid }) => pid === expected.pid).length !== 1 ||
    new Set(current.foreground.map(({ pid }) => pid)).size !== current.foreground.length ||
    current.foreground.some(({ pid }) => !pid || !underProcess(pid, expected.pid) || group(pid) !== current.pgid)
  )
    throw new DeploymentHeld("native UI foreground ownership changed before stop");
  if (current.shellInFront) attestMonitorForeground(config, expected, current);
  for (const monitor of record?.oldMonitors ?? []) {
    if (!sameProcess(monitor) || monitor.pid === expected.pid || !underProcess(monitor.pid, expected.pid))
      throw new DeploymentHeld("monitor identity changed before native stop");
  }
  if (record?.oldSourceHash && sourceManifest(realpathSync(config.liveSource)).hash !== record.oldSourceHash)
    throw new DeploymentHeld("previous source changed after its handoff journal");
  if (underProcess(process.pid, expected.pid) || group(process.pid) === current.pgid)
    throw new DeploymentHeld("UI replacement controller must run independently outside the target actor");
  const state = readPaneState(config.stateDir, config.pane);
  if (current.status === "working" || state?.agentStatus === "working")
    throw new DeploymentBusy("native Cataly is busy; waiting for its idle boundary");
  if (
    (current.status !== "idle" && current.status !== "done") ||
    current.agent !== "omp" ||
    current.pid !== expected.pid ||
    current.sessionId !== expected.sessionId ||
    expected.pane !== config.pane ||
    expected.sessionId !== config.sessionId ||
    !state ||
    state.role !== "cataly" ||
    state.paneId !== config.pane ||
    state.pid !== expected.pid ||
    state.sessionId !== expected.sessionId ||
    state.sessionFile !== expected.sessionFile ||
    state.startedAt !== expected.startedAt ||
    state.cwd !== expected.cwd ||
    state.approvalPending ||
    state.agentStatus !== "idle" ||
    !current.rootPid ||
    !underProcess(expected.pid, current.rootPid) ||
    !emptyNativeInput(hc ? screen.text : screen, hc)
  )
    throw new DeploymentHeld("native UI stop requires the same idle owner and observed empty native input");
  if (!sameProcess(expected)) throw new DeploymentHeld("native runtime changed before UI stop");
  if (config.runtime === "hc") {
    if (!hc) throw new DeploymentHeld("hc native UI stop lacks a bound screen");
    requireHcTerminal(expected.hcTerminal, screen.terminal);
    return { token: editorToken(health, expected), terminal: screen.terminal, idle: screen.idle };
  }
  if (!cli.nativeUi.exit) throw new DeploymentHeld("native UI stop requires a supported exit operation");
  return undefined;
}
