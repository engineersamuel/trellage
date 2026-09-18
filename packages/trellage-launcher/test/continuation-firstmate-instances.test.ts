import { randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ContinuationActionStatus as Status, firstmateInstanceKey, firstmateSubmissionDigest, parseFirstmateSubmissionRequestV1,
  validateContinuationDraft, type ContinuationDraft, type FirstmateInstanceReferenceV1,
  type FirstmateSubmissionReceiptV1, type FirstmateSubmissionRequestV1,
} from "@trellage/guide-core"
import { createContinuationServices } from "../src/continuation-runtime.ts"
import { ContinuationStore } from "../src/continuation-store.ts"
import { changeContinuationAction, continuationActionLocked, continuationNeedsReconciliation, ContinuationScreen } from "../src/continuation-ui-state.ts"
import { ContinuationUiController } from "../src/continuation-ui.tsx"
import { createFirstmateInstanceContext } from "../src/guide-firstmate-instance-selection.ts"
import { initialFirstmateInstanceMenu } from "../src/guide-firstmate-instance-menu.ts"
import { FirstmateJournalError, FirstmateJournalErrorCode } from "../src/guide-firstmate-journal.ts"
import { prepareGuidePrompt } from "../src/guide-context.ts"
import { renderWorkflowBodyCandidate } from "../src/guide-workflow-prompt.ts"
import { firstmateGuide, firstmateMemoryJournal, firstmateReceipt, preparedFirstmateFixtureDraft } from "./helpers/continuation-firstmate-fixtures.ts"
import {
  alpha, beta, instanceCatalog, instanceFleet, instanceOrchestration, InstanceRunner, MemoryCreationPlans,
} from "./helpers/firstmate-instance-flow.ts"

const roots: string[] = []
const testDirectory = path.dirname(fileURLToPath(import.meta.url))
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const draft = (): ContinuationDraft => {
  const original = preparedFirstmateFixtureDraft()
  const template = original.actions[0]!
  const prepared = prepareGuidePrompt(firstmateGuide, "review-project", "native:fmx/default", template.brief, {
    originalIntent: template.originalIntent ?? template.brief, projectTarget: template.projectTarget!, orchestration: instanceOrchestration,
  })
  const candidates = [1, 2, 3].map((index) => ({
    id: `candidate-${index}`,
    ...renderWorkflowBodyCandidate(prepared.workflow, { title: `Review ${index}`, prompt: `Inspect path ${index}.`, notes: "Inspect without changing scope." }),
  }))
  return validateContinuationDraft({
    ...original,
    snapshot: { ...original.snapshot, source: { ...original.snapshot.source, cwd: `${beta.root}/runtime` } },
    assessment: {
      ...original.assessment!,
      actions: original.assessment!.actions.map((action, index) => ({
        ...action, profileRef: index < 2 ? "native:fmx/default" : "native:cdx/default",
        workflowId: index < 2 ? "review-project" : "review", dependsOn: [],
      })),
    },
    actions: original.actions.map((edit, index) => index < 2 ? {
      ...template, actionId: edit.actionId, candidates, prompt: candidates[index]!.prompt,
      selectedCandidateId: candidates[index]!.id,
    } : {
      actionId: edit.actionId, brief: edit.brief, selected: false, status: Status.Draft,
      profileRef: "native:cdx/default", workflowId: "review",
    }),
  })
}
const choice = (descriptor = alpha) => ({
  descriptor, configurationCwd: "/work/alpha",
  context: createFirstmateInstanceContext(descriptor, alpha.worktree.evidence, descriptor === alpha ? "entry-match" : "confirmed-join"),
})
const setup = (initial = draft()) => {
  let saved = initial
  const store = new ContinuationStore(path.resolve("test/.unused-instance-memory-store"))
  vi.spyOn(store, "load").mockImplementation(async () => saved)
  const save = vi.spyOn(store, "save").mockImplementation(async (next, revision) => {
    if (revision !== saved.revision) throw new Error("Concurrent fixture save.")
    saved = validateContinuationDraft({ ...next, revision: revision + 1 })
    return saved
  })
  const runner = new InstanceRunner()
  const journals = new Map([alpha, beta].map((item) => [firstmateInstanceKey(item.reference), firstmateMemoryJournal()]))
  const factory = vi.fn((reference: FirstmateInstanceReferenceV1) => journals.get(firstmateInstanceKey(reference))!.journal)
  const legacy = firstmateMemoryJournal()
  const provider = vi.fn(() => { throw new Error("No model call is allowed in an instance operation.") })
  const create = () => createContinuationServices({
    store, catalog: instanceCatalog(), guideRoot: "/fixture/guides", runner,
    initialDraft: saved, firstmateJournal: legacy.journal, firstmateJournalFor: factory,
    firstmateCreationStore: new MemoryCreationPlans(),
    context: { surface: "popup", workspaceId: "actual-workspace", paneId: "actual-pane", cwd: saved.snapshot.source.cwd, launchOrigin: choice(beta).context },
    sourceClient: {
      check: async () => ({ sameSource: true, advanced: false, revision: saved.snapshot.revision }),
      refresh: async () => { throw new Error("No new conversation was requested.") },
    },
    assessmentProvider: provider, preparationProvider: provider,
  })
  const services = create()
  const bind = async (actionId: string, descriptor = alpha) => services.confirmFirstmateInstance!(saved, actionId, choice(descriptor))
  const approve = async (actionId: string, descriptor = alpha) =>
    services.confirmFirstmateAction!(saved, actionId, "submit", instanceFleet(descriptor).identity!)
  return { services, create, saved: () => saved, store, save, runner, journals, factory, legacy, provider, bind, approve }
}

