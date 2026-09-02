import type { Key } from "ink"
import { describe, expect, it } from "vitest"

import {
  BasketPreviewActionType,
  BasketPreviewArgsError,
  BasketPreviewView,
  activeViewText,
  assembleStagedPrompt,
  basketPreviewCommandForKey,
  basketPreviewReducer,
  destinationSummaryLines,
  initialBasketPreviewState,
  isChunkEdited,
  parseBasketPreviewArgv,
  previewChunks,
  previewDestination,
  stagedCharacterCount,
  type BasketPreviewAction,
  type BasketPreviewState,
} from "../src/basket-preview.js"
import { basketBlockPreview, basketVisibleRange, countTextLines } from "../src/basket.js"

const emptyKey = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  home: false,
  end: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
} satisfies Key

const chunkIds = previewChunks.map((chunk) => chunk.id)

const reduceAll = (state: BasketPreviewState, ...types: ReadonlyArray<BasketPreviewActionType>): BasketPreviewState =>
  types.reduce((current, type) => basketPreviewReducer(current, { type } as BasketPreviewAction), state)

describe("parseBasketPreviewArgv", () => {
  it("accepts the preview flag alone", () => {
    expect(parseBasketPreviewArgv(["--preview"])).toEqual({ help: false })
  })

  it("reports help without requiring the flag", () => {
    expect(parseBasketPreviewArgv(["--help"]).help).toBe(true)
  })

  it("rejects a layout name", () => {
    expect(() => parseBasketPreviewArgv(["--preview", "composer"])).toThrow(BasketPreviewArgsError)
    expect(() => parseBasketPreviewArgv(["--preview", "composer"])).toThrow("accepts no argument: composer")
  })

  it("rejects a repeated flag", () => {
    expect(() => parseBasketPreviewArgv(["--preview", "--preview"])).toThrow("Duplicate flag: --preview")
  })

  it("requires the preview flag", () => {
    expect(() => parseBasketPreviewArgv([])).toThrow("requires --preview")
  })
})

describe("basketPreviewReducer selection and contents", () => {
  const start = initialBasketPreviewState()

  it("wraps the cursor at both ends", () => {
    expect(reduceAll(start, BasketPreviewActionType.PreviousChunk).cursor).toBe(previewChunks.length - 1)
    const last = { ...start, cursor: previewChunks.length - 1 }
    expect(basketPreviewReducer(last, { type: BasketPreviewActionType.NextChunk }).cursor).toBe(0)
  })

  it("reorders the selected chunk and follows it", () => {
    const moved = basketPreviewReducer(start, { type: BasketPreviewActionType.MoveChunkLater })
    expect(moved.cursor).toBe(1)
    expect(moved.chunks.map((chunk) => chunk.id)).toEqual([chunkIds[1], chunkIds[0], ...chunkIds.slice(2)])
    expect(basketPreviewReducer(moved, { type: BasketPreviewActionType.MoveChunkEarlier }).chunks).toEqual(
      previewChunks,
    )
  })

  it("does not reorder past either end", () => {
    expect(basketPreviewReducer(start, { type: BasketPreviewActionType.MoveChunkEarlier })).toBe(start)
    const last = { ...start, cursor: previewChunks.length - 1 }
    expect(basketPreviewReducer(last, { type: BasketPreviewActionType.MoveChunkLater })).toBe(last)
  })

  it("drops the selected chunk and keeps the cursor in range", () => {
    const dropped = basketPreviewReducer(
      { ...start, cursor: previewChunks.length - 1 },
      { type: BasketPreviewActionType.DropChunk },
    )
    expect(dropped.chunks.map((chunk) => chunk.id)).toEqual(chunkIds.slice(0, -1))
    expect(dropped.cursor).toBe(previewChunks.length - 2)
  })

  it("clears and restores the basket", () => {
    const cleared = basketPreviewReducer(start, { type: BasketPreviewActionType.ClearChunks })
    expect(cleared.chunks).toEqual([])
    expect(basketPreviewReducer(cleared, { type: BasketPreviewActionType.DropChunk })).toBe(cleared)
    expect(basketPreviewReducer(cleared, { type: BasketPreviewActionType.NextChunk })).toBe(cleared)
    expect(basketPreviewReducer(cleared, { type: BasketPreviewActionType.RestoreChunks }).chunks).toEqual(previewChunks)
  })
})

