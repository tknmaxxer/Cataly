import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DeploymentConfig } from "../src/update/deployment-types.ts";
import { catalyEnv } from "./e2e-hc-setup.ts";

/** The real source CLI uses a clean actor environment; forward only the private hc core's socket directories. */
export function applyHcSource(root: string, deployment: DeploymentConfig) {
  const hc = join(root, "isolated-hc");
  const env = catalyEnv(deployment.catalyHome);
  const xdg = Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("XDG_")));
  writeFileSync(
    hc,
    `#!${process.execPath}
const child = Bun.spawnSync([${JSON.stringify(deployment.hc)}, ...process.argv.slice(2)], {
  env: { ...process.env, ...${JSON.stringify(xdg)} }, stdout: "inherit", stderr: "inherit",
});
process.exit(child.exitCode);
`,
    { mode: 0o700 },
  );
  const file = join(root, "source-update.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      git: process.execPath,
      gh: process.execPath,
      activityFiles: [join(deployment.stateDir, "inbound-activity.json")],
      deployment: { ...deployment, hc },
    }),
    { mode: 0o600 },
  );
  return Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, "../skills/cataly-mode/scripts/src/cli.ts"),
      "update",
      "source",
      "apply",
      "--when",
      "idle",
      "--config",
      file,
    ],
    { env: { HOME: deployment.home, PATH: process.env["PATH"], CATALY_TELEMETRY: "0" } },
  );
}
