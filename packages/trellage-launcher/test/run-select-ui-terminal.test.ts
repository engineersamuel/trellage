import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Terminal } from "@xterm/headless"
import { bunArguments, bunExecutable } from "@trellage/runtime"
import { describe, expect, it, vi } from "vitest"
import type { RunSelectorChoice } from "../src/run-select-state.ts"
import { spawnSourcePty, type SourcePtyExit } from "./helpers/source-pty.ts"

const entry = fileURLToPath(new URL("./fixtures/run-select-ui-fixture.tsx", import.meta.url))
const down = "\u001b[B"
const up = "\u001b[A"
const right = "\u001b[C"
const left = "\u001b[D"
const escape = "\u001b"
const enter = "\r"
const cyan = 6
const magenta = 5
const green = 2
const yellow = 3

const createTerminal = async (scenario = "restored", cols = 120, color = "enabled") => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-run-selector-"))
  const terminal = new Terminal({ cols, rows: 40, scrollback: 0, allowProposedApi: true })
  const child = spawnSourcePty(bunExecutable(), bunArguments(entry, [root, scenario]), {
    name: "xterm-256color", cols, rows: terminal.rows, cwd: root,
    env: {
      HOME: root,
      PATH: path.dirname(bunExecutable()),
      TERM: "xterm-256color",
      CI: "false",
      ...(color === "no-color" ? { NO_COLOR: "1" } : { FORCE_COLOR: color === "force-zero" ? "0" : "1" }),
    },
  })
  let screen = ""
  let output = ""
  let exit: SourcePtyExit | undefined
  terminal.onData((data) => child.write(data))
  child.onData((data) => {
    output += data
    terminal.write(data, () => {
      screen = Array.from({ length: terminal.rows }, (_, row) =>
        terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? "",
      ).join("\n")
    })
  })
  child.onExit((status) => { exit = status })
  const waitFor = async (...texts: string[]): Promise<void> => {
    await vi.waitFor(() => {
      expect(exit, `Selector exited: ${JSON.stringify(exit)}; output: ${JSON.stringify(output.slice(-2000))}`).toBeUndefined()
      for (const text of texts) expect(screen).toContain(text)
    }, { timeout: 5000, interval: 20 })
  }
  const cell = (needle: string, offset = 0) => {
    const lines = screen.split("\n")
    const row = lines.findIndex((line) => line.includes(needle))
    if (row < 0) throw new Error(`Missing ${needle} in:\n${screen}`)
    const col = lines[row]!.indexOf(needle) + offset
    const value = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.getCell(col)
    if (!value) throw new Error(`Missing terminal cell for ${needle}`)
    return {
      fg: value.isFgDefault() ? null : value.getFgColor(),
      bg: value.isBgDefault() ? null : value.getBgColor(),
      bold: Boolean(value.isBold()), inverse: Boolean(value.isInverse()), dim: Boolean(value.isDim()),
    }
  }
  const close = async (): Promise<void> => {
    try {
      if (exit === undefined) {
        child.kill("SIGKILL")
        await vi.waitFor(() => expect(exit).toBeDefined(), { timeout: 5000, interval: 20 })
      }
    } finally {
      await new Promise<void>((resolve) => terminal.write("", resolve))
      terminal.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
  try {
    await waitFor("trx run: choose a harness, profiles and model", "› Harness")
    await vi.waitFor(async () => {
      expect(await readFile(path.join(root, "ready"), "utf8")).toBe("ready")
    }, { timeout: 5000, interval: 20 })
  } catch (error) {
    await close()
    throw error
  }
  return {
    cell, waitFor, close,
    screen: () => screen,
    async press(keys: string, ...texts: string[]): Promise<void> {
      child.write(keys)
      await waitFor(...texts)
    },
    async focus(needle: string, focused = true): Promise<void> {
      await vi.waitFor(() => expect(cell(needle).inverse).toBe(focused), { timeout: 5000, interval: 20 })
    },
    noColors(): void {
      // Check every emitted frame, including erased rows, not just the final screen.
      for (const match of output.matchAll(/\u001b\[([\d;]*)m/gu)) {
        for (const code of match[1]!.split(";").map(Number)) {
          expect((code >= 30 && code <= 38) || (code >= 40 && code <= 48) || (code >= 90 && code <= 107)).toBe(false)
        }
      }
      for (let row = 0; row < terminal.rows; row += 1) {
        for (let col = 0; col < terminal.cols; col += 1) {
          const value = terminal.buffer.active.getLine(row)?.getCell(col)
          expect(value?.isFgDefault()).toBe(true)
          expect(value?.isBgDefault()).toBe(true)
        }
      }
    },
    async finish(keys = escape): Promise<Array<RunSelectorChoice | null>> {
      child.write(keys)
      await vi.waitFor(() => expect(exit).toMatchObject({ exitCode: 0, signal: 0 }), { timeout: 5000, interval: 20 })
      return JSON.parse(await readFile(path.join(root, "result.json"), "utf8")) as Array<RunSelectorChoice | null>
    },
  }
}

const openPicker = async (ui: Awaited<ReturnType<typeof createTerminal>>) => {
  await ui.press(down, "› Profiles")
  await ui.press("\t", "› Model")
  await ui.press(enter, "Select model", "enter select · esc back")
}

describe("RunSelector terminal", { timeout: 15000 }, () => {
  it("uses the Trellage palette without painting the terminal background or neutral text", async () => {
    const ui = await createTerminal()
    try {
      for (const text of ["trx run:", "› Harness", "Fixture Pi", "Always on", "Normal", "Plan", "↑↓", "←→", "space", "enter", "esc"]) {
        expect(ui.cell(text).fg, text).toBe(cyan)
      }
      expect(ui.cell("trx run:").bold).toBe(true)
      expect(ui.cell("› Harness").bold).toBe(true)
      for (const text of ["fixture-model-alpha", "fixture-plan", "fixture-style"]) expect(ui.cell(text).fg, text).toBe(magenta)
      expect(ui.cell("◂ high").fg).toBe(yellow)
      expect(ui.cell("effort high", 7).fg).toBe(yellow)
      for (const text of ["[x] fixture-review", "fixture-common", "fixture-extension", "fixture-skill", "trx run pi"]) {
        expect(ui.cell(text).fg, text).toBe(green)
        expect(ui.cell(text).dim, text).toBe(false)
      }
      expect(ui.cell("trx run pi").bg).toBeNull()
      for (const text of ["choose a harness", "[ ] fixture-build", "Profiles", "Restored from", "--no-always skips", "field ·"]) {
        expect(ui.cell(text).fg, text).toBeNull()
      }
      expect(ui.cell("Restored from").dim).toBe(true)
      expect(ui.cell("field ·").dim).toBe(true)
      expect(await ui.finish()).toEqual([null])
    } finally { await ui.close() }
  })

  it("keeps profile focus inverse and independent from selection, and delivers exactly one launch callback", async () => {
    const ui = await createTerminal()
    try {
      await ui.press(down, "› Profiles")
      expect(ui.cell("[x] fixture-review")).toMatchObject({ inverse: true, bold: true, fg: null, bg: null })
      await ui.press(right)
      await ui.focus("[ ] fixture-build")
      expect(ui.cell("[x] fixture-review")).toMatchObject({ fg: green, inverse: false })
      await ui.press(" ", "[x] fixture-build")
      expect(ui.cell("[x] fixture-build")).toMatchObject({ inverse: true, bold: true, fg: null })
      await ui.press(left)
      await ui.focus("[x] fixture-review")
      await ui.press(" ", "[ ] fixture-review")
      await ui.press(down, "› Model")
      expect(ui.cell("[x] fixture-build").fg).toBe(green)
      expect(ui.cell("[ ] fixture-review").fg).toBeNull()
      await ui.press(right, "◂ fixture-model-beta ▸")
      await ui.press(down, "› Effort")
      await ui.press(left, "◂ low ▸")
      await ui.press(up, "› Model")
      await ui.press(up, "› Profiles")
      expect(await ui.finish(enter)).toEqual([{ harness: "pi", profiles: ["fixture-build"], model: "fixture-model-beta", effort: "low" }])
    } finally { await ui.close() }
  })

  it("colors model groups and committed markers while cursor focus overrides selection; selects and cancels the panel", async () => {
    const ui = await createTerminal()
    try {
      await openPicker(ui)
      expect(ui.cell("╭").fg).toBe(cyan)
      expect(ui.cell("Select model")).toMatchObject({ fg: cyan, bold: true })
      for (const text of ["Frontier", "Other models"]) expect(ui.cell(text)).toMatchObject({ fg: magenta, bold: true, dim: false })
      expect(ui.cell("● fixture-model-alpha")).toMatchObject({ fg: null, bg: null, inverse: true, bold: true })
      await ui.press(down)
      await ui.focus("fixture-model-beta")
      expect(ui.cell("● fixture-model-alpha")).toMatchObject({ fg: green, inverse: false })
      expect(ui.cell("fixture-model-beta")).toMatchObject({ fg: null, bg: null, inverse: true, bold: true })
      expect(ui.cell("↓ more")).toMatchObject({ fg: null, dim: true })
      expect(ui.cell("enter").fg).toBe(cyan)
      await ui.press(escape, "› Model", "◂ fixture-model-alpha ▸")
      await ui.press(enter, "Select model", "enter select · esc back")
      await ui.press(down)
      await ui.focus("fixture-model-beta")
      await ui.press(enter, "› Model", "◂ fixture-model-beta ▸")
      await ui.press(enter, "Select model", "● fixture-model-beta")
      await ui.press("q", "› Model")
      expect(await ui.finish("q")).toEqual([null])
    } finally { await ui.close() }
  })

  it("scrolls the existing 14-line model viewport and wraps without losing the committed marker", async () => {
    const ui = await createTerminal("default")
    try {
      await openPicker(ui)
      expect(ui.screen().split("\n").filter((line) => /harness default|Frontier|Other models|fixture-model-/u.test(line))).toHaveLength(14)
      await ui.press(up, "fixture-model-24", "↑ more")
      await ui.focus("fixture-model-24")
      expect(ui.screen()).not.toContain("↓ more")
      expect(ui.screen()).not.toContain("Frontier")
      await ui.press(enter, "◂ fixture-model-24 ▸")
      await ui.press(enter, "● fixture-model-24")
      await ui.press(down, "Frontier", "↓ more")
      await ui.focus("harness default")
      await ui.press(enter, "◂ fixture-default (default) ▸")
      expect(await ui.finish()).toEqual([null])
    } finally { await ui.close() }
  })

  it("preserves empty profiles, defaults, missing defaults, and harness-specific always-on content", async () => {
    const ui = await createTerminal("empty")
    try {
      await ui.waitFor("none defined in config.toml (clean base harness)", "◂ fixture-default (default) ▸", "fixture-pi-only", "fixture-pi-skill")
      expect(ui.cell("(default)")).toMatchObject({ fg: null, dim: true })
      expect(ui.cell("none defined")).toMatchObject({ fg: null, dim: true })
      await ui.press(down, "› Profiles")
      await ui.press(" ")
      await ui.press(up, "› Harness")
      await ui.press(right, "Fixture Codex", "◂ harness default ▸")
      expect(ui.screen()).not.toContain("fixture-pi-only")
      expect(ui.screen()).not.toContain("fixture-pi-skill")
      expect(ui.screen()).not.toContain("fixture-extension")
      expect(ui.screen()).toContain("fixture-common")
      expect(ui.screen()).not.toContain("(default)")
      expect(await ui.finish(enter)).toEqual([{ harness: "codex", profiles: [] }])
    } finally { await ui.close() }
  })

  for (const cols of [80, 120]) {
    it(`keeps long profile/model names and wrapped command/hints readable at ${cols} columns`, async () => {
      const ui = await createTerminal("long", cols)
      try {
        const compact = ui.screen().replace(/\s/gu, "")
        const name = "fixture-profile-with-a-long-name-for-checking-terminal-wrapping-at-eighty-columns"
        const model = "fixture-model-with-a-long-name-for-checking-terminal-wrapping-at-eighty-columns"
        expect(compact).toContain(`[x]${name}`)
        expect(compact).toContain(`trxrunpi${name}--model${model}--efforthigh`)
        expect(compact).toContain("enterlaunch(onModel:openlist)·esccancel")
        expect(ui.screen()).toContain("trx run: choose")
        await openPicker(ui)
        expect(ui.screen().replace(/[\s│]/gu, "")).toContain(`●${model}`)
        await ui.press(escape, "› Model")
        expect(await ui.finish()).toEqual([null])
      } finally { await ui.close() }
    })
  }

  for (const mode of ["no-color", "force-zero"]) {
    it(`retains content and non-color state indicators with ${mode}`, async () => {
      const ui = await createTerminal("restored", 120, mode)
      try {
        await ui.waitFor("Restored from worktree history", "[x] fixture-review", "[ ] fixture-build", "trx run pi fixture-review --model fixture-model-alpha --effort high")
        ui.noColors()
        await ui.press(down, "› Profiles")
        await ui.press(" ", "[ ] fixture-review")
        await ui.press(right)
        await ui.press(" ", "[x] fixture-build")
        await ui.press(down, "› Model")
        await ui.press(enter, "Select model", "● fixture-model-alpha")
        await ui.press(down)
        await ui.press(enter, "› Model", "◂ fixture-model-beta ▸")
        await ui.press(enter, "Select model", "● fixture-model-beta")
        ui.noColors()
        await ui.press(escape, "› Model")
        await ui.press(down, "› Effort")
        ui.noColors()
        expect(await ui.finish(enter)).toEqual([{ harness: "pi", profiles: ["fixture-build"], model: "fixture-model-beta", effort: "high" }])
      } finally { await ui.close() }
    })
  }

  it("preserves Ink's Ctrl+C exit without delivering a launch callback", async () => {
    const ui = await createTerminal()
    try { expect(await ui.finish("\u0003")).toEqual([]) }
    finally { await ui.close() }
  })
})
