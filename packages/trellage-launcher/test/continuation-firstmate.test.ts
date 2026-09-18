import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ContinuationActionStatus as Status,
  ContinuationPlacementKind as Placement,
  firstmateSubmissionDigest,
  parseFirstmateSubmissionRequestV1,
  validateContinuationDraft,
  type ContinuationDraft,
  type FirstmateFleetReadinessV1,
} from "@trellage/guide-core"
import * as batch from "../src/guide-batch.ts"
import * as privateLaunch from "../src/continuation-launch.ts"
import { createContinuationServices } from "../src/continuation-runtime.ts"
import { ContinuationStore } from "../src/continuation-store.ts"
import { changeContinuationAction } from "../src/continuation-ui-state.ts"
import { FirstmateSubmissionClient } from "../src/guide-firstmate.ts"
import { parseGuideCatalog, type CombinedGuideCatalog } from "../src/guide-catalog.ts"
import { prepareGuidePrompt, registeredGuideProjectTarget } from "../src/guide-context.ts"
import { renderWorkflowBodyCandidate } from "../src/guide-workflow-prompt.ts"
import type { CommandRunner } from "../src/guide-launch.ts"
import type { FirstmateJournalEntry } from "../src/guide-firstmate-journal.ts"
import {
  firstmateFleetIdentity,
  firstmateFleetReadiness,
  firstmateGuide,
  firstmateMemoryJournal,
  firstmateOrchestration,
  firstmateOriginalIntent,
  firstmateProjectC,
  firstmatePreparedPrompt,
  firstmateReceipt,
  firstmateRuntimeCatalog,
  preparedFirstmateFixtureDraft,
  type ContinuationFirstmateProfile,
} from "./helpers/continuation-firstmate-fixtures.ts"

afterEach(() => vi.restoreAllMocks())

const runtimeDraft = (profile: ContinuationFirstmateProfile = "default"): ContinuationDraft => {
  const draft = preparedFirstmateFixtureDraft(profile)
  if (draft.assessment === undefined) throw new Error("Fixture assessment is required.")
  return validateContinuationDraft({
    ...draft,
    assessment: {
      ...draft.assessment,
      actions: draft.assessment.actions.map((action, index) => index === 0 ? action : {
        ...action, profileRef: "native:cdx/default", workflowId: "review",
      }),
    },
    actions: draft.actions.map((edit, index) => index === 0 ? edit : {
      ...edit, profileRef: "native:cdx/default", workflowId: "review",
    }),
  })
}

