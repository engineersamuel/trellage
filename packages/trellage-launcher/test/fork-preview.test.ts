import type { Key } from "ink"
import { describe, expect, it } from "vitest"

import {
  ForkPreviewActionType,
  ForkPreviewArgsError,
  ForkStep,
  activeFork,
  forkChoiceIndex,
  forkPlacement,
  forkPreviewCommandForKey,
  forkPreviewFooterLines,
  forkPreviewReducer,
  forkPreviewVariants,
  forkPrompt,
  initialForkPreviewState,
  inlineRows,
  launchSummaryLines,
  parseForkPreviewArgv,
  previewLenses,
  previewRecommendations,
  previewRows,
  showsDetailPane,
  wizardStepIndex,
  type ForkPreviewAction,
  type ForkPreviewState,
  type ForkPreviewVariant,
} from "../src/fork-preview.js"

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

const reduceAll = (state: ForkPreviewState, ...actions: ReadonlyArray<ForkPreviewAction>): ForkPreviewState =>
  actions.reduce(forkPreviewReducer, state)

const start = (variant: ForkPreviewVariant = "tabs"): ForkPreviewState => initialForkPreviewState(variant)

/** One fork opened from the council lens, sitting on its prompt step. */
const forked = (variant: ForkPreviewVariant = "tabs"): ForkPreviewState =>
  forkPreviewReducer(start(variant), { type: ForkPreviewActionType.ForkLens, index: 0 })

/** The same fork, walked to ready. */
const finished = (variant: ForkPreviewVariant = "tabs"): ForkPreviewState =>
  reduceAll(
    forked(variant),
    { type: ForkPreviewActionType.Advance },
    { type: ForkPreviewActionType.ChoiceNext },
    { type: ForkPreviewActionType.Advance },
  )

describe("parseForkPreviewArgv", () => {
  it("defaults to the tabs variant", () => {
    expect(parseForkPreviewArgv(["--forks"])).toEqual({ help: false, variant: "tabs" })
  })

  it("accepts every named variant", () => {
    for (const variant of forkPreviewVariants) {
      expect(parseForkPreviewArgv(["--forks", variant]).variant).toBe(variant)
    }
  })

  it("reports help without requiring the flag", () => {
    expect(parseForkPreviewArgv(["--help"]).help).toBe(true)
  })

  it("names the valid variants when one is unknown", () => {
    expect(() => parseForkPreviewArgv(["--forks", "board"])).toThrow(ForkPreviewArgsError)
    expect(() => parseForkPreviewArgv(["--forks", "board"])).toThrow("tabs, inline")
  })

  it("rejects a repeated flag and a second variant", () => {
    expect(() => parseForkPreviewArgv(["--forks", "--forks"])).toThrow("Duplicate flag")
    expect(() => parseForkPreviewArgv(["--forks", "tabs", "inline"])).toThrow("Only one variant")
  })

  it("requires the forks flag", () => {
    expect(() => parseForkPreviewArgv([])).toThrow("requires --forks")
  })
})

describe("forking", () => {
  it("opens a lens fork on its prompt step and makes it active", () => {
    const state = forked()
    expect(state.forks).toHaveLength(1)
    expect(state.forks[0]?.origin.label).toBe(previewLenses[0]?.origin.label)
    expect(state.forks[0]?.step).toBe(ForkStep.Candidate)
    expect(activeFork(state)?.id).toBe(1)
  })

  it("forks the recommendation under the main cursor", () => {
    const state = reduceAll(
      start(),
      { type: ForkPreviewActionType.MainNext },
      { type: ForkPreviewActionType.MainActivate },
    )
    expect(state.forks[0]?.origin.label).toBe(previewRecommendations[1]?.label)
  })

  it("keeps every fork independent and numbers them in order", () => {
    const state = reduceAll(
      start(),
      { type: ForkPreviewActionType.ForkLens, index: 0 },
      { type: ForkPreviewActionType.Advance },
      { type: ForkPreviewActionType.ForkLens, index: 1 },
    )
    expect(state.forks.map((fork) => fork.id)).toEqual([1, 2])
    expect(state.forks.map((fork) => fork.step)).toEqual([ForkStep.Placement, ForkStep.Candidate])
    expect(activeFork(state)?.id).toBe(2)
  })

  it("keeps the recommendation rail intact in tabs while a fork is open", () => {
    expect(previewRows(forked("tabs"))).toHaveLength(previewRecommendations.length)
  })
})

