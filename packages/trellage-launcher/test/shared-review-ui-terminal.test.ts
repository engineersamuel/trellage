import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Terminal } from "@xterm/headless"
import { bunArguments, bunExecutable } from "@trellage/runtime"
import { expect, it, vi } from "vitest"
import { spawnSourcePty } from "./helpers/source-pty.ts"

it.each(["complete", "partial", "cancelled", "all"])("streams separate review tabs across navigation, resize and %s outcome", async (outcome) => {
  const root = await mkdtemp(path.join(process.cwd(), ".review-pty-"))
  const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true })
  const entry = fileURLToPath(new URL("./fixtures/shared-review-ui-fixture.tsx", import.meta.url))
  const child = spawnSourcePty(bunExecutable(), bunArguments(entry, [root, outcome]), {
    name: "xterm-256color", cols: 80, rows: 24, cwd: root,
    env: { ...process.env, CI: "false", FORCE_COLOR: "1", TMPDIR: root },
  })
  let screen = ""
  terminal.onData((data) => child.write(data))
  child.onData((data) => terminal.write(data, () => {
    screen = Array.from({ length: terminal.rows }, (_, row) =>
      terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? "").join("\n")
  }))
  const wait = async (...text: string[]) => vi.waitFor(() => {
    for (const value of text) expect(screen).toContain(value)
  }, { timeout: 8000, interval: 25 })
  const press = async (key: string, ...text: string[]) => { child.write(key); await wait(...text) }
  try {
    await wait("src/login.ts")
    await press("\r", "Choose reviewers")
    await press("\r", "Confirm read-only review")
    await press("\r", "› Fleet [queued]", "Ponytail [queued]", "Waiting for streamed output", "Esc cancel")
    await writeFile(path.join(root, "stream"), "")
    await wait("Specialist 1", "fleet streamed line 000", "Fleet [running]")
    expect(screen).not.toContain("ponytail streamed")
    // Every available content row is used, with the controls below it.
    const assertFilled = () => {
      const lines = screen.split("\n")
      const first = lines.findIndex((line) => line.includes("fleet streamed line"))
      const footer = lines.findIndex((line) => line.includes("Tab/Shift+Tab"))
      expect(footer - first).toBeGreaterThan(terminal.rows - 17)
      expect(lines[footer - 2]).toContain("fleet streamed line")
      expect(lines[footer - 1]).toBe(` ╰${"─".repeat(terminal.cols - 4)}╯`)
      const top = lines.findIndex((line) => line === ` ╭${"─".repeat(terminal.cols - 4)}╮`)
      expect(top).toBeGreaterThan(0)
      for (const line of lines.slice(top + 1, footer - 1)) {
        expect(line.startsWith(" │ ")).toBe(true)
        expect(line.endsWith(" │")).toBe(true)
        expect(line.length).toBe(terminal.cols - 1)
      }
      expect(screen).toMatch(/ ╔═+╗╭─+╮/)
      expect(screen).toContain("║ › Fleet [running] ║")
      expect(screen).toContain("Read-only reviews do not authorize edits")
    }
    assertFilled()
    if (process.env.REVIEW_UI_SCREEN === "1") console.log(`\n${screen}\n`)
    if (outcome === "all") {
      for (const [index, label, content] of [
        [2, "Ponytail", "ponytail streamed"],
        [3, "First principles", "first-principles streamed"],
        [4, "Behavior", "behavior-preservation streamed"],
        [5, "Architecture", "improve-codebase-architecture streamed"],
        [6, "Matt", "matt-code-review streamed"],
        [7, "Overview", "fleet: running"],
        [8, "Synthesis", "Waiting for streamed output"],
      ] as const) {
        await press("\t", `› ${label}`, `Tab ${index}/8`, content, "Esc cancel")
        const lines = screen.split("\n")
        const footer = lines.findIndex((line) => line.includes("Tab/Shift+Tab"))
        expect(lines[footer - 1]).toBe(` ╰${"─".repeat(terminal.cols - 4)}╯`)
        expect(screen).toContain(`║ › ${label}`)
      }
      await press("\t", "› Fleet", "fleet streamed line 000")
    }
    await press("\t", "› Ponytail [running]", "ponytail streamed line 000")
    expect(screen).toContain("╭")
    expect(screen).toContain("║ › Ponytail [running] ║")
    expect(screen).not.toContain("fleet streamed")
    await press("\u001b[Z", "› Fleet [running]", "fleet streamed line 000")
    child.write("\u001b[6~")
    await vi.waitFor(() => expect(screen).not.toContain("fleet streamed line 000"))
    const before = screen.match(/fleet streamed line \d+/u)?.[0]
    await press("\u001b[5~", "fleet streamed line 000")
    await press("\u001b[6~", before!)
    await press("\u001b[C", "ponytail streamed line 000")
    await press("\u001b[D", before!)
    await writeFile(path.join(root, "append"), "")
    await wait(before!)
    terminal.resize(110, 42)
    child.resize(110, 42)
    await wait(before!)
    await vi.waitFor(assertFilled)
    if (process.env.REVIEW_UI_SCREEN === "1") console.log(`\n${screen}\n`)
    if (outcome === "all") {
      await wait("Architecture [running]", "Matt [running]", "Overview [running]", "Synthesis [queued]")
      await press("\u001b[Z", "› Synthesis [queued]", "Tab 8/8", "Esc cancel")
      await press("\u001b[C", "› Fleet [running]", before!)
      assertFilled()
    }
    if (outcome === "cancelled") child.write("\u001b")
    else await writeFile(path.join(root, "finish"), outcome === "all" ? "complete" : outcome)
    await wait(`Fleet [${outcome === "cancelled" ? "failed" : outcome === "all" ? "complete" : outcome}]`, "f findings", before!)
    if (outcome === "partial") {
      await press("\u001b[Z", "› Synthesis [complete]", "Overview [incomplete]")
      await press("\t", "› Fleet [partial]", before!)
    }
    await press("p", "fleet full saved evidence")
    await wait("w".repeat(104), "Review changes", "f findings")
    await press("p", before!)
    terminal.resize(80, 24)
    child.resize(80, 24)
    await wait(before!, "Esc back")
    await press("p", "fleet full saved evidence", "w".repeat(74), "Review changes")
  } finally {
    child.kill()
    terminal.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

it("shows an Architecture prerequisite timeout as partial with synthesis not run", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".review-pty-"))
  const terminal = new Terminal({ cols: 100, rows: 30, scrollback: 0, allowProposedApi: true })
  const entry = fileURLToPath(new URL("./fixtures/shared-review-ui-fixture.tsx", import.meta.url))
  const child = spawnSourcePty(bunExecutable(), bunArguments(entry, [root, "architecture-failed"]), {
    name: "xterm-256color", cols: 100, rows: 30, cwd: root,
    env: { ...process.env, CI: "false", FORCE_COLOR: "1", TMPDIR: root },
  })
  let screen = ""
  terminal.onData((data) => child.write(data))
  child.onData((data) => terminal.write(data, () => {
    screen = Array.from({ length: terminal.rows }, (_, row) =>
      terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? "").join("\n")
  }))
  const wait = async (...texts: string[]) => vi.waitFor(() => {
    for (const text of texts) expect(screen).toContain(text)
  }, { timeout: 8000, interval: 25 })
  try {
    await wait("src/login.ts")
    child.write("\r")
    await wait("Choose reviewers", "Improve codebase architecture")
    child.write("\r")
    await wait("Confirm read-only review")
    child.write("\r")
    await wait("Architecture [queued]")
    await writeFile(path.join(root, "stream"), "")
    await wait("Architecture [running]")
    await writeFile(path.join(root, "append"), "")
    await writeFile(path.join(root, "finish"), "architecture-failed")
    await wait("Architecture [partial]", "Synthesis [not-run]")
    child.write("f")
    await wait(
      "Review failed",
      "Failed phase: Independent reviews",
      "Failure reason: Request timeout",
      "Partial findings saved: 1.",
    )
    child.write("p")
    await wait("Architecture [partial]", "Synthesis [not-run]")
    child.write("\t")
    await wait("Failure phase: Independent reviews", "Failure reason: Request timeout")
  } finally {
    child.kill()
    terminal.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
