import { describe, expect, it, vi } from "vitest"
import { checkAdminHarnessUpdates } from "../src/admin-harness-update-discovery.js"
import type { AdminProfileEntry } from "../src/admin-model.js"
import type { CommandRunner, CommandRunResult } from "../src/guide-launch.js"

const container = (name: string): AdminProfileEntry => ({
  ref: `sandbox:${name}`,
  surface: "sandbox",
  harness: "claude",
  name,
  description: name,
  commandPath: "/fixture/trellage",
  doctorSupported: false,
  inventorySupported: false,
  health: "healthy",
  install: "installed",
  stale: false,
  updateCheckSupported: false,
  harnessVersionSupported: true,
  updateCheckStale: false,
  harnessVersionSelector: "latest",
  version: "1.0.0",
})
const report = (installed: string, latest: string): CommandRunResult => ({
  stdout: JSON.stringify({ schemaVersion: 1, installed, latest, latestKnown: true }),
  stderr: "",
  exitCode: 0,
})

describe("fresh Admin harness discovery", () => {
  it("refreshes the release once and reads every Container receipt without reusing stale latest values", async () => {
    const entries = [container("alpha"), container("beta")]
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) =>
      args[1] === "alpha" ? report("2.0.0", "3.0.0") : report("2.5.0", "1.0.0"),
    )
    const publish = vi.fn()
    const results = await checkAdminHarnessUpdates(entries, { run }, "/fixture/worktree", new AbortController().signal, publish)
    expect(run.mock.calls.map(([, args]) => args)).toEqual([
      ["harness-version", "alpha", "--refresh-latest"],
      ["harness-version", "beta"],
    ])
    expect(results.get(entries[0]!.ref)).toEqual({
      installed: { kind: "known", version: "2.0.0" },
      latest: { kind: "known", version: "3.0.0" },
    })
    expect(results.get(entries[1]!.ref)).toEqual({
      installed: { kind: "known", version: "2.5.0" },
      latest: { kind: "known", version: "3.0.0" },
    })
    expect(publish).toHaveBeenCalledTimes(2)
    expect(run.mock.calls.every(([, , options]) => options?.cwd === "/fixture/worktree")).toBe(true)
  })

  it("checks a shared Native runtime once while returning a result for every associated profile", async () => {
    const entries = ["one", "two"].map(
      (name): AdminProfileEntry => ({
        ...container(name),
        ref: `native:cdx/${name}`,
        surface: "native",
        launcher: "cdx",
        harness: "codex",
        commandPath: "/fixture/cdx",
      }),
    )
    const run = vi.fn<CommandRunner["run"]>(async () => report("0.153.4", "0.154.0"))
    const results = await checkAdminHarnessUpdates(entries, { run }, "/fixture", new AbortController().signal)
    expect(run.mock.calls.map(([, args]) => args)).toEqual([["harness-version"]])
    expect([...results.keys()]).toEqual(entries.map((entry) => entry.ref))
    expect([...results.values()].map((result) => result.latest)).toEqual([
      { kind: "known", version: "0.154.0" },
      { kind: "known", version: "0.154.0" },
    ])
  })

  it("aborts owned reads and never publishes a cancelled discovery as current", async () => {
    const controller = new AbortController()
    const run = vi.fn<CommandRunner["run"]>(
      async (_executable, _args, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
        }),
    )
    const publish = vi.fn()
    const checking = checkAdminHarnessUpdates([container("alpha")], { run }, "/fixture", controller.signal, publish)
    const rejected = expect(checking).rejects.toThrow("cancelled")
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    controller.abort(new Error("cancelled"))
    await rejected
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[2]?.signal?.aborted).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  })

  it("keeps installed versions separate for different Native runtime paths", async () => {
    const entries = ["one", "two"].map(
      (name): AdminProfileEntry => ({
        ...container(name),
        ref: `native:omp/${name}`,
        surface: "native",
        launcher: "omp",
        harness: "oh-my-pi",
        commandPath: `/fixture/${name}/omp`,
      }),
    )
    const run = vi.fn<CommandRunner["run"]>(async (executable) => report(executable === "/fixture/one/omp" ? "3.0.0" : "2.0.0", "3.0.0"))
    const publish = vi.fn()
    const results = await checkAdminHarnessUpdates(entries, { run }, "/fixture", new AbortController().signal, publish)
    expect(run.mock.calls.map(([executable]) => executable)).toEqual(["/fixture/one/omp", "/fixture/two/omp"])
    expect(results.get(entries[0]!.ref)?.installed).toEqual({ kind: "known", version: "3.0.0" })
    expect(results.get(entries[1]!.ref)?.installed).toEqual({ kind: "known", version: "2.0.0" })
    expect(publish).not.toHaveBeenCalled()
  })
})