describe("stepping inside a fork", () => {
  it("walks prompt to destination to ready and keeps both choices", () => {
    const state = finished()
    const fork = state.forks[0]
    expect(fork?.step).toBe(ForkStep.Ready)
    expect(fork?.candidateIndex).toBe(0)
    expect(fork?.placementIndex).toBe(1)
    expect(fork === undefined ? "" : forkPlacement(fork)).toContain("new worktree")
    expect(fork === undefined ? "" : forkPrompt(fork)).toContain("Council")
  })

  it("moves the choice for the current step only", () => {
    const moved = forkPreviewReducer(forked(), { type: ForkPreviewActionType.ChoiceNext })
    expect(moved.forks[0]?.candidateIndex).toBe(1)
    expect(moved.forks[0]?.placementIndex).toBe(0)
  })

  it("wraps the choice at both ends", () => {
    const back = forkPreviewReducer(forked(), { type: ForkPreviewActionType.ChoicePrevious })
    const fork = back.forks[0]
    expect(fork?.candidateIndex).toBe(2)
    expect(fork === undefined ? -1 : forkChoiceIndex(fork)).toBe(2)
  })

  it("steps back out to the main screen from the first step", () => {
    const out = forkPreviewReducer(forked(), { type: ForkPreviewActionType.Retreat })
    expect(out.activeId).toBeUndefined()
    expect(out.forks).toHaveLength(1)
  })

  it("keeps a fork's progress when the main screen is visited and it is re-entered", () => {
    const parked = reduceAll(
      forked(),
      { type: ForkPreviewActionType.ChoiceNext },
      { type: ForkPreviewActionType.Advance },
      { type: ForkPreviewActionType.GoMain },
    )
    const resumed = forkPreviewReducer(parked, { type: ForkPreviewActionType.SelectFork, index: 0 })
    expect(resumed.forks[0]?.step).toBe(ForkStep.Placement)
    expect(resumed.forks[0]?.candidateIndex).toBe(1)
    expect(activeFork(resumed)?.id).toBe(1)
  })

  it("drops the active fork and returns to the main screen", () => {
    const dropped = forkPreviewReducer(forked(), { type: ForkPreviewActionType.DropFork })
    expect(dropped.forks).toEqual([])
    expect(dropped.activeId).toBeUndefined()
  })
})

describe("switching between forks", () => {
  const two = reduceAll(
    start(),
    { type: ForkPreviewActionType.ForkLens, index: 0 },
    { type: ForkPreviewActionType.ForkLens, index: 1 },
  )

  it("cycles and wraps", () => {
    expect(forkPreviewReducer(two, { type: ForkPreviewActionType.NextFork }).activeId).toBe(1)
    expect(forkPreviewReducer(two, { type: ForkPreviewActionType.PreviousFork }).activeId).toBe(1)
  })

  it("ignores a jump past the last fork", () => {
    expect(forkPreviewReducer(two, { type: ForkPreviewActionType.SelectFork, index: 8 })).toEqual(two)
  })

  it("does nothing when no fork is open", () => {
    const empty = start()
    expect(forkPreviewReducer(empty, { type: ForkPreviewActionType.NextFork })).toEqual(empty)
  })
})

describe("the inline rail", () => {
  it("expands an unfinished fork's choices as rows and collapses a ready one", () => {
    expect(inlineRows(forked("inline")).filter((row) => row.kind === "choice")).toHaveLength(3)
    expect(inlineRows(finished("inline")).filter((row) => row.kind === "choice")).toHaveLength(0)
  })

  it("puts the cursor on the new fork's first choice, so Enter advances it", () => {
    const state = forked("inline")
    expect(state.mainCursor).toBe(previewRecommendations.length + 1)
    const advanced = forkPreviewReducer(state, { type: ForkPreviewActionType.MainActivate })
    expect(advanced.forks).toHaveLength(1)
    expect(advanced.forks[0]?.step).toBe(ForkStep.Placement)
  })

  it("pulls the cursor back into range when a fork collapses", () => {
    const state = reduceAll(
      forked("inline"),
      { type: ForkPreviewActionType.MainActivate },
      { type: ForkPreviewActionType.MainNext },
      { type: ForkPreviewActionType.MainNext },
    )
    const ready = forkPreviewReducer(state, { type: ForkPreviewActionType.MainActivate })
    expect(ready.forks[0]?.step).toBe(ForkStep.Ready)
    expect(ready.mainCursor).toBeLessThan(previewRows(ready).length)
  })
})