describe("basketPreviewReducer views", () => {
  const start = initialBasketPreviewState()

  it("opens and closes the block viewer", () => {
    const opened = basketPreviewReducer(start, { type: BasketPreviewActionType.OpenBlock })
    expect(opened.view).toBe(BasketPreviewView.Block)
    expect(activeViewText(opened)).toBe(previewChunks[0]?.text)
    expect(basketPreviewReducer(opened, { type: BasketPreviewActionType.CloseView }).view).toBe(BasketPreviewView.List)
  })

  it("opens the final prompt viewer", () => {
    const opened = basketPreviewReducer(start, { type: BasketPreviewActionType.OpenFinal })
    expect(opened.view).toBe(BasketPreviewView.Final)
    expect(activeViewText(opened)).toBe(assembleStagedPrompt(previewChunks))
  })

  it("does not open a viewer on an empty basket", () => {
    const cleared = basketPreviewReducer(start, { type: BasketPreviewActionType.ClearChunks })
    expect(basketPreviewReducer(cleared, { type: BasketPreviewActionType.OpenBlock }).view).toBe(BasketPreviewView.List)
    expect(basketPreviewReducer(cleared, { type: BasketPreviewActionType.OpenFinal }).view).toBe(BasketPreviewView.List)
  })

  it("clamps scrolling to the reported maximum", () => {
    const opened = basketPreviewReducer(start, { type: BasketPreviewActionType.OpenBlock })
    const down = basketPreviewReducer(opened, { type: BasketPreviewActionType.Scroll, delta: 10, maximum: 4 })
    expect(down.scroll).toBe(4)
    const up = basketPreviewReducer(down, { type: BasketPreviewActionType.Scroll, delta: -10, maximum: 4 })
    expect(up.scroll).toBe(0)
  })

  it("resets the scroll when the viewer closes", () => {
    const scrolled = reduceAll(start, BasketPreviewActionType.OpenBlock)
    const moved = basketPreviewReducer(scrolled, { type: BasketPreviewActionType.Scroll, delta: 3, maximum: 9 })
    expect(basketPreviewReducer(moved, { type: BasketPreviewActionType.CloseView }).scroll).toBe(0)
  })
})

describe("basketPreviewReducer editor", () => {
  const start = initialBasketPreviewState()

  it("loads the captured text into the draft", () => {
    const editing = basketPreviewReducer(start, { type: BasketPreviewActionType.EditStart })
    expect(editing.view).toBe(BasketPreviewView.Edit)
    expect(editing.draft).toBe(previewChunks[0]?.text)
    expect(activeViewText(editing)).toBe(editing.draft)
  })

  it("appends, deletes, and saves onto the selected chunk", () => {
    const edited = reduceAll(
      start,
      BasketPreviewActionType.EditStart,
      BasketPreviewActionType.EditBackspace,
      BasketPreviewActionType.EditBackspace,
    )
    const appended = basketPreviewReducer(edited, { type: BasketPreviewActionType.EditAppend, text: "!!" })
    const saved = basketPreviewReducer(appended, { type: BasketPreviewActionType.EditSave })
    expect(saved.view).toBe(BasketPreviewView.List)
    expect(saved.draft).toBe("")
    expect(saved.chunks[0]?.text).toBe(`${previewChunks[0]?.text.slice(0, -2)}!!`)
    expect(saved.chunks.slice(1)).toEqual(previewChunks.slice(1))
  })

  it("marks an edited chunk and reverts it to the captured text", () => {
    const saved = basketPreviewReducer(
      basketPreviewReducer(basketPreviewReducer(start, { type: BasketPreviewActionType.EditStart }), {
        type: BasketPreviewActionType.EditAppend,
        text: " extra",
      }),
      { type: BasketPreviewActionType.EditSave },
    )
    const changed = saved.chunks[0]
    expect(changed === undefined ? false : isChunkEdited(changed, previewChunks[0]?.text)).toBe(true)
    const reverted = basketPreviewReducer(saved, { type: BasketPreviewActionType.RevertChunk })
    expect(reverted.chunks[0]?.text).toBe(previewChunks[0]?.text)
    expect(basketPreviewReducer(reverted, { type: BasketPreviewActionType.RevertChunk })).toBe(reverted)
  })

  it("discards the draft on cancel", () => {
    const editing = basketPreviewReducer(start, { type: BasketPreviewActionType.EditStart })
    const cancelled = basketPreviewReducer(
      basketPreviewReducer(editing, { type: BasketPreviewActionType.EditAppend, text: "zzz" }),
      { type: BasketPreviewActionType.EditCancel },
    )
    expect(cancelled.view).toBe(BasketPreviewView.List)
    expect(cancelled.chunks).toEqual(previewChunks)
  })

  it("refuses to save an empty block", () => {
    const emptied = { ...start, view: BasketPreviewView.Edit, draft: "   " }
    expect(basketPreviewReducer(emptied, { type: BasketPreviewActionType.EditSave })).toBe(emptied)
  })
})

