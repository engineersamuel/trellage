import { describe, expect, it } from "vitest"
import {
  contextMenuStyleRequest,
  contextMenuUiReducer,
  ensureContextMenuMarkdown,
  initialContextMenuUiState,
  startContextMenuRewriteTask,
  type ContextMenuUiRequest,
} from "../src/context-menu-ui.tsx"
import { markdownInlineSegments, markdownPromptLines } from "../src/guide-ui.tsx"
import { RestrictedGuideModelError } from "../src/copilot-guide-provider.ts"

const style = {
  id: "ste-english",
  title: "STE English",
  description: "Clear, controlled English.",
  instruction: "Use short direct sentences.",
} as const

const request: ContextMenuUiRequest = {
  schemaVersion: 1,
  kind: "rewrite-output",
  source: { workspaceId: "workspace", tabId: "tab", paneId: "pane", cwd: "/repo", agent: "copilot" },
  message: { paneId: "pane", role: "harness", text: "# Source\n\nKeep **facts**.", capturedAt: "2026-09-10T12:00:00Z", source: "visible" },
  styles: [style],
}

describe("contextual rewrite UI contract", () => {
  it("starts in style selection and moves through loading, result, and copy states", () => {
    const selecting = initialContextMenuUiState(request)
    expect(selecting).toEqual({ kind: "selecting", index: 0 })
    const loading = contextMenuUiReducer(selecting, { kind: "loading", style, index: 0 })
    expect(loading).toEqual({ kind: "loading", style, index: 0 })
    const result = contextMenuUiReducer(loading, { kind: "result", style, index: 0, markdown: "# Rewritten" })
    expect(result).toEqual({ kind: "result", style, index: 0, markdown: "# Rewritten" })
    expect(contextMenuUiReducer(result, { kind: "copied", value: true })).toMatchObject({ copied: true })
    expect(contextMenuUiReducer(result, { kind: "copied", value: false })).toMatchObject({ copied: false })
  })

  it("keeps cancellation and SDK errors as visible states", () => {
    const loading = contextMenuUiReducer(initialContextMenuUiState(request), { kind: "loading", style, index: 0 })
    expect(contextMenuUiReducer(loading, { kind: "cancelled", index: 0, message: "Rewrite cancelled after SDK cleanup." })).toEqual({
      kind: "cancelled",
      index: 0,
      message: "Rewrite cancelled after SDK cleanup.",
    })
    expect(contextMenuUiReducer(loading, { kind: "error", style, index: 0, message: "Copilot could not start." })).toMatchObject({
      kind: "error",
      style,
      message: "Copilot could not start.",
    })
  })

  it("keeps the prior rewrite attached when a regeneration fails", () => {
    const result = contextMenuUiReducer(initialContextMenuUiState(request), { kind: "result", style, index: 0, markdown: "# Previous" })
    const loading = contextMenuUiReducer(result, { kind: "loading", style, index: 0, previousMarkdown: "# Previous", previousStyle: style, previousIndex: 0 })
    expect(loading).toMatchObject({ kind: "loading", previousMarkdown: "# Previous" })
    expect(contextMenuUiReducer(loading, { kind: "error", style, index: 0, message: "offline", previousMarkdown: "# Previous", previousStyle: style, previousIndex: 0 })).toMatchObject({
      kind: "error",
      previousMarkdown: "# Previous",
    })
    expect(contextMenuUiReducer(result, { kind: "view", view: "original" })).toMatchObject({ kind: "result", selectedView: "original" })
  })

  it("binds the selected style to the captured pane message", () => {
    expect(contextMenuStyleRequest(request, style)).toEqual({
      schemaVersion: 1,
      kind: "rewrite",
      paneId: "pane",
      styleId: "ste-english",
      style,
      message: "# Source\n\nKeep **facts**.",
    })
  })

  it("renders Markdown structure and inline formatting through the shared guide helpers", () => {
    expect(markdownPromptLines("# Heading\n\n- **bold**\n\n`code`", 80).map(({ text, kind }) => ({ text, kind }))).toEqual([
      { text: "Heading", kind: "heading" },
      { text: "", kind: "body" },
      { text: "• bold", kind: "list" },
      { text: "", kind: "body" },
      { text: "code", kind: "body" },
    ])
    expect(markdownInlineSegments("**bold** and `code`")).toEqual([
      { text: "bold", kind: "bold" },
      { text: " and ", kind: "text" },
      { text: "code", kind: "code" },
    ])
    expect(ensureContextMenuMarkdown("# Rewritten")).toBe("# Rewritten")
    expect(() => ensureContextMenuMarkdown(" \n")).toThrow("empty")
  })

  it("leaves loading after cancellation only until the deferred rewrite settles", async () => {
    let resolveRewrite!: (value: { readonly schemaVersion: 1; readonly kind: "rewrite-result"; readonly styleId: string; readonly markdown: string }) => void
    const pending = new Promise<{
      readonly schemaVersion: 1
      readonly kind: "rewrite-result"
      readonly styleId: string
      readonly markdown: string
    }>((resolve) => { resolveRewrite = resolve })
    const task = startContextMenuRewriteTask({ request, style, index: 0, rewrite: () => pending })
    let state = contextMenuUiReducer(initialContextMenuUiState(request), { kind: "loading", style, index: 0 })
    expect(state.kind).toBe("loading")
    task.controller.abort()
    resolveRewrite({ schemaVersion: 1, kind: "rewrite-result", styleId: "ste-english", markdown: "# Late result" })
    state = contextMenuUiReducer(state, await task.promise)
    expect(state).toEqual({ kind: "cancelled", index: 0, message: "Rewrite cancelled after SDK cleanup." })
  })

  it("keeps cleanup failures visible when cancellation rejects", async () => {
    const task = startContextMenuRewriteTask({
      request,
      style,
      index: 0,
      rewrite: (_value, signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new RestrictedGuideModelError("cancelled", ["stop"])), { once: true })
      }),
    })
    task.controller.abort()
    await expect(task.promise).resolves.toEqual({
      kind: "cancelled",
      index: 0,
      message: "Rewrite cancelled. Cleanup failed: stop.",
    })
  })
})