const setup = (options: {
  readonly profile?: ContinuationFirstmateProfile
  readonly action?: batch.FirstmateGuideAction
  readonly herdr?: boolean
  readonly initial?: ContinuationDraft
  readonly catalog?: CombinedGuideCatalog
} = {}) => {
  const profile = options.profile ?? "default"
  let saved = options.initial ?? runtimeDraft(profile)
  let fleet = firstmateFleetReadiness(profile, options.action, { backend: options.herdr ? "herdr" : "tmux" })
  const memory = firstmateMemoryJournal()
  const store = new ContinuationStore(path.resolve("test/.continuation-firstmate-memory-store"))
  const statuses: Array<Status> = []
  const load = vi.spyOn(store, "load").mockImplementation(async (id) => {
    if (id !== saved.id) throw new Error("Fixture draft not found.")
    return saved
  })
  const write = vi.spyOn(store, "save").mockImplementation(async (draft, revision) => {
    if (revision !== saved.revision || draft.revision !== revision) throw new Error("Fixture revision conflict.")
    saved = validateContinuationDraft({ ...draft, revision: revision + 1 })
    statuses.push(saved.actions[0]!.status)
    return saved
  })
  const launchEvent = vi.spyOn(store, "appendLaunchEvent").mockRejectedValue(new Error("Firstmate must not create a legacy pane launch record."))
  const request = () => {
    const value = saved.actions[0]?.firstmateSubmission?.request
    if (value === undefined) throw new Error("The fixture needs an explicitly approved request.")
    return value
  }
  const run = vi.fn<CommandRunner["run"]>(async (executable, args, commandOptions) => {
    if (commandOptions === undefined) throw new Error("Command options are required for fixture control I/O.")
    expect(executable).toBe("/profiles/fmx")
    expect(args[1]).toBe(profile)
    expect(commandOptions.cwd).toBe(saved.snapshot.source.cwd)
    if (args[0] === "inventory") {
      return { exitCode: 0, stderr: "", stdout: JSON.stringify({
        schemaVersion: 1, launcher: "fmx", profile, readiness: "busy", fleet,
      }) }
    }
    if (args[0] === "submit") {
      const sent = parseFirstmateSubmissionRequestV1(JSON.parse(commandOptions.stdin ?? "null"))
      expect(sent).toEqual(request())
      expect(saved.actions[0]?.status).toBe(Status.Submitting)
      expect(memory.entries.get(sent.requestId)?.status).toBe("sending")
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(firstmateReceipt(sent)) }
    }
    if (args[0] === "receipt") {
      expect(JSON.parse(commandOptions.stdin ?? "null")).toEqual({
        schemaVersion: 1, requestId: request().requestId, expectedFleet: request().expectedFleet,
      })
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(firstmateReceipt(request(), "handled")) }
    }
    throw new Error(`Unexpected fixture operation: ${args[0]}`)
  })
  const check = vi.fn(async () => ({ sameSource: true, advanced: false, revision: saved.snapshot.revision }))
  const preparationProvider = vi.fn(() => { throw new Error("No model is needed for submission.") })
  const services = createContinuationServices({
    store, catalog: options.catalog ?? firstmateRuntimeCatalog(), guideRoot: "/fixture/guides", runner: { run },
    initialDraft: saved, firstmateJournal: memory.journal,
    ...(options.herdr ? { context: { surface: "popup" as const, workspaceId: "real-workspace", paneId: "real-pane", cwd: saved.snapshot.source.cwd } } : {}),
    sourceClient: { check, refresh: async () => { throw new Error("No source client was invented.") } },
    assessmentProvider: () => { throw new Error("No model is needed for submission.") },
    preparationProvider,
  })
  const approve = async (action: batch.FirstmateGuideAction = options.action ?? "submit") => {
    if (services.confirmFirstmateAction === undefined) throw new Error("Missing explicit confirmation service.")
    return services.confirmFirstmateAction(saved, "action-1", action, firstmateFleetIdentity(profile))
  }
  return {
    services, store, load, write, run, check, launchEvent, preparationProvider, memory, request, approve, statuses,
    saved: () => saved,
    fleet: () => fleet,
    setFleet: (value: FirstmateFleetReadinessV1) => { fleet = value },
  }
}

const seedJournal = async (
  f: ReturnType<typeof setup>,
  status: FirstmateJournalEntry["status"],
) => {
  const request = f.request()
  const entry: FirstmateJournalEntry = {
    schemaVersion: 1, request, digest: firstmateSubmissionDigest(request), status,
    receipt: status === "accepted" ? firstmateReceipt(request) : null,
    message: status === "accepted" ? "Saved note. Supervisor announcement failed." : "Inspect this same request. Do not resend.",
  }
  f.memory.entries.set(request.requestId, entry)
  await f.store.save({
    ...f.saved(),
    actions: f.saved().actions.map((edit, index) => index > 0 ? edit : {
      ...edit, status: Status.Submitting,
    }),
  }, f.saved().revision)
}

