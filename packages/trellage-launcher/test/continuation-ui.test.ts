import { describe, expect, test, vi } from "vitest"
import {
  ContinuationActionStatus,
  ContinuationPlacementKind,
  type ContinuationDraft,
} from "@trellage/guide-core"
import { ContinuationUiController } from "../src/continuation-ui.tsx"
import { RestrictedGuideModelError } from "../src/copilot-guide-provider.ts"
import {
  continuationAction,
  ContinuationField,
  ContinuationOperation,
  ContinuationSaveState,
  ContinuationScreen,
  ContinuationTextCommand,
} from "../src/continuation-ui-state.ts"
import {
  continuationFixtureDraft,
  createContinuationServiceFixture,
  ContinuationFixtureEventKind,
} from "./helpers/continuation-ui-fixtures.ts"

const deferred = <Value>() => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

const setup = (assessed = true) => {
  const initial = continuationFixtureDraft(assessed)
  const fixture = createContinuationServiceFixture(initial)
  const onExit = vi.fn()
  const controller = new ContinuationUiController(fixture.services, initial, true, onExit)
  return { fixture, controller, onExit }
}

const ready = async () => {
  const context = setup()
  context.controller.resume()
  await context.controller.prepare("action-1")
  await context.controller.changeAction("action-1", { selected: true })
  return context
}

