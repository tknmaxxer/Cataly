import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DeploymentCli, hcDeploymentCli } from "../src/update/deployment-cli.ts";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { launchedProcess, launchRuntime } from "../src/update/deployment-launch.ts";
import { stopRuntime } from "../src/update/deployment-native.ts";
import { DeploymentHeld, sameProcess } from "../src/update/deployment-process.ts";
import type { DeploymentConfig, DeploymentRecord } from "../src/update/deployment-types.ts";
import { hc, hcBin, screen, until } from "./e2e-hc-setup.ts";

export function writeHcOwner(
  config: DeploymentConfig,
  env: Record<string, string | undefined>,
  offerPath: string,
  quitKey: string,
  startedPath: string,
): void {
  const ownerModule = new URL("../src/update/deployment-hc-exit.ts", import.meta.url).href;
  const { pane, stateDir, sessionId } = config;
  const owner = { pane, stateDir, sessionId };
  const { XDG_RUNTIME_DIR, XDG_CONFIG_HOME, XDG_STATE_HOME } = env;
  const isolation = { XDG_RUNTIME_DIR, XDG_CONFIG_HOME, XDG_STATE_HOME };
  writeFileSync(
    config.omp!,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { HcOwnerExit } from ${JSON.stringify(ownerModule)};
const startedAt = new Date().toISOString();
writeFileSync(${JSON.stringify(startedPath)}, startedAt);
let draft = "owner draft";
let offer;
const renew = () => {
  offer = new HcOwnerExit();
  writeFileSync(${JSON.stringify(offerPath)}, offer.token);
};
renew();
const draw = () => process.stdout.write("\\x1b[2J\\x1b[H π > ⬢ GPT-4o > workspace ▶────6%────128K─\\r\\n╰─ " +
  (draft || "    ⇧⇥ to change thinking effort") + "\\r\\n");
process.stdin.setRawMode(true);
process.stdin.on("data", (input) => {
  if (input.includes(21)) { draft = ""; renew(); draw(); }
  if (input.includes(32)) { draft = "   "; draw(); }
  if (input.includes(13)) {
    process.stdout.write("\\x1b]7501;state=working:app=omp\\x1b\\\\");
    process.stdout.write("\\x1b]7501;state=idle:app=omp\\x1b\\\\");
    draw();
  }
  if (input.includes(4)) writeFileSync(${JSON.stringify(quitKey)}, "key");
});
process.stdout.write("\\x1b]7501;state=idle:app=omp\\x1b\\\\");
draw();
setInterval(() => {
  const current = offer;
  void current.poll({
    ...${JSON.stringify(owner)},
    startedAt,
    pid: process.pid,
    shutdownIfIdle: () => { if (offer === current && !draft) process.exit(0); },
  }, async (_cmd, args) => {
    const p = Bun.spawn([${JSON.stringify(hcBin)}, ...args], {
      env: { ...process.env, ...${JSON.stringify(isolation)} }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  });
}, 50);
`,
    { mode: 0o700 },
  );
}

export async function holdHcExitRace(
  config: DeploymentConfig,
  cli: DeploymentCli,
  record: DeploymentRecord,
  env: Record<string, string | undefined>,
  offerPath: string,
  quitKey: string,
  sampleEmptyEditor: () => void,
) {
  const { pane } = config;
  for (const change of [
    ["keys", pane, "space"],
    ["send", pane, "--", "next-turn"],
  ]) {
    sampleEmptyEditor();
    const changed = { ...record };
    const originalTurn = (await hc("get", pane))["turn"];
    await expect(
      stopRuntime(
        config,
        cli,
        changed,
        () => {},
        false,
        () => {
          expect(Bun.spawnSync([hcBin!, ...change], { env }).exitCode).toBe(0);
        },
      ),
    ).rejects.toThrow(DeploymentHeld);
    expect(changed.nativeUiExitRequestedAt).toBeDefined();
    expect(existsSync(quitKey)).toBe(false);
    expect(sameProcess(record.oldRuntime!)).toBe(true);
    if (change[0] === "send") expect((await hc("get", pane))["turn"]).not.toBe(originalTurn);
    const consumedToken = readFileSync(offerPath, "utf8");
    await hc("keys", pane, "ctrl+u");
    await until("a cleared draft with a new exit offer", async () =>
      (await screen(pane)).includes("thinking effort") && readFileSync(offerPath, "utf8") !== consumedToken
        ? true
        : undefined,
    );
  }
}

export async function holdHcReplacement(config: DeploymentConfig, cli: DeploymentCli, record: DeploymentRecord) {
  const path = join(config.releaseRoot, "stopped-deployment.json");
  saveDeploymentJson(path, record);
  const recovered = JSON.parse(readFileSync(path, "utf8")) as DeploymentRecord;
  const { address: replacement } = (await hc(
    "run",
    "--bg",
    "--no-parent",
    "--no-notify",
    "--",
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-i",
  )) as { address: string };
  const shell = await until("the replacement shell", async () => {
    const front = await cli.foreground(replacement, "held");
    return front.shell && front.processes?.length === 1 ? front : undefined;
  });
  const original = recovered.oldRuntime!.hcTerminal!;
  expect(shell.rootPid).not.toBe(original.root.pid);
  let sends = 0;
  for (const swap of ["terminal", "root"]) {
    const changed = hcDeploymentCli(async (cmd, argv) => {
      const target = swap === "root" ? replacement : config.pane;
      if (argv[1] === "send") {
        sends++;
        return cli.exec(cmd, [argv[0]!, "send", target, ...argv.slice(3)]);
      }
      const result = await cli.exec(cmd, argv[1] === "get" ? [argv[0]!, "get", target] : argv);
      if (argv[1] !== "get" || result.code !== 0) return result;
      const row = JSON.parse(result.stdout);
      // The same root under a new terminal record, then a new root under the
      // same terminal record (as with a kept terminal).
      return {
        ...result,
        stdout: JSON.stringify({
          ...row,
          address: config.pane,
          created_ms: original.createdMs + (swap === "terminal" ? 1 : 0),
        }),
      };
    });
    const mismatch = "hc terminal or root shell differs from the journaled owner";
    await expect(stopRuntime(config, changed, recovered, () => {})).rejects.toThrow(mismatch);
    await expect(launchRuntime(config, changed, recovered)).rejects.toThrow(mismatch);
    await expect(launchedProcess(config, changed, recovered, new Date().toISOString())).rejects.toThrow(mismatch);
    await expect(
      launchRuntime(config, changed, { ...recovered, oldToolchain: recovered.toolchain! }, false, true),
    ).rejects.toThrow(mismatch);
  }
  expect(sends).toBe(0);
  await hc("kill", replacement);
}
