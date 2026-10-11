import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createProcessLifecycle, POSIX_ALARM_SCRIPT, runCleanupStages } from "./process-lifecycle.ts"

test("managed process settlement waits for close after a spawn error", async () => {
  const lifecycle = createProcessLifecycle({ settleDeadline: 100 })
  const managed = lifecycle.spawn("/definitely/missing/trellage-process", [], { stdio: "ignore" })

  const result = await managed.settled

  expect(result.error).toBeInstanceOf(Error)
  expect(result.closed).toBe(true)
})

test("cleanup runs every bounded stage and reports all failures", async () => {
  const order: string[] = []

  try {
    await runCleanupStages([
      async () => { order.push("release"); throw new Error("release failed") },
      async () => { order.push("processes"); throw new Error("process cleanup failed") },
      async () => { order.push("children") },
    ], "fixture cleanup")
    throw new Error("cleanup unexpectedly succeeded")
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map((failure) => (failure as Error).message)).toEqual([
      "release failed",
      "process cleanup failed",
    ])
  }

  expect(order).toEqual(["release", "processes", "children"])
})

test("cleanup waits only for registered children to close and does not signal them", async () => {
  const lifecycle = createProcessLifecycle({ settleDeadline: 20 })
  const managed = lifecycle.spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 150)"], { stdio: "ignore" })
  const killSignals: Array<NodeJS.Signals | number | undefined> = []
  const originalKill = managed.child.kill.bind(managed.child)
  managed.child.kill = ((signal?: NodeJS.Signals | number) => {
    killSignals.push(signal)
    return originalKill(signal)
  }) as typeof managed.child.kill

  await expect(lifecycle.cleanup()).rejects.toThrow("did not close")
  const result = await managed.settled

  expect(killSignals).toEqual([])
  expect(result.closed).toBe(true)
  expect(result.code).toBe(0)
})

test("a TERM-ignoring hung command self-terminates from the inherited POSIX alarm", async () => {
  const lifecycle = createProcessLifecycle({ settleDeadline: 2_000 })
  const managed = lifecycle.spawn("perl", [
    "-e", POSIX_ALARM_SCRIPT,
    process.execPath,
    "-e",
    "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30_000)",
  ], {
    env: { ...process.env, TRELLAGE_TEST_ALARM_SECONDS: "1" },
    stdio: "ignore",
  })

  const result = await managed.settled

  expect(result.closed).toBe(true)
  expect(result.code).toBeNull()
  expect(result.signal).toBe("SIGALRM")
})

test("the inherited alarm survives the shell-router to Bash to Bun chain", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trellage-router-alarm-"))
  const router = path.join(directory, "router")
  await writeFile(router, `#!/usr/bin/env bash
set -euo pipefail
exec "\${TRELLAGE_TEST_BUN}" -e 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30_000)'
`, { mode: 0o755 })
  await chmod(router, 0o755)

  try {
    const lifecycle = createProcessLifecycle({ settleDeadline: 5_000 })
    const managed = lifecycle.spawn("perl", [
      "-e", POSIX_ALARM_SCRIPT,
      router,
    ], {
      env: { ...process.env, TRELLAGE_TEST_BUN: process.execPath, TRELLAGE_TEST_ALARM_SECONDS: "1" },
      stdio: "ignore",
    })

    const result = await managed.settled

    expect(result.closed).toBe(true)
    expect(result.code).toBeNull()
    expect(result.signal).toBe("SIGALRM")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
