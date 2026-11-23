import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writePaneState } from "../skills/cataly-mode/scripts/src/lane-state.ts";
import { parseDeploymentConfig } from "../src/update/deployment.ts";
import { hcDeploymentCli } from "../src/update/deployment-cli.ts";
import { ownReleaseRoot } from "../src/update/deployment-files.ts";
import { launchedProcess, launchRuntime, stopLaunchedProcess } from "../src/update/deployment-launch.ts";
import { captureRuntime, requireShell, stopRuntime } from "../src/update/deployment-native.ts";
import { DeploymentHeld, sameProcess } from "../src/update/deployment-process.ts";
import type { DeploymentRecord, RuntimeIdentity } from "../src/update/deployment-types.ts";
import { digest } from "../src/update/source.ts";
import { applyHcSource } from "./e2e-hc-deploy-cli.ts";
import { catalyEnv, hc, hcBin, newHome, screen, session, startCore, stopCore, until } from "./e2e-hc-setup.ts";

// Real hc, one isolated core: the foreground group a managed replacement reads is rebuilt from the kernel.
// The native observer's locale, as actorEnv sets it: ps prints its start time in a form Date.parse reads.
const env = {
  ...catalyEnv(newHome("deploy")),
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
};
const cli = hcDeploymentCli(async (cmd, argv) => {
  const p = Bun.spawn([cmd, ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
});

beforeAll(async () => {
  if (hcBin) await startCore();
});
afterAll(async () => {
  if (hcBin) await stopCore();
});

test.skipIf(!hcBin)(
  "an hc terminal's foreground is its bare shell, then exactly the program started in it",
  async () => {
    // Given an hc terminal running an interactive Bash at its prompt.
    const { address } = (await hc(
      "run",
      "--bg",
      "--no-parent",
      "--no-notify",
      "--",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-i",
    )) as {
      address: string;
    };
    const bare = await until("a bare shell", async () => {
      const front = await cli.foreground(address, "held");
      return front.processes?.length === 1 ? front : undefined;
    });
    // Then the foreground is that shell alone, leading its own group.
    expect(bare.shell).toBe(true);
    expect(bare.processes![0]).toMatchObject({ pid: bare.rootPid, name: "bash" });
    expect(bare.pgid).toBe(bare.rootPid);
    // When a program is started in it.
    await cli.start(address, "exec 3>&-; sleep 300");
    const running = await until("the started program in front", async () => {
      const front = await cli.foreground(address, "held");
      return front.processes?.some((p) => p.name === "sleep") ? front : undefined;
    });
    // Then that program is the whole foreground group, the shell stays its root, and no shell is in front.
    expect(running.shell).toBe(false);
    expect(running.rootPid).toBe(bare.rootPid);
    expect(running.processes).toEqual([{ pid: running.pgid!, name: "sleep", argv: ["sleep", "300"] }]);
    // And the probe reports the same kernel foreground.
    const probe = await cli.probe(address, "held", newHome("deploy-state"));
    expect(probe).toMatchObject({ shellInFront: false, rootPid: bare.rootPid, pgid: running.pgid });
    await hc("kill", address);
  },
);

test.skipIf(!hcBin)(
  "hc holds a visible draft, exits the idle lead into the bare shell and resumes the same session",
  async () => {
    // Given an hc terminal at an interactive Bash prompt and a deployment of that terminal with a private native stand-in.
    const root = realpathSync(newHome("deploy-launch"));
    const { address } = (await hc(
      "run",
      "--bg",
      "--no-parent",
      "--no-notify",
      "--cwd",
      root,
      "--",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-i",
    )) as {
      address: string;
    };
    const config = parseDeploymentConfig(
      {
        releaseRoot: "managed",
        liveSource: "home/.cataly/src",
        home: "home",
        catalyHome: "home/.cataly",
        catalyConfig: "home/.cataly/config.json",
        stateDir: "home/.cataly/state",
        bun: process.execPath,
        omp: "omp",
        runtime: "hc",
        nativeStopMode: "ui",
        hc: hcBin!,
        hcSession: session,
        pane: address,
        sessionId: "preserved-session",
        model: "openai-codex/gpt-6.1-sol",
        restartLock: "home/.cataly/restart.lock",
        launcherPath: "home/.cataly/bin/restart",
        healthTimeoutMs: 100,
        stopTimeoutMs: 5_000,
      },
      root,
    );
    writeFileSync(
      config.omp,
      `#!${process.execPath}
let draft = "owner draft";
const draw = () => process.stdout.write("\\x1b[2J\\x1b[H π > ⬢ GPT-4o > workspace ▶────6%────128K─\\r\\n╰─ " +
  (draft || "    ⇧⇥ to change thinking effort") + "\\r\\n");
process.stdin.setRawMode(true);
process.stdin.on("data", (input) => {
  if (input.includes(21)) { draft = ""; draw(); }
  if (input.includes(32)) { draft = "   "; draw(); }
  if (input.includes(4) && !draft) process.exit(0);
});
process.stdout.write("\\x1b]7501;state=idle:app=omp\\x1b\\\\");
draw();
`,
      { mode: 0o700 },
    );
    ownReleaseRoot(config);
    const nativeConfig = join(config.releaseRoot, "native-config.json");
    writeFileSync(nativeConfig, JSON.stringify({ update: { auto: false } }), { mode: 0o600 });
    const toolchain = {
      omp: config.omp,
      ompEntry: realpathSync(config.omp),
      ompEntryHash: digest(readFileSync(config.omp)),
      bun: process.execPath,
      bunHash: digest(readFileSync(process.execPath)),
      nativeVersion: "18.18.8",
      nativeConfig,
      nativeConfigHash: digest(readFileSync(nativeConfig)),
    };
    const record = {
      oldRuntime: { cwd: root, sessionFile: join(root, "session.jsonl") } as RuntimeIdentity,
      toolchain,
    } as DeploymentRecord;
    const monitorDir = join(config.stateDir, "monitors");
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      join(monitorDir, `${config.sessionId}.json`),
      JSON.stringify({ version: 1, sessionId: config.sessionId, monitors: [] }),
      { mode: 0o600 },
    );
    await until("a bare shell", async () => ((await requireShell(config, cli)) === undefined ? true : undefined));
    // When the managed launch types the native command into it.
    const since = new Date().toISOString();
    await launchRuntime(config, cli, record);
    const launched = await until("the launched native process", () => launchedProcess(config, cli, record, since));
    // Then the kernel identifies exactly that process under the terminal's shell, running the private native entry.
    expect(launched.executable).toBe(realpathSync(process.execPath));
    expect(sameProcess(launched)).toBe(true);
    const bind = async (pid: number) => {
      const startedAt = new Date().toISOString();
      writePaneState(config.stateDir, {
        paneId: address,
        role: "cataly",
        sessionId: config.sessionId,
        sessionFile: record.oldRuntime!.sessionFile,
        cwd: root,
        pid,
        startedAt,
        updatedAt: startedAt,
        agentStatus: "idle",
        approvalPending: false,
        goal: { status: "none" },
      });
      expect(await cli.probe(address, "held", config.stateDir)).toMatchObject({ pid, agent: "omp", status: "idle" });
      return captureRuntime(config, cli);
    };
    await until("a draft on screen", async () => (await screen(address)).includes("owner draft") || undefined);
    const old = await bind(launched.pid);
    record.oldRuntime = old;
    const healthDir = join(config.stateDir, "runtime");
    mkdirSync(healthDir);
    const editor = (editorEmpty: boolean) =>
      writeFileSync(
        join(healthDir, `${address}.json`),
        JSON.stringify({
          version: 1,
          paneId: address,
          role: "cataly",
          pid: old.pid,
          sessionId: old.sessionId,
          startedAt: old.startedAt,
          updatedAt: new Date().toISOString(),
          presetLoaded: true,
          editorEmpty,
          monitors: [],
        }),
        { mode: 0o600 },
      );
    editor(true);
    const applied = applyHcSource(root, config);
    expect(applied.exitCode).toBe(4);
    expect(applied.stderr.toString()).toContain("same idle owner and observed empty native input");
    expect(sameProcess(old)).toBe(true);
    await hc("keys", address, "space");
    await until("a whitespace draft", async () => (await screen(address)).trimEnd().endsWith("╰─") || undefined);
    editor(false);
    await expect(stopRuntime(config, cli, record, () => {})).rejects.toThrow(DeploymentHeld);
    expect(record.nativeUiExitRequestedAt).toBeUndefined();
    await hc("keys", address, "ctrl+u");
    await until("a cleared draft", async () => (await screen(address)).includes("thinking effort") || undefined);
    await expect(stopRuntime(config, cli, record, () => {})).rejects.toThrow(DeploymentHeld);
    expect(record.nativeUiExitRequestedAt).toBeUndefined();
    editor(true);
    await stopRuntime(config, cli, record, () => {});
    expect(record.nativeUiExitRequestedAt).toBeDefined();
    expect(sameProcess(launched)).toBe(false);
    await requireShell(config, cli);
    const resumedAt = new Date().toISOString();
    await launchRuntime(config, cli, record);
    const resumed = await until("the resumed process", () => launchedProcess(config, cli, record, resumedAt));
    expect(await bind(resumed.pid)).toMatchObject({ sessionId: old.sessionId, sessionFile: old.sessionFile });
    expect(resumed.pid).not.toBe(old.pid);
    await stopLaunchedProcess(config, cli, record, resumedAt, resumed);
    await hc("kill", address);
  },
  60_000,
);

test.skipIf(!hcBin)("a terminal hc does not know is doubt", async () => {
  expect(await cli.foreground("t999", "held")).toEqual({ shell: true });
});