describe("explicit continuation effects", () => {
  test("opening, navigating, resuming and closing make zero inference calls", async () => {
    const { controller, fixture, onExit } = setup()
    expect(fixture.events).toEqual([])
    controller.resume()
    controller.view({ screen: ContinuationScreen.Action, actionIndex: 2 })
    controller.view({ screen: ContinuationScreen.Overview })
    await controller.close()
    expect(fixture.events).toEqual([])
    expect(onExit).toHaveBeenCalledWith(0)
  })

  test("saves model and effort edits before explicit analysis", async () => {
    const { controller, fixture } = setup(false)
    controller.edit(ContinuationField.Model)
    controller.text(ContinuationTextCommand.Clear)
    controller.text(ContinuationTextCommand.Insert, "gpt-5.5")
    expect(await controller.commitEditor()).toBe(true)
    controller.edit(ContinuationField.Effort)
    controller.text(ContinuationTextCommand.Clear)
    controller.text(ContinuationTextCommand.Insert, "xhigh")
    expect(await controller.commitEditor()).toBe(true)
    expect(fixture.events.map(({ kind }) => kind)).toEqual([ContinuationFixtureEventKind.Save, ContinuationFixtureEventKind.Save])
    await controller.analyze()
    const analysis = fixture.events.find(({ kind }) => kind === ContinuationFixtureEventKind.Analyze)
    expect(analysis?.draft).toMatchObject({ model: "gpt-5.5", effort: "xhigh", revision: 3 })
    expect(controller.getSnapshot().screen).toBe(ContinuationScreen.Overview)
    expect(controller.getSnapshot().draft.actions).toHaveLength(5)
    expect(controller.getSnapshot().draft.actions.every((edit) => !edit.selected)).toBe(true)
    expect(fixture.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
  })

  test("does not analyze when the call plan fails or when an assessment already exists", async () => {
    const fresh = setup(false)
    fresh.fixture.services.estimate = () => { throw new Error("Input budget exceeded.") }
    await fresh.controller.analyze()
    expect(fresh.controller.getSnapshot().error).toContain("Input budget exceeded")
    expect(fresh.fixture.events).toEqual([])
    const saved = setup()
    await saved.controller.analyze()
    expect(saved.controller.getSnapshot().error).toContain("assessment is saved")
    expect(saved.fixture.events).toEqual([])
  })

  test("keeps independent briefs, prompts, selections and destinations across views", async () => {
    const { controller, fixture } = setup()
    await controller.changeAction("action-1", { brief: "Review the exact boundary changes.", selected: true })
    await controller.prepare("action-1")
    const first = continuationAction(controller.getSnapshot().draft, "action-1").edit
    controller.view({ actionIndex: 1, screen: ContinuationScreen.Action })
    await controller.changeAction("action-2", { brief: "Draw only the data flow.", selected: true })
    await controller.prepare("action-2")
    await controller.changeAction("action-2", { placement: { kind: ContinuationPlacementKind.NewTab } })
    await controller.changeAction("action-2", { sharedWriteConfirmed: true })
    controller.view({ actionIndex: 0, screen: ContinuationScreen.Prompt })
    expect(continuationAction(controller.getSnapshot().draft, "action-1").edit).toEqual(first)
    expect(continuationAction(fixture.saved(), "action-2").edit).toMatchObject({
      brief: "Draw only the data flow.",
      prompt: expect.stringContaining("Draw only the data flow."),
      placement: { kind: ContinuationPlacementKind.NewTab },
      sharedWriteConfirmed: true,
    })
    expect(fixture.events.filter(({ kind }) => kind === ContinuationFixtureEventKind.Prepare).map(({ actionId }) => actionId)).toEqual(["action-1", "action-2"])
  })

  test("preparation stores all guide choices and requires explicit prompt selection", async () => {
    const initial = continuationFixtureDraft()
    const fixture = createContinuationServiceFixture(initial, () => undefined, { candidates: true })
    const controller = new ContinuationUiController(fixture.services, initial)
    await controller.prepare("action-1")
    expect(controller.getSnapshot().screen).toBe(ContinuationScreen.Candidates)
    expect(controller.getSnapshot().draft.actions[0]?.candidates).toHaveLength(3)
    expect(controller.getSnapshot().draft.actions[0]?.prompt).toBeUndefined()
    expect(controller.getSnapshot().draft.actions[0]?.selected).toBe(false)
    expect(fixture.saved().actions[0]?.status).toBe(ContinuationActionStatus.Draft)
    expect(fixture.saved().actions[0]?.selectedCandidateId).toBeUndefined()
    const prepared = fixture.saved().actions[0]
    controller.view({ candidateIndex: 1 })
    expect(controller.getSnapshot().draft.actions[0]).toMatchObject({ status: ContinuationActionStatus.Draft })
    expect(controller.getSnapshot().draft.actions[0]?.selectedCandidateId).toBeUndefined()
    expect(controller.getSnapshot().draft.actions[0]?.prompt).toBeUndefined()
    expect(fixture.events.filter(({ kind }) => kind === ContinuationFixtureEventKind.Save)).toHaveLength(0)
    controller.edit(ContinuationField.Prompt)
    expect(controller.getSnapshot().error).toContain("Prepare and choose a prompt before editing")
    expect(controller.getSnapshot().editor).toBeNull()
    expect(controller.getSnapshot().draft.actions[0]?.prompt).toBeUndefined()
    expect(controller.getSnapshot().draft.actions[0]?.selectedCandidateId).toBeUndefined()
    expect(await controller.chooseCandidate("action-1", "candidate-2")).toBe(true)
    expect(controller.getSnapshot().screen).toBe(ContinuationScreen.Prompt)
    expect(fixture.saved().actions[0]).toMatchObject({
      status: ContinuationActionStatus.Prepared,
      selectedCandidateId: "candidate-2",
      prompt: prepared?.candidates?.[1]?.prompt,
      selected: false,
    })
    expect(fixture.saved().actions[0]?.candidates).toEqual(prepared?.candidates)
    expect(fixture.events.filter(({ kind }) => kind === ContinuationFixtureEventKind.Save)).toHaveLength(1)
    expect(fixture.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
  })

  test("captures latest only after confirmation and preserves the previous edited draft", async () => {
    const { controller, fixture } = setup()
    await controller.changeAction("action-1", { brief: "Keep this old draft edit." })
    const oldId = controller.getSnapshot().draft.id
    await controller.latest()
    expect(fixture.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Latest)).toBe(false)
    controller.view({ screen: ContinuationScreen.LatestConfirmation })
    await controller.latest()
    expect(controller.getSnapshot().screen).toBe(ContinuationScreen.Setup)
    expect(controller.getSnapshot().draft.id).not.toBe(oldId)
    expect(controller.getSnapshot().draft.assessment).toBeUndefined()
    expect(fixture.drafts.get(oldId)?.actions[0]?.brief).toBe("Keep this old draft edit.")
    expect(fixture.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Analyze)).toBe(false)
  })

  test("preserves edited candidate prompts and their chosen origin across views and resume", async () => {
    const initial = continuationFixtureDraft()
    const fixture = createContinuationServiceFixture(initial, () => undefined, { candidates: true })
    const controller = new ContinuationUiController(fixture.services, initial)
    await controller.prepare("action-1")
    await controller.chooseCandidate("action-1", "candidate-2")
    const candidates = fixture.saved().actions[0]?.candidates
    controller.edit(ContinuationField.Prompt)
    controller.text(ContinuationTextCommand.Clear)
    controller.text(ContinuationTextCommand.Insert, "The complete human-edited outgoing prompt.")
    const saved = await controller.commitEditor()
    expect(saved, controller.getSnapshot().error ?? "").toBe(true)
    expect(fixture.saved().actions[0]).toMatchObject({
      status: ContinuationActionStatus.Prepared,
      selectedCandidateId: "candidate-2",
      prompt: "The complete human-edited outgoing prompt.",
      candidates,
    })
    for (const screen of [ContinuationScreen.Candidates, ContinuationScreen.Action, ContinuationScreen.Overview, ContinuationScreen.Prompt]) {
      controller.view({ screen })
      expect(controller.getSnapshot().draft.actions[0]).toEqual(fixture.saved().actions[0])
    }
    const resumed = new ContinuationUiController(fixture.services, fixture.saved(), true)
    resumed.resume()
    resumed.view({ screen: ContinuationScreen.Prompt })
    expect(resumed.getSnapshot().draft.actions[0]).toEqual(fixture.saved().actions[0])
    expect(fixture.events.filter(({ kind }) => kind === ContinuationFixtureEventKind.Prepare)).toHaveLength(1)
    expect(fixture.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Analyze)).toBe(false)
    expect(await resumed.chooseCandidate("action-1", "candidate-3")).toBe(true)
    expect(fixture.saved().actions[0]).toMatchObject({
      status: ContinuationActionStatus.Prepared,
      selectedCandidateId: "candidate-3",
      prompt: candidates?.[2]?.prompt,
      candidates,
    })
    expect(fixture.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
  })

  test("discard needs explicit confirmation and a failed discard does not close", async () => {
    const { controller, fixture, onExit } = setup()
    await controller.discard()
    expect(fixture.events).toEqual([])
    controller.view({ screen: ContinuationScreen.DiscardConfirmation })
    const discard = fixture.services.discard
    fixture.services.discard = vi.fn().mockRejectedValueOnce(new Error("Draft is locked.")).mockImplementation(discard)
    await controller.discard()
    expect(onExit).not.toHaveBeenCalled()
    expect(controller.getSnapshot().error).toContain("Draft is locked")
    await controller.discard()
    expect(onExit).toHaveBeenCalledWith(0)
  })
})

