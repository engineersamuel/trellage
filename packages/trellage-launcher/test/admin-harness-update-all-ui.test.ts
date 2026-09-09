import { Socket } from "node:net"
import { clearLine, clearScreenDown, cursorTo, moveCursor } from "node:readline"
import { stripVTControlCharacters } from "node:util"
import type { Direction } from "node:tty"
import React from "react"
import { render } from "ink"
import stringWidth from "string-width"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AdminApp } from "../src/admin-ui.js"
import { AdminRunManager } from "../src/admin-run-manager.js"
import { launchAdminProfile } from "../src/admin-launch.js"
import { DoctorFailureDiagnosisProvider } from "../src/admin-diagnosis-provider.js"
import { checkAdminSkillsUpdates } from "../src/admin-skills-check.js"
import type { AdminProfileEntry } from "../src/admin-model.js"
import type { CommandRunner, CommandRunOptions, CommandRunResult } from "../src/guide-launch.js"

vi.mock("../src/admin-harness-version-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin-harness-version-cache.js")>()),
  loadHarnessVersionCache: async () => ({ schemaVersion: 2, entries: {} }),
  defaultAdminHarnessVersionCachePath: () => "/unused/admin-cache.json",
  createHarnessVersionCacheSaveQueue: () => ({ enqueue: async () => {} }),
}))

vi.mock("../src/admin-launch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin-launch.js")>()),
  launchAdminProfile: vi.fn<typeof launchAdminProfile>(async () => {}),
}))

vi.mock("../src/admin-skills-check.js", () => ({
  checkAdminSkillsUpdates: vi.fn<typeof checkAdminSkillsUpdates>(
    async (entries: ReadonlyArray<AdminProfileEntry>) => new Map(entries.map((entry) => [entry.ref, { kind: "current" as const }])),
  ),
}))

// In-memory sockets satisfy Ink's full TTY types without opening a host terminal.
class TestInput extends Socket {
  isTTY = true
  isRaw = false
  override _read(): void {}
  setRawMode(mode: boolean): this {
    this.isRaw = mode
    return this
  }
}

class TestOutput extends Socket {
  isTTY = true
  columns = 140
  rows = 48
  readonly frames: string[] = []
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const text = stripVTControlCharacters(chunk.toString("utf8"))
    if (text.trim().length > 0) this.frames.push(text)
    callback()
  }
  clearLine(direction: Direction, callback?: () => void): boolean {
    return clearLine(this, direction, callback)
  }
  clearScreenDown(callback?: () => void): boolean {
    return clearScreenDown(this, callback)
  }
  cursorTo(x: number, y?: number | (() => void), callback?: () => void): boolean {
    return typeof y === "function" ? cursorTo(this, x, undefined, y) : cursorTo(this, x, y, callback)
  }
  moveCursor(x: number, y: number, callback?: () => void): boolean {
    return moveCursor(this, x, y, callback)
  }
  getColorDepth(): number {
    return 1
  }
  hasColors(): boolean {
    return false
  }
  getWindowSize(): [number, number] {
    return [this.columns, this.rows]
  }
}

const container = (name: string, harness = "claude"): AdminProfileEntry => ({
  ref: `sandbox:${name}`,
  surface: "sandbox",
  harness,
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
  harnessVersionSelector: "latest",
  updateCheckStale: false,
})

const native = (name = "default"): AdminProfileEntry => ({
  ...container(name),
  ref: `native:cldx/${name}`,
  surface: "native",
  launcher: "cldx",
  commandPath: "/fixture/cldx",
})

const success: CommandRunResult = { stdout: "updated", stderr: "", exitCode: 0 }
const versionReport = (installed = "2.1.252", latest = "3.0.0"): CommandRunResult => ({
  ...success,
  stdout: JSON.stringify({ schemaVersion: 1, installed, latest, latestKnown: true }),
})
const isUpdate = (args: ReadonlyArray<string>) =>
  ["harness-update", "upgrade", "update", "skills", "skills-update", "repair", "setup"].includes(args[0] ?? "")
