import { realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { type PaneState, readPaneState } from "../../skills/cataly-mode/scripts/src/lane-state.ts";
import { SHELLS } from "../runtime/foreground.ts";
import type { Front } from "../runtime/herdr/probe.ts";
import { DeploymentHeld, processIdentity, sameProcess } from "./deployment-process.ts";
import type { DeploymentConfig } from "./deployment-types.ts";
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
export function shellRejection(reason: string, front: Front, pid?: number, owner?: PaneState): DeploymentHeld {
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
