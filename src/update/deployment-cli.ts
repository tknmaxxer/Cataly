import { basename } from "node:path";
import { platform } from "../platform/index.ts";
import type { Exec } from "../runtime/exec.ts";
import { interactiveShellInFront } from "../runtime/foreground.ts";
import { hcCall } from "../runtime/hc/exec.ts";
import { probe as hcProbe } from "../runtime/hc/probe.ts";
import { HerdrCli, reasonOf } from "../runtime/herdr/exec.ts";
import { type Front, foreground as herdrForeground, probe as herdrProbe } from "../runtime/herdr/probe.ts";
import { start as herdrStart } from "../runtime/herdr/sessions.ts";
import type { ForegroundProcess, Probe } from "../runtime/types.ts";
import { type HcIdleTurn, hcIdleTurn, ownsHcForeground, requireHcTerminal, sameHcTurn } from "./deployment-hc.ts";
import { DeploymentHeld } from "./deployment-process.ts";
import { hcTerminalIdentity } from "./deployment-shell.ts";
import type { HcTerminalIdentity } from "./deployment-types.ts";
import { procChildren, procCmdline, procExeTarget, procStat } from "./proc.ts";

type DeploymentFront = Front & { readonly hcTerminal?: HcTerminalIdentity };
type HcScreen = { readonly text: string; readonly terminal: HcTerminalIdentity; readonly idle: HcIdleTurn };

/** The terminal operations a managed replacement performs on the Cataly's own pane or terminal. */
export interface DeploymentCli {
  readonly exec: Exec;
  probe(pane: string, onFail: string, stateDir: string): Promise<Probe>;
  foreground(pane: string, onFail: string): Promise<DeploymentFront>;
  start(pane: string, command: string): Promise<void>;
  readonly nativeUi?: {
    read(pane: string, lines: number, owner: Probe): Promise<string | HcScreen>;
    exit?(pane: string): Promise<void>;
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
  const foreground = async (pane: string, onFail: string): Promise<DeploymentFront> => {
    let identity: HcTerminalIdentity | undefined;
    try {
      const terminal = await hcCall(exec, ["get", pane]);
      const pid = terminal["pid"];
      if (typeof pid !== "number" || terminal["state"] !== "live") throw new Error("terminal is gone");
      identity = hcTerminalIdentity(terminal, pane);
      return { ...kernelForeground(pid), ...(identity ? { hcTerminal: identity } : {}) };
    } catch (error) {
      process.stderr.write(`cataly: hc foreground lookup failed for ${pane} (${reasonOf(error)}); ${onFail}\n`);
      // A just-exited child can vanish during the kernel walk. This proves no
      // foreground, but does not invalidate the surviving terminal/root receipt.
      return { shell: true, ...(identity ? { hcTerminal: identity } : {}) };
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
            read: (pane: string, _lines: number, owner: Probe) => readHcNativeScreen(exec, pane, owner),
          },
        }
      : {}),
  };
}

/** Bracket the visible frame with observations of the same live OMP turn. */
async function readHcNativeScreen(exec: Exec, pane: string, owner: Probe): Promise<HcScreen> {
  const pid = owner.pid;
  if (owner.rootPid === undefined || pid === undefined || owner.rootPid === pid)
    throw new DeploymentHeld("hc native UI stop requires an interactive root shell, not a direct lead launch");
  const get = async () => {
    const row = await hcCall(exec, ["get", pane]);
    const terminal = hcTerminalIdentity(row, pane);
    const idle = hcIdleTurn(row, pid);
    if (!terminal || terminal.root.pid !== owner.rootPid || !idle || idle.turn !== owner.turn)
      throw new DeploymentHeld("hc cannot bind the screen to the same idle OMP turn and recoverable terminal");
    return { terminal, idle };
  };
  try {
    const before = await get();
    // The visible screen only: an editor in scrollback cannot authorize exit.
    const frame = await hcCall(exec, ["read", pane]);
    const after = await get();
    requireHcTerminal(before.terminal, after.terminal);
    if (
      frame["complete"] === true &&
      frame["how"] === "screen" &&
      typeof frame["text"] === "string" &&
      sameHcTurn(before.idle, after.idle) &&
      ownsHcForeground(after.terminal, pid)
    )
      return { ...after, text: frame["text"] };
  } catch (error) {
    if (error instanceof DeploymentHeld) throw error;
  }
  throw new DeploymentHeld("hc current screen is incomplete, unreadable or changed during observation");
}
