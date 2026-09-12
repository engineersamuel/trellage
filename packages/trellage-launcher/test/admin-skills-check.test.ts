import { describe, expect, it, vi } from "vitest"
import { checkAdminSkillsUpdates } from "../src/admin-skills-check.ts"
import type { AdminProfileEntry } from "../src/admin-model.ts"
import { createNodeCommandRunner, type CommandRunner } from "../src/guide-launch.ts"

const entry = (name: string, surface: "native" | "sandbox" = "native"): AdminProfileEntry => ({
  ref: `${surface}:cpx/${name}`,
  surface,
  launcher: "cpx",
  name,
  description: name,
  commandPath: surface === "sandbox" ? "/fixture/trellage" : "/fixture/cpx",
  doctorSupported: true,
  inventorySupported: true,
  health: "healthy",
  install: "installed",
  stale: false,
  updateCheckSupported: true,
  harnessVersionSupported: true,
  updateCheckStale: false,
})
const output = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 as const })
const check = (
  entries: ReadonlyArray<AdminProfileEntry>,
  run: CommandRunner["run"],
  signal = new AbortController().signal,
) => checkAdminSkillsUpdates(entries, { run }, "/fixture", "/fixture/trx", signal)

describe("read-only Admin skills discovery", () => {
  it("allows owned resource cleanup to finish after cancellation", async () => {
    const controller = new AbortController()
    let cleaned = false
    const result = createNodeCommandRunner().run(
      process.execPath,
      [
        "-e",
        [
          'process.on("SIGTERM", () => setTimeout(() => { console.log("cleaned"); process.exit(0) }, 1100))',
          'console.log("ready")',
          "setInterval(() => {}, 1000)",
        ].join(";"),
      ],
      {
        signal: controller.signal,
        timeoutMs: 5000,
        terminationGraceMs: 3000,
        env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
        onOutput: (text) => {
          if (text.includes("ready")) controller.abort()
          if (text.includes("cleaned")) cleaned = true
        },
      },
    )
    await expect(result).rejects.toMatchObject({ kind: "aborted" })
    expect(cleaned).toBe(true)
  })

  it("checks deployed Native and Container profiles separately and caches help", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_command, args) =>
      output(
        args[0] === "--help"
          ? "cpx skills-check PROFILE"
          : JSON.stringify({ kind: args[1] === "old" ? "available" : "current" }),
      ),
    )
    const entries = [entry("old"), entry("new"), entry("container", "sandbox")]
    const results = await check(entries, run)
    expect([...results.keys()]).toEqual([...entries.map(({ ref }) => ref), "skills:shared"])
    expect([...results.values()].map(({ kind }) => kind)).toEqual(["available", "current", "current", "unknown"])
    expect(run.mock.calls.map(([, args]) => args)).toEqual([
      ["--help"],
      ["skills-check", "old"],
      ["skills-check", "new"],
      ["--help"],
      ["skills-check", "container"],
      ["--help"],
    ])
  })

  it("never forwards a new management verb into an old launcher", async () => {
    const run = vi.fn<CommandRunner["run"]>(async () => output("cpx skills-update PROFILE"))
    expect((await check([entry("default")], run)).get(entry("default").ref)?.kind).toBe("unknown")
    expect(run).toHaveBeenCalledTimes(2)
  })

  it.each(["available", "unknown"] as const)("keeps Container checks explicit: %s", async (kind) => {
    const result = kind === "unknown" ? { kind, diagnostic: "Installed image is unavailable." } : { kind }
    const run = vi.fn<CommandRunner["run"]>(async (_command, args) =>
      output(args[0] === "--help" ? "trellage skills-check PROFILE" : JSON.stringify(result)),
    )
    expect((await check([entry("container", "sandbox")], run)).get(entry("container", "sandbox").ref)).toEqual(result)
  })

  it.each(["", "current", "{}", '{"kind":"unknown"}', '{"kind":"current"}\nnoise', '{"kind":"current"}\n{}'])(
    "does not call missing or malformed evidence current: %s",
    async (text) => {
      const run = vi.fn<CommandRunner["run"]>(async (_command, args) =>
        output(args[0] === "--help" ? "skills-check PROFILE" : text),
      )
      const result = (await check([entry("default")], run)).get(entry("default").ref)
      expect(result?.kind).toBe("unknown")
      expect(result?.diagnostic).toBeTruthy()
    },
  )

  it("combines all Firstmate target reports and keeps errors explicit", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_command, args) =>
      output(args[0] === "--help" ? "skills-check PROFILE" : '{"kind":"current"}\n{"kind":"available"}'),
    )
    expect((await check([entry("default")], run)).get(entry("default").ref)).toEqual({ kind: "available" })
    run.mockRejectedValue(new Error("source fetch failed"))
    expect((await check([entry("default")], run)).get(entry("default").ref)).toEqual({
      kind: "unknown",
      diagnostic: "source fetch failed",
    })
  })

  it("does not start cancelled checks and returns a result for every ref", async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    const run = vi.fn<CommandRunner["run"]>()
    const results = await check([entry("one"), entry("two")], run, controller.signal)
    expect([...results.values()]).toEqual([
      { kind: "unknown", diagnostic: "cancelled" },
      { kind: "unknown", diagnostic: "cancelled" },
      { kind: "unknown", diagnostic: "cancelled" },
    ])
    expect(run).not.toHaveBeenCalled()
  })

  it.each(["current", "available", "unknown"] as const)(
    "checks shared caches with zero profile copies: %s",
    async (kind) => {
      const result = kind === "unknown" ? { kind, diagnostic: "Guide cache is missing." } : { kind }
      const run = vi.fn<CommandRunner["run"]>(async (_command, args) =>
        output(args[0] === "--help" ? "trx skills check --json" : JSON.stringify(result)),
      )
      expect([...(await check([], run))]).toEqual([["skills:shared", result]])
      expect(run.mock.calls.map(([command, args]) => [command, args])).toEqual([
        ["/fixture/trx", ["--help"]],
        ["/fixture/trx", ["skills", "check", "--json"]],
      ])
    },
  )

  it("retains partial shared-cache diagnostics without inventing currency", async () => {
    const result = { kind: "available", diagnostic: "Guide cache is missing; another cache has a known update." }
    const run = vi.fn<CommandRunner["run"]>(async (_command, args) =>
      output(args[0] === "--help" ? "trx skills check --json" : JSON.stringify(result)),
    )
    expect((await check([], run)).get("skills:shared")).toEqual(result)
  })
})