const legacyDraft = (): ContinuationDraft => {
  const initial = draft()
  const edit = initial.actions[0]!
  const { instances: _instances, preparation: _preparation, ...legacy } = instanceOrchestration
  const prepared = prepareGuidePrompt(firstmateGuide, "review-project", "native:fmx/default", edit.brief, {
    originalIntent: edit.originalIntent!, projectTarget: edit.projectTarget!, orchestration: legacy,
  })
  const candidates = [1, 2, 3].map((index) => ({
    id: `candidate-${index}`,
    ...renderWorkflowBodyCandidate(prepared.workflow, {
      title: `Legacy ${index}`, prompt: `Keep legacy specification ${index} unchanged.`, notes: "Previously reviewed.",
    }),
  }))
  const request = parseFirstmateSubmissionRequestV1({
    schemaVersion: 1, requestId: "00000000-0000-4000-8000-000000000060",
    expectedFleet: { ...instanceFleet(alpha).identity!, home: "/state/firstmate/default/home" },
    originalIntent: edit.originalIntent, generatedSpec: candidates[0]!.prompt,
    workflowId: edit.workflowId, projectTarget: edit.projectTarget,
  })
  return validateContinuationDraft({
    ...initial, actions: initial.actions.map((action, index) => index > 0 ? { ...action, selected: false } : {
      ...action, candidates, selectedCandidateId: "candidate-1", prompt: request.generatedSpec,
      firstmateAction: "submit", firstmateSubmission: { request, receipt: null },
    }),
  })
}