describe("durable editing and failure recovery", () => {
  test("retains failed edits and the original save error; blocks close, inference and reload", async () => {
    const { controller, fixture, onExit } = setup()
    const save = fixture.services.save
    fixture.services.save = vi.fn().mockRejectedValueOnce(new Error("Disk is full.")).mockImplementation(save)
    expect(await controller.changeAction("action-1", { selected: true })).toBe(false)
    expect(controller.getSnapshot().draft.actions[0]?.selected).toBe(true)
    expect(fixture.saved().actions[0]?.selected).toBe(false)
    controller.view({ screen: ContinuationScreen.Action })
    await controller.close()
    await controller.prepare("action-1")
    await controller.reload()
    expect(onExit).not.toHaveBeenCalled()
    expect(controller.getSnapshot().error).toContain("Save failed. Disk is full.")
    expect(controller.getSnapshot().saveState).toBe(ContinuationSaveState.Failed)
    expect(fixture.events).toEqual([])
    expect(await controller.save()).toBe(true)
    expect(fixture.saved().actions[0]?.selected).toBe(true)
    await controller.close()
    expect(onExit).toHaveBeenCalledWith(0)
  })

  test("a failed editor save preserves both full buffer and pending draft", async () => {
    const { controller, fixture } = setup()
    controller.view({ screen: ContinuationScreen.Action })
    controller.edit(ContinuationField.Brief)
    controller.text(ContinuationTextCommand.Clear)
    controller.text(ContinuationTextCommand.Insert, "Exact edited brief\nwith a second line.")
    fixture.services.save = vi.fn().mockRejectedValue(new Error("Revision conflict."))
    await controller.commitEditor()
    expect(controller.getSnapshot().screen).toBe(ContinuationScreen.Editor)
    expect(controller.getSnapshot().editor?.value).toBe("Exact edited brief\nwith a second line.")
    expect(controller.getSnapshot().draft.actions[0]?.brief).toBe("Exact edited brief\nwith a second line.")
    expect(controller.getSnapshot().saveState).toBe(ContinuationSaveState.Failed)
  })

  test("invalid input cannot be closed or silently discarded", async () => {
    const { controller, fixture, onExit } = setup(false)
    controller.edit(ContinuationField.Model)
    controller.text(ContinuationTextCommand.Clear)
    await controller.close()
    expect(onExit).not.toHaveBeenCalled()
    expect(controller.getSnapshot().editor?.value).toBe("")
    expect(controller.getSnapshot().error).toContain("must not be empty")
    expect(fixture.events).toEqual([])
    controller.text(ContinuationTextCommand.Insert, "gpt-5.4")
    await controller.close()
    expect(fixture.saved().model).toBe("gpt-5.4")
    expect(onExit).toHaveBeenCalledWith(0)
  })

  test("serializes saves and defers close until persistence succeeds", async () => {
    const { controller, fixture, onExit } = setup()
    const gate = deferred<ContinuationDraft>()
    fixture.services.save = vi.fn(() => gate.promise)
    const first = controller.changeAction("action-1", { selected: true })
    expect(await controller.changeAction("action-2", { selected: true })).toBe(false)
    await controller.close()
    expect(onExit).not.toHaveBeenCalled()
    gate.resolve(fixture.commit(controller.getSnapshot().draft))
    expect(await first).toBe(true)
    expect(onExit).toHaveBeenCalledWith(0)
    expect(fixture.services.save).toHaveBeenCalledTimes(1)
  })

  test("reloads partial analysis revisions before a user-controlled retry", async () => {
    const { controller, fixture } = setup(false)
    const analyze = fixture.services.analyze
    fixture.services.analyze = async (draft) => {
      fixture.commit({ ...draft, summaries: [{ key: "summary-one", text: "Older synthetic messages.", evidenceIds: ["message-1"] }] })
      throw new Error("Summary chunk two failed.")
    }
    await controller.analyze()
    expect(controller.getSnapshot().draft).toMatchObject({ revision: 2, summaries: [{ key: "summary-one" }] })
    expect(controller.getSnapshot().error).toContain("Summary chunk two failed")
    fixture.services.analyze = analyze
    await controller.analyze()
    expect(controller.getSnapshot().draft.assessment?.actions).toHaveLength(5)
    expect(controller.getSnapshot().draft.summaries).toHaveLength(1)
  })

  test.each([ContinuationOperation.Analyze, ContinuationOperation.Prepare])("waits for required reload before showing %s failure or allowing edits", async (operation) => {
    const { controller, fixture } = setup(operation === ContinuationOperation.Prepare)
    const gate = deferred<void>()
    const reload = fixture.services.reload
    fixture.services.reload = vi.fn(async (draft: ContinuationDraft) => {
      await gate.promise
      return reload(draft)
    })
    const failAfterSave = async (draft: ContinuationDraft) => {
      fixture.commit(draft)
      throw new Error("Operation failed after a durable save.")
    }
    fixture.services.analyze = failAfterSave
    fixture.services.prepare = failAfterSave
    const pending = operation === ContinuationOperation.Analyze ? controller.analyze() : controller.prepare("action-1")
    await vi.waitFor(() => expect(fixture.services.reload).toHaveBeenCalledTimes(1))
    expect(controller.getSnapshot()).toMatchObject({ operation, error: null })
    expect(controller.getSnapshot().draft.revision).toBe(1)
    expect(await controller.changeAction("action-1", { selected: true })).toBe(false)
    gate.resolve(undefined)
    await pending
    expect(controller.getSnapshot()).toMatchObject({
      operation: ContinuationOperation.Idle,
      error: "Operation failed after a durable save.",
      draft: { revision: 2 },
    })
    expect(controller.getSnapshot().draft).toEqual(fixture.saved())
  })
})

