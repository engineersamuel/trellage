import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { guideWorld } from "./guide-world.ts"

export type RunDispatch = { kind: "runtime" | "selector"; argv: readonly string[] } | { kind: "rejected"; status: 1 }

export function expectedRunDispatch(argv: readonly string[], harnesses: readonly string[]): RunDispatch {
  const first = argv[0]
  if (first === undefined || first === "") return { kind: "selector", argv: [] }
  if (["-h", "--help", "help"].includes(first)) return { kind: "runtime", argv: ["--help"] }
  if (harnesses.includes(first)) return { kind: "runtime", argv }
  if (["--dry-run", "--no-always", "--allow-unproven-isolation", "--require-proven-isolation"].includes(first))
    return { kind: "selector", argv }
  return { kind: "rejected", status: 1 }
}

/** Observe the actual Bash router at its Bun entrypoint boundary; execute the selected behavior separately. */
export async function observeRunDispatch(
  world: Awaited<ReturnType<typeof guideWorld>>,
  argv: readonly string[],
  ordinal: bigint,
): Promise<RunDispatch> {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1")
  const root = path.resolve(import.meta.dir, "../..")
  return world.withCase(ordinal, async (cwd) => {
    const receipt = path.join(cwd, "dispatch.json")
    const child = Bun.spawn(["/bin/bash", path.join(root, "prototypes/trellage-router/bin/trx"), "run", ...argv], {
      cwd: root,
      env: {
        ...world.environment,
        TRELLAGE_TRX_SOURCE_ROOT: path.join(root, "prototypes/trellage-router"),
        TRELLAGE_BUN_EXECUTABLE: path.join(import.meta.dir, "run-dispatch-bun.sh"),
        TRELLAGE_DISPATCH_REAL_BUN: process.execPath,
        TRELLAGE_DISPATCH_CAPTURE: path.join(import.meta.dir, "run-dispatch-capture.ts"),
        TRELLAGE_DISPATCH_RECEIPT: receipt,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15000)
    try {
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (!existsSync(receipt)) {
        assert.equal(status, 1, stderr)
        assert.equal(stdout, "")
        assert.ok(stderr.startsWith(`trx: unknown harness: ${argv[0]}; harnesses:`), stderr)
        return { kind: "rejected", status: 1 }
      }
      assert.equal(status, 0, stderr)
      assert.equal(stderr, "")
      const captured = JSON.parse(await readFile(receipt, "utf8")) as { entry: string; argv: string[] }
      const entries = {
        [path.join(root, "packages/trellage-runtime/src/native-run/cli.ts")]: "runtime",
        [path.join(root, "packages/trellage-launcher/src/run-select-cli.tsx")]: "selector",
      } as const
      const kind = entries[captured.entry]
      assert.ok(kind, `Unexpected router entrypoint ${captured.entry}`)
      if (kind === "runtime" && JSON.stringify(captured.argv) === '["--help"]')
        assert.ok(stdout.startsWith("Usage:\n  trx run "), stdout)
      else assert.equal(stdout, "")
      return { kind, argv: captured.argv }
    } finally {
      clearTimeout(timeout)
    }
  })
}
