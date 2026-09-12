import { PassThrough } from "node:stream"
import React from "react"
import * as preferences from "../src/rewrite-state.ts"
import { Terminal } from "@xterm/headless"
import { render, type Instance } from "ink"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ContextMenuApp, type ContextMenuUiRequest } from "../src/context-menu-ui.tsx"
import type { ContextMenuRewriteRequest, ContextMenuRewriteResponse } from "../src/context-menu-command.ts"

const style = { id: "plain", title: "Plain English", description: "Short direct sentences.", instruction: "Be concise." } as const
const source = "# Original\n\nKeep **facts** and the exact Markdown."
const request: ContextMenuUiRequest = {
  schemaVersion: 1,
  kind: "rewrite-output",
  source: { workspaceId: "workspace", tabId: "tab", paneId: "pane", cwd: "/repo", agent: "fixture" },
  message: { paneId: "pane", role: "harness", text: source, capturedAt: "2026-09-11T12:00:00Z", source: "visible" },
  styles: [style],
}

const errorRequest: ContextMenuUiRequest = {
  source: request.source,
  styles: request.styles,
  schemaVersion: request.schemaVersion,
  kind: "context-menu-error",
  error: { code: "capture-failed", message: "The original source is unavailable." },
}

const result = (markdown: string, cache: "hit" | "miss" = "miss"): ContextMenuRewriteResponse => ({
  schemaVersion: 1,
  kind: "rewrite-result",
  styleId: style.id,
  markdown,
  cache,
})

interface Harness {
  readonly input: PassThrough
  readonly frames: string[]
  readonly terminal: Terminal
  readonly instance: Instance
  readonly press: (keys: string) => Promise<void>
  readonly close: () => Promise<void>
}

const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/gu

const mount = (rewrite: (request: ContextMenuRewriteRequest, signal: AbortSignal) => Promise<ContextMenuRewriteResponse>, initialRequest = request, copy = async (_value: string): Promise<void> => undefined, columns = 100): Harness => {
  const input = new PassThrough()
  Object.assign(input, { isTTY: true, isRawModeSupported: true, setRawMode: () => input, ref: () => input, unref: () => input })
  const output = new PassThrough()
  Object.assign(output, { columns, rows: 24, isTTY: true })
  const terminal = new Terminal({ cols: columns, rows: 24, allowProposedApi: true, convertEol: true })
  const frames: string[] = []
  output.on("data", (chunk: Buffer) => { frames.push(chunk.toString("utf8")); terminal.write(chunk.toString("utf8")) })
  const instance = render(
    React.createElement(ContextMenuApp, { request: initialRequest, rewrite, clipboard: { copy } }),
    {
      stdin: input as never,
      stdout: output as never,
      interactive: true,
      exitOnCtrlC: false,
      kittyKeyboard: { mode: "disabled" },
      alternateScreen: false,
      patchConsole: false,
      maxFps: 30,
      onRender: () => undefined,
    },
  )
  return {
    input,
    frames,
    terminal,
    instance,
    press: async (keys) => { input.write(keys); await new Promise(resolve => setTimeout(resolve, 40)) },
    close: async () => {
      instance.unmount()
      output.destroy()
      terminal.dispose()
    },
  }
}

const screen = (harness: Harness): string => Array.from({ length: harness.terminal.rows }, (_, i) => harness.terminal.buffer.active.getLine(harness.terminal.buffer.active.viewportY + i)?.translateToString(true) ?? "").join("\n")
const waitFor = async (harness: Harness, text: string): Promise<void> => {
  await vi.waitFor(() => expect(screen(harness)).toContain(text), { timeout: 2_000, interval: 10 })
}

