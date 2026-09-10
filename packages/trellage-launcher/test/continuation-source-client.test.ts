import { mkdtemp, realpath, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ContinuationSourceClient } from "../src/continuation-source-client.js"
import { ContinuationStore } from "../src/continuation-store.js"
import { CommandRunnerError, type CommandRunner } from "../src/guide-launch.js"
import { runtimeSnapshot } from "./helpers/continuation-runtime-fixtures.js"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const setup = async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "trx-source-client-")))
  roots.push(root)
  const store = new ContinuationStore(root)
  const snapshot = runtimeSnapshot(root)
  const run = vi.fn<CommandRunner["run"]>().mockResolvedValue({
    stdout: JSON.stringify({ sameSource: true, advanced: false, revision: snapshot.revision }),
    stderr: "",
    exitCode: 0,
  })
  const client = new ContinuationSourceClient({
    store,
    runner: { run },
    repoRoot: "/test/repo",
    env: {},
  })
  return { root, store, snapshot, run, client }
}

describe("continuation source subprocess boundary", () => {
  it("maps only a clean graceful child exit to AbortError", async () => {
    const f = await setup()
    const controller = new AbortController()
    f.run.mockImplementation(async () => {
      controller.abort()
      throw new CommandRunnerError({
        kind: "aborted", executable: process.execPath, args: [], message: "command aborted",
        exitCode: 143, signal: null, stdout: "", stderr: "",
      })
    })
    await expect(f.client.check(f.snapshot, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
  })

  it.each([
    { exitCode: 1, signal: null, stderr: "cleanup failed" },
    { exitCode: null, signal: "SIGKILL" as const, stderr: "" },
  ])("preserves unsuccessful cancellation metadata: %j", async (outcome) => {
    const f = await setup()
    const controller = new AbortController()
    const error = new CommandRunnerError({
      kind: "aborted", executable: process.execPath, args: [], message: "cleanup was not confirmed",
      stdout: "", ...outcome,
    })
    f.run.mockImplementation(async () => { controller.abort(); throw error })
    await expect(f.client.check(f.snapshot, controller.signal)).rejects.toBe(error)
  })

  it("passes only a private path and cleans up its probe without requiring a saved draft", async () => {
    const f = await setup()
    const status = await f.client.check(f.snapshot)
    expect(status.sameSource).toBe(true)
    const call = f.run.mock.calls[0]
    expect(call?.[1][0]).toBe("/test/repo/pocs/herdr-trx-guide/conversation-source.ts")
    expect(call?.[1][1]).toBe("--check")
    expect(path.dirname(call?.[1][2] ?? "")).toBe(path.join(f.root, "continuations", "requests"))
    expect(JSON.stringify(f.run.mock.calls)).not.toContain("Implement the search flow")
    expect(await readdir(path.join(f.root, "continuations", "requests"))).toEqual([])
  })

  it("rejects malformed freshness metadata while still removing its probe", async () => {
    const f = await setup()
    f.run.mockResolvedValue({
      stdout: '{"sameSource":true,"advanced":false,"revision":"invalid"}',
      stderr: "",
      exitCode: 0,
    })
    await expect(f.client.check(f.snapshot)).rejects.toThrow("invalid freshness metadata")
    expect(await readdir(path.join(f.root, "continuations", "requests"))).toEqual([])
  })

  it("forwards abort and cleanup grace and preserves the original snapshot on failure", async () => {
    const f = await setup()
    const controller = new AbortController()
    f.run.mockRejectedValue(new DOMException("Cancelled", "AbortError"))
    await expect(f.client.check(f.snapshot, controller.signal)).rejects.toThrow("Cancelled")
    expect(f.run.mock.calls[0]?.[2]).toMatchObject({
      signal: controller.signal,
      terminationGraceMs: 10_000,
    })
    expect(await readdir(path.join(f.root, "continuations", "requests"))).toEqual([])
    expect(f.snapshot.messages).toHaveLength(2)
  })
})