describe("instance-bound continuation delivery", () => {
  it("preserves an explicit destination through actual instance confirmation and clears only its approval", async () => {
    const initial = draft()
    const placement = { kind: "existing-worktree" as const, path: "/work/explicit-d" }
    const f = setup(validateContinuationDraft({
      ...initial, actions: initial.actions.map((edit, index) => index > 0 ? edit : {
        ...edit, placement, sharedWriteConfirmed: true, uncommittedChangesConfirmed: true,
      }),
    }))
    const original = f.saved().actions[0]!
    await f.bind("action-1", alpha)
    await f.approve("action-1", alpha)
    const confirmed = await f.bind("action-1", beta)
    expect(confirmed.actions[0]).toMatchObject({
      placement, sharedWriteConfirmed: false, uncommittedChangesConfirmed: false, prerequisitesConfirmed: false,
      firstmateInstance: beta.reference, prompt: original.prompt, candidates: original.candidates,
      selectedCandidateId: original.selectedCandidateId, originalIntent: original.originalIntent,
      projectTarget: original.projectTarget, projectTargetConfirmed: true,
    })
    expect(confirmed.actions[0]).not.toHaveProperty("firstmateSubmission")
    expect(confirmed.actions[0]).not.toHaveProperty("firstmateAction")
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.runner.submissions).toEqual([])
  })

  it.each([
    { phase: "confirmation", operation: "get", code: FirstmateJournalErrorCode.LockUnavailable },
    { phase: "launch", operation: "get", code: FirstmateJournalErrorCode.IoFailure },
    { phase: "confirmation", operation: "factory", code: FirstmateJournalErrorCode.UnsafePath },
  ])("isolates A's $operation failure during B $phase using the production store", async ({ phase, operation, code }) => {
    const f = await durableFixture(Status.SubmissionUnknown)
    const initial = await f.store.save({
      ...f.saved, actions: f.saved.actions.map((edit, index) => index === 0 ? { ...edit, selected: false } : edit),
    }, f.saved.revision)
    const runner = new InstanceRunner()
    const a = firstmateMemoryJournal()
    const b = firstmateMemoryJournal()
    let blocked = phase === "confirmation"
    const journalError = new FirstmateJournalError(code, `A journal cannot be read (${code}).`)
    vi.spyOn(a.journal, "get").mockImplementation(async (requestId) => {
      if (blocked) throw journalError
      return a.entries.get(requestId)
    })
    const provider = vi.fn(() => { throw new Error("No model calls are allowed.") })
    const services = createContinuationServices({
      store: f.store, catalog: instanceCatalog(), guideRoot: "/fixture/guides", runner, initialDraft: initial,
      firstmateJournalFor: (reference) => {
        if (firstmateInstanceKey(reference) !== firstmateInstanceKey(alpha.reference)) return b.journal
        if (blocked && operation === "factory") throw journalError
        return a.journal
      },
      firstmateCreationStore: new MemoryCreationPlans(),
      context: {
        surface: "popup", workspaceId: "actual-workspace", paneId: "actual-pane",
        cwd: initial.snapshot.source.cwd, launchOrigin: choice(beta).context,
      },
      sourceClient: {
        check: async () => ({ sameSource: true, advanced: false, revision: initial.snapshot.revision }),
        refresh: async () => { throw new Error("No new conversation was requested.") },
      },
      assessmentProvider: provider, preparationProvider: provider,
    })
    const discovery = await services.firstmateInstanceOperation!(
      initial, "action-2", initialFirstmateInstanceMenu("/work/alpha"), new AbortController().signal,
    )
    expect(discovery.type).toBe("resolved")
    let current = await services.confirmFirstmateInstance!(initial, "action-2", choice(beta))
    current = await services.confirmFirstmateAction!(current, "action-2", "submit", instanceFleet(beta).identity!)
    const bRequest = current.actions[1]!.firstmateSubmission!.request
    blocked = true
    current = await services.save(changeContinuationAction(current, "action-2", { prerequisitesConfirmed: true }))
    current = await services.launch(current, false)
    expect(current.actions[0]).toMatchObject({
      selected: false, status: Status.SubmissionUnknown, firstmateInstance: alpha.reference,
      firstmateSubmission: { request: f.request, receipt: null },
      firstmateDiagnostic: expect.stringContaining(journalError.message),
    })
    expect(current.actions[1]).toMatchObject({
      status: Status.Accepted, firstmateInstance: beta.reference, firstmateSubmission: { request: bRequest },
    })
    expect(runner.submissions).toEqual([bRequest])
    expect(a.entries.size).toBe(0)
    expect(b.entries.get(bRequest.requestId)?.status).toBe("accepted")
    expect(runner.calls.filter(({ args }) => ["inventory", "submit", "receipt", "prepare"].includes(args[0]!))
      .every(({ args }) => args[args.indexOf("--instance") + 1] === beta.reference.instanceId)).toBe(true)
    const reloaded = await services.reload(current)
    expect(reloaded.actions[0]?.firstmateSubmission).toEqual(current.actions[0]?.firstmateSubmission)
    expect(reloaded.actions[0]?.firstmateDiagnostic).toContain(journalError.message)
    expect(continuationActionLocked(reloaded.actions[0]!)).toBe(true)
    expect(provider).not.toHaveBeenCalled()
  })

  it("launches old legacy requests unchanged after capability publication, using the flat journal and old vectors", async () => {
    const f = setup(legacyDraft())
    const request = structuredClone(f.saved().actions[0]!.firstmateSubmission!.request)
    f.runner.reply = async ({ args, options }) => {
      expect(args).toEqual([args[0], "default", "--json"])
      if (args[0] === "inventory") return f.runner.ok({
        schemaVersion: 1, launcher: "fmx", profile: "default", readiness: "healthy",
        fleet: { ...instanceFleet(alpha), identity: request.expectedFleet },
      })
      if (args[0] !== "submit") throw new Error("No instance discovery, preparation, or identity migration is allowed.")
      expect(JSON.parse(options?.stdin ?? "null")).toEqual(request)
      return f.runner.ok(firstmateReceipt(request))
    }
    const result = await f.services.launch(f.saved(), false)
    expect(result.actions[0]?.status).toBe(Status.Accepted)
    expect(result.actions[0]?.firstmateSubmission?.request).toEqual(request)
    expect(result.actions[0]).not.toHaveProperty("firstmateInstance")
    expect(f.legacy.entries.get(request.requestId)?.status).toBe("accepted")
    expect(f.factory).not.toHaveBeenCalled()
    expect(f.provider).not.toHaveBeenCalled()
  })

  it("reframes only an explicitly replaced unsubmitted legacy specification and keeps the old request object intact", async () => {
    const f = setup(legacyDraft())
    const original = f.saved().actions[0]!.firstmateSubmission!.request
    const bytes = JSON.stringify(original)
    const changed = await f.bind("action-1", beta)
    expect(JSON.stringify(original)).toBe(bytes)
    expect(changed.actions[0]?.firstmateInstance).toEqual(beta.reference)
    expect(changed.actions[0]).not.toHaveProperty("firstmateSubmission")
    expect(changed.actions[0]?.prompt).toContain("Keep legacy specification 1 unchanged.")
    expect(changed.actions[0]?.prompt).toContain("verified task namespace")
    expect(changed.actions[0]?.prompt).not.toContain('"taskIdPrefix"')
    expect(changed.actions[0]?.candidates).toHaveLength(3)
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.runner.submissions).toEqual([])
  })

  it("requires explicit binding and retains task, target, and source through instance-only changes", async () => {
    const f = setup()
    const before = f.saved()
    await expect(f.approve("action-1")).rejects.toThrow(/confirm.*instance/)
    expect(f.runner.calls).toEqual([])
    const first = await f.bind("action-1")
    expect(first.snapshot).toEqual(before.snapshot)
    expect(first.actions[0]).toMatchObject({
      firstmateInstance: alpha.reference, prompt: before.actions[0]!.prompt,
      candidates: before.actions[0]!.candidates, selectedCandidateId: before.actions[0]!.selectedCandidateId,
      projectTarget: before.actions[0]!.projectTarget, projectTargetConfirmed: true,
      originalIntent: before.actions[0]!.originalIntent,
    })
    await f.approve("action-1")
    const changed = await f.bind("action-1", beta)
    expect(changed.actions[0]).not.toHaveProperty("firstmateSubmission")
    expect(changed.actions[0]).not.toHaveProperty("firstmateAction")
    expect(changed.actions[0]?.placement?.kind).toBe("new-worktree")
    expect(changed.actions[0]?.sharedWriteConfirmed).toBe(false)
    expect(changed.actions[0]?.prompt).toBe(before.actions[0]?.prompt)
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.runner.calls.every(({ args }) => args[0] === "instances" || args[0] === "inventory")).toBe(true)
  })

  it("delivers two default instances to separate journals and keeps immutable request bytes", async () => {
    const f = setup()
    await f.bind("action-1", alpha)
    await f.bind("action-2", beta)
    await f.approve("action-1", alpha)
    await f.approve("action-2", beta)
    const requests = f.saved().actions.slice(0, 2).map(({ firstmateSubmission }) => structuredClone(firstmateSubmission!.request))
    const source = structuredClone(f.saved().snapshot.source)
    const delivered = await f.services.launch(f.saved(), false)
    expect(delivered.actions.slice(0, 2).map(({ status }) => status)).toEqual([Status.Accepted, Status.Accepted])
    expect(delivered.actions.slice(0, 2).map(({ firstmateSubmission }) => firstmateSubmission!.request)).toEqual(requests)
    expect(delivered.snapshot.source).toEqual(source)
    expect([...f.journals.get(firstmateInstanceKey(alpha.reference))!.entries.keys()]).toEqual([requests[0]!.requestId])
    expect([...f.journals.get(firstmateInstanceKey(beta.reference))!.entries.keys()]).toEqual([requests[1]!.requestId])
    expect(f.legacy.entries.size).toBe(0)
    expect(f.runner.submissions).toHaveLength(2)
    expect(f.runner.calls.some(({ args }) => args[0] === "prepare")).toBe(false)
    await expect(f.bind("action-1", beta)).rejects.toThrow(/accepted|uncertain/i)
    expect(f.provider).not.toHaveBeenCalled()
  })

  it("reconciles an unknown named request after restart without fresh control context or another send", async () => {
    const f = setup()
    await f.bind("action-1")
    await f.approve("action-1")
    const request = structuredClone(f.saved().actions[0]!.firstmateSubmission!.request)
    const memory = f.journals.get(firstmateInstanceKey(alpha.reference))!
    await memory.journal.prepare(request)
    await memory.journal.begin(request)
    await f.store.save({
      ...f.saved(), actions: f.saved().actions.map((edit) => edit.actionId === "action-1" ? { ...edit, status: Status.Submitting } : edit),
    }, f.saved().revision)
    f.runner.calls.length = 0
    f.runner.reply = async ({ args, options }) => {
      if (args[0] !== "receipt") throw new Error("Reconciliation must not inspect, repair, bind, or submit.")
      expect(args).toEqual(["receipt", "default", "--json", "--instance", alpha.reference.instanceId])
      expect(JSON.parse(options?.stdin ?? "null")).toMatchObject({ requestId: request.requestId, expectedFleet: request.expectedFleet })
      return f.runner.ok(firstmateReceipt(request, "handled"))
    }
    const fresh = f.create()
    const result = await fresh.reload(f.saved())
    expect(result.actions[0]).toMatchObject({
      status: Status.Accepted, firstmateInstance: alpha.reference,
      firstmateSubmission: { request, receipt: { state: "handled" } },
    })
    expect(f.runner.calls).toHaveLength(1)
    expect(f.legacy.entries.size).toBe(0)
  })

  it("does not reuse a saved reference as fresh instance-control approval", async () => {
    const f = setup()
    await f.bind("action-1")
    await f.approve("action-1")
    const request = structuredClone(f.saved().actions[0]?.firstmateSubmission?.request)
    const fresh = f.create()
    await expect(fresh.launch(f.saved(), false)).rejects.toThrow(/Review the saved instance/)
    expect(f.runner.submissions).toEqual([])
    expect(f.saved().actions[0]?.firstmateSubmission?.request).toEqual(request)
    expect(f.saved().actions[0]?.firstmateInstance).toEqual(alpha.reference)
  })

  it("requires action reconfirmation after a context change without replacing the saved request ID", async () => {
    const f = setup()
    await f.bind("action-1")
    await f.approve("action-1")
    const original = structuredClone(f.saved().actions[0]!.firstmateSubmission!.request)
    await f.services.confirmFirstmateInstance!(f.saved(), "action-1", {
      descriptor: alpha, configurationCwd: "/work/beta",
      context: createFirstmateInstanceContext(alpha, beta.worktree.evidence, "confirmed-join"),
    })
    expect(f.saved().actions[0]?.firstmateSubmission?.request).toEqual(original)
    expect(f.saved().actions[0]?.sharedWriteConfirmed).toBe(false)
    await expect(f.services.launch(f.saved(), false)).rejects.toThrow(/Reconfirm the same fleet action/)
    expect(f.runner.submissions).toEqual([])
    await f.approve("action-1")
    expect(f.saved().actions[0]?.firstmateSubmission?.request).toEqual(original)
  })

  it("does not allow an ordinary save to invent or swap an instance approval", async () => {
    const f = setup()
    await expect(f.services.save(changeContinuationAction(f.saved(), "action-1", { firstmateInstance: beta.reference })))
      .rejects.toThrow(/explicit instance review/)
    expect(f.saved().actions[0]).not.toHaveProperty("firstmateInstance")
  })

  it("opens instance review before model preparation and does not approve on discovery", async () => {
    const f = setup()
    const ui = new ContinuationUiController(f.services, f.saved())
    await ui.prepare("action-1")
    expect(ui.getSnapshot().screen).toBe(ContinuationScreen.FirstmateInstances)
    expect(ui.getSnapshot().draft.actions[0]).not.toHaveProperty("firstmateInstance")
    expect(f.save).not.toHaveBeenCalled()
    expect(f.provider).not.toHaveBeenCalled()
    await ui.instanceEvent({ type: "confirm" })
    await ui.instanceEvent({ type: "move", delta: 1 })
    await ui.instanceEvent({ type: "confirm" })
    expect(ui.getSnapshot().screen).toBe(ContinuationScreen.Action)
    expect(ui.getSnapshot().draft.actions[0]?.firstmateInstance).toEqual(alpha.reference)
    expect(ui.getSnapshot().draft.actions[0]).not.toHaveProperty("firstmateSubmission")
    expect(f.runner.submissions).toEqual([])
    ui.dispose()
  })
})

