import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import path from "node:path"
import type { guideWorld } from "./guide-world.ts"

export async function verifyRootHelp(
  world: Awaited<ReturnType<typeof guideWorld>>,
  command: "run" | "guide",
  rootArgv: readonly string[],
  argv: readonly string[],
  ordinal: bigint,
): Promise<void> {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1")
  assert.equal(rootArgv.length, 1)
  assert.ok(["-h", "--help", "help"].includes(rootArgv[0]!))
  const root = path.resolve(import.meta.dir, "../..")
  await world.withCase(ordinal, async (cwd) => {
    const unexpected = path.join(cwd, "unexpected-bun")
    const child = Bun.spawn(
      ["bash", path.join(root, "prototypes/trellage-router/bin/trx"), ...rootArgv, command, ...argv],
      {
        cwd: root,
        env: {
          ...world.environment,
          TRELLAGE_TRX_SOURCE_ROOT: path.join(root, "prototypes/trellage-router"),
          TRELLAGE_BUN_EXECUTABLE: path.join(import.meta.dir, "root-help-deny-bun.sh"),
          TRELLAGE_ROOT_HELP_UNEXPECTED: unexpected,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15000)
    try {
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      assert.equal(status, 0, stderr)
      assert.equal(stderr, "")
      assert.ok(stdout.startsWith("Usage:\n  trx\n"), stdout)
      assert.ok(stdout.includes("trx run HARNESS [PROFILE...]"), stdout)
      assert.ok(stdout.includes("trx guide [INTENT]"), stdout)
      assert.equal(existsSync(unexpected), false, "Root help must not start any Bun entrypoint")
    } finally {
      clearTimeout(timeout)
    }
  })
}
