import { describe, expect, test } from "vitest"
import {
  ContinuationActionStatus,
  ContinuationPlacementKind,
  type ContinuationDraft,
} from "../../trellage-guide-core/dist/index.js"
import {
  changeContinuationAction,
  changeContinuationEditor,
  continuationAction,
  continuationDependenciesWaiting,
  continuationLaunchPlan,
  continuationStatusLabel,
  defaultContinuationPlacement,
  describeContinuationPlacement,
  describeContinuationPromptOrigin,
  initialContinuationUiState,
  rankedContinuationActions,
  selectContinuationCandidate,
  withContinuationPlacementDefaults,
  ContinuationField,
  ContinuationOperation,
  ContinuationSaveState,
  ContinuationScreen,
  ContinuationTextCommand,
  continuationFieldLimit,
  type ContinuationEditor,
} from "../src/continuation-ui-state.js"
import { continuationFixtureDraft, continuationFixtureProfiles } from "./helpers/continuation-ui-fixtures.js"

const prepared = (draft: ContinuationDraft, id = "action-1"): ContinuationDraft =>
  changeContinuationAction(draft, id, { prompt: `Full prompt for ${id}`, selected: true })

describe("continuation action state", () => {
  test("opening and resume do not request an operation", () => {
    const state = initialContinuationUiState(continuationFixtureDraft(), true)
    expect(state.screen).toBe(ContinuationScreen.Setup)
    expect(state.operation).toBe(ContinuationOperation.Idle)
    expect(state.saveState).toBe(ContinuationSaveState.Saved)
    expect(state.draft.actions).toHaveLength(5)
  })

  test("orders five cards by rank and defaults to distinct worktrees", () => {
    const original = continuationFixtureDraft()
    const draft = {
      ...original,
      assessment: { ...original.assessment!, actions: [...original.assessment!.actions].reverse() },
      actions: original.actions.map(({ placement: _placement, ...edit }) => edit),
    }
    expect(rankedContinuationActions(draft).map(({ rank }) => rank)).toEqual([1, 2, 3, 4, 5])
    const next = withContinuationPlacementDefaults(draft)
    expect(new Set(next.actions.map((edit) => JSON.stringify(edit.placement))).size).toBe(5)
    for (const action of rankedContinuationActions(next)) {
      expect(continuationAction(next, action.id).edit.placement).toEqual(defaultContinuationPlacement(next, action))
    }
    expect(draft.actions[0]).not.toHaveProperty("placement")
  })

  test.each([
    { brief: "Changed brief for the first action only." },
    { profileRef: continuationFixtureProfiles[1].ref },
    { workflowId: "explain" },
  ])("invalidates only the changed action's prompt: %j", (change) => {
    const before = prepared(prepared(continuationFixtureDraft()), "action-2")
    const after = changeContinuationAction(before, "action-1", change)
    expect(continuationAction(after, "action-1").edit).not.toHaveProperty("prompt")
    expect(continuationAction(after, "action-1").edit.status).toBe(ContinuationActionStatus.Draft)
    expect(after.actions.slice(1)).toEqual(before.actions.slice(1))
    expect(continuationAction(after, "action-1").edit.placement).toEqual(continuationAction(before, "action-1").edit.placement)
  })

  test("unchanged input and selection do not erase a prepared prompt", () => {
    const draft = prepared(continuationFixtureDraft())
    const edit = continuationAction(draft, "action-1").edit
    const next = changeContinuationAction(draft, "action-1", { brief: edit.brief, selected: false })
    expect(continuationAction(next, "action-1").edit.prompt).toBe(edit.prompt)
  })

  test("candidate selection is explicit; editing the full prompt retains choices and the chosen origin", () => {
    const initial = continuationFixtureDraft()
    const candidates = ["First", "Second", "Third"].map((title, index) => ({
      id: `choice-${index + 1}`, title, prompt: `Entire ${title.toLowerCase()} workflow prompt`, notes: "Generated and optimized.",
    }))
    const draft = { ...initial, actions: initial.actions.map((edit) => ({ ...edit, candidates })) }
    const chosen = selectContinuationCandidate(draft, "action-1", "choice-2")
    expect(continuationAction(chosen, "action-1").edit).toMatchObject({
      prompt: candidates[1]!.prompt, selectedCandidateId: "choice-2", selected: false, status: ContinuationActionStatus.Prepared,
    })
    expect(describeContinuationPromptOrigin(continuationAction(chosen, "action-1").edit)).toBe("Selected candidate: choice-2")
    const edited = changeContinuationAction(chosen, "action-1", { prompt: "The complete user-edited workflow prompt." })
    expect(continuationAction(edited, "action-1").edit).toMatchObject({
      selectedCandidateId: "choice-2", prompt: "The complete user-edited workflow prompt.", status: ContinuationActionStatus.Prepared,
    })
    expect(continuationAction(edited, "action-1").edit.candidates).toEqual(candidates)
    expect(describeContinuationPromptOrigin(continuationAction(edited, "action-1").edit)).toBe("Edited from candidate: choice-2")
    const copied = changeContinuationAction(chosen, "action-1", { prompt: candidates[0]!.prompt })
    expect(continuationAction(copied, "action-1").edit.selectedCandidateId).toBe("choice-2")
    expect(describeContinuationPromptOrigin(continuationAction(copied, "action-1").edit)).toBe("Edited from candidate: choice-2")
    const rebriefed = changeContinuationAction(chosen, "action-1", { brief: "A different action-specific input." })
    expect(continuationAction(rebriefed, "action-1").edit).not.toHaveProperty("candidates")
    expect(continuationAction(rebriefed, "action-1").edit).not.toHaveProperty("selectedCandidateId")
    expect(continuationAction(rebriefed, "action-2").edit.candidates).toEqual(candidates)
    expect(() => selectContinuationCandidate(draft, "action-1", "invented-choice")).toThrow(/saved prompt candidate/u)
  })

  test("changing branch or base clears the committed-only confirmation", () => {
    const confirmed = changeContinuationAction(continuationFixtureDraft(), "action-1", { uncommittedChangesConfirmed: true })
    const moved = changeContinuationAction(confirmed, "action-1", {
      placement: { kind: ContinuationPlacementKind.NewWorktree, branch: "new/destination", baseRef: "release" },
    })
    expect(continuationAction(confirmed, "action-1").edit.uncommittedChangesConfirmed).toBe(true)
    expect(continuationAction(moved, "action-1").edit.uncommittedChangesConfirmed).toBe(false)
  })

  test("unconfirmed dependencies remain waiting, even after prerequisite delivery", () => {
    const draft = prepared(continuationFixtureDraft(), "action-5")
    const afterDelivery = {
      ...draft,
      actions: draft.actions.map((edit) => edit.actionId === "action-1" ? { ...edit, status: ContinuationActionStatus.Launched } : edit),
    }
    expect(continuationDependenciesWaiting(afterDelivery, "action-5")).toBe(true)
    expect(continuationLaunchPlan(afterDelivery, continuationFixtureProfiles).waiting.map(({ actionId }) => actionId)).toEqual(["action-5"])
    const confirmed = changeContinuationAction(afterDelivery, "action-5", { prerequisitesConfirmed: true })
    expect(continuationLaunchPlan(confirmed, continuationFixtureProfiles).ready.map(({ actionId }) => actionId)).toEqual(["action-5"])
  })

  test("explicit prerequisite confirmation does not schedule a dependency in the same batch", () => {
    const draft = changeContinuationAction(prepared(prepared(continuationFixtureDraft()), "action-5"), "action-5", { prerequisitesConfirmed: true })
    expect(continuationAction(draft, "action-5").edit.status).toBe(ContinuationActionStatus.Waiting)
    expect(continuationLaunchPlan(draft, continuationFixtureProfiles).ready.map(({ actionId }) => actionId)).toEqual(["action-1"])
    const deselected = changeContinuationAction(draft, "action-1", { selected: false })
    expect(continuationAction(deselected, "action-5").edit.status).toBe(ContinuationActionStatus.Waiting)
    expect(continuationAction(deselected, "action-5").edit.prerequisitesConfirmed).toBe(false)
    const confirmed = changeContinuationAction(deselected, "action-5", { prerequisitesConfirmed: true })
    expect(continuationAction(confirmed, "action-5").edit.status).toBe(ContinuationActionStatus.Prepared)
  })

  test.each([ContinuationActionStatus.Unknown, ContinuationActionStatus.Launching, ContinuationActionStatus.Launched])("locks receipt-bearing state %s but allows deselection", (status) => {
    const initial = prepared(continuationFixtureDraft())
    const draft = { ...initial, actions: initial.actions.map((edit) => edit.actionId === "action-1" ? { ...edit, status } : edit) }
    expect(() => changeContinuationAction(draft, "action-1", { brief: "Do it again" })).toThrow(/receipt/u)
    expect(continuationAction(changeContinuationAction(draft, "action-1", { selected: false }), "action-1").edit.status).toBe(status)
    const label = continuationStatusLabel(draft, continuationAction(draft, "action-1").edit)
    expect(label).toContain(status === ContinuationActionStatus.Launched ? "work not verified" : "NEEDS RECONCILIATION")
  })
})