const durableFixture = async (status: Status) => {
  const root = path.join(testDirectory, `.fmi-continuation-${randomUUID()}`)
  await mkdir(root, { mode: 0o700 })
  roots.push(root)
  const store = new ContinuationStore(path.join(root, "state"))
  const initial = draft()
  const created = await store.create(initial.snapshot, initial.model, initial.effort)
  const edit = initial.actions[0]!
  const request = parseFirstmateSubmissionRequestV1({
    schemaVersion: 1, requestId: "00000000-0000-4000-8000-000000000041",
    expectedFleet: instanceFleet(alpha).identity, originalIntent: edit.originalIntent, generatedSpec: edit.prompt,
    workflowId: edit.workflowId, projectTarget: edit.projectTarget,
  })
  const saved = await store.save({
    ...created, assessment: initial.assessment!,
    actions: initial.actions.map((action, index) => index > 0 ? action : {
      ...action, firstmateInstance: alpha.reference, firstmateAction: "submit", status,
      firstmateSubmission: { request, receipt: status === Status.Accepted ? firstmateReceipt(request) : null },
    }),
  }, created.revision)
  return { store, saved, request }
}

const rejectedReceipt = (request: FirstmateSubmissionRequestV1): FirstmateSubmissionReceiptV1 => ({
  ...firstmateReceipt(request), state: "rejected", noteId: null, announcement: "not-needed",
  error: { code: "rejected", message: "The original submission was rejected." },
})

