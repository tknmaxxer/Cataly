import { DeploymentHeld, sameProcess } from "./deployment-process.ts";
import type { HcTerminalIdentity } from "./deployment-types.ts";
import { procChildren, procStat } from "./proc.ts";

export type HcIdleTurn = {
  readonly turn: number;
  readonly status: "idle" | "done";
  readonly statusMs: number;
  readonly screenIdentity: string;
};
export class HcTerminalChanged extends DeploymentHeld {}

export function requireHcTerminal(expected?: HcTerminalIdentity, actual?: HcTerminalIdentity): void {
  if (
    !expected?.root ||
    !actual ||
    expected.address !== actual.address ||
    expected.createdMs !== actual.createdMs ||
    !sameProcess(expected.root, actual.root) ||
    !sameProcess(expected.root)
  )
    throw new HcTerminalChanged("hc terminal or root shell differs from the journaled owner");
}

export function hcIdleTurn(terminal: Record<string, unknown>, pid: number): HcIdleTurn | undefined {
  const status = terminal["status"] as { app?: unknown; state?: unknown } | undefined;
  const foreground = terminal["foreground"] as { pid?: unknown } | undefined;
  const turn = terminal["turn"];
  const statusMs = terminal["status_ms"];
  const screenIdentity = terminal["identity"];
  if (
    foreground?.pid !== pid ||
    terminal["screen"] !== "exact" ||
    status?.app !== "omp" ||
    (status.state !== "idle" && status.state !== "done") ||
    typeof turn !== "number" ||
    !Number.isSafeInteger(turn) ||
    typeof statusMs !== "number" ||
    !Number.isSafeInteger(statusMs) ||
    typeof screenIdentity !== "string"
  )
    return undefined;
  return { turn, status: status.state, statusMs, screenIdentity };
}

export function sameHcTurn(expected: HcIdleTurn, actual?: HcIdleTurn): boolean {
  return (
    actual?.turn === expected.turn &&
    actual.status === expected.status &&
    actual.statusMs === expected.statusMs &&
    actual.screenIdentity === expected.screenIdentity
  );
}

/** Both the controller and the exiting owner require the same recoverable foreground. */
export function ownsHcForeground(terminal: HcTerminalIdentity, pid: number): boolean {
  try {
    const children = new Set(procChildren(terminal.root.pid, true));
    const owner = procStat(pid);
    return (
      children.size === 1 &&
      children.has(pid) &&
      owner.ppid === terminal.root.pid &&
      owner.pgid === procStat(terminal.root.pid).tpgid &&
      sameProcess(terminal.root)
    );
  } catch {
    return false;
  }
}
