import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Exec, spawnExec } from "../runtime/exec.ts";
import { hcCall } from "../runtime/hc/exec.ts";
import { saveDeploymentText } from "./deployment-files.ts";
import { type HcIdleTurn, hcIdleTurn, ownsHcForeground, requireHcTerminal, sameHcTurn } from "./deployment-hc.ts";
import { hcTerminalIdentity } from "./deployment-shell.ts";
import type { HcTerminalIdentity } from "./deployment-types.ts";

type ExitAdmission = {
  readonly token: string;
  readonly terminal: HcTerminalIdentity;
  readonly idle: HcIdleTurn;
};
type ExitRequest = ExitAdmission & {
  readonly pid: number;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly expires: number;
};
type Owner = Pick<ExitRequest, "pid" | "sessionId" | "startedAt"> & {
  readonly stateDir: string;
  readonly pane: string;
  readonly shutdownIfIdle: () => void;
};

const requestPath = (stateDir: string, token: string) => join(stateDir, "runtime", `hc-exit-${token}.json`);
export const validExitToken = (token: unknown): token is string =>
  typeof token === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(token);

export function discardHcExit(stateDir: string, token: string): void {
  rmSync(requestPath(stateDir, token), { force: true });
}

/** Publish once, only after the durable stop intent. A reader never sees a partially written request. */
export function publishHcExit(stateDir: string, request: ExitRequest): void {
  if (!validExitToken(request.token)) throw new Error("invalid hc exit admission");
  saveDeploymentText(requestPath(stateDir, request.token), JSON.stringify(request), { createOnly: true });
}

/** The terminal never receives an exit key. Only this OMP incarnation can consume its single-use offer. */
export class HcOwnerExit {
  readonly token = randomUUID();
  #used = false;

  get available(): boolean {
    return !this.#used;
  }

  async poll(owner: Owner, exec: Exec = spawnExec): Promise<void> {
    if (this.#used) return;
    const path = requestPath(owner.stateDir, this.token);
    try {
      const raw = readFileSync(path, "utf8");
      this.#used = true;
      rmSync(path);
      const request = JSON.parse(raw) as ExitRequest;
      if (
        request.token !== this.token ||
        request.pid !== owner.pid ||
        request.sessionId !== owner.sessionId ||
        request.startedAt !== owner.startedAt ||
        !Number.isSafeInteger(request.expires) ||
        !(Date.now() < request.expires)
      )
        return;
      const terminal = await hcCall(exec, ["get", owner.pane]);
      requireHcTerminal(request.terminal, hcTerminalIdentity(terminal, owner.pane));
      if (
        sameHcTurn(request.idle, hcIdleTurn(terminal, owner.pid)) &&
        ownsHcForeground(request.terminal, owner.pid) &&
        Date.now() < request.expires
      )
        owner.shutdownIfIdle();
    } catch {
      // Absent, expired, malformed or changed evidence never grants an exit.
    }
  }
}
