import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import {
  confirmHarnessUpgrade,
  InteractiveTerminalRequiredError,
  normalizeInteractiveTerminalError,
  parseHarnessUpgradeArgv,
  runHarnessUpgradeCli,
  type HarnessUpgradeCliOptions,
  type HarnessUpgradeConfirmation,
} from "../src/harness-upgrade-cli.ts"
import {
  parseGuideCatalog,
  type CombinedGuideCatalog,
  type HeadlessCapabilitiesV1,
  type NativeGuideCatalogEntry,
} from "../src/guide-catalog.ts"
import { CommandRunnerError, type CommandRunner, type CommandRunResult } from "../src/guide-launch.ts"

const headless: HeadlessCapabilitiesV1 = {
  schemaVersion: 1,
  prompt: true,
  outputFormats: ["text"],
  eventContract: null,
  trellageEventContract: null,
  sessionId: "none",
  resume: false,
  resumeWithPrompt: false,
  questionToolControl: "none",
  changedFiles: "none",
  usage: false,
  cost: false,
  modelOverride: false,
  effortOverride: false,
  testedHarnessVersion: null,
}

const guide: NativeGuideCatalogEntry["guide"] = {
  schemaVersion: 1,
  capabilities: ["fixture"],
  bestFor: ["Fixture updates", "Fixture previews"],
  avoidFor: ["Live updates", "Model inference"],
  prerequisites: [],
  workflows: [{ id: "fixture", description: "Fixture", examples: ["One", "Two"], promptTemplate: "{{intent}}" }],
}

const native = (launcher = "claude", harness = "claude", name = "a"): NativeGuideCatalogEntry => ({
  launcher,
  harness,
  name,
  description: name,
  headless,
  sandbox: false,
  herdrCompatibility: { status: "untested" },
  guide,
  commandPath: "/fixture/trx",
})

const catalog = (): CombinedGuideCatalog => ({
  schemaVersion: 1,
  native: [native(), native("claude", "claude", "b")],
})

const success = (stdout = ""): CommandRunResult => ({ stdout, stderr: "", exitCode: 0 })
const successfulCommand = (args: ReadonlyArray<string>): CommandRunResult => {
  if (args[0] === "--help")
    return success("Usage: trx skills update\nUsage: trx upgrade HARNESS PROFILE --harness-only --skills-only")
  if (args[0] === "harness-version") {
    return success('{"schemaVersion":1,"installed":"2.1.0","latestKnown":true,"latest":"3.0.0"}')
  }
  return success("updated")
}

const fixture = (source = catalog()) => {
  const lines: Array<string> = []
  const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => successfulCommand(args))
  const readCatalog = vi.fn(() => source)
  const invoke = (argv: ReadonlyArray<string>, overrides: Partial<HarnessUpgradeCliOptions> = {}) =>
    runHarnessUpgradeCli({
      argv,
      readCatalog,
      runner: { run },
      cwd: "/fixture/worktree",
      writeLine: (line) => lines.push(line),
      ...overrides,
    })
  return { lines, run, readCatalog, invoke }
}

