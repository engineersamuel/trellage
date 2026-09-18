import { describe, expect, test } from "vitest"
import {
  ContinuationActionStatus,
  ContinuationPlacementKind,
  parseGuideProjectTargetV1,
  type ContinuationDraft,
} from "@trellage/guide-core"
import {
  changeContinuationAction,
  changeContinuationEditor,
  continuationAction,
  continuationActionLocked,
  continuationDependenciesWaiting,
  continuationLaunchPlan,
  continuationStatusLabel,
  continuationProjectTargetProblem,
  continuationPromptEditText,
  continuationRenderedPrompt,
  describeContinuationProjectTarget,
  describeContinuationSubmission,
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
} from "../src/continuation-ui-state.ts"
import { continuationFixtureDraft, continuationFixtureProfiles } from "./helpers/continuation-ui-fixtures.ts"
import { workflowPromptFrame } from "../src/guide-workflow-prompt.ts"
import {
  firstmateFixtureDraft,
  firstmateOriginalIntent,
  firstmatePreparedPrompt,
  firstmateProfiles,
  firstmateProjectC,
  firstmateReceipt,
  firstmateRequest,
  preparedFirstmateFixtureDraft,
} from "./helpers/continuation-firstmate-fixtures.ts"

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

  describe("confirmed Firstmate continuation context", () => {
    test("old Firstmate preparations remain visible but cannot be submitted or selected without a confirmed target", () => {
      const prepared = preparedFirstmateFixtureDraft()
      const old = {
        ...prepared,
        actions: prepared.actions.map(({ originalIntent: _intent, projectTarget: _target, projectTargetConfirmed: _confirmed, ...edit }) => edit),
      }
      expect(continuationLaunchPlan(old, firstmateProfiles).blocked).toEqual([expect.stringContaining("confirm a project target")])
      expect(() => selectContinuationCandidate(old, "action-1", "candidate-1", firstmateProfiles)).toThrow(/confirm a project target/u)
      expect(() => continuationPromptEditText(old, "action-1", firstmateProfiles)).toThrow(/confirm a project target/u)
      expect(old.actions[0]?.prompt).toBe(prepared.actions[0]?.prompt)
    })

    test("proposed targets are not consent, and fleet scope is unavailable to project workflows", () => {
      const initial = firstmateFixtureDraft()
      const proposed = changeContinuationAction(initial, "action-1", { projectTarget: firstmateProjectC(), projectTargetConfirmed: false })
      expect(continuationProjectTargetProblem(proposed, "action-1", firstmateProfiles)).toContain("confirm a project target")
      const confirmed = changeContinuationAction(proposed, "action-1", { projectTargetConfirmed: true })
      expect(continuationProjectTargetProblem(confirmed, "action-1", firstmateProfiles)).toBeNull()
      const missingProject = changeContinuationAction(confirmed, "action-1", { projectTarget: null, projectTargetConfirmed: true })
      expect(continuationProjectTargetProblem(missingProject, "action-1", firstmateProfiles)).toContain("requires a confirmed project")
      const fleet = changeContinuationAction(missingProject, "action-1", { workflowId: "review-fleet-status" })
      expect(fleet.actions[0]?.projectTargetConfirmed).toBe(false)
      const fleetConfirmed = changeContinuationAction(fleet, "action-1", { projectTargetConfirmed: true })
      expect(continuationProjectTargetProblem(fleetConfirmed, "action-1", firstmateProfiles)).toBeNull()
    })

    test.each([
      { projectTarget: parseGuideProjectTargetV1({
        ...firstmateProjectC(), source: { kind: "local", location: "/fixture/project-d" }, entryWorktree: "/fixture/project-d",
      }) },
      { profileRef: "native:fmx/pstack-workers" },
      { workflowId: "review-fleet-status" },
      { projectTargetConfirmed: false },
    ])("invalidates unsubmitted choices, payloads and all approvals when context changes: %j", (change) => {
      const prepared = preparedFirstmateFixtureDraft()
      const initial = {
        ...prepared,
        actions: prepared.actions.map((edit, index) => index > 0 ? edit : {
          ...edit, firstmateSubmission: { request: firstmateRequest(prepared), receipt: null },
        }),
      }
      const changed = changeContinuationAction(initial, "action-1", change)
      expect(changed.actions[0]).toMatchObject({
        status: ContinuationActionStatus.Draft, originalIntent: firstmateOriginalIntent,
        prerequisitesConfirmed: false, sharedWriteConfirmed: false, uncommittedChangesConfirmed: false,
        projectTargetConfirmed: false,
      })
      expect(changed.actions[0]).not.toHaveProperty("prompt")
      expect(changed.actions[0]).not.toHaveProperty("candidates")
      expect(changed.actions[0]).not.toHaveProperty("selectedCandidateId")
      expect(changed.actions[0]).not.toHaveProperty("firstmateSubmission")
      expect(changed.actions.slice(1)).toEqual(initial.actions.slice(1))
    })

    test("reinspection requires fresh confirmation, including when the inspected root and revision are unchanged", () => {
      const prepared = preparedFirstmateFixtureDraft()
      const proposed = changeContinuationAction(prepared, "action-1", { projectTarget: firstmateProjectC() })
      expect(proposed.actions[0]?.projectTargetConfirmed).toBe(false)
      expect(proposed.actions[0]?.prompt).toBeUndefined()
      const confirmed = changeContinuationAction(proposed, "action-1", { projectTargetConfirmed: true })
      expect(confirmed.actions[0]?.prompt).toBeUndefined()
      expect(() => selectContinuationCandidate(confirmed, "action-1", "candidate-2", firstmateProfiles)).toThrow(/saved prompt candidate/u)
    })

    test("a source-A destination edit cannot replace confirmed project C or its exact original intent", () => {
      const prepared = preparedFirstmateFixtureDraft()
      const moved = changeContinuationAction(prepared, "action-1", {
        placement: { kind: ContinuationPlacementKind.ExistingWorktree, path: "/fixture/source-a/other-pane" },
      })
      expect(moved.snapshot.source.cwd).toBe("/fixture/source-a")
      expect(moved.actions[0]).toMatchObject({
        originalIntent: firstmateOriginalIntent,
        projectTarget: firstmateProjectC(),
        projectTargetConfirmed: true,
        prompt: prepared.actions[0]?.prompt,
      })
      const target = describeContinuationProjectTarget(moved.actions[0]!)
      expect(target).toContain("Exact base revision: " + "c".repeat(40))
      expect(target).toContain("Dirty changes: excluded. No working files are copied.")
      expect(target).toContain("Source: local /fixture/project-c")
    })

    test("only an explicit brief edit establishes new human intent", () => {
      const original = preparedFirstmateFixtureDraft()
      const chosen = selectContinuationCandidate(original, "action-1", "candidate-1", firstmateProfiles)
      expect(chosen.actions[0]?.originalIntent).toBe(firstmateOriginalIntent)
      const rendered = continuationRenderedPrompt(chosen, "action-1", "Inspect the error paths only.", firstmateProfiles)
      const edited = changeContinuationAction(chosen, "action-1", { prompt: rendered })
      expect(edited.actions[0]?.originalIntent).toBe(firstmateOriginalIntent)
      expect(edited.actions[0]?.selectedCandidateId).toBe("candidate-1")
      const humanBrief = "  New human scope.\r\nDo not deploy. 😀  "
      const rebriefed = changeContinuationAction(edited, "action-1", { brief: humanBrief })
      expect(rebriefed.actions[0]?.brief).toBe(humanBrief)
      expect(rebriefed.actions[0]?.originalIntent).toBe(humanBrief)
      expect(rebriefed.actions[0]?.projectTarget).toEqual(firstmateProjectC())
      expect(rebriefed.actions[0]?.prompt).toBeUndefined()
    })
  })

  describe("fixed-frame continuation prompt editing", () => {
    test("exposes only the body and restores the confirmed target/workflow frame once", () => {
      const draft = preparedFirstmateFixtureDraft()
      expect(continuationPromptEditText(draft, "action-1", firstmateProfiles)).toBe("Trace failure paths.")
      const body = "  Inspect committed evidence.\nKeep the original scope. 😀  "
      const rendered = continuationRenderedPrompt(draft, "action-1", body, firstmateProfiles)
      const frame = workflowPromptFrame(firstmatePreparedPrompt(draft).workflow)
      expect(rendered).toBe(`${frame.beforeBody}${body}${frame.afterBody}`)
      expect(continuationRenderedPrompt(draft, "action-1", rendered, firstmateProfiles)).toBe(rendered)
      expect(rendered).toContain('"location": "/fixture/project-c"')
      expect(rendered).toContain('"workflowId": "review-project"')
      expect(rendered).not.toContain("/fixture/source-a")
      expect(rendered).not.toContain(firstmateOriginalIntent)
      expect(() => continuationRenderedPrompt(draft, "action-1", `${frame.beforeBody}${rendered}${frame.afterBody}`, firstmateProfiles))
        .toThrow(/repeated fixed frame/u)
    })

    test("checks the 8000-character final frame boundary while retaining a 60000-character original intent", () => {
      const prepared = preparedFirstmateFixtureDraft()
      const originalIntent = ` ${"😀".repeat(29_999)} `
      const draft = { ...prepared, actions: prepared.actions.map((edit, index) => index > 0 ? edit : { ...edit, originalIntent }) }
      const frame = workflowPromptFrame(firstmatePreparedPrompt(draft).workflow)
      const maximumBody = 8000 - frame.beforeBody.length - frame.afterBody.length
      const rendered = continuationRenderedPrompt(draft, "action-1", "x".repeat(maximumBody), firstmateProfiles)
      expect(rendered).toHaveLength(8000)
      expect(draft.actions[0]?.originalIntent).toBe(originalIntent)
      expect(() => continuationRenderedPrompt(draft, "action-1", "x".repeat(maximumBody + 1), firstmateProfiles)).toThrow(/8000/u)
    })

    test("rejects an outgoing candidate from an obsolete target frame rather than nesting it", () => {
      const prepared = preparedFirstmateFixtureDraft()
      const changed = {
        ...prepared,
        actions: prepared.actions.map((edit, index) => index > 0 ? edit : {
          ...edit,
          projectTarget: parseGuideProjectTargetV1({
            ...firstmateProjectC(), source: { kind: "local", location: "/fixture/project-d" }, entryWorktree: "/fixture/project-d",
          }),
        }),
      }
      expect(() => selectContinuationCandidate(changed, "action-1", "candidate-2", firstmateProfiles)).toThrow(/repeated fixed frame|does not match/u)
      expect(() => continuationRenderedPrompt(changed, "action-1", prepared.actions[0]!.prompt!, firstmateProfiles))
        .toThrow(/repeated fixed frame/u)
      expect(continuationLaunchPlan(changed, firstmateProfiles).blocked).toEqual([expect.stringContaining("fixed frame")])
    })

    test("leaves generic profile prompt editing unchanged", () => {
      const draft = prepared(continuationFixtureDraft())
      const prompt = continuationAction(draft, "action-1").edit.prompt!
      expect(continuationPromptEditText(draft, "action-1", continuationFixtureProfiles)).toBe(prompt)
      expect(continuationRenderedPrompt(draft, "action-1", "An entire authored prompt.", continuationFixtureProfiles)).toBe("An entire authored prompt.")
    })

    test("bounds keyboard paste by available body space without truncation", () => {
      const editor: ContinuationEditor = {
        field: ContinuationField.Prompt, value: "123", cursor: 3, returnScreen: ContinuationScreen.Prompt, maximumLength: 4,
      }
      expect(changeContinuationEditor(editor, ContinuationTextCommand.Insert, "4").value).toBe("1234")
      expect(() => changeContinuationEditor(editor, ContinuationTextCommand.Insert, "45")).toThrow(/Nothing was truncated/u)
      expect(editor.value).toBe("123")
    })

    test("does not accept an empty specification merely because its fixed frame is non-empty", () => {
      expect(() => continuationRenderedPrompt(preparedFirstmateFixtureDraft(), "action-1", " \n ", firstmateProfiles))
        .toThrow(/must not be empty/u)
    })
  })

  describe("Firstmate submission state safety", () => {
    test.each(["default", "pstack-workers"] as const)("requires explicit %s action approval after preparing a specification", (profile) => {
      const draft = preparedFirstmateFixtureDraft(profile)
      expect(continuationLaunchPlan(draft, firstmateProfiles).blocked).toEqual([expect.stringContaining("Explicitly confirm Start fleet")])
      const actions = draft.actions.map((edit, index) => {
        if (index > 0) return edit
        const { placement: _placement, ...rest } = edit
        return {
          ...rest, firstmateAction: "submit" as const,
          firstmateSubmission: { request: firstmateRequest(draft), receipt: null },
        }
      })
      const approved = withContinuationPlacementDefaults({ ...draft, actions })
      expect(approved.actions[0]).not.toHaveProperty("placement")
      expect(continuationLaunchPlan(approved, firstmateProfiles).ready.map(({ actionId }) => actionId)).toEqual(["action-1"])
    })

    test("shows startup failure separately from a saved request and note ID", () => {
      const draft = preparedFirstmateFixtureDraft()
      const request = firstmateRequest(draft)
      const edit = {
        ...draft.actions[0]!,
        status: ContinuationActionStatus.Accepted,
        firstmateAction: "start" as const,
        firstmateSubmission: { request, receipt: firstmateReceipt(request) },
        firstmateDiagnostic: "Supervisor startup failed: the selected pane was unavailable.",
      }
      const lines = describeContinuationSubmission(edit)
      expect(lines).toContain(`Firstmate request: ${request.requestId}`)
      expect(lines).toContain("Receipt: saved; note captain-note-1")
      expect(lines).toContain("Confirmed action: Start fleet")
      expect(lines).toContain("Delivery diagnostic: Supervisor startup failed: the selected pane was unavailable.")
      expect(continuationStatusLabel(draft, edit)).toBe("ACCEPTED - note saved; work not verified")
    })

    test.each([
      ContinuationActionStatus.Submitting,
      ContinuationActionStatus.Accepted,
      ContinuationActionStatus.SubmissionUnknown,
    ])("keeps request content immutable in %s and permits only selection changes", (status) => {
      const prepared = preparedFirstmateFixtureDraft()
      const request = firstmateRequest(prepared)
      const receipt = status === ContinuationActionStatus.Accepted ? firstmateReceipt(request, "handled") : null
      const draft = {
        ...prepared,
        actions: prepared.actions.map((edit, index) => index > 0 ? edit : { ...edit, status, firstmateSubmission: { request, receipt } }),
      }
      expect(continuationActionLocked(draft.actions[0]!)).toBe(true)
      for (const change of [
        { brief: "Changed intent" }, { prompt: "Changed specification" }, { projectTarget: null },
        { projectTargetConfirmed: false }, { workflowId: "review-fleet-status" },
      ]) expect(() => changeContinuationAction(draft, "action-1", change)).toThrow(/cannot be edited or resent/u)
      const deselected = changeContinuationAction(draft, "action-1", { selected: false })
      expect(deselected.actions[0]?.firstmateSubmission).toEqual({ request, receipt })
      const plan = continuationLaunchPlan(draft, firstmateProfiles)
      expect(plan.ready).toHaveLength(0)
      const label = continuationStatusLabel(draft, draft.actions[0]!)
      if (status === ContinuationActionStatus.Accepted) {
        expect(label).toBe("ACCEPTED - note saved; work not verified")
        expect(plan.blocked).toHaveLength(0)
        expect(describeContinuationSubmission(draft.actions[0]!)).toContain("Announcement: failed")
      } else expect(plan.blocked).toEqual([expect.stringContaining("needs reconciliation")])
    })

    test("shows waiting for start from a saved receipt snapshot even when its wake was sent", () => {
      const draft = preparedFirstmateFixtureDraft()
      const request = firstmateRequest(draft)
      const receipt = {
        ...firstmateReceipt(request), announcement: "sent" as const, supervisorState: "stopped" as const, error: null,
      }
      const edit = {
        ...draft.actions[0]!, status: ContinuationActionStatus.Accepted,
        firstmateSubmission: { request, receipt },
        firstmateDiagnostic: "Latest observed fleet status: supervisor running.",
      }
      const lines = describeContinuationSubmission(edit)
      expect(lines).toContain("Announcement: sent")
      expect(lines).toContain("Fleet at receipt: waiting for supervisor start (receipt snapshot).")
      expect(lines).toContain("Delivery diagnostic: Latest observed fleet status: supervisor running.")
      expect(continuationStatusLabel(draft, edit)).toBe("ACCEPTED - note saved; work not verified")
    })

    test("acceptance does not release a dependent action without verified prerequisite results", () => {
      const draft = preparedFirstmateFixtureDraft()
      const request = firstmateRequest(draft)
      const accepted = {
        ...draft,
        actions: draft.actions.map((edit, index) => index > 0 ? edit : {
          ...edit, status: ContinuationActionStatus.Accepted, firstmateSubmission: { request, receipt: firstmateReceipt(request) },
        }),
      }
      const dependent = changeContinuationAction(accepted, "action-5", { selected: true })
      expect(continuationDependenciesWaiting(dependent, "action-5")).toBe(true)
      expect(continuationLaunchPlan(dependent, firstmateProfiles).waiting.map(({ actionId }) => actionId)).toEqual(["action-5"])
    })

    test("a prepared unsent payload is invalidated by a direct prompt edit without changing original intent", () => {
      const draft = preparedFirstmateFixtureDraft()
      const unsent = {
        ...draft,
        actions: draft.actions.map((edit, index) => index > 0 ? edit : {
          ...edit, firstmateAction: "submit" as const,
          firstmateSubmission: { request: firstmateRequest(draft), receipt: null },
        }),
      }
      const edited = changeContinuationAction(unsent, "action-1", {
        prompt: continuationRenderedPrompt(unsent, "action-1", "Inspect only the selected revision.", firstmateProfiles),
      })
      expect(edited.actions[0]).not.toHaveProperty("firstmateSubmission")
      expect(edited.actions[0]).not.toHaveProperty("firstmateAction")
      expect(edited.actions[0]?.originalIntent).toBe(firstmateOriginalIntent)
      expect(edited.actions[0]?.projectTarget).toEqual(firstmateProjectC())
    })
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