const commandResult = (args: ReadonlyArray<string>): CommandRunResult => {
  if (args[0] === "--help")
    return { ...success, stdout: "usage: launcher harness-update\nlauncher skills-update PROFILE\ntrx skills update" }
  if (args[0] === "harness-version") return versionReport()
  return success
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.mocked(checkAdminSkillsUpdates).mockReset()
  vi.mocked(checkAdminSkillsUpdates).mockImplementation(
    async (entries) => new Map(entries.map((entry) => [entry.ref, { kind: "current" as const }])),
  )
})

const mountAdmin = async (
  entries: ReadonlyArray<AdminProfileEntry>,
  onUpdate?: (options: CommandRunOptions | undefined, args: ReadonlyArray<string>) => Promise<CommandRunResult>,
  size = { columns: 140, rows: 48 },
  onVersion?: CommandRunner["run"],
) => {
  const stdin = new TestInput()
  const stdout = new TestOutput()
  stdout.columns = size.columns
  stdout.rows = size.rows
  const stderr = new TestOutput()
  const run = vi.fn<CommandRunner["run"]>(async (executable, args, options) => {
    if (isUpdate(args) && onUpdate !== undefined) return onUpdate(options, args)
    if (args[0] === "harness-version" && onVersion !== undefined) return onVersion(executable, args, options)
    return commandResult(args)
  })
  const clientFactory = vi.fn<() => never>(() => {
    throw new Error("Model inference is not allowed")
  })
  const app = render(
    React.createElement(AdminApp, {
      entries,
      runManager: new AdminRunManager({ runner: { run } }),
      guideRoot: "/unused",
      runner: { run },
      diagnosisProvider: new DoctorFailureDiagnosisProvider({ clientFactory }),
      herdrEnv: {},
      cwd: "/fixture/worktree",
      routerCommandPath: "/fixture/trx",
    }),
    { stdin, stdout, stderr, debug: true, interactive: true, patchConsole: false },
  )
  // Subscribe before unmount so Ink can remove its beforeExit handler.
  const beforeExitListeners = process.listeners("beforeExit")
  const exited = app.waitUntilExit()
  cleanups.push(async () => {
    app.unmount()
    await exited
    app.cleanup()
    stdin.destroy()
    stdout.destroy()
    stderr.destroy()
    expect(process.listeners("beforeExit")).toEqual(beforeExitListeners)
    expect(clientFactory).not.toHaveBeenCalled()
    expect(launchAdminProfile).not.toHaveBeenCalled()
  })
  const screen = () => stdout.frames.at(-1) ?? ""
  const press = async (key: string) => {
    stdin.push(key)
    await new Promise<void>((resolve) => setImmediate(resolve))
    await app.waitUntilRenderFlush()
  }
  const updates = () => run.mock.calls.filter(([, args]) => isUpdate(args))
  await vi.waitFor(() => expect(screen()).toContain("Trellage Admin"))
  return { app, exited, screen, press, updates, run }
}