describe.each(["default", "pstack-workers"] as const)("Firstmate continuation delivery: %s", (profile) => {
  it("requires explicit action confirmation after the specification and target, then saves without sending", async () => {
    const f = setup({ profile })
    await expect(f.services.launch(f.saved(), false)).rejects.toThrow(/Explicitly confirm Start fleet/u)
    expect(f.run).not.toHaveBeenCalled()
    const approved = await f.approve()
    const request = f.request()
    expect(request).toMatchObject({
      originalIntent: firstmateOriginalIntent,
      projectTarget: firstmateProjectC(),
      generatedSpec: runtimeDraft(profile).actions[0]?.prompt,
      workflowId: "review-project",
      expectedFleet: firstmateFleetIdentity(profile),
    })
    expect(request.requestId).toMatch(/^[a-f0-9-]{14}4[a-f0-9-]{21}$/u)
    expect(approved.actions[0]).toMatchObject({
      status: Status.Prepared, firstmateAction: "submit", firstmateSubmission: { request, receipt: null },
    })
    expect(request.generatedSpec).not.toContain(request.expectedFleet.home)
    expect(request.generatedSpec).not.toContain(request.originalIntent)
    await f.approve()
    expect(f.request()).toEqual(request)
    expect(f.run.mock.calls.every(([, args]) => args[0] === "inventory")).toBe(true)
    expect(f.memory.entries.size).toBe(0)
    expect(f.preparationProvider).not.toHaveBeenCalled()
    expect(f.launchEvent).not.toHaveBeenCalled()
  })

  it("sends the persisted request to active workers' existing fleet without Herdr, a socket, or a private prompt", async () => {
    const f = setup({ profile })
    const deliverPrivate = vi.spyOn(privateLaunch, "launchPrivateContinuation")
    const approved = await f.approve()
    const request = f.request()
    const delivered = await f.services.launch(approved, false)
    expect(f.fleet().activeWorkers).toBeGreaterThan(0)
    expect(delivered.actions[0]).toMatchObject({
      status: Status.Accepted, firstmateAction: "submit",
      firstmateSubmission: { request, receipt: { state: "saved", noteId: "captain-note-1", announcement: "failed" } },
      firstmateDiagnostic: expect.stringContaining("announcement failed"),
    })
    expect(delivered.actions[0]).not.toHaveProperty("launch")
    expect(f.statuses).toContain(Status.Submitting)
    expect(f.statuses.indexOf(Status.Submitting)).toBeLessThan(f.statuses.indexOf(Status.Accepted))
    expect(f.run.mock.calls.filter(([, args]) => args[0] === "submit")).toHaveLength(1)
    expect(f.check).toHaveBeenCalled()
    expect(deliverPrivate).not.toHaveBeenCalled()
    expect(f.launchEvent).not.toHaveBeenCalled()
    expect(f.preparationProvider).not.toHaveBeenCalled()
  })

  it("locks an unknown request and reconciles its same-ID receipt without sending it again", async () => {
    const f = setup({ profile })
    await f.approve()
    const request = f.request()
    await seedJournal(f, "sending")
    const lookup = vi.spyOn(FirstmateSubmissionClient.prototype, "receipt")
    const submit = vi.spyOn(FirstmateSubmissionClient.prototype, "submit")
    const result = await f.services.reload(f.saved())
    expect(lookup).toHaveBeenCalledExactlyOnceWith(request)
    expect(submit).not.toHaveBeenCalled()
    expect(result.actions[0]).toMatchObject({
      status: Status.Accepted,
      firstmateSubmission: { request, receipt: { state: "handled", requestId: request.requestId } },
    })
    expect(f.memory.events.some(({ operation }) => operation === "begin")).toBe(false)
    expect(f.launchEvent).not.toHaveBeenCalled()
  })

  it("restores known accepted journal evidence before any new control I/O", async () => {
    const f = setup({ profile })
    await f.approve()
    const request = f.request()
    await seedJournal(f, "accepted")
    f.run.mockClear()
    f.run.mockRejectedValue(new Error("Control I/O must not run for a known accepted note."))
    const result = await f.services.reload(f.saved())
    expect(result.actions[0]).toMatchObject({ status: Status.Accepted, firstmateSubmission: { request } })
    const revision = result.revision
    expect((await f.services.reload(result)).revision).toBe(revision)
    expect(f.run).not.toHaveBeenCalled()
    expect(f.memory.events.every(({ operation }) => operation === "get")).toBe(true)
    await expect(f.approve()).rejects.toThrow(/cannot receive a new action/u)
    expect(f.request()).toEqual(request)
  })
})