describe.each([Status.Submitting, Status.Accepted, Status.SubmissionUnknown])("store-level Firstmate protection: %s", (status) => {
  it("does not unlock the request through intermediate status-only saves and an unsupported rejection", async () => {
    const f = await durableFixture(status)
    let saved = await f.store.save({
      ...f.saved, actions: f.saved.actions.map((edit, index) => index > 0 ? edit : {
        ...edit, selected: false, status: status === Status.Submitting ? Status.SubmissionUnknown : status,
      }),
    }, f.saved.revision)
    saved = await f.store.save({
      ...saved, actions: saved.actions.map((edit, index) => index > 0 ? edit : {
        ...edit, firstmateDiagnostic: "A later status-only update is not rejection evidence.",
      }),
    }, saved.revision)
    const protectedAction = saved.actions[0]!
    await expect(f.store.save({
      ...saved, actions: saved.actions.map((edit, index) => index > 0 ? edit : {
        ...edit, status: Status.SubmissionRejected, firstmateSubmission: { request: f.request, receipt: null },
      }),
    }, saved.revision)).rejects.toThrow(/cannot|rejection/i)
    const loaded = await f.store.load(saved.id)
    expect(loaded.actions[0]).toEqual(protectedAction)
    const {
      firstmateAction: _action, firstmateSubmission: _submission, firstmateDiagnostic: _diagnostic, ...unbound
    } = loaded.actions[0]!
    await expect(f.store.save({
      ...loaded, actions: [{ ...unbound, firstmateInstance: beta.reference, status: Status.Prepared }, ...loaded.actions.slice(1)],
    }, loaded.revision)).rejects.toThrow(/cannot/i)
    expect((await f.store.load(saved.id)).actions[0]).toEqual(protectedAction)
  })

  it.each(["remove", "reference", "payload", "request-id", "reset"] as const)("rejects %s without losing the original request", async (change) => {
    const f = await durableFixture(status)
    const current = f.saved.actions[0]!
    let edited = current
    if (change === "reference") edited = { ...current, firstmateInstance: { ...alpha.reference, mode: "legacy" } }
    if (change === "payload") {
      const request = { ...f.request, originalIntent: "Another intent." }
      edited = { ...current, originalIntent: request.originalIntent, firstmateSubmission: {
        request, receipt: status === Status.Accepted ? firstmateReceipt(request) : null,
      } }
    }
    if (change === "request-id") {
      const request = { ...f.request, requestId: "00000000-0000-4000-8000-000000000042" }
      edited = { ...current, firstmateSubmission: { request, receipt: status === Status.Accepted ? firstmateReceipt(request) : null } }
    }
    if (change === "reset") edited = { ...current, status: Status.Prepared }
    const next = {
      ...f.saved,
      actions: change === "remove" ? f.saved.actions.slice(1) : [edited, ...f.saved.actions.slice(1)],
    }
    await expect(f.store.save(next, f.saved.revision)).rejects.toThrow()
    expect((await f.store.load(f.saved.id)).actions[0]).toEqual(current)
  })

  it("permits selection changes and valid receipt reconciliation without changing identity", async () => {
    const f = await durableFixture(status)
    const next = await f.store.save({
      ...f.saved, actions: f.saved.actions.map((edit, index) => index > 0 ? edit : {
        ...edit, selected: false, status: Status.Accepted,
        firstmateSubmission: { request: f.request, receipt: firstmateReceipt(f.request, "handled") },
      }),
    }, f.saved.revision)
    expect(next.actions[0]).toMatchObject({ selected: false, status: Status.Accepted, firstmateInstance: alpha.reference })
    expect(next.actions[0]?.firstmateSubmission?.request).toEqual(f.request)
  })
})