describe("global Admin update keyboard ownership", () => {
  it("hides current harnesses and skills and disables confirmation when nothing is available", async () => {
    const nativeProfiles = ["pstack", "superpowers"].map((name) => ({
      ...native(name),
      ref: `native:cdx/${name}`,
      launcher: "cdx",
      harness: "codex",
      commandPath: "/fixture/cdx",
    }))
    const profiles = [...nativeProfiles, { ...container("codex-current", "codex"), version: "0.153.4" }]
    const tui = await mountAdmin(profiles, undefined, undefined, async () => versionReport("0.153.4", "0.153.4"))
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain("Everything is up to date"))
    for (const entry of profiles) expect(tui.screen()).not.toContain(entry.ref)
    expect(tui.screen()).toContain("Native updates: 0 | Container builds: 0")
    expect(tui.screen()).not.toContain("0.153.4 -> 0.153.4")
    expect(tui.updates()).toHaveLength(0)
    await tui.press("y")
    expect(tui.updates()).toHaveLength(0)
    expect(tui.screen()).not.toContain("[y]")
    const checks = tui.run.mock.calls.filter(([, args]) => args[0] === "harness-version").length
    await tui.press("\u001b")
    await vi.waitFor(() => expect(tui.screen()).toContain("Trellage Admin"))
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain("Everything is up to date"))
    expect(tui.run.mock.calls.filter(([, args]) => args[0] === "harness-version").length).toBeGreaterThan(checks)
  })

  it("shows per-profile current and target versions before skills, preserving mixed Container pins", async () => {
    const installed = new Map([
      ["floating", "2.1.252"],
      ["pinned", "2.1.263"],
      ["current", "2.1.260"],
    ])
    const entries = [
      native(),
      ...[...installed].map(([name, version]) => ({
        ...container(name),
        version,
        harnessVersionSelector: name === "pinned" ? "2.1.252" : "latest",
      })),
    ]
    const tui = await mountAdmin(entries, undefined, undefined, async (_executable, args) =>
      versionReport(installed.get(args[1] ?? "") ?? "2.1.259", "2.1.260"),
    )
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain("native:cldx/default: 2.1.259 -> 2.1.260"))
    expect(tui.screen()).toContain("sandbox:floating: 2.1.252 -> 2.1.260")
    expect(tui.screen()).toContain("sandbox:pinned: 2.1.263 -> 2.1.252 (pinned)")
    expect(tui.screen()).not.toContain("sandbox:current")
    expect(tui.screen()).not.toContain("2.1.260 -> 2.1.260")
    expect(tui.screen().indexOf("sandbox:pinned:")).toBeLessThan(tui.screen().indexOf("Native skills"))
    expect(tui.updates()).toHaveLength(0)
  })

  it("waits for fresh versions and skill checks before enabling the frozen selection", async () => {
    let resolveVersion = (_result: CommandRunResult): void => {
      throw new Error("Version lookup was not initialized")
    }
    const pending = new Promise<CommandRunResult>((resolve) => {
      resolveVersion = resolve
    })
    let resolveSkills!: (result: Awaited<ReturnType<typeof checkAdminSkillsUpdates>>) => void
    vi.mocked(checkAdminSkillsUpdates).mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          resolveSkills = resolve
        }),
    )
    const tui = await mountAdmin([native()], undefined, undefined, async () => pending)
    await vi.waitFor(() => expect(tui.run.mock.calls.some(([, args]) => args[0] === "harness-version")).toBe(true))
    await tui.press("A")
    expect(tui.screen()).toContain("Checking harness versions and skill sources")
    await tui.press("y")
    expect(tui.updates()).toHaveLength(0)

    resolveVersion(versionReport("2.1.252", "2.1.260"))
    await tui.press("y")
    expect(tui.screen()).not.toContain("[y]")
    expect(tui.updates()).toHaveLength(0)
    resolveSkills(new Map([[native().ref, { kind: "current" }]]))
    await vi.waitFor(() => expect(tui.screen()).toContain("Planned native:cldx/default: 2.1.252 -> 2.1.260"))
    expect(tui.screen()).toContain("[y] update selected items")
    expect(tui.screen()).toContain("Required after harness updates")
    expect(tui.updates()).toHaveLength(0)
    await tui.press("y")
    await vi.waitFor(() => expect(tui.screen()).toContain("Update all finished: 1 updated"))
    expect(tui.updates().map(([, args]) => args)).toEqual([["harness-update"], ["skills", "update"], ["skills-update", "default"]])
  })

  it("shows each Firstmate profile's own source revision and catalog pin", async () => {
    const entries = ["default", "pstack-workers"].map((name) => ({
      ...native(name),
      ref: `native:fmx/${name}`,
      launcher: "fmx",
      harness: "firstmate",
      commandPath: "/fixture/fmx",
    }))
    const reports = new Map([
      ["default", versionReport("a".repeat(40), "b".repeat(40))],
      ["pstack-workers", versionReport("c".repeat(40), "d".repeat(40))],
    ])
    const tui = await mountAdmin(entries, undefined, undefined, async (_executable, args) => {
      const result = reports.get(args[1] ?? "")
      if (result === undefined) throw new Error(`Unexpected version command: ${args.join(" ")}`)
      return result
    })
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain(`${"d".repeat(40)} (catalog pin)`))
    expect(tui.screen()).toContain(`native:fmx/default: ${"a".repeat(40)} -> ${"b".repeat(40)} (catalog pin)`)
    expect(tui.screen()).toContain(`native:fmx/pstack-workers: ${"c".repeat(40)} -> ${"d".repeat(40)}`)
    expect(tui.updates()).toHaveLength(0)
  })

  it("aborts discovery on close and ignores its late results", async () => {
    let resolveSkills!: (result: Awaited<ReturnType<typeof checkAdminSkillsUpdates>>) => void
    vi.mocked(checkAdminSkillsUpdates).mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          resolveSkills = resolve
        }),
    )
    const tui = await mountAdmin([native()])
    await tui.press("A")
    await vi.waitFor(() => expect(checkAdminSkillsUpdates).toHaveBeenCalled())
    const signal = vi.mocked(checkAdminSkillsUpdates).mock.calls.at(-1)?.[4]
    expect(tui.screen()).toContain("Checking harness versions and skill sources")
    await tui.press("\u001b")
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    resolveSkills(new Map([[native().ref, { kind: "available" }]]))
    await tui.press("y")
    expect(tui.screen()).toContain("Trellage Admin")
    expect(tui.screen()).not.toContain("Update all harnesses and skills")
    expect(tui.updates()).toHaveLength(0)
  })

  it("updates only available skill copies and rebuilds a skill-only Container", async () => {
    const entries = [native("changed"), native("current"), container("skills"), container("current")]
    vi.mocked(checkAdminSkillsUpdates).mockResolvedValueOnce(
      new Map(entries.map((entry) => [entry.ref, { kind: entry.name === "current" ? ("current" as const) : ("available" as const) }])),
    )
    const tui = await mountAdmin(entries, undefined, undefined, async () => versionReport("3.0.0", "3.0.0"))
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain("[y] update selected items"))
    expect(tui.screen()).toContain("Native updates: 0 | Container builds: 1")
    expect(tui.screen()).toContain("Skills update sandbox:skills")
    expect(tui.screen()).toContain("Skills update native:cldx/changed")
    expect(tui.screen()).not.toContain("native:cldx/current")
    expect(tui.screen()).not.toContain("sandbox:current")
    await tui.press("y")
    await vi.waitFor(() => expect(tui.screen()).toContain("Update all finished: 1 updated"))
    expect(tui.updates().map(([, args]) => args)).toEqual([
      ["skills", "update"],
      ["skills-update", "changed"],
      ["upgrade", "skills", "--strict-harness"],
    ])
  })

  it("can refresh only an available shared skill cache", async () => {
    vi.mocked(checkAdminSkillsUpdates).mockResolvedValueOnce(
      new Map([
        [native().ref, { kind: "current" }],
        ["skills:shared", { kind: "available" }],
      ]),
    )
    const tui = await mountAdmin([native()], undefined, undefined, async () => versionReport("3.0.0", "3.0.0"))
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain("Shared skill cache update"))
    expect(tui.screen()).not.toContain(native().ref)
    await tui.press("y")
    await vi.waitFor(() => expect(tui.screen()).toContain("Update all finished: 0 updated"))
    expect(tui.updates().map(([, args]) => args)).toEqual([["skills", "update"]])
  })

  it("shows unknown checks separately without selecting or calling them current", async () => {
    const entries = [container("available"), container("current"), container("unknown")]
    vi.mocked(checkAdminSkillsUpdates).mockResolvedValueOnce(
      new Map([
        [entries[0]!.ref, { kind: "current" }],
        [entries[1]!.ref, { kind: "current" }],
        [entries[2]!.ref, { kind: "unknown", diagnostic: "Skill source offline" }],
      ]),
    )
    const tui = await mountAdmin(entries, undefined, undefined, async (_executable, args) => {
      if (args[1] === "unknown") throw new Error("Version source offline")
      return versionReport(args[1] === "current" ? "3.0.0" : "2.1.252")
    })
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain("[y] update selected items"))
    expect(tui.screen()).toContain("Incomplete checks")
    expect(tui.screen()).toContain("Skill source offline")
    expect(tui.screen()).not.toContain("sandbox:current")
    expect(tui.screen()).not.toContain("Planned sandbox:unknown")
    expect(tui.screen()).not.toContain("Everything is up to date")
    await tui.press("y")
    await vi.waitFor(() => expect(tui.screen()).toContain("Update all finished: 1 updated, 0 failed"))
    expect(tui.updates().map(([, args]) => args)).toEqual([["upgrade", "available", "--strict-harness"]])
  })

  it("disables confirmation when only failed checks remain", async () => {
    vi.mocked(checkAdminSkillsUpdates).mockResolvedValueOnce(
      new Map([[native().ref, { kind: "unknown", diagnostic: "Skill source offline" }]]),
    )
    const tui = await mountAdmin([native()], undefined, undefined, async () => {
      throw new Error("Version source offline")
    })
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain("No confirmed updates"))
    expect(tui.screen()).toContain("Incomplete checks")
    expect(tui.screen()).toContain("Version source offline")
    expect(tui.screen()).toContain("Skill source offline")
    expect(tui.screen()).not.toContain("Everything is up to date")
    expect(tui.screen()).not.toContain("[y]")
    await tui.press("y")
    expect(tui.updates()).toHaveLength(0)
  })

  it("keeps A and U as search text, previews hidden profiles, cancels without mutation, and updates the full confirmed scope", async () => {
    const unsupported: AdminProfileEntry = {
      ...native(),
      ref: "native:agx/default",
      launcher: "agx",
      harness: "agency",
      harnessVersionSupported: false,
      commandPath: "/fixture/agx",
    }
    const entries = [native("native-a"), native("native-b"), container("container-a"), container("container-b"), unsupported]
    const tui = await mountAdmin(entries)
    await tui.press("/")
    await tui.press("A")
    await tui.press("U")
    await tui.press("x")
    expect(tui.screen()).toContain("Search: AUx")
    expect(tui.updates()).toHaveLength(0)
    await tui.press("\r")
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain("including profiles hidden by filters"))
    await vi.waitFor(() => expect(tui.screen()).toContain("[y] update selected items"))
    expect(tui.screen()).toContain("Native updates: 1 | Container builds: 2 | Incomplete checks: 1")
    expect(tui.screen()).toContain("Native skill copies: 2")
    for (const entry of entries) expect(tui.screen()).toContain(entry.ref)
    for (const key of ["U", "l", "p", "g", "i"]) await tui.press(key)
    expect(tui.updates()).toHaveLength(0)
    await tui.press("\u001b")
    await vi.waitFor(() => expect(tui.screen()).toContain('No profiles match "AUx"'))
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain("[y] update selected items"))
    await tui.press("y")
    await vi.waitFor(() => expect(tui.screen()).toContain("Update all finished: 4 updated, 0 failed, 0 unsupported"))
    expect(tui.screen()).toContain("Native skills: 2 updated, 0 failed, 0 not run")
    expect(tui.updates().map(([, args]) => args)).toEqual([
      ["harness-update"],
      ["skills", "update"],
      ["skills-update", "native-a"],
      ["skills-update", "native-b"],
      ["upgrade", "container-a", "--strict-harness"],
      ["upgrade", "container-b", "--strict-harness"],
    ])
    expect(tui.updates().find(([, args]) => args[0] === "skills")?.[0]).toBe("/fixture/trx")
    await tui.press("\u001b")
    await vi.waitFor(() => expect(tui.screen()).toContain("Trellage Admin"))
    await tui.press("/")
    await tui.press("\u007f")
    await tui.press("\u007f")
    await tui.press("\u007f")
    await tui.press("\r")
    expect(tui.screen()).toContain("3.0.0")
  })

  it("does not let A change the scope of an existing U confirmation", async () => {
    const tui = await mountAdmin([container("claude-a"), container("claude-b"), container("codex", "codex"), native()])
    await tui.press("U")
    await tui.press("A")
    expect(tui.screen()).not.toContain("including profiles hidden by filters")
    await tui.press("y")
    expect(tui.updates()).toHaveLength(0)
    await tui.press("U")
    await tui.press("y")
    await vi.waitFor(() => expect(tui.updates()).toHaveLength(2))
    expect(tui.updates().map(([, args]) => args)).toEqual([
      ["upgrade", "claude-a", "--strict-harness"],
      ["upgrade", "claude-b", "--strict-harness"],
    ])
  })

  it("shows active progress, blocks duplicate or profile actions, and cancels pending work", async () => {
    const tui = await mountAdmin([native(), container("queued")], async (options, args) => {
      if (args[0] !== "skills") return commandResult(args)
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("Update cancelled")), { once: true })
      })
    })
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain("[y] update selected items"))
    await tui.press("y")
    await vi.waitFor(() => expect(tui.updates()).toHaveLength(2))
    expect(tui.screen()).toContain("Refreshing shared Native skill caches")
    await tui.press("A")
    await tui.press("y")
    await tui.press("\u001b")
    await vi.waitFor(() => expect(tui.screen()).toContain("[A] view update progress"))
    expect(tui.screen()).not.toContain("[U] update harness")
    for (const key of ["U", "l", "p"]) await tui.press(key)
    expect(tui.updates()).toHaveLength(2)
    await tui.press("A")
    await tui.press("c")
    await vi.waitFor(() => expect(tui.screen()).toContain("Update all cancelled"))
    expect(tui.updates()).toHaveLength(2)
    expect(tui.screen()).toContain("1 not run")
  })

  it("shows Native skill cache failures without stopping independent Container updates", async () => {
    const tui = await mountAdmin([native(), container("claude")], async (_options, args) => {
      if (args[0] === "skills") throw new Error("Skill source unavailable")
      return commandResult(args)
    })
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain("[y] update selected items"))
    await tui.press("y")
    await vi.waitFor(() => expect(tui.screen()).toContain("Update all finished: 2 updated"))
    expect(tui.screen()).toContain("Shared skill cache refresh failed")
    expect(tui.screen()).toContain("Skill source unavailable")
    expect(tui.screen()).toContain("Native skills: 0 updated, 0 failed, 1 not run")
    expect(tui.updates().some(([, args]) => args[0] === "skills-update")).toBe(false)
    expect(tui.updates().some(([, args]) => args[0] === "upgrade")).toBe(true)
  })

  it("cancels the owned queue when Admin exits", async () => {
    let signal: AbortSignal | undefined
    const tui = await mountAdmin(
      [native(), container("queued")],
      (options) =>
        new Promise((_resolve, reject) => {
          signal = options?.signal
          signal?.addEventListener("abort", () => reject(new Error("Update cancelled")), { once: true })
        }),
    )
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain("[y] update selected items"))
    await tui.press("y")
    await vi.waitFor(() => expect(tui.updates()).toHaveLength(1))
    await tui.press("\u001b")
    await vi.waitFor(() => expect(tui.screen()).toContain("Trellage Admin"))
    await tui.press("q")
    await tui.exited
    expect(signal?.aborted).toBe(true)
    expect(tui.updates()).toHaveLength(1)
  })

  it("keeps the complete scope readable with page keys in an 80-column terminal", async () => {
    const entries = Array.from({ length: 16 }, (_value, index) => ({
      ...container(`claude-${String(index).padStart(2, "0")}`),
      version: "2.1.252",
    }))
    const tui = await mountAdmin(entries, undefined, { columns: 80, rows: 24 })
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain("2.1.252 -> 3.0.0"))
    expect(tui.screen()).toContain("Container builds: 16")
    expect(tui.screen()).not.toContain("sandbox:claude-15")
    await tui.press("\u001b[6~")
    await tui.press("\u001b[6~")
    await vi.waitFor(() => expect(tui.screen()).toContain("sandbox:claude-15"))
    const lines = tui.screen().trimEnd().split("\n")
    expect(lines.length).toBeLessThanOrEqual(24)
    expect(lines.every((line) => stringWidth(line) <= 80)).toBe(true)
    expect(tui.updates()).toHaveLength(0)
  })

  it("wraps full source revisions and pins without truncation in an 80-column terminal", async () => {
    const current = "a".repeat(40)
    const target = "b".repeat(40)
    const profile = { ...container("headlong-pinned", "headlong"), version: current, harnessVersionSelector: target }
    const tui = await mountAdmin([profile], undefined, { columns: 80, rows: 24 }, async () => versionReport(current, "c".repeat(40)))
    await tui.press("A")
    await vi.waitFor(() => expect(tui.screen()).toContain(current))
    expect(tui.screen()).toContain(`${target} (pinned)`)
    const lines = tui.screen().trimEnd().split("\n")
    expect(lines.length).toBeLessThanOrEqual(24)
    expect(lines.every((line) => stringWidth(line) <= 80)).toBe(true)
    expect(tui.updates()).toHaveLength(0)
  })
})