describe("upgrade CLI arguments", () => {
  it.each([
    { argv: ["all"], approval: "confirm", scope: "all" },
    { argv: ["all", "--yes"], approval: "yes", scope: "all" },
    { argv: ["all", "--dry-run"], approval: "dry-run", scope: "all" },
    { argv: ["all", "--native"], approval: "confirm", scope: "native" },
    { argv: ["all", "--native", "--yes"], approval: "yes", scope: "native" },
    { argv: ["all", "--dry-run", "--native"], approval: "dry-run", scope: "native" },
  ])("parses $argv without broadening approval", ({ argv, approval, scope }) => {
    expect(parseHarnessUpgradeArgv(argv)).toEqual({ kind: "run", approval, scope })
  })

  it.each(["--help", "-h", "help"])("serves %s without catalog discovery or commands", async (flag) => {
    const { invoke, readCatalog, run, lines } = fixture()
    const confirm = vi.fn()
    expect(await invoke([flag], { confirm })).toBe(0)
    expect(await invoke(["all", flag], { confirm })).toBe(0)
    expect(readCatalog).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(lines.join("\n")).toContain("trx upgrade all [--native] [--yes | --dry-run]")
  })

  it.each(
    [
      [],
      ["--yes"],
      ["native"],
      ["all", "--yes", "--dry-run"],
      ["all", "--yes", "--yes"],
      ["all", "--dry-run", "--dry-run"],
      ["all", "--unknown"],
      ["all", "--yes=true"],
      ["all", "--"],
      ["all", "profile"],
      ["all", "--help", "--yes"],
      ["--help", "--yes"],
      ["all", "--native", "--native"],
      ["all", "--native", "--yes", "--dry-run"],
      ["all", "--native", "--help"],
    ].map((argv) => ({ argv })),
  )("rejects $argv before discovery, confirmation, or commands", async ({ argv }) => {
    const { invoke, readCatalog, run } = fixture()
    const confirm = vi.fn()
    await expect(invoke(argv, { confirm })).rejects.toThrow("Use trx upgrade all")
    expect(readCatalog).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})

describe("upgrade CLI discovery and authorization", () => {
  it("previews every profile and preserves pins without commands or confirmation in dry-run", async () => {
    const source = catalog()
    const before = JSON.stringify(source)
    const { invoke, lines, run, readCatalog } = fixture(source)
    const confirm = vi.fn()
    expect(await invoke(["all", "--dry-run"], { confirm })).toBe(0)
    expect(readCatalog).toHaveBeenCalledOnce()
    expect(confirm).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(JSON.stringify(source)).toBe(before)
    expect(lines.join("\n")).toContain("2 catalog profiles")
    for (const ref of ["native:claude/a", "native:claude/b"]) expect(lines.join("\n")).toContain(ref)
    expect(lines.join("\n")).not.toContain("sandbox:")
    expect(lines.join("\n")).toContain("Scope: 1 Native runtime/profile updates.")
    expect(lines.join("\n")).not.toContain("/fixture/trellage")
    expect(lines.join("\n")).toContain("Refresh: trx skills update")
    expect(lines.join("\n")).toContain("/fixture/trx upgrade claude a --skills-only")
    expect(lines.join("\n")).toContain("/fixture/trx upgrade claude b --skills-only")
    const preview = lines.join("\n")
    expect(preview).toContain("/fixture/trx upgrade claude a --harness-only")
    expect(preview.indexOf("/fixture/trx upgrade claude a --harness-only")).toBeLessThan(preview.indexOf("Refresh: trx skills update"))
    expect(preview.indexOf("Refresh: trx skills update")).toBeLessThan(preview.indexOf("/fixture/trx upgrade claude a --skills-only"))
    expect(lines.at(-1)).toContain("No harness or skill updates or installed-version checks were started")
  })

  it("accepts --native with the same Native harness and skill preview", async () => {
    const { invoke, lines, run } = fixture()
    expect(await invoke(["all", "--native", "--dry-run"])).toBe(0)
    expect(run).not.toHaveBeenCalled()
    const preview = lines.join("\n")
    expect(preview).toContain("Scope: 1 Native runtime/profile updates.")
    expect(preview).toContain("/fixture/trx upgrade claude a --harness-only")
    expect(preview).toContain("/fixture/trx upgrade claude b --skills-only")
    expect(preview).not.toContain("Container")
  })

  it("rejects duplicate static identities before running anything", async () => {
    const source = catalog()
    const { invoke, run } = fixture(source)
    await expect(invoke(["all", "--yes"], {
      readCatalog: () => ({ ...source, native: [...source.native, ...source.native] }),
    })).rejects.toThrow("Incomplete catalog")
    expect(run).not.toHaveBeenCalled()
  })

  it("reports unsupported entries as an incomplete dry-run without running anything", async () => {
    const { invoke, run, lines } = fixture({ ...catalog(), native: [native("agency", "agency")] })
    expect(await invoke(["all", "--dry-run"])).toBe(1)
    expect(run).not.toHaveBeenCalled()
    expect(lines.join("\n")).toContain("Unsupported harness native:agency/a: No harness update command is supported for agency.")
    expect(lines.join("\n")).toContain("/fixture/trx upgrade agency a --skills-only")
  })

  it("prints the complete scope before asking for explicit approval", async () => {
    const { invoke, run, lines } = fixture()
    const confirm = vi.fn(async (): Promise<HarnessUpgradeConfirmation> => {
      expect(lines.join("\n")).toContain("native:claude/b")
      expect(lines.join("\n")).toContain("Refresh: trx skills update")
      expect(lines.join("\n")).toContain("/fixture/trx upgrade claude b --skills-only")
      expect(run).not.toHaveBeenCalled()
      return "confirmed"
    })
    expect(await invoke(["all"], { confirm })).toBe(0)
    expect(confirm).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalled()
  })

  it.each([
    { confirmation: "cancelled" as const, status: 130 },
    { confirmation: "unavailable" as const, status: 1 },
  ])("does not run updates after $confirmation confirmation", async ({ confirmation, status }) => {
    const { invoke, run, lines } = fixture()
    expect(await invoke(["all"], { confirm: async () => confirmation })).toBe(status)
    expect(run).not.toHaveBeenCalled()
    expect(lines.join("\n")).not.toContain("All catalog harness versions and skills were updated.")
  })

  it("never treats absent non-interactive confirmation as approval", async () => {
    const { invoke, run, lines } = fixture()
    expect(await invoke(["all"])).toBe(1)
    expect(run).not.toHaveBeenCalled()
    expect(lines.at(-1)).toContain("Use --yes to authorize updates")
  })

  it("does not require a terminal for explicitly authorized updates", async () => {
    const { invoke } = fixture()
    const confirm = vi.fn()
    expect(await invoke(["all", "--yes"], { confirm })).toBe(0)
    expect(confirm).not.toHaveBeenCalled()
  })

  it.each([
    { native: [] },
    { native: [native(), native()] },
  ])("rejects an incomplete or duplicate catalog before approval", async (entries) => {
    const { invoke, run } = fixture({ ...catalog(), ...entries })
    const confirm = vi.fn()
    await expect(invoke(["all", "--yes"], { confirm })).rejects.toThrow("Incomplete catalog")
    expect(run).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it("does not mask catalog read or parse failures with a success summary", async () => {
    const { invoke, run, lines } = fixture()
    await expect(invoke(["all", "--yes"], { readCatalog: () => parseGuideCatalog("{}") })).rejects.toThrow("catalog")
    expect(run).not.toHaveBeenCalled()
    expect(lines).toEqual([])
  })

  it("does not hide an unexpected confirmation failure or start mutations", async () => {
    const { invoke, run, lines } = fixture()
    const error = Object.assign(new Error("too many open files"), { code: "EMFILE" })
    await expect(
      invoke(["all"], {
        confirm: async () => {
          throw error
        },
      }),
    ).rejects.toBe(error)
    expect(run).not.toHaveBeenCalled()
    expect(lines.some((line) => line.startsWith("No approval:"))).toBe(false)
  })
})

describe("upgrade CLI shared queue execution", () => {
  it("runs shared and per-profile updates, then reports each result and fresh installed versions", async () => {
    const { invoke, run, lines } = fixture()
    expect(await invoke(["all", "--yes"])).toBe(0)
    expect(run.mock.calls.map(([executable, args]) => [executable, args])).toEqual([
      ["/fixture/trx", ["--help"]],
      ["/fixture/trx", ["upgrade", "claude", "a", "--harness-only"]],
      ["/fixture/trx", ["harness-version", "claude", "a"]],
      ["trx", ["--help"]],
      ["trx", ["skills", "update"]],
      ["/fixture/trx", ["--help"]],
      ["/fixture/trx", ["upgrade", "claude", "a", "--skills-only"]],
      ["/fixture/trx", ["--help"]],
      ["/fixture/trx", ["upgrade", "claude", "b", "--skills-only"]],
    ])
    expect(run.mock.calls.every(([, , options]) => options?.cwd === "/fixture/worktree")).toBe(true)
    expect(lines.join("\n")).toContain("[1/1] Native claude")
    expect(lines.join("\n")).toContain("Updated harness native:claude/a")
    expect(lines.join("\n")).toContain("Updated harness native:claude/b")
    expect(lines.join("\n")).toContain("Harness summary: 2 updated, 0 failed, 0 unsupported")
    expect(lines.join("\n")).toContain("Native skills summary: 2 updated, 0 failed, 0 not run; shared cache: updated.")
    expect(lines.at(-1)).toBe("All catalog harness versions and skills were updated.")
  })

  it("keeps Oh My Pi and Pi Coding Agent operations distinct", async () => {
    const { invoke, run } = fixture({
      ...catalog(),
      native: [
        native("omp", "oh-my-pi"),
        native("pi", "pi"),
      ],
    })
    expect(await invoke(["all", "--yes"])).toBe(0)
    expect(
      run.mock.calls.filter(([, args]) => ["update", "upgrade"].includes(args[0]!) && !args.includes("--skills-only")).map(([executable, args]) => [executable, args]),
    ).toEqual([
      ["/fixture/trx", ["upgrade", "omp", "a"]],
      ["/fixture/trx", ["upgrade", "pi", "a"]],
    ])
  })

  it("continues independent failures and reports unsupported profiles without declaring full success", async () => {
    const { invoke, run, lines } = fixture({
      ...catalog(),
      native: [...catalog().native, native("agency", "agency")],
    })
    run.mockImplementation(async (executable, args) => {
      if (args.includes("--harness-only")) {
        throw new CommandRunnerError({
          kind: "exited",
          executable,
          args,
          exitCode: 9,
          message: "fixture command failed",
          stderr: "native package fetch failed",
        })
      }
      return successfulCommand(args)
    })
    expect(await invoke(["all", "--yes"])).toBe(1)
    expect(lines.join("\n")).toContain("Failed harness native:claude/b: native package fetch failed")
    expect(lines.join("\n")).not.toContain("sandbox:")
    expect(lines.join("\n")).toContain("Unsupported harness native:agency/a")
    expect(lines.at(-1)).toContain("did not complete successfully")
  })

  it("fails closed on old wrappers instead of forwarding an unknown verb into an agent", async () => {
    const { invoke, run, lines } = fixture()
    run.mockImplementation(async (executable, args) =>
      executable === "/fixture/trx" && args[0] === "--help" ? success("Usage: cldx PROFILE [AGENT_ARGS]") : successfulCommand(args),
    )
    expect(await invoke(["all", "--yes"])).toBe(1)
    expect(run.mock.calls.some(([, args]) => args.includes("--harness-only"))).toBe(false)
    expect(lines.join("\n")).toContain("does not support upgrade. Refresh the installed Trellage launcher first.")
    expect(run.mock.calls.some(([, args]) => args.includes("--skills-only"))).toBe(false)
    expect(lines.join("\n")).toContain("does not support upgrade. Refresh the installed Trellage launcher first.")
  })

  it("reports installed-version refresh failure and continues other groups", async () => {
    const { invoke, run, lines } = fixture()
    run.mockImplementation(async (executable, args) =>
      executable === "/fixture/trx" && args[0] === "harness-version"
        ? success('{"schemaVersion":1,"installed":null,"latestKnown":true,"latest":"3.0.0"}')
        : successfulCommand(args),
    )
    expect(await invoke(["all", "--yes"])).toBe(1)
    expect(lines.join("\n")).toContain("Installed-version refresh failed for Native claude")
    expect(lines.join("\n")).toContain("1 installed-version refresh failures")
    expect(lines.at(-1)).toContain("did not complete successfully")
  })

  it("reports latest-lookup limitations without confusing them with a failed installed-version read", async () => {
    const { invoke, run, lines } = fixture()
    run.mockImplementation(async (_executable, args) =>
      args[0] === "harness-version"
        ? success('{"schemaVersion":1,"installed":"2.1.0","latestKnown":false,"latest":null}')
        : successfulCommand(args),
    )
    expect(await invoke(["all", "--yes"])).toBe(0)
    expect(lines.join("\n")).toContain("Latest-version lookup unsupported")
  })

  it("stops active mutation on cancellation and reports profiles not run", async () => {
    const { invoke, run, lines } = fixture()
    const controller = new AbortController()
    run.mockImplementation(async (executable, args, options) => {
      if (!args.includes("--harness-only")) return successfulCommand(args)
      return new Promise((_resolve, reject) => {
        options!.signal!.addEventListener(
          "abort",
          () => reject(new CommandRunnerError({ kind: "aborted", executable, args, message: "fixture update cancelled" })),
          { once: true },
        )
        controller.abort()
      })
    })
    expect(await invoke(["all", "--yes"], { signal: controller.signal })).toBe(130)
    expect(run.mock.calls.filter(([, args]) => args[0] !== "--help").map(([, args]) => args)).toEqual([["upgrade", "claude", "a", "--harness-only"]])
    expect(lines.join("\n")).toContain("fixture update cancelled")
    expect(lines.join("\n")).toContain("not run")
    expect(lines.at(-1)).toContain("Completed updates were not rolled back")
  })

  it("does not start an already-cancelled authorized run", async () => {
    const { invoke, run } = fixture()
    expect(await invoke(["all", "--yes"], { signal: AbortSignal.abort() })).toBe(130)
    expect(run).not.toHaveBeenCalled()
  })

  it("forwards cancellation to installed-version reads and does not start the next update group", async () => {
    const { invoke, run, lines } = fixture()
    const controller = new AbortController()
    run.mockImplementation(async (executable, args, options) => {
      const cancelled = () => new CommandRunnerError({ kind: "aborted", executable, args, message: "version read cancelled" })
      if (options?.signal?.aborted === true) throw cancelled()
      if (args[0] !== "harness-version") return successfulCommand(args)
      return new Promise((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(cancelled()), { once: true })
        controller.abort()
      })
    })
    expect(await invoke(["all", "--yes"], { signal: controller.signal })).toBe(130)
    expect(run.mock.calls.some(([, args]) => args[0] === "upgrade" && !args.includes("--skills-only") && !args.includes("--harness-only"))).toBe(false)
    expect(lines.join("\n")).toContain("Installed-version refresh failed")
  })
})

describe("upgrade CLI Native skills phase", () => {
  it("uses the exact router executable without switching to an installed PATH copy", async () => {
    const { invoke, run, lines } = fixture()
    const routerCommandPath = "/fixture/current worktree/bin/trx"
    expect(await invoke(["all", "--yes"], { routerCommandPath })).toBe(0)
    expect(
      run.mock.calls.filter(([executable]) => executable === routerCommandPath).map(([executable, args]) => [executable, args]),
    ).toEqual([
      [routerCommandPath, ["--help"]],
      [routerCommandPath, ["skills", "update"]],
    ])
    expect(run.mock.calls.some(([executable]) => executable === "trx")).toBe(false)
    expect(lines.join("\n")).toContain("Refresh: '/fixture/current worktree/bin/trx' skills update")
  })

  it("refreshes shared caches once and copies every Native profile, including unsupported Agency harnesses", async () => {
    const launchers = [
      ["agency", "agency"],
      ["copilot", "copilot"],
      ["codex", "codex"],
      ["claude", "claude"],
      ["jcode", "jcode"],
      ["omp", "oh-my-pi"],
      ["pi", "pi"],
      ["prime", "prime"],
    ] as const
    const { invoke, run, lines } = fixture({ ...catalog(), native: launchers.map(([launcher, harness]) => native(launcher, harness)) })
    expect(await invoke(["all", "--yes"])).toBe(1)
    expect(run.mock.calls.filter(([, args]) => args[0] === "skills")).toHaveLength(1)
    expect(
      run.mock.calls
        .filter(([, args]) => args.includes("--skills-only"))
        .map(([executable, args]) => [executable, args])
        .sort(),
    ).toEqual(launchers.map(([launcher]) => ["/fixture/trx", ["upgrade", launcher, "a", "--skills-only"]]).sort())
    expect(lines.join("\n")).toContain("Updated Native skills native:agency/a")
    expect(lines.join("\n")).toContain("Unsupported harness native:agency/a")
    expect(lines.join("\n")).toContain("Native skills summary: 8 updated, 0 failed, 0 not run")
  })

  it("does not use stale caches after refresh failure, but still runs independent harness updates", async () => {
    const { invoke, run, lines } = fixture()
    run.mockImplementation(async (_executable, args) => {
      if (args[0] === "skills") throw new Error("fixture shared skills cache failed")
      return successfulCommand(args)
    })
    expect(await invoke(["all", "--yes"])).toBe(1)
    expect(run.mock.calls.some(([, args]) => args.includes("--skills-only"))).toBe(false)
    expect(lines.join("\n")).toContain("Native skills cache failed: fixture shared skills cache failed")
    expect(lines.join("\n")).toContain("Native skills not run native:claude/a: shared cache refresh failed; no stale cache is used.")
    expect(lines.join("\n")).toContain("Native skills not run native:claude/b: shared cache refresh failed; no stale cache is used.")
    expect(lines.join("\n")).toContain("Harness summary: 2 updated, 0 failed, 0 unsupported")
    expect(lines.join("\n")).toContain("Native skills summary: 0 updated, 0 failed, 2 not run; shared cache: failed.")
    expect(lines.at(-1)).toContain("did not complete successfully")
  })

  it("continues after a per-profile copy or verification failure and keeps skill counts separate", async () => {
    const { invoke, run, lines } = fixture()
    run.mockImplementation(async (_executable, args) => {
      if (args.includes("--skills-only") && args[2] === "a") throw new Error("fixture skill verification failed")
      return successfulCommand(args)
    })
    expect(await invoke(["all", "--yes"])).toBe(1)
    expect(lines.join("\n")).toContain("Failed Native skills native:claude/a: fixture skill verification failed")
    expect(lines.join("\n")).toContain("Updated Native skills native:claude/b")
    expect(lines.join("\n")).toContain("Harness summary: 2 updated, 0 failed, 0 unsupported")
    expect(lines.join("\n")).toContain("Native skills summary: 1 updated, 1 failed, 0 not run; shared cache: updated.")
    expect(lines.at(-1)).toContain("did not complete successfully")
  })

  it.each(["Usage: launcher harness-update", "Usage: launcher harness-update skills-updates", ""])(
    "does not send an unsafe skills verb to a launcher with help %j",
    async (help) => {
      const { invoke, run, lines } = fixture()
      run.mockImplementation(async (executable, args) =>
        executable === "/fixture/trx" && args[0] === "--help" ? success(help) : successfulCommand(args),
      )
      expect(await invoke(["all", "--yes"])).toBe(1)
      expect(run.mock.calls.some(([, args]) => args.includes("--skills-only"))).toBe(false)
      expect(lines.join("\n")).toContain("does not support upgrade")
        expect(lines.join("\n")).toContain("Native skills summary: 0 updated, 2 failed, 0 not run")
    },
  )

  it("rejects an old router skills interface without forwarding an unknown command", async () => {
    const { invoke, run, lines } = fixture()
    run.mockImplementation(async (executable, args) =>
      executable === "trx" && args[0] === "--help" ? success("Usage: trx PROFILE") : successfulCommand(args),
    )
    expect(await invoke(["all", "--yes"])).toBe(1)
    expect(run.mock.calls.some(([, args]) => args[0] === "skills" || args.includes("--skills-only"))).toBe(false)
    expect(lines.join("\n")).toContain("does not support skills update")
    expect(lines.join("\n")).toContain("Harness summary: 2 updated, 0 failed, 0 unsupported")
  })

  it.each(["skills", "skills-update"])(
    "cancels the active %s phase and reports later skills and harness profiles not run",
    async (verb) => {
      const { invoke, run, lines } = fixture()
      const controller = new AbortController()
      run.mockImplementation(async (executable, args, options) => {
        if (verb === "skills-update" ? !args.includes("--skills-only") : args[0] !== verb) return successfulCommand(args)
        return new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => reject(new CommandRunnerError({ kind: "aborted", executable, args, message: "fixture skills cancelled" })),
            { once: true },
          )
          controller.abort()
        })
      })
      expect(await invoke(["all", "--yes"], { signal: controller.signal })).toBe(130)
      expect(run.mock.calls.some(([, args]) => args[0] === "upgrade" && !args.includes("--skills-only") && !args.includes("--harness-only"))).toBe(false)
      expect(run.mock.calls.some(([, args]) => args.includes("--harness-only"))).toBe(true)
      expect(run.mock.calls.some(([, args]) => args.includes("--skills-only") && args[2] === "b")).toBe(false)
      expect(lines.join("\n")).toContain("Native skills not run native:claude/b: cancelled.")
      expect(lines.join("\n")).toContain("fixture skills cancelled")
    },
  )
})