describe("Firstmate rejection evidence", () => {
  it("keeps old unproved rejected records frozen across another save", async () => {
    const f = await durableFixture(Status.SubmissionRejected)
    const selected = await f.store.save({
      ...f.saved, actions: f.saved.actions.map((edit, index) => index > 0 ? edit : { ...edit, selected: false }),
    }, f.saved.revision)
    const current = selected.actions[0]!
    expect(continuationActionLocked(current)).toBe(true)
    expect(continuationNeedsReconciliation(current)).toBe(true)
    await expect(f.store.save({
      ...selected, actions: [{ ...current, status: Status.Prepared }, ...selected.actions.slice(1)],
    }, selected.revision)).rejects.toThrow(/cannot/i)
    expect((await f.store.load(selected.id)).actions[0]).toEqual(current)
  })

  it.each([Status.Submitting, Status.SubmissionUnknown])("allows a proved rejection from %s and a later explicit new draft", async (status) => {
    const f = await durableFixture(status)
    const requestBytes = JSON.stringify(f.request)
    const rejected = await f.store.save({
      ...f.saved, actions: f.saved.actions.map((edit, index) => index > 0 ? edit : {
        ...edit, status: Status.SubmissionRejected,
        firstmateSubmission: { request: f.request, receipt: rejectedReceipt(f.request) },
      }),
    }, f.saved.revision)
    expect(continuationActionLocked(rejected.actions[0]!)).toBe(false)
    const next = changeContinuationAction(rejected, "action-1", { firstmateInstance: beta.reference })
    const saved = await f.store.save(next, rejected.revision)
    expect(saved.actions[0]).toMatchObject({ firstmateInstance: beta.reference, status: Status.Prepared })
    expect(saved.actions[0]).not.toHaveProperty("firstmateSubmission")
    expect(JSON.stringify(f.request)).toBe(requestBytes)
  })

  it.each([Status.Submitting, Status.SubmissionUnknown])("cannot erase saved acceptance evidence under an intermediate %s status", async (status) => {
    const f = await durableFixture(status)
    const acceptedEvidence = await f.store.save({
      ...f.saved, actions: f.saved.actions.map((edit, index) => index > 0 ? edit : {
        ...edit, firstmateSubmission: { request: f.request, receipt: firstmateReceipt(f.request) },
      }),
    }, f.saved.revision)
    await expect(f.store.save({
      ...acceptedEvidence, actions: acceptedEvidence.actions.map((edit, index) => index > 0 ? edit : {
        ...edit, status: Status.SubmissionRejected,
        firstmateSubmission: { request: f.request, receipt: rejectedReceipt(f.request) },
      }),
    }, acceptedEvidence.revision)).rejects.toThrow(/acceptance evidence/i)
    expect((await f.store.load(acceptedEvidence.id)).actions[0]?.firstmateSubmission)
      .toEqual(acceptedEvidence.actions[0]?.firstmateSubmission)
  })

  it("reconciles an old unproved rejected journal record with the same ID instead of making it editable", async () => {
    const f = setup()
    await f.bind("action-1", alpha)
    await f.approve("action-1", alpha)
    const request = f.saved().actions[0]!.firstmateSubmission!.request
    await f.store.save({
      ...f.saved(), actions: f.saved().actions.map((edit, index) => index > 0 ? edit : {
        ...edit, status: Status.SubmissionRejected,
      }),
    }, f.saved().revision)
    const memory = f.journals.get(firstmateInstanceKey(alpha.reference))!
    memory.entries.set(request.requestId, {
      schemaVersion: 1, request, digest: firstmateSubmissionDigest(request),
      status: "rejected", receipt: null, message: "Old unproved rejection.",
    })
    f.runner.calls.length = 0
    f.runner.reply = async ({ args, options }) => {
      expect(args).toEqual(["receipt", "default", "--json", "--instance", alpha.reference.instanceId])
      expect(JSON.parse(options?.stdin ?? "null")).toMatchObject({ requestId: request.requestId, expectedFleet: request.expectedFleet })
      return f.runner.ok(firstmateReceipt(request, "handled"))
    }
    const reconciled = await f.services.reload(f.saved())
    expect(reconciled.actions[0]).toMatchObject({
      status: Status.Accepted, firstmateInstance: alpha.reference, firstmateSubmission: { request, receipt: { state: "handled" } },
    })
    expect(f.runner.calls).toHaveLength(1)
    expect(f.runner.submissions).toEqual([])
  })
})