describe("wizard breadcrumbs", () => {
  it("lights the step of the active fork in tabs and of the cursor's fork in inline", () => {
    expect(wizardStepIndex(start())).toBe(0)
    expect(wizardStepIndex(forked("tabs"))).toBe(1)
    expect(wizardStepIndex(forked("inline"))).toBe(1)
    expect(wizardStepIndex({ ...forked("inline"), mainCursor: 0 })).toBe(0)
  })
})

describe("launch summary", () => {
  it("names only the ready forks and counts the rest", () => {
    const mixed = forkPreviewReducer(finished(), { type: ForkPreviewActionType.ForkLens, index: 1 })
    const lines = launchSummaryLines(mixed)
    expect(lines[0]).toBe("Launching 1 fork.")
    expect(lines[1]).toContain("council")
    expect(lines.at(-1)).toBe("Skipped 1 unfinished fork.")
  })

  it("launches nothing when no fork is ready", () => {
    expect(launchSummaryLines(forked())).toEqual(["No fork is ready. Nothing was launched."])
  })
})

describe("variant key maps", () => {
  it("cycles variants, forks a lens, launches, and quits from both variants", () => {
    for (const variant of forkPreviewVariants) {
      const state = start(variant)
      expect(forkPreviewCommandForKey(state, "]", emptyKey)).toEqual({ type: ForkPreviewActionType.NextVariant })
      expect(forkPreviewCommandForKey(state, "r", emptyKey)).toEqual({
        type: ForkPreviewActionType.ForkLens,
        index: 1,
      })
      expect(forkPreviewCommandForKey(state, "L", emptyKey)).toEqual({ type: "launch" })
      expect(forkPreviewCommandForKey(state, "q", emptyKey)).toEqual({ type: "quit" })
    }
  })

  it("maps Tab, backtick and digits only in tabs", () => {
    const tabs = forked("tabs")
    expect(forkPreviewCommandForKey(tabs, "", { ...emptyKey, tab: true })).toEqual({
      type: ForkPreviewActionType.NextFork,
    })
    expect(forkPreviewCommandForKey(tabs, "", { ...emptyKey, tab: true, shift: true })).toEqual({
      type: ForkPreviewActionType.PreviousFork,
    })
    expect(forkPreviewCommandForKey(tabs, "`", emptyKey)).toEqual({ type: ForkPreviewActionType.GoMain })
    expect(forkPreviewCommandForKey(tabs, "2", emptyKey)).toEqual({
      type: ForkPreviewActionType.SelectFork,
      index: 1,
    })
    expect(forkPreviewCommandForKey(forked("inline"), "", { ...emptyKey, tab: true })).toBeUndefined()
  })

  it("chooses inside the active fork in tabs and moves the rail on the main screen", () => {
    expect(forkPreviewCommandForKey(forked("tabs"), "j", emptyKey)).toEqual({
      type: ForkPreviewActionType.ChoiceNext,
    })
    expect(forkPreviewCommandForKey(start("tabs"), "j", emptyKey)).toEqual({ type: ForkPreviewActionType.MainNext })
  })

  it("acts on whatever row the inline cursor is on", () => {
    expect(forkPreviewCommandForKey(start("inline"), "", { ...emptyKey, return: true })).toEqual({
      type: ForkPreviewActionType.MainActivate,
    })
    expect(forkPreviewCommandForKey(forked("inline"), "b", emptyKey)).toEqual({
      type: ForkPreviewActionType.Retreat,
    })
    expect(forkPreviewCommandForKey({ ...forked("inline"), mainCursor: 0 }, "b", emptyKey)).toBeUndefined()
  })

  it("ignores an unmapped key", () => {
    expect(forkPreviewCommandForKey(start(), "z", emptyKey)).toBeUndefined()
  })
})

describe("narrow terminals", () => {
  it("drops the detail pane under 70 columns", () => {
    expect(showsDetailPane(69)).toBe(false)
    expect(showsDetailPane(70)).toBe(true)
  })

  it("names the active variant in the footer", () => {
    expect(forkPreviewFooterLines(start("inline")).at(-1)).toContain("(inline)")
    expect(forkPreviewFooterLines(start("tabs")).at(-1)).toContain("(tabs)")
  })
})