describe("assembleStagedPrompt", () => {
  it("emits one sourced block per chunk in staged order", () => {
    const prompt = assembleStagedPrompt(previewChunks)
    expect(prompt.split("\n\n")[0]?.split("\n")[0]).toBe("## from council · 09:38")
    expect(previewChunks.every((chunk) => prompt.includes(`## from ${chunk.pane} · ${chunk.capturedAt}`))).toBe(true)
    expect(prompt).toContain("mcptoon token savings: 41% p50, 28% p95 across 12 tool schemas (n=340).")
  })

  it("follows a reorder", () => {
    const moved = basketPreviewReducer(initialBasketPreviewState(), {
      type: BasketPreviewActionType.MoveChunkLater,
    })
    expect(assembleStagedPrompt(moved.chunks).startsWith("## from research · 09:39")).toBe(true)
  })

  it("is empty for an empty basket", () => {
    expect(assembleStagedPrompt([])).toBe("")
    expect(stagedCharacterCount([])).toBe(0)
    expect(countTextLines("")).toBe(0)
  })
})

describe("basketBlockPreview", () => {
  it("truncates a long block to the line budget and marks the cut", () => {
    const long = previewChunks.find((chunk) => chunk.id === "spec")
    const preview = basketBlockPreview(long?.text ?? "", 60)
    expect(preview.truncated).toBe(true)
    expect(preview.lines).toHaveLength(2)
    expect(preview.lines.at(-1)?.endsWith("…")).toBe(true)
    expect(preview.lines.every((line) => line.length <= 60)).toBe(true)
  })

  it("never breaks a word or wraps a line", () => {
    const council = previewChunks.find((chunk) => chunk.id === "council")
    const [first] = basketBlockPreview(council?.text ?? "", 94).lines
    expect(first?.endsWith("…")).toBe(true)
    expect(first?.slice(0, -1).endsWith(" ")).toBe(false)
    expect(council?.text.startsWith(first?.slice(0, -1) ?? "")).toBe(true)
  })

  it("skips blank source lines so the summary is two lines of real text", () => {
    const bench = previewChunks.find((chunk) => chunk.id === "research")
    const preview = basketBlockPreview(bench?.text ?? "", 100)
    expect(preview.lines).toHaveLength(2)
    expect(preview.lines.every((line) => line.trim().length > 0)).toBe(true)
    expect(preview.lines[1]?.startsWith("  schema group")).toBe(true)
  })

  it("leaves a short block whole and unmarked", () => {
    const short = previewChunks.find((chunk) => chunk.id === "doctor")
    const preview = basketBlockPreview(short?.text ?? "", 100)
    expect(preview.truncated).toBe(false)
    expect(preview.lines).toEqual([short?.text])
    expect(preview.lines.some((line) => line.endsWith("…"))).toBe(false)
  })
})

describe("basketVisibleRange", () => {
  it("keeps the selected block on screen when the list overflows", () => {
    const heights = [4, 4, 4, 4, 4]
    expect(basketVisibleRange(heights, 0, 9)).toEqual({ start: 0, end: 2 })
    const range = basketVisibleRange(heights, 4, 9)
    expect(range.end).toBe(5)
    expect(range.start).toBeLessThanOrEqual(4)
  })

  it("shows every block when they all fit", () => {
    expect(basketVisibleRange([2, 2, 2], 1, 100)).toEqual({ start: 0, end: 3 })
  })

  it("shows the selected block even when it alone overflows", () => {
    expect(basketVisibleRange([40, 40], 1, 5)).toEqual({ start: 1, end: 2 })
  })

  it("is empty for an empty basket", () => {
    expect(basketVisibleRange([], 0, 10)).toEqual({ start: 0, end: 0 })
  })
})

describe("destinationSummaryLines", () => {
  it("names the launcher, profile, model, and where it runs", () => {
    const [runsOn, runsIn] = destinationSummaryLines(previewDestination)
    expect(runsOn).toContain("cldx · claude/default")
    expect(runsOn).toContain("claude-opus-5")
    expect(runsOn).toContain("sandbox off")
    expect(runsIn).toContain("~/src/trellage")
    expect(runsIn).toContain("session profile-match")
  })
})