describe("contextual rewrite UI rendered integration", () => {
  const mounted: Harness[] = []
  afterEach(async () => {
    for (const harness of mounted.splice(0)) await harness.close()
    vi.restoreAllMocks()
  })

  it.each(["hit", "miss"] as const)("switches from original to rewritten on successful completion (cache %s)", async (cache) => {
    let resolve!: (value: ContextMenuRewriteResponse) => void
    const pending = new Promise<ContextMenuRewriteResponse>((done) => { resolve = done })
    const harness = mount(async () => pending)
    mounted.push(harness)
    await waitFor(harness, "TRX contextual actions")
    await harness.press("\r")
    await waitFor(harness, "Rewriting as Plain English")
    await harness.press("o")
    await waitFor(harness, "Keep facts and the exact Markdown.")
    resolve(result("# Finished output\n\nThe rewrite is ready.", cache))
    await waitFor(harness, "Rewritten as Plain English")
    await waitFor(harness, "The rewrite is ready.")
    expect(screen(harness)).toContain("c copy rewritten")
    expect(screen(harness)).not.toContain("Keep facts and the exact Markdown.")
  })

  it("switches from diff to rewritten after successful regeneration", async () => {
    let resolve!: (value: ContextMenuRewriteResponse) => void
    let calls = 0
    const harness = mount(async () => ++calls === 1
      ? result("# First rewrite")
      : new Promise<ContextMenuRewriteResponse>(done => { resolve = done }))
    mounted.push(harness)
    await waitFor(harness, "TRX contextual actions")
    await harness.press("\r")
    await waitFor(harness, "First rewrite")
    await harness.press("d")
    await waitFor(harness, "Original (before)")
    await harness.press("g")
    await waitFor(harness, "Rewriting as Plain English")
    resolve(result("# Fresh rewrite\n\nRegenerated successfully."))
    await waitFor(harness, "Regenerated successfully.")
    expect(screen(harness)).toContain("c copy rewritten")
    expect(screen(harness)).not.toContain("Original (before)")
  })

  it("renders descriptions and navigates through the full catalog to Yoda", async () => {
    vi.spyOn(preferences, "readPreferredStyle").mockResolvedValue(undefined)
    vi.spyOn(preferences, "writePreferredStyle").mockResolvedValue(undefined)
    const styles = Array.from({ length: 20 }, (_, index) => ({
      id: index === 19 ? "yoda" : `style-${index + 1}`,
      title: index === 19 ? "Yoda" : `Style ${index + 1}`,
      description: index === 19 ? "Plain technical English; a Yoda-style final line." : `Description ${index + 1}`,
      instruction: "Be concise.",
    }))
    const harness = mount(async () => result("# Rewritten"), { ...request, styles })
    mounted.push(harness)
    await waitFor(harness, "Description 1")
    for (let index = 0; index < 19; index += 1) await harness.press("j")
    await waitFor(harness, "Choose a style (20/20)")
    expect(screen(harness)).toContain("Yoda")
    expect(screen(harness)).toContain("Plain technical English; a Yoda-style final line.")
  })

  it("renders original, rewritten, and aligned diff views from real keyboard input", async () => {
    const harness = mount(async () => result("# Rewritten\n\nKeep facts."))
    mounted.push(harness)
    await harness.press("\r")
    await waitFor(harness, "Keep facts.")
    await harness.press("o")
    await waitFor(harness, "Keep facts and the exact Markdown.")
    await harness.press("d")
    await waitFor(harness, "Original (before)")
    const rows = screen(harness).split("\n")
    const heading = rows.find(row => row.includes("Original (before)"))!
    const content = rows.find(row => row.includes("- # Original"))!
    expect(heading).toContain("Rewritten (after)")
    expect(heading.indexOf(" │ ")).toBe(content.indexOf(" │ "))
    expect(heading.indexOf("Rewritten (after)")).toBe(content.indexOf("+ # Rewritten"))
  })

  it("bypasses cache on g and preserves the prior result after a failed regeneration", async () => {
    let calls = 0
    const seen: ContextMenuRewriteRequest[] = []
    const harness = mount(async (rewriteRequest) => {
      seen.push(rewriteRequest)
      calls += 1
      if (calls === 1) return result("# Saved rewrite", "hit")
      throw new Error("fixture offline")
    })
    mounted.push(harness)
    await harness.press("\r")
    await waitFor(harness, "Saved rewrite")
    await harness.press("g")
    await waitFor(harness, "Rewrite unavailable.")
    expect(screen(harness)).toContain("Saved rewrite")
    expect(seen[1]?.bypassCache).toBe(true)
  })

  it("copies exact original while loading and rewritten Markdown from Diff", async () => {
    let resolve!: (value: ContextMenuRewriteResponse) => void
    const copied: string[] = []
    const harness = mount(() => new Promise(done => { resolve = done }), request, async value => { copied.push(value) })
    mounted.push(harness)
    await waitFor(harness, "TRX contextual actions")
    await harness.press("\r")
    await waitFor(harness, "Rewriting as")
    await harness.press("o")
    await waitFor(harness, "Original")
    await harness.press("c")
    await vi.waitFor(() => expect(copied).toEqual([source]))
    resolve(result("# Rewrite\n\nExact **Markdown**.\n"))
    await waitFor(harness, "Rewritten as")
    await harness.press("d")
    await waitFor(harness, "Diff")
    await harness.press("c")
    await vi.waitFor(() => expect(copied[1]).toBe("# Rewrite\n\nExact **Markdown**.\n"))
    await waitFor(harness, "Copied rewritten")
  })

  it("does not attach a pending copy confirmation to another view", async () => {
    let copied!: () => void
    const harness = mount(async () => result("# Rewritten"), request, () => new Promise(resolve => { copied = resolve }))
    mounted.push(harness)
    await harness.press("\r")
    await waitFor(harness, "Rewritten as")
    await harness.press("c")
    await vi.waitFor(() => expect(copied).toBeTypeOf("function"))
    await harness.press("o")
    await waitFor(harness, "Original")
    copied()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(screen(harness)).not.toContain("Copied rewritten")
  })

  it("remembers explicit selection without starting a rewrite and reports preference faults", async () => {
    const second = { ...style, id: "second", title: "Second style" }
    vi.spyOn(preferences, "readPreferredStyle").mockResolvedValue("second")
    const write = vi.spyOn(preferences, "writePreferredStyle").mockRejectedValue(new Error("disk failed"))
    const rewrite = vi.fn(async () => result("unexpected"))
    const harness = mount(rewrite, { ...request, styles: [style, second] })
    mounted.push(harness)
    await waitFor(harness, "› Second style")
    expect(rewrite).not.toHaveBeenCalled()
    await harness.press("k")
    await waitFor(harness, "› Plain English")
    expect(write).toHaveBeenCalledWith(undefined, "plain")
    await waitFor(harness, "Could not save the selected style")
  })

  it("preserves each document scroll position and labels narrow diffs", async () => {
    const original = Array.from({ length: 80 }, (_, i) => `Original line ${i}`).join("\n")
    const rewritten = Array.from({ length: 80 }, (_, i) => `New line ${i}`).join("\n")
    const harness = mount(async () => result(rewritten), { ...request, message: { ...request.message!, text: original } }, undefined, 70)
    mounted.push(harness)
    await waitFor(harness, "Choose a style")
    await harness.press("\r")
    await waitFor(harness, "Rewritten as")
    await harness.press("o")
    await waitFor(harness, "Original line 0")
    await harness.press("\x1b[6~")
    await vi.waitFor(() => expect(screen(harness).match(/Original line \d+/)?.[0]).toBe("Original line 11"))
    const originalPosition = screen(harness).match(/Original line \d+/)?.[0]
    expect(originalPosition).not.toBe("Original line 0")
    await harness.press("w")
    await waitFor(harness, "New line 0")
    await harness.press("\x1b[6~")
    await vi.waitFor(() => expect(screen(harness).match(/New line \d+/)?.[0]).toBe("New line 11"))
    const rewritePosition = screen(harness).match(/New line \d+/)?.[0]
    await harness.press("o")
    await waitFor(harness, originalPosition!)
    await harness.press("w")
    await waitFor(harness, rewritePosition!)
    await harness.press("d")
    await waitFor(harness, "Unified diff")
    await harness.press("\x1b[6~")
    await waitFor(harness, "- Original line 6")
    const diffPosition = screen(harness).match(/- Original line \d+/)?.[0]
    await harness.press("o")
    await waitFor(harness, originalPosition!)
    await harness.press("d")
    await waitFor(harness, diffPosition!)
  })

  it("does not start a rewrite for a source error and leaves the error visible", async () => {
    const rewrite = vi.fn(async () => result("unexpected"))
    const harness = mount(rewrite, errorRequest)
    mounted.push(harness)
    await waitFor(harness, "The original source is unavailable.")
    await harness.press("\r")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rewrite).not.toHaveBeenCalled()
    expect(screen(harness)).toContain("Rewrite unavailable.")
  })
})