describe("conservative continuation launch plan", () => {
  test.each([
    { kind: ContinuationPlacementKind.NewTab },
    { kind: ContinuationPlacementKind.CurrentWorkspacePane, direction: "right" as const },
    { kind: ContinuationPlacementKind.ExistingWorktree, path: "/fixture/shared" },
  ] as const)("requires explicit shared writable consent even for model-reported read-only work: %j", (placement) => {
    const draft = changeContinuationAction(prepared(continuationFixtureDraft()), "action-1", { placement })
    expect(continuationLaunchPlan(draft, continuationFixtureProfiles).blocked).toEqual([expect.stringContaining("shared writable")])
    const confirmed = changeContinuationAction(draft, "action-1", { sharedWriteConfirmed: true })
    expect(continuationLaunchPlan(confirmed, continuationFixtureProfiles).ready).toHaveLength(1)
    const changed = changeContinuationAction(confirmed, "action-1", {
      placement: { kind: ContinuationPlacementKind.ExistingWorktree, path: "/fixture/other-destination" },
    })
    expect(continuationAction(changed, "action-1").edit.sharedWriteConfirmed).toBe(false)
  })

  test("rejects colliding worktree branches", () => {
    const draft = prepared(prepared(continuationFixtureDraft()), "action-2")
    const placement = continuationAction(draft, "action-1").edit.placement!
    const next = changeContinuationAction(draft, "action-2", { placement })
    expect(continuationLaunchPlan(next, continuationFixtureProfiles).blocked).toEqual([expect.stringContaining("separate worktree branch")])
  })

  test("requires catalog profile/workflow options", () => {
    const changed = changeContinuationAction(continuationFixtureDraft(), "action-1", { profileRef: "untrusted/model-choice" })
    const result = continuationLaunchPlan(prepared(changed), continuationFixtureProfiles)
    expect(result.ready).toHaveLength(0)
    expect(result.blocked).toEqual([expect.stringContaining("known profile and workflow")])
  })

  test("does not send unprepared or uncertain actions", () => {
    const base = changeContinuationAction(continuationFixtureDraft(), "action-1", { selected: true })
    expect(continuationLaunchPlan(base, continuationFixtureProfiles).blocked).toEqual([expect.stringContaining("full outgoing prompt")])
    const uncertain = { ...prepared(base), actions: prepared(base).actions.map((edit) => edit.actionId === "action-1" ? { ...edit, status: ContinuationActionStatus.Unknown } : edit) }
    expect(continuationLaunchPlan(uncertain, continuationFixtureProfiles).blocked).toEqual([expect.stringContaining("needs reconciliation")])
  })

  test("waiting actions need no generated prompt until explicitly released", () => {
    const draft = changeContinuationAction(continuationFixtureDraft(), "action-5", { selected: true })
    expect(continuationLaunchPlan(draft, continuationFixtureProfiles)).toMatchObject({ ready: [], waiting: [expect.objectContaining({ actionId: "action-5" })], blocked: [] })
  })

  test("describes the actual destination and conservative access", () => {
    expect(describeContinuationPlacement({ kind: ContinuationPlacementKind.NewWorktree, branch: "next/example", baseRef: "release" }, "/source")).toContain("branch next/example, base release")
    expect(describeContinuationPlacement({ kind: ContinuationPlacementKind.NewTab }, "/source")).toBe("New tab: shared writable /source")
    expect(describeContinuationPlacement({ kind: ContinuationPlacementKind.CurrentWorkspacePane, direction: "down" }, "/source")).toContain("new down pane; shared writable /source")
    expect(describeContinuationPlacement({ kind: ContinuationPlacementKind.ExistingWorktree, path: "/other" }, "/source")).toContain("/other")
  })
})