describe("basketPreviewCommandForKey", () => {
  const list = BasketPreviewView.List

  it("maps quit and submit in the list", () => {
    expect(basketPreviewCommandForKey("q", emptyKey, list)).toEqual({ type: "quit" })
    expect(basketPreviewCommandForKey("", { ...emptyKey, escape: true }, list)).toEqual({ type: "quit" })
    expect(basketPreviewCommandForKey("", { ...emptyKey, return: true }, list)).toEqual({ type: "submit" })
  })

  it("maps both the arrow keys and their j/k aliases to the same actions", () => {
    const next = { type: BasketPreviewActionType.NextChunk }
    const previous = { type: BasketPreviewActionType.PreviousChunk }
    expect(basketPreviewCommandForKey("", { ...emptyKey, downArrow: true }, list)).toEqual(next)
    expect(basketPreviewCommandForKey("j", emptyKey, list)).toEqual(next)
    expect(basketPreviewCommandForKey("", { ...emptyKey, upArrow: true }, list)).toEqual(previous)
    expect(basketPreviewCommandForKey("k", emptyKey, list)).toEqual(previous)
  })

  it("maps the basket open and edit keys", () => {
    expect(basketPreviewCommandForKey("o", emptyKey, list)).toEqual({ type: BasketPreviewActionType.OpenBlock })
    expect(basketPreviewCommandForKey("f", emptyKey, list)).toEqual({ type: BasketPreviewActionType.OpenFinal })
    expect(basketPreviewCommandForKey("e", emptyKey, list)).toEqual({ type: BasketPreviewActionType.EditStart })
    expect(basketPreviewCommandForKey("u", emptyKey, list)).toEqual({ type: BasketPreviewActionType.RevertChunk })
    expect(basketPreviewCommandForKey("x", emptyKey, list)).toEqual({ type: BasketPreviewActionType.DropChunk })
    expect(basketPreviewCommandForKey("X", emptyKey, list)).toEqual({ type: BasketPreviewActionType.ClearChunks })
    expect(basketPreviewCommandForKey("r", emptyKey, list)).toEqual({ type: BasketPreviewActionType.RestoreChunks })
  })

  it("scrolls and closes in the block viewer, and can edit from it", () => {
    const block = BasketPreviewView.Block
    expect(basketPreviewCommandForKey("j", emptyKey, block)).toEqual({ type: "scroll", delta: 1 })
    expect(basketPreviewCommandForKey("k", emptyKey, block)).toEqual({ type: "scroll", delta: -1 })
    expect(basketPreviewCommandForKey("", { ...emptyKey, pageDown: true }, block)).toEqual({
      type: "scroll",
      delta: 10,
    })
    expect(basketPreviewCommandForKey("", { ...emptyKey, pageUp: true }, block)).toEqual({ type: "scroll", delta: -10 })
    expect(basketPreviewCommandForKey("q", emptyKey, block)).toEqual({ type: BasketPreviewActionType.CloseView })
    expect(basketPreviewCommandForKey("e", emptyKey, block)).toEqual({ type: BasketPreviewActionType.EditStart })
  })

  it("does not offer editing in the final prompt viewer", () => {
    expect(basketPreviewCommandForKey("e", emptyKey, BasketPreviewView.Final)).toBeUndefined()
    expect(basketPreviewCommandForKey("q", emptyKey, BasketPreviewView.Final)).toEqual({
      type: BasketPreviewActionType.CloseView,
    })
  })

  it("treats printable keys as text in the editor", () => {
    const edit = BasketPreviewView.Edit
    expect(basketPreviewCommandForKey("q", emptyKey, edit)).toEqual({
      type: BasketPreviewActionType.EditAppend,
      text: "q",
    })
    expect(basketPreviewCommandForKey("", { ...emptyKey, backspace: true }, edit)).toEqual({
      type: BasketPreviewActionType.EditBackspace,
    })
    expect(basketPreviewCommandForKey("", { ...emptyKey, return: true }, edit)).toEqual({
      type: BasketPreviewActionType.EditSave,
    })
    expect(basketPreviewCommandForKey("", { ...emptyKey, escape: true }, edit)).toEqual({
      type: BasketPreviewActionType.EditCancel,
    })
    expect(basketPreviewCommandForKey("c", { ...emptyKey, ctrl: true }, edit)).toBeUndefined()
  })

  it("ignores an unmapped key", () => {
    expect(basketPreviewCommandForKey("z", emptyKey, list)).toBeUndefined()
  })
})