describe("real cancellation", () => {
  test.each([
    { operation: ContinuationOperation.Analyze, error: new Error("Summary cache save failed.") },
    { operation: ContinuationOperation.Prepare, error: new RestrictedGuideModelError("cancelled", ["force-stop"]) },
    { operation: ContinuationOperation.Prepare, error: Object.assign(new DOMException("Cleanup result is unknown.", "AbortError"), { cleanupFailures: null }) },
  ])("$operation keeps failure visible after cancellation and durable reload", async ({ operation, error }) => {
    const { controller, fixture, onExit } = setup(operation === ContinuationOperation.Prepare)
    const serviceGate = deferred<ContinuationDraft>()
    const reloadGate = deferred<void>()
    const reload = fixture.services.reload
    let signal: AbortSignal | undefined
    const block = (draft: ContinuationDraft, received: AbortSignal) => {
      signal = received
      fixture.commit(draft)
      return serviceGate.promise
    }
    fixture.services.analyze = block
    fixture.services.prepare = (draft, _actionId, received) => block(draft, received)
    fixture.services.reload = vi.fn(async (draft: ContinuationDraft) => {
      await reloadGate.promise
      return reload(draft)
    })
    const pending = operation === ContinuationOperation.Analyze ? controller.analyze() : controller.prepare("action-1")
    controller.cancel()
    expect(signal?.aborted).toBe(true)
    serviceGate.reject(error)
    await vi.waitFor(() => expect(fixture.services.reload).toHaveBeenCalledTimes(1))
    expect(controller.getSnapshot()).toMatchObject({ operation, error: null, draft: { revision: 1 } })
    reloadGate.resolve(undefined)
    await pending
    expect(controller.getSnapshot()).toMatchObject({
      screen: ContinuationScreen.Overview,
      operation: ContinuationOperation.Idle,
      cancelling: false,
      error: error.message,
      draft: { revision: 2 },
    })
    expect(controller.getSnapshot().notice ?? "").not.toContain("Cancelled")
    expect(controller.getSnapshot().draft).toEqual(fixture.saved())
    expect(onExit).not.toHaveBeenCalled()
  })

  test("keeps the original cancellation-time failure visible when reload also fails", async () => {
    const { controller, fixture } = setup(false)
    const gate = deferred<ContinuationDraft>()
    fixture.services.analyze = () => gate.promise
    fixture.services.reload = async () => { throw new Error("Saved state unavailable.") }
    const pending = controller.analyze()
    controller.cancel()
    gate.reject(new Error("Summary cache save failed."))
    await pending
    expect(controller.getSnapshot().saveState).toBe(ContinuationSaveState.RecoveryRequired)
    expect(controller.getSnapshot().error).toContain("Summary cache save failed.")
    expect(controller.getSnapshot().error).toContain("Cannot reload saved state. Saved state unavailable.")
    expect(controller.getSnapshot().notice).toContain("No automatic resend")
  })

  test("reports an external AbortError as a failure when the user did not cancel", async () => {
    const { controller, fixture } = setup(false)
    fixture.services.analyze = async () => { throw new DOMException("Provider stopped externally.", "AbortError") }
    await controller.analyze()
    expect(controller.getSnapshot().error).toBe("Provider stopped externally.")
    expect(controller.getSnapshot().notice ?? "").not.toContain("Cancelled")
  })

  test.each([ContinuationOperation.Analyze, ContinuationOperation.Prepare])("%s sends AbortSignal and waits for service cleanup before overview", async (operation) => {
    const { controller, fixture, onExit } = setup(operation === ContinuationOperation.Prepare)
    const gate = deferred<ContinuationDraft>()
    let signal: AbortSignal | undefined
    const block = async (_draft: ContinuationDraft, received: AbortSignal, progress: (message: string) => void) => {
      signal = received
      progress("Provider is running; waiting for explicit cancellation.")
      return gate.promise
    }
    fixture.services.analyze = block
    fixture.services.prepare = (draft, _actionId, received, progress) => block(draft, received, progress)
    const operationPromise = operation === ContinuationOperation.Analyze ? controller.analyze() : controller.prepare("action-1")
    expect(controller.getSnapshot().operation).toBe(operation)
    await controller.close()
    expect(signal?.aborted).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({ operation, cancelling: true })
    expect(onExit).not.toHaveBeenCalled()
    gate.reject(operation === ContinuationOperation.Prepare
      ? new RestrictedGuideModelError("cancelled")
      : new DOMException("Owned provider session aborted and closed.", "AbortError"))
    await operationPromise
    expect(controller.getSnapshot()).toMatchObject({ screen: ContinuationScreen.Overview, operation: ContinuationOperation.Idle, cancelling: false })
    expect(controller.getSnapshot().notice).toContain("Cancelled")
    expect(controller.getSnapshot().error).toBeNull()
    expect(fixture.events.map(({ kind }) => kind)).toEqual([ContinuationFixtureEventKind.Reload])
  })

  test("unmount disposal aborts the owned service instead of ignoring its result", async () => {
    const { controller, fixture } = setup(false)
    const gate = deferred<ContinuationDraft>()
    let signal: AbortSignal | undefined
    fixture.services.analyze = (_draft, received) => { signal = received; return gate.promise }
    const pending = controller.analyze()
    controller.dispose()
    expect(signal?.aborted).toBe(true)
    gate.reject(new DOMException("Aborted", "AbortError"))
    await pending
  })

  test("source refresh receives cancellation and does not erase the old draft", async () => {
    const { controller, fixture } = setup()
    const gate = deferred<ContinuationDraft>()
    let signal: AbortSignal | undefined
    fixture.services.latest = (_draft, received) => { signal = received; return gate.promise }
    const id = controller.getSnapshot().draft.id
    controller.view({ screen: ContinuationScreen.LatestConfirmation })
    const pending = controller.latest()
    controller.cancel()
    expect(signal?.aborted).toBe(true)
    gate.reject(new DOMException("Capture stopped.", "AbortError"))
    await pending
    expect(controller.getSnapshot().draft.id).toBe(id)
    expect(controller.getSnapshot().notice).toContain("Cancelled")
  })

  test("keeps source-refresh cleanup failures visible after cancellation", async () => {
    const { controller, fixture } = setup()
    const gate = deferred<ContinuationDraft>()
    let signal: AbortSignal | undefined
    fixture.services.latest = (_draft, received) => { signal = received; return gate.promise }
    controller.view({ screen: ContinuationScreen.LatestConfirmation })
    const pending = controller.latest()
    controller.cancel()
    expect(signal?.aborted).toBe(true)
    gate.reject(new Error("Capture cleanup failed."))
    await pending
    expect(controller.getSnapshot()).toMatchObject({ screen: ContinuationScreen.Overview, error: "Capture cleanup failed." })
    expect(controller.getSnapshot().draft).toEqual(fixture.saved())
    expect(controller.getSnapshot().notice ?? "").not.toContain("Cancelled")
  })
})

