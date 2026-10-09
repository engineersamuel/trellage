import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Terminal } from "@xterm/headless"
import { bunArguments, bunExecutable } from "@trellage/runtime"
import { describe, expect, it, vi } from "vitest"
import { appendReviewOutput } from "../src/review-ui.tsx"
import { spawnSourcePty, type SourcePtyExit } from "./helpers/source-pty.ts"

const entry = fileURLToPath(new URL("./fixtures/review-ui-fixture.tsx", import.meta.url))

const createTerminal = async (
  slow: boolean, cols = 100, rows = 26, behind = false, herdr = false, clean = false, handoff = false,
  partial = false, delayMs?: number, diff = false,
) => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-review-ui-"))
  const terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
  const child = spawnSourcePty(bunExecutable(), bunArguments(entry, [root]), {
    name: "xterm-256color",
    cols: terminal.cols,
    rows: terminal.rows,
    cwd: root,
    env: {
      ...process.env,
      REVIEW_FIXTURE_SLOW: slow ? "1" : "0",
      REVIEW_FIXTURE_BEHIND: behind ? "1" : "0",
      REVIEW_FIXTURE_HERDR: herdr ? "1" : "0",
      REVIEW_FIXTURE_CLEAN: clean ? "1" : "0",
      REVIEW_FIXTURE_HANDOFF: handoff ? "1" : "0",
      REVIEW_FIXTURE_PARTIAL: partial ? "1" : "0",
      REVIEW_FIXTURE_DELAY_MS: delayMs?.toString() ?? "",
      REVIEW_FIXTURE_DIFF: diff ? "1" : "0",
      // The PTY is interactive even when its test runner runs in CI.
      CI: "false",
      FORCE_COLOR: "1",
      TERM: "xterm-256color",
    },
  })
  let screen = ""
  let output = ""
  let exit: SourcePtyExit | undefined
  terminal.onData((data) => child.write(data))
  child.onData((data) => {
    output = (output + data).slice(-12_000)
    terminal.write(data, () => {
      screen = Array.from({ length: terminal.rows }, (_, row) =>
        terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? "",
      ).join("\n")
    })
  })
  child.onExit((status) => { exit = status })
  const waitForScreen = async (timeout: number, ...texts: string[]): Promise<void> => {
    await vi.waitFor(() => {
      expect(exit, `Review PTY exited before rendering: ${JSON.stringify(exit)}`).toBeUndefined()
      for (const text of texts) {
        expect(screen, `Review PTY output: ${JSON.stringify(output)}; child PID: ${child.pid}`).toContain(text)
      }
    }, { timeout, interval: 20 })
  }
  const waitFor = async (...texts: string[]): Promise<void> => waitForScreen(5_000, ...texts)
  const events = async (): Promise<Array<{ kind: string; selected: string[] }>> => {
    try {
      return (await readFile(path.join(root, "events.jsonl"), "utf8"))
        .trimEnd().split("\n").map((line) => JSON.parse(line) as { kind: string; selected: string[] })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }
  try {
    await waitForScreen(15_000, "Ponytail Review", "Fleet Review", "Matt Pocock Code Review",
      "1 file · captured patch: 173,384 bytes (169.3 KiB)")
    if (!clean) await waitForScreen(15_000, "Included staged, unstaged, and untracked files")
  } catch (error) {
    if (exit === undefined) child.kill("SIGKILL")
    await rm(root, { recursive: true, force: true })
    throw error
  }
  return {
    press: (keys: string): void => child.write(keys),
    screen: (): string => screen,
    fg: (needle: string): { readonly color: number; readonly default: boolean } => {
      const row = screen.split("\n").findIndex((line) => line.includes(needle))
      if (row < 0) throw new Error(`Text is not visible: ${needle}`)
      const col = screen.split("\n")[row]!.indexOf(needle)
      const cell = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.getCell(col)
      if (!cell) throw new Error(`No terminal cell for: ${needle}`)
      return { color: cell.getFgColor(), default: cell.isFgDefault() }
    },
    waitFor,
    events,
    close: async (): Promise<void> => {
      if (exit === undefined) child.kill()
      await rm(root, { recursive: true })
    },
  }
}

