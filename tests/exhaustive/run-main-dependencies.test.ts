import assert from "node:assert/strict"
import path from "node:path"
import { test } from "bun:test"
import { nativeMatrixWorld } from "./native-world.ts"
import { main } from "../../packages/trellage-runtime/src/native-run/run.ts"
import { expectedRunArgumentTail } from "./run-behavior-oracle.ts"

test("main forwards dependencies through real parsing, dry-run, and clean launch", async () => {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1")
  const root = path.resolve(import.meta.dir, "../..")
  const world = await nativeMatrixWorld(root)
  const keys = ["XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const
  const previous = keys.map((key) => process.env[key])
  const lines: string[] = []
  try {
    // Keep a regression that ignores dependencies inside private fallback paths.
    for (const key of keys) process.env[key] = path.join(world.root, key)
    const status = await main(["pi", "clean", "--dry-run"], {
      ...world.dependencies,
      write: (line) => lines.push(line),
      spawner: async () => {
        throw Error("Dry-run must never launch")
      },
    })
    assert.equal(status, 0)
    assert.ok(
      lines.some((line) => line.startsWith("Always-on")),
      "main must forward the injected writer",
    )
    const forwarded = ["-p", "quote ' $() `literal`\n日本語"]
    for (const resumeArgs of [[], ["--resume=session-fixture"]]) {
      let launched = 0
      const launchStatus = await main(
        ["pi", "clean", "--model", "fixture-model", "--effort", "high", ...resumeArgs, "--", ...forwarded],
        {
          ...world.dependencies,
          write: (line) => lines.push(line),
          spawner: async (launch, environment, cwd, onSpawn) => {
            assert.equal(launch.command, "pi")
            assert.equal(environment.HOME, world.root)
            assert.equal(cwd, root)
            assert.deepEqual(launch.args.slice(-forwarded.length), forwarded)
            const tail = expectedRunArgumentTail(
              "pi",
              resumeArgs.length ? { kind: "pick", id: "session-fixture" } : undefined,
              forwarded,
            )
            assert.deepEqual(tail, [...(resumeArgs.length ? ["--resume", "session-fixture"] : []), ...forwarded])
            assert.deepEqual(launch.args.slice(-tail.length), tail)
            assert.equal(launch.args[launch.args.indexOf("--model") + 1], "fixture-model")
            assert.equal(launch.args[launch.args.indexOf("--thinking") + 1], "high")
            assert.ok(launch.args.includes("--no-skills"))
            launched++
            onSpawn(undefined)
            return 17
          },
        },
      )
      assert.equal(launchStatus, 17)
      assert.equal(launched, 1)
    }
  } finally {
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    }
    await world.dispose()
  }
})