describe("explicit source-bound launch", () => {
  test("prepares an edited prompt after a confirmed-failure receipt without resending automatically", async () => {
    const initial = continuationFixtureDraft()
    const failed: ContinuationDraft = {
      ...initial,
      actions: initial.actions.map((edit) => edit.actionId === "action-1" ? {
        ...edit,
        selected: true,
        status: ContinuationActionStatus.Failed,
        prompt: "Original outgoing prompt.",
        launch: {
          attemptId: "40000000-0000-4000-8000-000000000001",
          status: ContinuationActionStatus.Failed,
          message: "The profile was not ready; no prompt was delivered.",
        },
      } : edit),
    }
    const fixture = createContinuationServiceFixture(failed)
    const controller = new ContinuationUiController(fixture.services, failed)
    const saved = await controller.changeAction("action-1", { prompt: "Explicitly edited retry prompt." })
    expect(saved, controller.getSnapshot().error ?? "").toBe(true)
    expect(fixture.saved().actions[0]).toMatchObject({ status: ContinuationActionStatus.Prepared, prompt: "Explicitly edited retry prompt." })
    expect(fixture.saved().actions[0]?.launch).toBeUndefined()
    expect(fixture.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
    await controller.reviewLaunch()
    await controller.confirmLaunch()
    expect(fixture.saved().actions[0]?.launch?.attemptId).not.toBe(failed.actions[0]?.launch?.attemptId)
    expect(fixture.saved().actions[0]?.status).toBe(ContinuationActionStatus.Launched)
  })

  test("queues a confirmed-failure action as waiting without a mismatched old receipt", async () => {
    const initial = continuationFixtureDraft()
    const failed: ContinuationDraft = {
      ...initial,
      actions: initial.actions.map((edit) => edit.actionId === "action-5" ? {
        ...edit,
        status: ContinuationActionStatus.Failed,
        prompt: "Wait for the required review result.",
        launch: {
          attemptId: "40000000-0000-4000-8000-000000000005",
          status: ContinuationActionStatus.Failed,
          message: "The attempt failed before delivery.",
        },
      } : edit),
    }
    const fixture = createContinuationServiceFixture(failed)
    const controller = new ContinuationUiController(fixture.services, failed)
    const saved = await controller.changeAction("action-5", { selected: true })
    expect(saved, controller.getSnapshot().error ?? "").toBe(true)
    expect(fixture.saved().actions[4]).toMatchObject({ status: ContinuationActionStatus.Waiting, selected: true })
    expect(fixture.saved().actions[4]?.launch).toBeUndefined()
    expect(fixture.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
  })

  test("saves first, checks source, and waits for explicit launch", async () => {
    const { controller, fixture } = await ready()
    await controller.reviewLaunch()
    expect(fixture.events.slice(-2).map(({ kind }) => kind)).toEqual([ContinuationFixtureEventKind.Save, ContinuationFixtureEventKind.CheckSource])
    expect(controller.getSnapshot().screen).toBe(ContinuationScreen.LaunchConfirmation)
    expect(fixture.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
    await controller.confirmLaunch()
    expect(fixture.events.slice(-2).map(({ kind }) => kind)).toEqual([ContinuationFixtureEventKind.CheckSource, ContinuationFixtureEventKind.Launch])
    expect(fixture.saved().actions[0]?.status).toBe(ContinuationActionStatus.Launched)
  })

  test("a different source blocks instead of switching panes or sending", async () => {
    const { controller, fixture } = await ready()
    fixture.setSource({ sameSource: false, advanced: true, revision: "different-source" })
    await controller.reviewLaunch()
    expect(controller.getSnapshot().error).toContain("different conversation")
    await controller.confirmLaunch()
    expect(fixture.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
  })

  test("advanced source requires acknowledgement, including advancement during prompt review", async () => {
    const { controller, fixture } = await ready()
    fixture.setSource({ sameSource: true, advanced: true, revision: "source-revision-2" })
    await controller.reviewLaunch()
    await controller.confirmLaunch()
    expect(fixture.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
    controller.view({ acknowledgeAdvanced: true })
    fixture.setSource({ sameSource: true, advanced: true, revision: "source-revision-3" })
    await controller.confirmLaunch()
    expect(controller.getSnapshot().acknowledgeAdvanced).toBe(false)
    expect(controller.getSnapshot().error).toContain("advanced again")
    controller.view({ acknowledgeAdvanced: true })
    await controller.confirmLaunch()
    expect(fixture.events.find(({ kind }) => kind === ContinuationFixtureEventKind.Launch)?.acknowledgeAdvanced).toBe(true)
  })

  test("save failure before review blocks every source check and launch", async () => {
    const { controller, fixture } = await ready()
    fixture.services.save = async () => { throw new Error("Cannot persist prompt.") }
    await controller.reviewLaunch()
    expect(controller.getSnapshot().saveState).toBe(ContinuationSaveState.Failed)
    expect(fixture.events.some(({ kind }) => kind === ContinuationFixtureEventKind.CheckSource || kind === ContinuationFixtureEventKind.Launch)).toBe(false)
  })

  test("cancels a launch-time source check before delivery", async () => {
    const { controller, fixture } = await ready()
    await controller.reviewLaunch()
    let signal: AbortSignal | undefined
    const gate = deferred<{ sameSource: boolean; advanced: boolean; revision: string }>()
    fixture.services.checkSource = (_draft, received) => { signal = received; return gate.promise }
    const pending = controller.confirmLaunch()
    controller.cancel()
    expect(signal?.aborted).toBe(true)
    gate.resolve({ sameSource: true, advanced: false, revision: "source-revision-1" })
    await pending
    expect(controller.getSnapshot().notice).toContain("Cancelled")
    expect(fixture.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
  })

  test.each([ContinuationScreen.Overview, ContinuationScreen.LaunchConfirmation])("keeps source-check cleanup failures visible after cancellation from %s", async (screen) => {
    const { controller, fixture } = await ready()
    if (screen === ContinuationScreen.LaunchConfirmation) await controller.reviewLaunch()
    const gate = deferred<{ sameSource: boolean; advanced: boolean; revision: string }>()
    let signal: AbortSignal | undefined
    fixture.services.checkSource = (_draft, received) => { signal = received; return gate.promise }
    const pending = screen === ContinuationScreen.LaunchConfirmation ? controller.confirmLaunch() : controller.reviewLaunch()
    await vi.waitFor(() => expect(signal).toBeDefined())
    controller.cancel()
    expect(signal?.aborted).toBe(true)
    gate.reject(new Error("Source-check cleanup failed."))
    await pending
    expect(controller.getSnapshot()).toMatchObject({ screen: ContinuationScreen.Overview, error: "Source-check cleanup failed." })
    expect(controller.getSnapshot().draft).toEqual(fixture.saved())
    expect(controller.getSnapshot().notice ?? "").not.toContain("cancelled")
    expect(fixture.events.filter(({ kind }) => kind === ContinuationFixtureEventKind.Reload)).toHaveLength(1)
    expect(fixture.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
  })

  test("unknown launch outcomes remain inspectable and cannot be resent", async () => {
    const { controller, fixture } = await ready()
    fixture.services.launch = async (draft) => fixture.commit({
      ...draft,
      actions: draft.actions.map((edit) => edit.actionId === "action-1" ? {
        ...edit,
        status: ContinuationActionStatus.Unknown,
        launch: { attemptId: "30000000-0000-4000-8000-000000000001", status: ContinuationActionStatus.Unknown, paneId: "already-created-pane", message: "Prompt delivery response was lost." },
      } : edit),
    })
    const launch = vi.spyOn(fixture.services, "launch")
    await controller.reviewLaunch()
    await controller.confirmLaunch()
    expect(controller.getSnapshot().notice).toContain("Needs reconciliation")
    expect(controller.getSnapshot().draft.actions[0]?.launch?.paneId).toBe("already-created-pane")
    await controller.prepare("action-1")
    expect(controller.getSnapshot().error).toContain("receipt inspection")
    await controller.reviewLaunch()
    expect(controller.getSnapshot().error).toContain("needs reconciliation")
    expect(launch).toHaveBeenCalledTimes(1)
  })

  test("blocks duplicate confirm while a launch promise is pending", async () => {
    const { controller, fixture } = await ready()
    const gate = deferred<ContinuationDraft>()
    fixture.services.launch = vi.fn(() => gate.promise)
    await controller.reviewLaunch()
    const pending = controller.confirmLaunch()
    await vi.waitFor(() => expect(controller.getSnapshot().operation).toBe(ContinuationOperation.Launch))
    await controller.confirmLaunch()
    expect(fixture.services.launch).toHaveBeenCalledTimes(1)
    gate.resolve(fixture.commit(controller.getSnapshot().draft))
    await pending
  })

  test("unknown persistence after launch failure requires reload before further work", async () => {
    const { controller, fixture } = await ready()
    fixture.services.launch = async () => { throw new Error("Connection lost after allocation.") }
    fixture.services.reload = async () => { throw new Error("Draft store unavailable.") }
    await controller.reviewLaunch()
    await controller.confirmLaunch()
    expect(controller.getSnapshot()).toMatchObject({ saveState: ContinuationSaveState.RecoveryRequired, operation: ContinuationOperation.Idle })
    expect(controller.getSnapshot().notice).toContain("No automatic resend")
    const before = controller.getSnapshot().draft
    expect(await controller.changeAction("action-2", { selected: true })).toBe(false)
    expect(controller.getSnapshot().draft).toEqual(before)
  })

  test("reloads partial launch results, marks interrupted work unknown, and preserves every receipt", async () => {
    const { controller, fixture } = await ready()
    await controller.prepare("action-2")
    await controller.changeAction("action-2", { selected: true })
    const firstReceipt = {
      attemptId: "30000000-0000-4000-8000-000000000001",
      status: ContinuationActionStatus.Launched,
      paneId: "first-delivered-pane",
      workspaceId: "first-workspace",
      cwd: "/fixture/first",
      message: "Prompt delivered.",
    }
    const secondReceipt = {
      attemptId: "30000000-0000-4000-8000-000000000002",
      status: ContinuationActionStatus.Launching,
      paneId: "second-allocated-pane",
      workspaceId: "second-workspace",
      cwd: "/fixture/second",
      message: "Destination allocated; delivery is not confirmed.",
    }
    fixture.services.launch = vi.fn(async (draft: ContinuationDraft) => {
      fixture.commit({
        ...draft,
        actions: draft.actions.map((edit) => {
          if (edit.actionId === "action-1") return { ...edit, status: ContinuationActionStatus.Launched, launch: firstReceipt }
          if (edit.actionId === "action-2") return { ...edit, status: ContinuationActionStatus.Launching, launch: secondReceipt }
          return edit
        }),
      })
      throw new Error("Launch response was lost.")
    })
    await controller.reviewLaunch()
    const reviewedRevision = controller.getSnapshot().draft.revision
    await controller.confirmLaunch()
    expect(controller.getSnapshot().error).toBe("Launch response was lost.")
    expect(controller.getSnapshot().draft.revision).toBe(reviewedRevision + 2)
    expect(controller.getSnapshot().draft).toEqual(fixture.saved())
    expect(controller.getSnapshot().draft.actions[0]?.launch).toEqual(firstReceipt)
    expect(controller.getSnapshot().draft.actions[1]).toMatchObject({
      status: ContinuationActionStatus.Unknown,
      launch: { ...secondReceipt, status: ContinuationActionStatus.Unknown },
    })
    await controller.reviewLaunch()
    expect(controller.getSnapshot().error).toContain("needs reconciliation")
    expect(fixture.services.launch).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().draft.actions[0]?.launch).toEqual(firstReceipt)
  })
})
