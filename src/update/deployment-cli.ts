import { basename } from "node:path";
import { platform } from "../platform/index.ts";
import type { Exec } from "../runtime/exec.ts";
import { interactiveShellInFront } from "../runtime/foreground.ts";
import { hcCall, isKind } from "../runtime/hc/exec.ts";
import { probe as hcProbe } from "../runtime/hc/probe.ts";
import { HerdrCli, reasonOf } from "../runtime/herdr/exec.ts";
import { type Front, foreground as herdrForeground, probe as herdrProbe } from "../runtime/herdr/probe.ts";
import { start as herdrStart } from "../runtime/herdr/sessions.ts";
import type { ForegroundProcess, Probe } from "../runtime/types.ts";
import { DeploymentHeld, sameProcess } from "./deployment-process.ts";
import { interactiveRootShell } from "./deployment-shell.ts";
import { procChildren, procCmdline, procExeTarget, procStat } from "./proc.ts";

/** The terminal operations a managed replacement performs on the Cataly's own pane or terminal. */
export interface DeploymentCli {
  readonly exec: Exec;
  probe(pane: string, onFail: string, stateDir: string): Promise<Probe>;
  foreground(pane: string, onFail: string): Promise<Front>;
  start(pane: string, command: string): Promise<void>;
  readonly nativeUi?: {
    readonly requiresEditorReceipt?: true;
    read(pane: string, lines: number, owner: Probe): Promise<string>;
    exit(pane: string): Promise<void>;
  };
}

export function herdrDeploymentCli(exec: Exec, session?: string): DeploymentCli {
  const cli = new HerdrCli(exec, session);
  return {
    exec,
    probe: (pane, onFail, stateDir) => herdrProbe(cli, pane, false, onFail, stateDir),
    foreground: (pane, onFail) => herdrForeground(cli, pane, onFail),
    start: (pane, command) => herdrStart(cli, pane, command),
    ...(platform.supportsHerdrNativeUi
      ? {
          nativeUi: {
            read: (pane: string, lines: number) => cli.read(pane, lines),
            exit: async (pane: string) => {
              await cli.call(["pane", "send-keys", pane, "ctrl+d"]);
            },
          },
        }
      : {}),
  };
}

/**
 * hc reports a terminal's root PID and only one foreground process, so the foreground group is rebuilt from the kernel:
 * the root's controlling-terminal group, and every descendant of the root in that group.
 */
export function kernelForeground(rootPid: number): Front {
  const pgid = procStat(rootPid).tpgid;
  if (pgid <= 0) throw new Error(`terminal root ${rootPid} has no foreground process group`);
  const members: ForegroundProcess[] = [];
  const seen = new Set<number>();
  const visit = (pid: number): void => {
    if (seen.has(pid)) return;
    seen.add(pid);
    if (procStat(pid).pgid === pgid) {
      const argv = procCmdline(pid).split("\0").filter(Boolean);
      members.push({ pid, name: basename(procExeTarget(pid)), argv });
    }
    for (const child of procChildren(pid, true)) visit(child);
  };
  visit(rootPid);
  return { shell: interactiveShellInFront(members), pgid, rootPid, processes: members };
}

export function hcDeploymentCli(exec: Exec): DeploymentCli {
  const rootOf = async (pane: string): Promise<number | undefined> => {
    try {
      const pid = (await hcCall(exec, ["get", pane]))["pid"];
      return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    } catch (error) {
      if (isKind(error, "not_found")) return undefined;
      throw error;
    }
  };
  const foreground = async (pane: string, onFail: string): Promise<Front> => {
    try {
      const root = await rootOf(pane);
      if (root === undefined) throw new Error("terminal is gone");
      return kernelForeground(root);
    } catch (error) {
      process.stderr.write(`cataly: hc foreground lookup failed for ${pane} (${reasonOf(error)}); ${onFail}\n`);
      return { shell: true };
    }
  };
  return {
    exec,
    probe: async (pane, onFail, stateDir) => {
      let seen: Probe;
      try {
        seen = await hcProbe(exec, pane, stateDir);
      } catch {
        return { status: "unknown", shellInFront: true };
      }
      if (seen.status === "gone") return seen;
      const front = await foreground(pane, onFail);
      const { pgid: _pgid, rootPid: _rootPid, foreground: _foreground, ...rest } = seen;
      return {
        ...rest,
        shellInFront: front.shell,
        ...(front.pgid === undefined ? {} : { pgid: front.pgid }),
        ...(front.rootPid === undefined ? {} : { rootPid: front.rootPid }),
        ...(front.processes === undefined ? {} : { foreground: front.processes }),
      };
    },
    foreground,
    start: async (pane, command) => {
      await hcCall(exec, ["send", pane, "--", command]);
    },
    ...(platform.supportsProcessReaders
      ? {
          nativeUi: {
            requiresEditorReceipt: true as const,
            read: (pane: string, _lines: number, owner: Probe) => readHcNativeScreen(exec, pane, owner),
            exit: async (pane: string) => {
              await hcCall(exec, ["keys", pane, "ctrl+d"]);
            },
          },
        }
      : {}),
  };
}

/** Bracket the visible frame with observations of the same live OMP turn. */
async function readHcNativeScreen(exec: Exec, pane: string, owner: Probe): Promise<string> {
  const root = owner.rootPid === undefined ? undefined : interactiveRootShell(owner.rootPid);
  if (!root || owner.rootPid === owner.pid)
    throw new DeploymentHeld("hc native UI stop requires an interactive root shell, not a direct lead launch");
  const get = async () => {
    const terminal = await hcCall(exec, ["get", pane]);
    const status = terminal["status"] as { app?: unknown; state?: unknown } | undefined;
    const foreground = terminal["foreground"] as { pid?: unknown } | undefined;
    if (
      terminal["address"] !== pane ||
      terminal["state"] !== "live" ||
      terminal["pid"] !== owner.rootPid ||
      owner.pid === undefined ||
      foreground?.pid !== owner.pid ||
      !Number.isSafeInteger(owner.turn) ||
      terminal["turn"] !== owner.turn ||
      typeof terminal["identity"] !== "string" ||
      terminal["screen"] !== "exact" ||
      status?.app !== "omp" ||
      (status.state !== "idle" && status.state !== "done")
    )
      throw new DeploymentHeld("hc cannot bind the screen to the same idle OMP turn and recoverable terminal");
    return [terminal["identity"], status.state, terminal["status_ms"]];
  };
  try {
    const children = new Set(procChildren(root.identity.pid, true));
    if (children.size !== 1 || owner.pid === undefined || !children.has(owner.pid))
      throw new DeploymentHeld("hc root shell has unrelated work or does not directly own the lead");
    const before = await get();
    // The visible screen only: an editor in scrollback cannot authorize exit.
    const frame = await hcCall(exec, ["read", pane]);
    const after = await get();
    if (
      frame["complete"] === true &&
      frame["how"] === "screen" &&
      typeof frame["text"] === "string" &&
      before.every((value, i) => value === after[i]) &&
      sameProcess(root.identity)
    )
      return frame["text"];
  } catch (error) {
    if (error instanceof DeploymentHeld) throw error;
  }
  throw new DeploymentHeld("hc current screen is incomplete, unreadable or changed during observation");
}