describe("bounded keyboard editor", () => {
  const editor = (value: string, cursor = [...value].length, field = ContinuationField.Brief): ContinuationEditor =>
    ({ field, value, cursor, returnScreen: ContinuationScreen.Action })

  test("edits Unicode code points without cutting surrogate pairs", () => {
    const start = editor("A🦊Z", 2)
    expect(changeContinuationEditor(start, ContinuationTextCommand.Backspace)).toMatchObject({ value: "AZ", cursor: 1 })
    expect(changeContinuationEditor(start, ContinuationTextCommand.Delete)).toMatchObject({ value: "A🦊", cursor: 2 })
    expect(changeContinuationEditor(start, ContinuationTextCommand.Insert, "é")).toMatchObject({ value: "A🦊éZ", cursor: 3 })
  })

  test("normalizes pasted controls without treating paste as shortcuts", () => {
    expect(changeContinuationEditor(editor(""), ContinuationTextCommand.Insert, "q\r\nx\u0000")).toMatchObject({ value: "q\nx" })
    expect(changeContinuationEditor(editor("", 0, ContinuationField.Model), ContinuationTextCommand.Insert, "model\r\nname")).toMatchObject({ value: "model name" })
  })

  test("rejects oversized paste instead of silently truncating", () => {
    const before = editor("model", 5, ContinuationField.Model)
    expect(() => changeContinuationEditor(before, ContinuationTextCommand.Insert, "x".repeat(continuationFieldLimit[ContinuationField.Model]))).toThrow(/Nothing was truncated/u)
    expect(before.value).toBe("model")
  })

  test.each([ContinuationField.Brief, ContinuationField.Prompt])("matches the core Unicode storage boundary for %s while keeping code-point cursor movement", (field) => {
    const maximum = continuationFieldLimit[field]
    const value = "😀".repeat(maximum / 2 - 1) + "x"
    const before = editor(value, [...value].length, field)
    const atLimit = changeContinuationEditor(before, ContinuationTextCommand.Insert, "y")
    expect(atLimit.value.length).toBe(maximum)
    expect(atLimit.cursor).toBe([...value].length + 1)
    expect(() => changeContinuationEditor(before, ContinuationTextCommand.Insert, "😀")).toThrow(/Nothing was truncated/u)
    expect(() => changeContinuationEditor(atLimit, ContinuationTextCommand.Insert, "z")).toThrow(/UTF-16 units/u)
    expect(before.value).toBe(value)
  })

  test("handles document and line boundaries, including cursor zero", () => {
    const start = editor("ab\ncde\nf", 0)
    expect(changeContinuationEditor(start, ContinuationTextCommand.Home).cursor).toBe(0)
    expect(changeContinuationEditor(start, ContinuationTextCommand.Up).cursor).toBe(0)
    expect(changeContinuationEditor(start, ContinuationTextCommand.Down).cursor).toBe(3)
    expect(changeContinuationEditor(editor(start.value, 5), ContinuationTextCommand.Up).cursor).toBe(2)
    expect(changeContinuationEditor(editor(start.value, 5), ContinuationTextCommand.Down).cursor).toBe(8)
    expect(changeContinuationEditor(editor(start.value, 5), ContinuationTextCommand.Home).cursor).toBe(3)
    expect(changeContinuationEditor(editor(start.value, 5), ContinuationTextCommand.End).cursor).toBe(6)
    expect(changeContinuationEditor(start, ContinuationTextCommand.Finish).cursor).toBe(8)
    expect(changeContinuationEditor(start, ContinuationTextCommand.Clear)).toMatchObject({ value: "", cursor: 0 })
  })
})