const terminal = () => ({
  input: Object.assign(new PassThrough(), { isTTY: true }),
  output: new PassThrough(),
})

describe("upgrade CLI terminal confirmation", () => {
  it.each(["ENXIO", "ENOTTY", "ENOENT", "EACCES", "EPERM"])("normalizes expected terminal error %s and retains its cause", (code) => {
    const cause = Object.assign(new Error("fixture terminal unavailable"), { code })
    const error = normalizeInteractiveTerminalError(cause)
    expect(error).toBeInstanceOf(InteractiveTerminalRequiredError)
    expect((error as InteractiveTerminalRequiredError).cause).toBe(cause)
    expect((error as Error).message).toBe("an interactive controlling terminal is required")
  })

  it("preserves unexpected terminal failures instead of converting them to missing approval", () => {
    const exhausted = Object.assign(new Error("too many open files"), { code: "EMFILE" })
    const unexpected = new TypeError("unexpected stream failure")
    expect(normalizeInteractiveTerminalError(exhausted)).toBe(exhausted)
    expect(normalizeInteractiveTerminalError(unexpected)).toBe(unexpected)
  })

  it.each([
    { answer: "yes", expected: "confirmed" },
    { answer: " YES ", expected: "confirmed" },
    { answer: "", expected: "cancelled" },
    { answer: "y", expected: "cancelled" },
    { answer: "no", expected: "cancelled" },
    { answer: "yes --force", expected: "cancelled" },
  ])("handles an explicit terminal answer '$answer'", async ({ answer, expected }) => {
    const { input, output } = terminal()
    const result = confirmHarnessUpgrade(input, output)
    input.write(`${answer}\r`)
    expect(await result).toBe(expected)
    input.destroy()
    output.destroy()
  })

  it("never reads approval from a non-TTY stream, including catalog JSON or piped yes", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    input.end("yes\n")
    expect(await confirmHarnessUpgrade(input, output)).toBe("unavailable")
    expect(input.read()?.toString()).toBe("yes\n")
    output.destroy()
  })

  it.each(["eof", "interrupt", "abort"])("cancels safely on %s", async (action) => {
    const { input, output } = terminal()
    const controller = new AbortController()
    const result = confirmHarnessUpgrade(input, output, controller.signal)
    if (action === "eof") input.end()
    if (action === "interrupt") input.write("\u0003")
    if (action === "abort") controller.abort()
    expect(await result).toBe("cancelled")
    input.destroy()
    output.destroy()
  })
})
