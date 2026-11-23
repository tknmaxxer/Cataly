import { realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { type PaneState, readPaneState } from "../../skills/cataly-mode/scripts/src/lane-state.ts";
import { SHELLS } from "../runtime/foreground.ts";
import type { Front } from "../runtime/herdr/probe.ts";
import type { DeploymentCli } from "./deployment-cli.ts";
import { requireHcTerminal } from "./deployment-hc.ts";
import { DeploymentHeld, processIdentity, sameProcess } from "./deployment-process.ts";
import type { DeploymentConfig, HcTerminalIdentity, ProcessIdentity } from "./deployment-types.ts";
import { procChildren, procCmdline, procExe, procStat } from "./proc.ts";

/** The root must survive the actor's exit and be able to return to an ordinary prompt. */
export function interactiveRootShell(pid: number) {
  const identity = processIdentity(pid);
  if (!identity || !SHELLS.has(basename(identity.executable))) return undefined;
  try {
    const argv = procCmdline(pid).split("\0").filter(Boolean);
    const argv0 = argv[0] ?? "";
    const invoked = basename(argv0).replace(/^-/, "");
    const matchesImage = isAbsolute(argv0)
      ? realpathSync(argv0) === realpathSync(procExe(pid))
      : invoked === basename(identity.executable);
    if (
      !matchesImage ||
      argv.slice(1).some((arg) => !/^-[il]+$|^--(?:login|interactive|noprofile|norc)$/.test(arg)) ||
      !sameProcess(identity)
    )
      return undefined;
    return { identity, invoked, argv };
  } catch {
    return undefined;
  }
}

export function hcTerminalIdentity(terminal: Record<string, unknown>, pane: string): HcTerminalIdentity | undefined {
  const pid = terminal["pid"];
  const createdMs = terminal["created_ms"];
  if (
    terminal["address"] !== pane ||
    terminal["state"] !== "live" ||
    typeof createdMs !== "number" ||
    !Number.isSafeInteger(createdMs) ||
    createdMs <= 0 ||
    typeof pid !== "number"
  )
    return undefined;
  const root = interactiveRootShell(pid);
  return root && { address: pane, createdMs, root: root.identity };
}

/** A foreground child shell is never the pane's bare prompt, including suspended/background native owners. */
export function bareRootShell(config: DeploymentConfig, front: Front): boolean {
  if (
    !front.shell ||
    !front.rootPid ||
    front.pgid !== front.rootPid ||
    front.processes?.length !== 1 ||
    front.processes[0]?.pid !== front.rootPid
  )
    return false;
  const owner = readPaneState(config.stateDir, config.pane);
  if (owner && processIdentity(owner.pid)) return false;
  const root = interactiveRootShell(front.rootPid);
  if (!root) return false;
  try {
    const entry = front.processes[0]!;
    const { identity, invoked, argv } = root;
    const { pgid, tpgid } = procStat(identity.pid);
    if (
      basename(entry.name).replace(/^-/, "") !== invoked ||
      argv.length !== entry.argv.length ||
      argv.some((arg, index) => arg !== entry.argv[index]) ||
      pgid !== front.pgid ||
      (tpgid > 0 && tpgid !== front.pgid) ||
      procChildren(identity.pid, true).length > 0
    )
      return false;
    return sameProcess(identity);
  } catch {
    return false;
  }
}

/** Failure-only witnesses exclude process arguments and private session contents. */
function shellRejection(reason: string, front: Front, pid?: number, owner?: PaneState): DeploymentHeld {
  return new DeploymentHeld(
    `${reason}: ${JSON.stringify({
      pid: pid ?? null,
      shell: front.shell,
      rootPid: front.rootPid ?? null,
      pgid: front.pgid ?? null,
      pids: front.processes?.map((process) => process.pid ?? null) ?? null,
      ...(owner ? { owner: { pid: owner.pid, sessionId: owner.sessionId, role: owner.role } } : {}),
    })}`,
  );
}

export async function requireShell(
  config: DeploymentConfig,
  cli: DeploymentCli,
  stopped?: ProcessIdentity,
  until = Date.now() + config.stopTimeoutMs,
  terminal?: HcTerminalIdentity,
): Promise<void> {
  for (;;) {
    if (stopped && Date.now() >= until) throw new DeploymentHeld("target pane is not an observed shell");
    const seen = await cli.foreground(config.pane, "deployment held");
    if (config.runtime === "hc") requireHcTerminal(terminal, seen.hcTerminal);
    if (stopped) {
      const owner = readPaneState(config.stateDir, config.pane);
      if (processIdentity(stopped.pid))
        throw shellRejection("native owner changed while awaiting shell (stopped PID is live)", seen, stopped.pid);
      if (owner && processIdentity(owner.pid))
        throw shellRejection("native owner changed while awaiting shell (pane owner is live)", seen, owner.pid, owner);
      const conflict = seen.processes?.find(
        (p) => p.pid !== undefined && (!seen.shell || p.pid !== seen.rootPid) && processIdentity(p.pid),
      );
      if (conflict)
        throw shellRejection("native owner changed while awaiting shell (foreground PID is live)", seen, conflict.pid);
    }
    if (bareRootShell(config, seen) && (!stopped || Date.now() < until)) return;
    if (!stopped || Date.now() >= until) throw shellRejection("target pane is not an observed shell", seen);
    await Bun.sleep(Math.min(50, until - Date.now()));
  }
}
