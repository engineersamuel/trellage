import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import path from "node:path";
import { cleanupFixtures, tempRoot } from "./fixtures.ts";

const lifecycle = path.resolve(import.meta.dir, "../../src/native-run/lifecycle-cli.ts");
const exec = promisify(execFile);

afterEach(cleanupFixtures);

test("maintenance cancellation stays nonzero when its lifecycle child handles TERM successfully", async () => {
  const home = await tempRoot("lifecycle-cancellation");
  const root = path.join(home, ".local/share/trellage/cpx");
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(
    path.join(root, ".managed-by-trellage-profiles"),
    "trellage-profiles-v1\n",
  );
  await writeFile(
    path.join(root, "bin/cpx"),
    `#!/bin/sh
trap 'exit 0' TERM
printf 'ready\\n'
sleep 30 &
wait
`,
    { mode: 0o755 },
  );
  const child = spawn(process.execPath, [lifecycle, "setup", "copilot", "hve"], {
    env: { HOME: home, PATH: [process.env.TRELLAGE_TEST_BIN, "/usr/bin", "/bin"].filter(Boolean).join(path.delimiter) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await once(child.stdout!, "data");
    child.kill("SIGTERM");
    const [code, signal] = await once(child, "exit");
    expect(code).toBe(143);
    expect(signal).toBeNull();
  } finally {
    child.kill("SIGKILL");
  }
});

test("old private runtimes cannot receive unsupported maintenance verbs", async () => {
  const home = await tempRoot("lifecycle-old-runtime");
  const root = path.join(home, ".local/share/trellage/cpx");
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(
    path.join(root, ".managed-by-trellage-profiles"),
    "trellage-profiles-v1\n",
  );
  await writeFile(
    path.join(root, "bin/cpx"),
    `#!/bin/sh
if [ "$1" = --help ]; then printf 'Usage: cpx PROFILE\n'; exit; fi
printf '%s\\n' "$@" > "$HOME/unexpected-mutation"
`,
    { mode: 0o755 },
  );
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  for (const args of [
    ["upgrade", "copilot", "hve", "--harness-only"],
    ["skills-update", "copilot", "hve"],
  ])
    await expect(exec(process.execPath, [lifecycle, ...args], { env })).rejects.toThrow(
      "Refresh the installed Trellage runtime first",
    );
  expect(await Bun.file(path.join(home, "unexpected-mutation")).exists()).toBe(false);
});

test("workflow-check reports the schemaVersion 2 composition identity", async () => {
  const home = await tempRoot("lifecycle-workflow-check");
  const root = path.join(home, ".local/share/trellage/cpx");
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(path.join(root, ".managed-by-trellage-profiles"), "trellage-profiles-v1\n");
  await writeFile(
    path.join(root, "bin/cpx"),
    `#!/bin/sh
printf '%s\\n' '{"schemaVersion":1,"launcher":"cpx","profile":"hve","mode":"interactive","agent":"hve-core:dt-coach","requiredSkills":["dt-methods"],"manifestSha256":"${"a".repeat(64)}","harnessVersion":"1.0.100"}'
`,
    { mode: 0o755 },
  );
  const { stdout } = await exec(
    process.execPath,
    [lifecycle, "workflow-check", "copilot", "hve", "--agent", "hve-core:dt-coach", "--require-skill", "dt-methods"],
    { env: { HOME: home, PATH: "/usr/bin:/bin" } },
  );
  expect(JSON.parse(stdout)).toEqual({
    schemaVersion: 2,
    harness: "copilot",
    profiles: ["hve"],
    mode: "interactive",
    agent: "hve-core:dt-coach",
    requiredSkills: ["dt-methods"],
    manifestSha256: "a".repeat(64),
    harnessVersion: "1.0.100",
  });
});

test("retired Pi and Codex lifecycle maintenance points to inventory", async () => {
  const env = { HOME: await tempRoot("external-lifecycle"), PATH: "/usr/bin:/bin" };
  for (const [harness, profile] of [["pi", "default"], ["codex", "pstack"]] as const) {
    await expect(exec(process.execPath, [lifecycle, "doctor", harness, profile], { env })).rejects.toThrow(
      `${harness} is installed and updated outside Trellage; use trx inventory ${harness} ${profile} --json`,
    );
  }
});

test("Nodecode upgrades use the native updater and propagate failures", async () => {
  const home = await tempRoot("nodecode-upgrade");
  const command = path.join(home, "custom-nodecode");
  await writeFile(command, `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/update-args"
printf '%s' "$NODECODE_HOME" > "$HOME/update-home"
exit 0
`, { mode: 0o755 });
  const env = { HOME: home, PATH: "/usr/bin:/bin", TRELLAGE_NODECODE_BIN: command, NODECODE_HOME: path.join(home, "state") };
  for (const args of [[], ["default", "--yes"], ["--all", "--harness-only"]]) {
    await exec(process.execPath, [lifecycle, "upgrade", "nodecode", ...args], { env });
    expect(await Bun.file(path.join(home, "update-args")).text()).toBe("update\n");
    expect(await Bun.file(path.join(home, "update-home")).text()).toBe(env.NODECODE_HOME);
  }
  await writeFile(command, "#!/bin/sh\necho update-failed >&2\nexit 23\n", { mode: 0o755 });
  await expect(exec(process.execPath, [lifecycle, "upgrade", "nodecode"], { env })).rejects.toMatchObject({ code: 23, stderr: "update-failed\n" });
});

test("Nodecode upgrade dry-run does not execute and unsupported flags fail closed", async () => {
  const home = await tempRoot("nodecode-upgrade-dry");
  const command = path.join(home, "missing-nodecode");
  const env = { HOME: home, PATH: "/usr/bin:/bin", TRELLAGE_NODECODE_BIN: command };
  const { stdout } = await exec(process.execPath, [lifecycle, "upgrade", "nodecode", "--dry-run"], { env });
  expect(JSON.parse(stdout)).toEqual({ harness: "nodecode", command, args: ["update"] });
  for (const flag of ["--skills-only", "--check", "--unknown"]) {
    await expect(exec(process.execPath, [lifecycle, "upgrade", "nodecode", flag], { env })).rejects.toThrow(`unsupported Nodecode upgrade option: ${flag}`);
  }
  await expect(exec(process.execPath, [lifecycle, "upgrade", "nodecode"], { env })).rejects.toThrow();
});
