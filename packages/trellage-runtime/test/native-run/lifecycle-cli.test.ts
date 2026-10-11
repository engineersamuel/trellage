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
  const root = path.join(home, ".local/share/trellage/cdx");
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(
    path.join(root, ".managed-by-trellage-codex-profiles"),
    "trellage-codex-profiles-v2\n",
  );
  await writeFile(
    path.join(root, "bin/cdx"),
    `#!/bin/sh
trap 'exit 0' TERM
printf 'ready\\n'
sleep 30 &
wait
`,
    { mode: 0o755 },
  );
  const child = spawn(process.execPath, [lifecycle, "setup", "codex", "pstack"], {
    env: { HOME: home, PATH: "/usr/bin:/bin" },
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
  const root = path.join(home, ".local/share/trellage/cdx");
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(
    path.join(root, ".managed-by-trellage-codex-profiles"),
    "trellage-codex-profiles-v2\n",
  );
  await writeFile(
    path.join(root, "bin/cdx"),
    `#!/bin/sh
if [ "$1" = --help ]; then printf 'Usage: cdx PROFILE\\n'; exit; fi
printf '%s\\n' "$@" > "$HOME/unexpected-mutation"
`,
    { mode: 0o755 },
  );
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  for (const args of [
    ["upgrade", "codex", "pstack", "--harness-only"],
    ["skills-update", "codex", "pstack"],
  ])
    await expect(exec(process.execPath, [lifecycle, ...args], { env })).rejects.toThrow(
      "Refresh the installed Trellage runtime first",
    );
  expect(await Bun.file(path.join(home, "unexpected-mutation")).exists()).toBe(false);
});