describe("ReviewApp terminal", () => {
  it("shows the current main tip and the common-ancestor review base separately", async () => {
    const terminal = await createTerminal(false, 120, 26, true)
    try {
      await terminal.waitFor("origin/main", "cccccccccccc", "review base aaaaaaaaaaaa", "HEAD bbbbbbbbbbbb")
      await terminal.waitFor("Review uses the common ancestor")
    } finally {
      await terminal.close()
    }
  })

  it("keeps the full captured patch size visible at narrow terminal widths", async () => {
    const terminal = await createTerminal(false, 80, 20)
    try {
      await terminal.waitFor("1 file · captured patch: 173,384 bytes (169.3 KiB)", "Enter start reviews")
      terminal.press(" ")
      await terminal.waitFor("[x] Ponytail Review")
      terminal.press("\r")
      await terminal.waitFor("173,384 bytes (169.3 KiB)", "Combined review")
    } finally {
      await terminal.close()
    }
  }, 15_000)

  it("bounds and sanitizes streamed output without changing the saved review", () => {
    const log = appendReviewOutput(undefined, { kind: "text", source: "Reviewer",
      text: `Start\x1b[31m${"x".repeat(9000)}\x1b[0m\nLast line` })
    expect(log.text.length).toBeLessThanOrEqual(8192)
    expect(log.text).toContain("Last line")
    expect(log.text).not.toContain("\x1b")
  })

  it("starts only checked workflows on the first Enter, but not an empty selection", async () => {
    const terminal = await createTerminal(false)
    try {
      terminal.press("\r\u001b[B")
      await terminal.waitFor("› [ ] Fleet Review")
      expect(await terminal.events()).toEqual([])
      terminal.press(" ")
      await terminal.waitFor("[x] Fleet Review")
      terminal.press("\u001b[A")
      await terminal.waitFor("› [ ] Ponytail Review")
      terminal.press(" ")
      await terminal.waitFor("[x] Ponytail Review")
      terminal.press("\r")
      await vi.waitFor(async () => {
        expect(await terminal.events()).toEqual([{
          kind: "run",
          selected: ["ponytail", "fleet"],
          head: "b".repeat(40),
        }])
      }, { timeout: 5_000 })
      await terminal.waitFor("Combined review", "/tmp/review.json")
      expect(await terminal.events()).toHaveLength(1)
    } finally {
      await terminal.close()
    }
  }, 15_000)

  it("starts all three selected reviews on the first Enter", async () => {
    const terminal = await createTerminal(false, 100, 26)
    try {
      for (const label of ["Ponytail Review", "Fleet Review", "Matt Pocock Code Review"]) {
        terminal.press(" ")
        await terminal.waitFor(`[x] ${label}`)
        if (label !== "Matt Pocock Code Review") {
          terminal.press("\u001b[B")
          await terminal.waitFor(`› [ ] ${label === "Ponytail Review" ? "Fleet Review" : "Matt Pocock Code Review"}`)
        }
      }
      terminal.press("\r")
      await vi.waitFor(async () => {
        expect((await terminal.events())[0]).toMatchObject({
          kind: "run", selected: ["ponytail", "fleet", "matt-code-review"],
        })
      }, { timeout: 5_000 })
      expect(await terminal.events()).toHaveLength(1)
    } finally { await terminal.close() }
  }, 15_000)

  it("selects Matt Pocock review independently of Ponytail and Fleet", async () => {
    const terminal = await createTerminal(false, 100, 26)
    try {
      await terminal.waitFor("Matt Pocock Code Review · 1 worker", "Standards review; no verified spec source")
      terminal.press("\u001b[B")
      await terminal.waitFor("› [ ] Fleet Review")
      terminal.press("\u001b[B")
      await terminal.waitFor("› [ ] Matt Pocock Code Review")
      terminal.press(" ")
      await terminal.waitFor("[x] Matt Pocock Code Review")
      terminal.press("\r")
      await vi.waitFor(async () => {
        expect((await terminal.events())[0]).toMatchObject({
          kind: "run", selected: ["matt-code-review"],
        })
      }, { timeout: 5_000 })
    } finally { await terminal.close() }
  }, 15_000)

  it("requires a separate confirmation before a current-terminal continuation", async () => {
    const terminal = await createTerminal(false, 80, 20)
    try {
      terminal.press(" ")
      await terminal.waitFor("[x] Ponytail Review")
      terminal.press("\r")
      await terminal.waitFor("c plan fixes here")
      terminal.press("c")
      await terminal.waitFor("Plan fixes with Copilot here?", "Enter confirms")
      expect(await terminal.events()).toHaveLength(1)
      terminal.press("\u001b")
      await terminal.waitFor("c plan fixes here")
      terminal.press("c")
      await terminal.waitFor("Plan fixes with Copilot here?")
      terminal.press("\r")
      await vi.waitFor(async () => {
        const events = await terminal.events()
        expect(events).toHaveLength(2)
        expect(events[1]).toMatchObject({ action: "continue", destination: "current-terminal",
          outcome: { markdownPath: "/tmp/review.md" } })
      }, { timeout: 5_000 })
    } finally {
      await terminal.close()
    }
  }, 15_000)

  it("keeps the terminal attached when starting a child after Review exits", async () => {
    const terminal = await createTerminal(false, 80, 20, false, false, false, true)
    try {
      terminal.press(" ")
      await terminal.waitFor("[x] Ponytail Review")
      terminal.press("\r")
      await terminal.waitFor("c plan fixes here")
      terminal.press("c")
      await terminal.waitFor("Plan fixes with Copilot here?")
      terminal.press("\r")
      await terminal.waitFor("HANDOFF_READY")
      terminal.press("handoff\r")
      await vi.waitFor(async () => {
        expect(terminal.screen()).toContain("HANDOFF_INPUT:handoff")
        expect(await terminal.events()).toContainEqual({ kind: "handed-off" })
      }, { timeout: 5_000 })
    } finally {
      await terminal.close()
    }
  }, 15_000)

  it("offers a Herdr tab but blocks a new worktree when changes are uncommitted", async () => {
    const terminal = await createTerminal(false, 100, 26, false, true)
    try {
      terminal.press(" ")
      await terminal.waitFor("[x] Ponytail Review")
      terminal.press("\r")
      await terminal.waitFor("New worktree unavailable: uncommitted changes are not transferred.")
      terminal.press("w")
      expect(await terminal.events()).toHaveLength(1)
      terminal.press("t")
      await terminal.waitFor("Plan then implement in a new Herdr tab (auto-approved, full access)?")
      terminal.press("\r")
      await vi.waitFor(async () => {
        expect((await terminal.events())[1]).toMatchObject({ action: "continue", destination: "new-herdr-tab" })
      }, { timeout: 5_000 })
    } finally {
      await terminal.close()
    }
  }, 15_000)

  it("offers a new worktree when the reviewed tree has no uncommitted changes", async () => {
    const terminal = await createTerminal(false, 100, 26, false, true, true)
    try {
      terminal.press(" ")
      await terminal.waitFor("[x] Ponytail Review")
      terminal.press("\r")
      await terminal.waitFor("w plan in a new worktree from reviewed HEAD")
      terminal.press("w")
      await terminal.waitFor("Create a worktree and plan fixes with Copilot there?")
      terminal.press("\r")
      await vi.waitFor(async () => {
        expect((await terminal.events())[1]).toMatchObject({ action: "continue", destination: "new-herdr-worktree" })
      }, { timeout: 5_000 })
    } finally {
      await terminal.close()
    }
  }, 15_000)

  it("does not start another paid review when Enter repeats during a run", async () => {
    const terminal = await createTerminal(true)
    try {
      terminal.press(" ")
      await terminal.waitFor("[x] Ponytail Review")
      terminal.press("\r")
      await terminal.waitFor("Ponytail Review: ")
      expect(terminal.screen()).not.toContain("Ponytail Review: running")
      await vi.waitFor(async () => {
        expect(await terminal.events()).toHaveLength(1)
      }, { timeout: 5_000 })
      terminal.press("\r")
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await terminal.events()).toHaveLength(1)
    } finally {
      await terminal.close()
    }
  })

  it("aborts a running review through the keyboard", async () => {
    const terminal = await createTerminal(true)
    try {
      terminal.press(" ")
      await terminal.waitFor("[x] Ponytail Review")
      terminal.press("\r")
      await terminal.waitFor("Ponytail Review: ")
      expect(terminal.screen()).not.toContain("Ponytail Review: running")
      terminal.press("\u001b")
      await terminal.waitFor("Cancelled: Partial results saved after cancellation")
    } finally {
      await terminal.close()
    }
  })

  it("switches narrow-screen live tabs while all three reviews keep running", async () => {
    const terminal = await createTerminal(true, 80, 18)
    try {
      terminal.press(" ")
      await terminal.waitFor("[x] Ponytail Review")
      terminal.press("\u001b[B")
      await terminal.waitFor("› [ ] Fleet Review")
      terminal.press(" ")
      await terminal.waitFor("[x] Fleet Review")
      terminal.press("\u001b[B")
      await terminal.waitFor("› [ ] Matt Pocock Code Review")
      terminal.press(" ")
      await terminal.waitFor("[x] Matt Pocock Code Review")
      terminal.press("\r")
      await terminal.waitFor("[Overview]", "Ponytail: ", "Fleet: ", "Matt: ", "Synthesis: queued",
        "Tab/Shift+Tab switch", "Esc cancels and saves completed", "results.")
      expect(terminal.screen()).not.toContain("running")
      expect(terminal.screen()).not.toContain("Fleet line 79")
      terminal.press("\t")
      await terminal.waitFor("Checking abstractions")
      await vi.waitFor(() => expect(terminal.screen()).toMatch(/\[Ponytail: [^\]]\]/u))
      const firstFrame = terminal.screen().match(/\[Ponytail: ([^\]])\]/u)?.[1]
      await vi.waitFor(() => {
        expect(terminal.screen().match(/\[Ponytail: ([^\]])\]/u)?.[1]).not.toBe(firstFrame)
      }, { timeout: 5_000 })
      expect(terminal.screen()).not.toContain("Fleet line 79")
      terminal.press("\u001b[C")
      await terminal.waitFor("Fleet line 79")
      expect(terminal.screen()).toMatch(/\[Fleet: [^\]]\]/u)
      expect(terminal.screen()).not.toContain("Fleet line 0")
      terminal.press("\u001b[5~")
      await terminal.waitFor("scrolled")
      terminal.press("\u001b[6~")
      await vi.waitFor(() => {
        expect(terminal.screen()).toContain("Fleet line 79")
        expect(terminal.screen()).not.toContain("scrolled")
      }, { timeout: 5_000 })
      terminal.press("\u001b[Z")
      await terminal.waitFor("Checking abstractions")
      expect(terminal.screen()).toMatch(/\[Ponytail: [^\]]\]/u)
      terminal.press("\u001b[D")
      await terminal.waitFor("[Overview]")
      terminal.press("\u001b[D")
      await terminal.waitFor("[Matt: ", "Matt Pocock Code Review: ", "live output", "Tab/Shift+Tab switch",
        "Esc cancels and saves completed", "results.")
      expect(terminal.screen()).toMatch(/\[Matt: [^\]]\]/u)
      expect(await terminal.events()).toHaveLength(1)
      terminal.press("\u001b")
      await terminal.waitFor("Cancelled: Partial results saved after cancellation")
    } finally {
      await terminal.close()
    }
  }, 15_000)

  it("opens synthesis after completion and retains each saved report in its own tab", async () => {
    const terminal = await createTerminal(false, 80, 20, false, false, false, false, true)
    try {
      terminal.press(" ")
      await terminal.waitFor("[x] Ponytail Review")
      terminal.press("\u001b[B")
      await terminal.waitFor("› [ ] Fleet Review")
      terminal.press(" ")
      await terminal.waitFor("[x] Fleet Review")
      terminal.press("\r")
      await terminal.waitFor("[Synthesis: incomplete]", "Combined review", "Synthesis finding 0")
      terminal.press("\u001b[6~")
      await vi.waitFor(() => expect(terminal.screen()).not.toContain("Synthesis finding 0"), { timeout: 5_000 })
      terminal.press("\u001b[6~")
      await terminal.waitFor("Synthesis finding 5")
      terminal.press("\u001b[Z")
      await terminal.waitFor("[Fleet: partial]", "fleet report", "fleet finding 0")
      terminal.press("\u001b[6~")
      await vi.waitFor(() => expect(terminal.screen()).not.toContain("fleet finding 0"), { timeout: 5_000 })
      terminal.press("\u001b[6~")
      await terminal.waitFor("fleet finding 5")
      terminal.press("\u001b[Z")
      await terminal.waitFor("[Ponytail: complete]", "ponytail report")
      terminal.press("\u001b")
      await terminal.waitFor("[Ponytail: complete]")
      expect(await terminal.events()).toHaveLength(1)
    } finally {
      await terminal.close()
    }
  }, 15_000)

  it("does not steal focus from a reviewer tab when synthesis finishes", async () => {
    const terminal = await createTerminal(false, 80, 20, false, false, false, false, false, 1200)
    try {
      terminal.press(" ")
      await terminal.waitFor("[x] Ponytail Review")
      terminal.press("\r")
      await terminal.waitFor("[Overview]", "Ponytail: ")
      terminal.press("\t")
      await vi.waitFor(() => expect(terminal.screen()).toMatch(/\[Ponytail: [^\]]\]/u))
      await terminal.waitFor("[Ponytail: complete]", "ponytail finding 0", "Synthesis: complete")
      expect(terminal.screen()).not.toContain("Synthesis finding 0")
      terminal.press("\u001b[C")
      await terminal.waitFor("[Synthesis: complete]", "Synthesis finding 0")
    } finally {
      await terminal.close()
    }
  }, 15_000)

  it.each([
    { rows: 18, partial: false }, { rows: 20, partial: false },
    { rows: 18, partial: true }, { rows: 20, partial: true },
  ])("keeps all three saved tabs and the handoff visible at 80 columns, $rows rows, partial=$partial", async ({ rows, partial }) => {
    const terminal = await createTerminal(false, 80, rows, false, false, false, false, partial)
    const fleetStatus = partial ? "partial" : "complete"
    try {
      for (const label of ["Ponytail Review", "Fleet Review", "Matt Pocock Code Review"]) {
        terminal.press(" ")
        await terminal.waitFor(`[x] ${label}`)
        if (label !== "Matt Pocock Code Review") {
          terminal.press("\u001b[B")
          await terminal.waitFor(`› [ ] ${label === "Ponytail Review" ? "Fleet Review" : "Matt Pocock Code Review"}`)
        }
      }
      terminal.press("\r")
      await terminal.waitFor(`[Synthesis: ${partial ? "incomplete" : "complete"}]`, "Ponytail: complete", `Fleet: ${fleetStatus}`,
        "Matt: complete", "c plan fixes here", "q exits")
      terminal.press("\u001b[Z")
      await terminal.waitFor("[Matt: complete]", "matt-code-review finding 0", "/tmp/matt-code-review.md",
        "c plan fixes here")
      terminal.press("\u001b[D")
      await terminal.waitFor(`[Fleet: ${fleetStatus}]`, "fleet finding 0", "/tmp/fleet.md", "q exits")
      terminal.press("\u001b[Z")
      await terminal.waitFor("[Ponytail: complete]", "ponytail finding 0", "/tmp/ponytail.md", "q exits")
      terminal.press("\u001b[D")
      await terminal.waitFor("[Overview]", "q exits")
      terminal.press("\u001b[C")
      await terminal.waitFor("[Ponytail: complete]", "ponytail finding 0")
      terminal.press("\t")
      await terminal.waitFor(`[Fleet: ${fleetStatus}]`, "fleet finding 0")
    } finally {
      await terminal.close()
    }
  }, 15_000)

  it("shows colored diff lines in the saved Review tab without displaying diff fences", async () => {
    const terminal = await createTerminal(false, 80, 22, false, false, false, false, false, undefined, true)
    try {
      terminal.press("\u001b[B")
      await terminal.waitFor("› [ ] Fleet Review")
      terminal.press(" ")
      await terminal.waitFor("[x] Fleet Review")
      terminal.press("\r")
      await terminal.waitFor("[Synthesis: complete]")
      terminal.press("\u001b[Z")
      await terminal.waitFor("[Fleet: complete]", "@@ -1 +1 @@", "-before", "+after", " unchanged")
      expect(terminal.screen()).not.toContain("```diff")
      expect(terminal.screen()).not.toContain("\n ```\n")
      expect(terminal.fg("+after").default).toBe(false)
      expect(terminal.fg("-before").default).toBe(false)
      expect(terminal.fg("@@ -1 +1 @@").default).toBe(false)
      expect(terminal.fg("+after").color).not.toBe(terminal.fg("-before").color)
      expect(terminal.fg(" unchanged").default).toBe(true)
    } finally {
      await terminal.close()
    }
  }, 15_000)
})