describe("Firstmate continuation admission and durable updates", () => {
  it("preserves an explicitly confirmed fleet-only workflow without inferring a project from the source", async () => {
    const scoped = changeContinuationAction(runtimeDraft(), "action-1", {
      brief: "  Review fleet status only.\nDo not start implementation workers.  ",
      workflowId: "review-fleet-status",
    })
    const targeted = changeContinuationAction(scoped, "action-1", { projectTarget: null, projectTargetConfirmed: true })
    const prompt = renderWorkflowBodyCandidate(firstmatePreparedPrompt(targeted).workflow, {
      title: "Read fleet status", prompt: "Report pending decisions and worker state.", notes: "Observation only.",
    }).prompt
    const f = setup({ initial: changeContinuationAction(targeted, "action-1", { prompt }) })
    await f.approve()
    const request = f.request()
    expect(request).toMatchObject({
      projectTarget: null, workflowId: "review-fleet-status", originalIntent: scoped.actions[0]?.brief,
    })
    expect(request.generatedSpec).not.toContain(f.saved().snapshot.source.cwd)
    expect((await f.services.launch(f.saved(), false)).actions[0]?.status).toBe(Status.Accepted)
  })

  it("rejects the whole-request byte limit before persistence or submission without truncating the human brief", async () => {
    const original = runtimeDraft()
    const catalog = firstmateRuntimeCatalog()
    const limited = parseGuideCatalog(JSON.stringify({
      ...catalog,
      native: catalog.native.map((entry) => entry.launcher !== "fmx" ? entry : {
        ...entry, orchestration: { ...entry.orchestration, submission: { schemaVersion: 1, maxRequestBytes: 16_384 } },
      }),
    }))
    const originalIntent = "é".repeat(16_000)
    const profile = limited.native.find(({ launcher, name }) => launcher === "fmx" && name === "default")!
    const prepared = prepareGuidePrompt(profile.guide, "review-project", "native:fmx/default", originalIntent, {
      originalIntent, projectTarget: firstmateProjectC(), orchestration: profile.orchestration!,
    })
    const prompt = renderWorkflowBodyCandidate(prepared.workflow, {
      title: "Bounded specification", prompt: "Inspect the confirmed revision.", notes: "Keep the full original intent.",
    }).prompt
    const initial: ContinuationDraft = {
      ...original,
      actions: original.actions.map((edit, index) => index > 0 ? edit : { ...edit, brief: originalIntent, originalIntent, prompt }),
    }
    const f = setup({ initial, catalog: limited })
    await expect(f.approve()).rejects.toThrow(/whole-request byte limit/u)
    expect(f.saved().actions[0]?.brief).toBe(originalIntent)
    expect(f.saved().actions[0]?.firstmateSubmission).toBeUndefined()
    expect(f.memory.entries.size).toBe(0)
    expect(f.run.mock.calls.every(([, args]) => args[0] === "inventory")).toBe(true)
  })

  it.each([
    { projectTargetConfirmed: false },
    { prompt: "Unframed specification." },
    { workflowId: "unknown-workflow" },
  ])("rejects incomplete or obsolete task context before control I/O: %j", async (change) => {
    const original = runtimeDraft()
    const f = setup({ initial: {
      ...original, actions: original.actions.map((edit, index) => index > 0 ? edit : { ...edit, ...change }),
    } })
    await expect(f.approve()).rejects.toThrow()
    expect(f.run).not.toHaveBeenCalled()
    expect(f.saved().actions[0]?.firstmateSubmission).toBeUndefined()
  })

  it("refuses a changed home or instance after the human readiness review", async () => {
    const f = setup()
    await f.services.inspectFirstmate?.(f.saved(), "action-1")
    f.setFleet(firstmateFleetReadiness("default", "submit", {
      identity: { ...firstmateFleetIdentity(), instanceId: "643ceff0-13f6-45ba-852a-8b5907cb6cb5", home: "/fixture/changed-home" },
    }))
    await expect(f.approve()).rejects.toThrow(/identity changed/u)
    expect(f.saved().actions[0]?.firstmateSubmission).toBeUndefined()
    expect(f.run.mock.calls.every(([, args]) => args[0] === "inventory")).toBe(true)
  })

  it("does not treat permission to save a note as permission to send to a stopped supervisor", async () => {
    const f = setup({ action: "start" })
    await expect(f.approve("submit")).rejects.toThrow(/existing owned supervisor/u)
    expect(f.saved().actions[0]?.firstmateSubmission).toBeUndefined()
  })

  it.each(["start", "recover"] as const)("requires actual Herdr context and shared-write approval for %s", async (action) => {
    const initial = runtimeDraft()
    const placed: ContinuationDraft = {
      ...initial,
      actions: initial.actions.map((edit, index) => index > 0 ? edit : { ...edit, placement: { kind: Placement.NewTab }, sharedWriteConfirmed: false }),
    }
    const outside = setup({ action, initial: placed })
    outside.setFleet(firstmateFleetReadiness("default", action))
    await expect(outside.approve(action)).rejects.toThrow(/actual Herdr context/u)
    const inside = setup({ action, herdr: true, initial: placed })
    await expect(inside.approve(action)).rejects.toThrow(/Confirm a shared writable destination/u)
    expect(inside.saved().actions[0]?.firstmateSubmission).toBeUndefined()
  })

  it.each(["consent", "prerequisite", "backend"] as const)("fails closed on unavailable %s rather than installing, repairing, or switching the action", async (reason) => {
    const original = runtimeDraft()
    const f = setup({ herdr: true, action: "start", initial: {
      ...original, actions: original.actions.map((edit, index) => index > 0 ? edit : { ...edit, placement: { kind: Placement.NewTab } }),
    } })
    const denied = { allowed: false, reason: "Required consent or prerequisite is missing." }
    const fleet = firstmateFleetReadiness("default", "start", reason === "backend" ? { backend: "tmux" } : {
      consentRequired: reason === "consent",
      prerequisites: [{ id: "fixture-tool", ready: reason !== "prerequisite", description: "A required tool." }],
      actions: { start: denied, recover: denied, submit: { allowed: true, reason: null } },
    })
    f.setFleet(fleet)
    await expect(f.approve("start")).rejects.toThrow(
      reason === "backend" ? /Herdr supervisor destination/u : reason === "consent" ? /consent/u : /prerequisites/u,
    )
    expect(f.saved().actions[0]?.firstmateSubmission).toBeUndefined()
    expect(f.run.mock.calls.every(([, args]) => args[0] === "inventory")).toBe(true)
  })

  it.each(["start", "recover"] as const)("records accepted notes and %s startup errors without pane launch receipts", async (action) => {
    const initial = runtimeDraft()
    const f = setup({ action, herdr: true, initial: {
      ...initial,
      actions: initial.actions.map((edit, index) => index > 0 ? edit : { ...edit, placement: { kind: Placement.NewTab } }),
    } })
    await f.approve(action)
    const request = f.request()
    vi.spyOn(batch, "executeGuideBatch").mockImplementation(async (value, services) => {
      expect(value.context).toMatchObject({ workspaceId: "real-workspace", callerPaneId: "real-pane" })
      const job = value.jobs[0]!
      expect(job).toMatchObject({
        firstmate: { action, requestId: request.requestId, expectedFleet: request.expectedFleet },
        guideContext: { originalIntent: firstmateOriginalIntent, workflowId: request.workflowId, projectTarget: firstmateProjectC() },
      })
      expect(job.privatePrompt).toBeUndefined()
      expect(job.command.args).not.toContain(request.generatedSpec)
      const journal = services.firstmateJournal!
      await services.onFirstmateUpdate?.(job, await journal.prepare(request))
      await services.onFirstmateUpdate?.(job, await journal.begin(request))
      expect(f.saved().actions[0]?.status).toBe(Status.Submitting)
      const receipt = firstmateReceipt(request)
      await services.onFirstmateUpdate?.(job, await journal.record(request, { status: "accepted", receipt, message: "Note saved; announcement failed." }))
      await services.onAllocated?.(job, { paneId: "one-supervisor-pane", workspaceId: "real-workspace", cwd: "/fixture/supervisor" })
      const result: batch.GuideBatchEntryResult = {
        job, status: "accepted", request, receipt, supervisor: "unknown",
        startupError: "Supervisor did not become ready.", paneId: "one-supervisor-pane",
      }
      await services.onResult?.(result)
      return { exitCode: 1, result: { entries: [result] } }
    })
    const delivered = await f.services.launch(f.saved(), false)
    expect(delivered.actions[0]).toMatchObject({
      status: Status.Accepted,
      firstmateSubmission: { request, receipt: { noteId: "captain-note-1" } },
      firstmateDiagnostic: expect.stringContaining("Supervisor startup failed: Supervisor did not become ready."),
    })
    expect(delivered.actions[0]).not.toHaveProperty("launch")
    expect(f.launchEvent).not.toHaveBeenCalled()
  })

  it.each(["malformed", "foreign", "refused", "not-found"] as const)("keeps %s receipt lookup evidence unknown and immutable", async (kind) => {
    const f = setup()
    await f.approve()
    const request = f.request()
    await seedJournal(f, "unknown")
    f.run.mockImplementation(async (_executable, args) => {
      expect(args).toEqual(["receipt", "default", "--json"])
      const base = firstmateReceipt(request)
      const receipt = kind === "foreign" ? { ...base, fleet: { ...base.fleet, home: "/fixture/foreign-home" } }
        : kind === "refused" ? { ...base, state: "rejected", noteId: null, announcement: "not-needed", error: { code: "unsafe", message: "Lookup refused." } }
        : { ...base, state: "not-found", noteId: null, digest: null, announcement: "not-needed", error: null }
      return { stdout: kind === "malformed" ? "{}" : JSON.stringify(receipt), stderr: "", exitCode: 0 }
    })
    const submit = vi.spyOn(FirstmateSubmissionClient.prototype, "submit")
    const result = await f.services.reload(f.saved())
    expect(result.actions[0]).toMatchObject({ status: Status.SubmissionUnknown, firstmateSubmission: { request } })
    await expect(f.approve()).rejects.toThrow(/cannot receive a new action/u)
    expect(() => changeContinuationAction(result, "action-1", { brief: "New content." })).toThrow(/cannot be edited/u)
    expect(submit).not.toHaveBeenCalled()
    expect(f.request()).toEqual(request)
  })

  it("does not let public draft saving manufacture action approval", async () => {
    const f = setup()
    const original = f.saved()
    const approved = await f.approve()
    const request = f.request()
    const changed = changeContinuationAction(approved, "action-1", { prompt: approved.actions[0]!.prompt! })
    await f.services.save(changed)
    const current = f.saved()
    await expect(f.services.save({
      ...current,
      actions: current.actions.map((edit, index) => index > 0 ? edit : {
        ...edit, originalIntent: request.originalIntent, firstmateAction: "submit", firstmateSubmission: { request, receipt: null },
      }),
    })).rejects.toThrow(/explicit action confirmation/u)
    expect(f.saved().actions[0]?.firstmateSubmission).toBeUndefined()
    expect(original.actions[0]?.firstmateSubmission).toBeUndefined()
  })

  it("maps one supervisor allocation and separate durable outcomes to two exact action requests", async () => {
    const initial = runtimeDraft()
    if (initial.assessment === undefined) throw new Error("The fixture needs an assessment.")
    const target = registeredGuideProjectTarget("separate-project")
    const brief = "Inspect the separately registered project. Do not merge."
    const workflow = prepareGuidePrompt(firstmateGuide, "review-project", "native:fmx/default", brief, {
      originalIntent: brief, projectTarget: target, orchestration: firstmateOrchestration,
    }).workflow
    const prompt = renderWorkflowBodyCandidate(workflow, { title: "Second project", prompt: "Inspect its failure paths.", notes: "Independent project." }).prompt
    const f = setup({ herdr: true, action: "start", initial: {
      ...initial,
      assessment: {
        ...initial.assessment,
        actions: initial.assessment.actions.map((action, index) => index !== 1 ? action : {
          ...action, brief, profileRef: "native:fmx/default", workflowId: "review-project",
        }),
      },
      actions: initial.actions.map((edit, index) => index > 1 ? edit : {
        ...edit, placement: { kind: Placement.NewTab }, sharedWriteConfirmed: true,
        ...(index === 0 ? {} : {
          brief, originalIntent: brief, prompt, projectTarget: target, projectTargetConfirmed: true,
          selected: true, status: Status.Prepared, profileRef: "native:fmx/default", workflowId: "review-project",
        }),
      }),
    } })
    await f.approve("start")
    await f.services.confirmFirstmateAction?.(f.saved(), "action-2", "start", firstmateFleetIdentity())
    const requests = f.saved().actions.slice(0, 2).map((edit) => edit.firstmateSubmission!.request)
    expect(new Set(requests.map(({ requestId }) => requestId)).size).toBe(2)
    vi.spyOn(batch, "executeGuideBatch").mockImplementation(async (value, services) => {
      const journal = services.firstmateJournal!
      expect(value.jobs).toHaveLength(2)
      for (const [index, job] of value.jobs.entries()) {
        expect(job.firstmate?.requestId).toBe(requests[index]!.requestId)
        await services.onFirstmateUpdate?.(job, await journal.prepare(requests[index]!))
      }
      const results: batch.GuideBatchEntryResult[] = []
      for (const [index, job] of value.jobs.entries()) {
        const request = requests[index]!
        await services.onFirstmateUpdate?.(job, await journal.begin(request))
        const receipt = { ...firstmateReceipt(request), noteId: `captain-note-${index + 1}`, announcement: "sent" as const, error: null }
        await services.onFirstmateUpdate?.(job, await journal.record(request, { status: "accepted", receipt, message: "Saved note." }))
        results.push({ job, request, receipt, status: "accepted", supervisor: "running", paneId: "shared-supervisor" })
      }
      await services.onAllocated?.(value.jobs[0]!, { paneId: "shared-supervisor", workspaceId: "real-workspace", cwd: "/fixture/supervisor-not-project" })
      for (const result of results) await services.onResult?.(result)
      return { exitCode: 0, result: { entries: results } }
    })
    const result = await f.services.launch(f.saved(), false)
    expect(result.actions.slice(0, 2).map(({ firstmateSubmission }) => firstmateSubmission?.request)).toEqual(requests)
    expect(result.actions.slice(0, 2).map(({ firstmateSubmission }) => firstmateSubmission?.receipt?.noteId)).toEqual(["captain-note-1", "captain-note-2"])
    expect(result.actions.slice(0, 2).every(({ status, launch }) => status === Status.Accepted && launch === undefined)).toBe(true)
    expect(f.launchEvent).not.toHaveBeenCalled()
  })

  it("serializes continuation writes from two concurrently submitted Firstmate profiles", async () => {
    const initial = runtimeDraft()
    const second = runtimeDraft("pstack-workers").actions[0]!
    const secondIntent = `${second.brief}\nFocus on error paths.`
    if (initial.assessment === undefined) throw new Error("The fixture needs an assessment.")
    const f = setup({ initial: {
      ...initial,
      assessment: {
        ...initial.assessment,
        actions: initial.assessment.actions.map((action, index) => index !== 1 ? action : {
          ...action, profileRef: second.profileRef!, workflowId: second.workflowId!, brief: secondIntent, dependsOn: [],
        }),
      },
      actions: initial.actions.map((edit, index) => index !== 1 ? edit : {
        ...second, actionId: edit.actionId, brief: secondIntent, originalIntent: secondIntent,
      }),
    } })
    f.run.mockImplementation(async (executable, args, options) => {
      expect(executable).toBe("/profiles/fmx")
      const name = args[1]
      if (name !== "default" && name !== "pstack-workers") throw new Error("Unknown fleet fixture.")
      if (args[0] === "inventory") return {
        exitCode: 0, stderr: "", stdout: JSON.stringify({
          schemaVersion: 1, launcher: "fmx", profile: name, readiness: "busy", fleet: firstmateFleetReadiness(name),
        }),
      }
      if (args[0] !== "submit") throw new Error("Unexpected fleet fixture command.")
      const sent = parseFirstmateSubmissionRequestV1(JSON.parse(options?.stdin ?? "null"))
      const action = f.saved().actions.find((edit) => edit.firstmateSubmission?.request.requestId === sent.requestId)
      expect(action?.status).toBe(Status.Submitting)
      expect(sent.expectedFleet).toEqual(firstmateFleetIdentity(name))
      return {
        exitCode: 0, stderr: "", stdout: JSON.stringify({
          ...firstmateReceipt(sent), announcement: "sent", error: null,
        }),
      }
    })
    await f.approve()
    await f.services.confirmFirstmateAction?.(f.saved(), "action-2", "submit", firstmateFleetIdentity("pstack-workers"))
    const requests = f.saved().actions.slice(0, 2).map((edit) => edit.firstmateSubmission!.request)
    const save = f.write.getMockImplementation()
    if (save === undefined) throw new Error("The fixture needs a store writer.")
    let writing = 0
    let maximumWriters = 0
    f.write.mockImplementation(async (draft, revision) => {
      writing += 1
      maximumWriters = Math.max(maximumWriters, writing)
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
        return await save(draft, revision)
      } finally {
        writing -= 1
      }
    })
    const result = await f.services.launch(f.saved(), false)
    expect(maximumWriters).toBe(1)
    expect(result.actions.slice(0, 2).map(({ status }) => status)).toEqual([Status.Accepted, Status.Accepted])
    expect(result.actions.slice(0, 2).map(({ firstmateSubmission }) => firstmateSubmission?.request)).toEqual(requests)
    expect(f.run.mock.calls.filter(([, args]) => args[0] === "submit")).toHaveLength(2)
    expect(f.memory.entries.size).toBe(2)
    expect(f.launchEvent).not.toHaveBeenCalled()
  })

  it("does not release a dependent action when only its prerequisite note was accepted", async () => {
    const initial = runtimeDraft()
    const f = setup({ initial: {
      ...initial,
      actions: initial.actions.map((edit, index) => index !== 4 ? edit : {
        ...edit, selected: true, prompt: "Check the prerequisite result before further work.",
        status: Status.Prepared, prerequisitesConfirmed: true,
      }),
    } })
    await f.approve()
    const result = await f.services.launch(f.saved(), false)
    expect(result.actions[0]?.status).toBe(Status.Accepted)
    expect(result.actions[4]).toMatchObject({ status: Status.Waiting, prerequisitesConfirmed: false })
    const calls = f.run.mock.calls.length
    await f.services.launch(result, false)
    expect(f.run).toHaveBeenCalledTimes(calls)
    expect(f.saved().actions[4]?.status).toBe(Status.Waiting)
  })

  it("prevents an edit when the journal already accepted a request whose callback was interrupted", async () => {
    const f = setup()
    const approved = await f.approve()
    const request = f.request()
    f.memory.entries.set(request.requestId, {
      schemaVersion: 1, request, digest: firstmateSubmissionDigest(request),
      status: "accepted", receipt: firstmateReceipt(request), message: "Known accepted note.",
    })
    f.run.mockClear()
    const changed = changeContinuationAction(approved, "action-1", { brief: "Replace the human request." })
    await expect(f.services.save(changed)).rejects.toThrow(/receipt state changed/u)
    expect(f.saved().actions[0]).toMatchObject({ status: Status.Accepted, firstmateSubmission: { request } })
    expect(f.run).not.toHaveBeenCalled()
  })

  it("keeps a lost submit response uncertain until a same-ID receipt lookup proves acceptance", async () => {
    const f = setup()
    await f.approve()
    const request = f.request()
    const run = f.run.getMockImplementation()!
    f.run.mockImplementation(async (executable, args, options) => args[0] === "inventory"
      ? run(executable, args, options)
      : { stdout: "malformed receipt", stderr: "", exitCode: 0 })
    const unknown = await f.services.launch(f.saved(), false)
    expect(unknown.actions[0]).toMatchObject({
      status: Status.SubmissionUnknown, firstmateSubmission: { request, receipt: null },
    })
    expect(f.run.mock.calls.filter(([, args]) => args[0] === "submit")).toHaveLength(1)
    const submitCalls = f.run.mock.calls.filter(([, args]) => args[0] === "submit").length
    f.run.mockImplementation(run)
    const accepted = await f.services.reload(unknown)
    expect(accepted.actions[0]).toMatchObject({ status: Status.Accepted, firstmateSubmission: { request } })
    expect(f.run.mock.calls.filter(([, args]) => args[0] === "submit")).toHaveLength(submitCalls)
  })

  it("keeps preflight refusal separate from native rejection and does not make a legacy launch receipt", async () => {
    const f = setup()
    await f.approve()
    const request = f.request()
    const execute = vi.spyOn(batch, "executeGuideBatch").mockImplementation(async (value, services) => {
      const result: batch.GuideBatchEntryResult = {
        job: value.jobs[0]!, status: "not-submitted", stage: "submission", message: "The owned fleet changed.",
      }
      await services.onResult?.(result)
      return { exitCode: 1, result: { entries: [result] } }
    })
    const refused = await f.services.launch(f.saved(), false)
    expect(refused.actions[0]).toMatchObject({
      status: Status.Prepared, firstmateSubmission: { request, receipt: null },
      firstmateDiagnostic: "Not submitted: The owned fleet changed.",
    })
    execute.mockImplementation(async (value, services) => {
      const job = value.jobs[0]!
      const journal = services.firstmateJournal!
      await services.onFirstmateUpdate?.(job, await journal.prepare(request))
      await services.onFirstmateUpdate?.(job, await journal.begin(request))
      const receipt = {
        ...firstmateReceipt(request), state: "rejected" as const, noteId: null, announcement: "not-needed" as const,
        error: { code: "rejected", message: "Native control refused the request." },
      }
      await services.onFirstmateUpdate?.(job, await journal.record(request, { status: "rejected", receipt, message: "Native control refused the request." }))
      const result: batch.GuideBatchEntryResult = {
        job, status: "submission-rejected", stage: "submission", request, receipt, message: "Native control refused the request.",
      }
      await services.onResult?.(result)
      return { exitCode: 1, result: { entries: [result] } }
    })
    const rejected = await f.services.launch(refused, false)
    expect(rejected.actions[0]).toMatchObject({
      status: Status.SubmissionRejected, firstmateSubmission: { request, receipt: { state: "rejected", noteId: null } },
    })
    expect(rejected.actions[0]).not.toHaveProperty("launch")
    expect(f.launchEvent).not.toHaveBeenCalled()
  })

  it("surfaces a failed accepted-state callback, then recovers the known note without new transport", async () => {
    const f = setup()
    await f.approve()
    const request = f.request()
    const write = f.write.getMockImplementation()!
    f.write.mockImplementation(async (value, revision) => {
      if (value.actions[0]?.status === Status.Accepted) {
        f.write.mockImplementation(write)
        throw new Error("Durable continuation save failed after acceptance.")
      }
      return write(value, revision)
    })
    await expect(f.services.launch(f.saved(), false)).rejects.toThrow(/save failed after acceptance/u)
    expect(f.memory.entries.get(request.requestId)?.status).toBe("accepted")
    f.run.mockClear()
    const restored = await f.services.reload(f.saved())
    expect(restored.actions[0]).toMatchObject({ status: Status.Accepted, firstmateSubmission: { request } })
    expect(f.run).not.toHaveBeenCalled()
  })
})
