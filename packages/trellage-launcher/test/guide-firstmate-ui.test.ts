import { Socket } from "node:net"
import { clearLine, clearScreenDown, cursorTo, moveCursor } from "node:readline"
import type { Direction } from "node:tty"
import { stripVTControlCharacters } from "node:util"
import React from "react"
import { render } from "ink"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  firstmateSubmissionDigest,
  parseFirstmateFleetReadinessV1,
  parseFirstmateOrchestrationV1,
  parseFirstmateSubmissionRequestV1,
  parseGuideProjectTargetV1,
  type FirstmateFleetReadinessV1,
  type FirstmateSubmissionRequestV1,
  type GuideProjectTargetV1,
  type FirstmateInstanceControlContextV1,
  type ProfileGuideV1,
} from "@trellage/guide-core"
import {
  GuideEffort,
  publicGuideLaunchCommand,
  selectedProfileFromCatalogRef,
  type GuideRecommendation,
} from "../src/guide-api.ts"
import { GuideAugmentKind } from "../src/guide-augment.ts"
import {
  createQueuedGuideJob,
  executeGuideBatch,
  type FirstmateGuideAction,
  type GuideBatch,
  type GuideBatchExecutionResult,
} from "../src/guide-batch.ts"
import type { CombinedGuideCatalog } from "../src/guide-catalog.ts"
import { prepareGuidePrompt, registeredGuideProjectTarget } from "../src/guide-context.ts"
import { executeGuideUiResult } from "../src/guide-interactive-execution.ts"
import { CommandRunnerError, type CommandRunner, type CommandRunOptions, type CommandRunResult, type HerdrEnvironment } from "../src/guide-launch.ts"
import { GuideArtifactCache } from "../src/guide-match-cache.ts"
import type { GuideGenerateCandidate, GuideProvider } from "../src/guide-provider.ts"
import {
  GuideApp,
  GuideUiActionType as Action,
  GuideUiStage as Stage,
  buildGuideUiBatch,
  createInitialGuideUiState,
  enrichLiteralCandidate,
  firstmateActionOptions,
  firstmateFleetStatusLines,
  firstmateInstallationPlanLines,
  forkState,
  guideUiReducer,
  guideUiTaskContext,
  handleGuidePaste,
  queuedFirstmateSupervisor,
  type GuideUiAction,
  type GuideUiResult,
  type GuideUiState,
} from "../src/guide-ui.tsx"
import { renderWorkflowBodyCandidate, workflowPromptFrame } from "../src/guide-workflow-prompt.ts"
import { firstmateMemoryJournal, legacyFirstmateCatalog } from "./helpers/continuation-firstmate-fixtures.ts"
import {
  missingToolsFleet,
  preparationInventory,
  preparationPlan,
  preparationRevision,
  preparedFleet,
} from "./helpers/firstmate-preparation-fixtures.ts"
import {
  alpha, beta, instanceProfile, instanceList, instanceOrchestration, InstanceRunner, MemoryCreationPlans,
} from "./helpers/firstmate-instance-flow.ts"

vi.mock("../src/guide-batch.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/guide-batch.ts")>()),
  executeGuideBatch: vi.fn<typeof executeGuideBatch>(),
}))

vi.mock("../src/guide-selected.ts", () => ({
  loadSelectedGuide: vi.fn(async (catalog: CombinedGuideCatalog, _root: string, ref: string) => {
    const entry = catalog.native.find((item) => `native:${item.launcher}/${item.name}` === ref)
    if (entry === undefined) throw new Error("Unknown synthetic guide.")
    return { ref, guide: entry.guide, body: "Use only the confirmed project and supported Claude workers." }
  }),
}))

type Profile = "default" | "pstack-workers"
const profiles: ReadonlyArray<Profile> = ["default", "pstack-workers"]
const originalIntent = "  Review project C.\r\nKeep all checks. Do not merge. 😀  "
const bodies = ["Inspect project boundaries.", "Trace error paths.", "Check focused evidence."] as const
const orchestration = (profile: Profile) => parseFirstmateOrchestrationV1({
  schemaVersion: 1,
  kind: "firstmate",
  sourceRevision: "b".repeat(40),
  taskIdPrefix: profile === "default" ? "fmd" : "fmp",
  workerPolicy: profile === "default" ? null : { name: "pstack-workers", digest: "a".repeat(64) },
  workerHarness: "claude",
  workerEfforts: ["low", "medium", "high"],
  dispatchRules: "claude-single",
  submission: { schemaVersion: 1, maxRequestBytes: 512 * 1024 },
})

const guide = (profile: Profile): ProfileGuideV1 => ({
  schemaVersion: 1,
  capabilities: ["fleet-orchestration"],
  bestFor: ["Review a project", "Read fleet status"],
  avoidFor: ["Changing permissions", "Unbounded work"],
  prerequisites: [],
  workflows: [
    {
      id: "review-project",
      description: "Review the confirmed project.",
      scope: "project",
      frame: "fixed",
      examples: ["Review project C", "Review this repository"],
      promptTemplate: [
        "## Firstmate operating contract",
        "Use the confirmed project and supported Claude controls.",
        ...(profile === "pstack-workers" ? ["Worker brief appendix: pstack is not a plugin or a new engine."] : []),
        "",
        "Specification:",
        "{{intent}}",
        "",
        "Report evidence. Do not merge.",
      ].join("\n"),
    },
    {
      id: "review-fleet-status",
      description: "Read fleet status.",
      scope: "fleet",
      frame: "fixed",
      examples: ["Report fleet status", "Watch pending decisions"],
      promptTemplate: "Read fleet status. Do not start implementation workers.\n\n{{intent}}\n\nReport observations only.",
    },
  ],
})

const headless: CombinedGuideCatalog["native"][number]["headless"] = {
  schemaVersion: 1, prompt: false, outputFormats: [], eventContract: null, trellageEventContract: null,
  sessionId: "none", resume: false, resumeWithPrompt: false, questionToolControl: "none",
  changedFiles: "none", usage: false, cost: false, modelOverride: false, effortOverride: false,
  testedHarnessVersion: null,
}

const catalog: CombinedGuideCatalog = {
  schemaVersion: 1,
  sandboxCommandPath: "/fixture/trellage",
  sandbox: [],
  native: [
    ...profiles.map((profile) => ({
      launcher: "fmx", harness: "firstmate", name: profile, description: `Firstmate ${profile}`,
      headless, sandbox: false, herdrCompatibility: { status: "supported" as const },
      guide: guide(profile), commandPath: "/fixture/fmx", orchestration: orchestration(profile),
    })),
    {
      launcher: "cdx", harness: "codex", name: "reviewer", description: "Review the repository.",
      headless, sandbox: false, herdrCompatibility: { status: "supported" },
      guide: guide("default"), commandPath: "/fixture/cdx",
    },
  ],
}

const selectedProfile = (profile: Profile) => selectedProfileFromCatalogRef(catalog, `native:fmx/${profile}`, "review-project")
const advertisedProfile = (profile: Profile) => {
  const selected = selectedProfile(profile)
  if (selected.surface !== "native") throw new Error("The preparation fixture must be Native.")
  return { ...selected, orchestration: { ...orchestration(profile), preparation: { schemaVersion: 1 as const } } }
}
const recommendation = (profile: Profile, workflowId = "review-project"): GuideRecommendation =>
  enrichLiteralCandidate(catalog, {
    profileRef: `native:fmx/${profile}`, workflowId, confidence: 0.9,
    reason: "Use the selected workflow.", tradeoff: "Requires explicit fleet control.",
  })

const localTarget = (location = "/fixture/project-c"): GuideProjectTargetV1 => parseGuideProjectTargetV1({
  schemaVersion: 1, projectName: null, source: { kind: "local", location }, entryWorktree: location,
  baseRevision: "c".repeat(40), dirty: true, dirtyChanges: "excluded",
})

const fleet = (profile: Profile, state: "running" | "stopped" | "stale" = "running"): FirstmateFleetReadinessV1 =>
  parseFirstmateFleetReadinessV1({
    schemaVersion: 1,
    identity: {
      profile, instanceId: "a3534b44-ae7f-4d52-8b1e-38613611aa38",
      home: `/fixture/private-owned-fleet/${profile}`, sourceRevision: orchestration(profile).sourceRevision,
    },
    runtime: "ready", backend: "tmux", supervisor: { state, pid: state === "running" ? 412 : null },
    activeWorkers: state === "stale" ? 2 : 0,
    prerequisites: [{ id: "claude", ready: true, description: "Claude worker runtime is installed." }],
    consentRequired: false,
    actions: {
      start: state === "stopped" ? { allowed: true, reason: null } : { allowed: false, reason: "A fresh supervisor is not allowed." },
      recover: state === "running" ? { allowed: false, reason: "The owned supervisor is already running." } : { allowed: true, reason: null },
      submit: { allowed: true, reason: null },
    },
  })

const openSelection = (profile: Profile, workflowId = "review-project", base?: GuideUiState): GuideUiState => {
  const matched = base ?? guideUiReducer(createInitialGuideUiState(originalIntent), {
    type: Action.MatchSucceeded, recommendations: [recommendation(profile, workflowId)],
  })
  return guideUiReducer(matched, {
    type: Action.RecommendationsConfirm, selectedProfile: selectedProfile(profile),
    recommendation: recommendation(profile, workflowId),
  })
}

const confirmLocalTarget = (state: GuideUiState, target = localTarget()): GuideUiState => {
  const inspecting = guideUiReducer(state, { type: Action.TargetCurrent })
  const resolved = guideUiReducer(inspecting, {
    type: Action.TargetResolved, inspectionId: inspecting.targetInspectionId, target,
  })
  return guideUiReducer(resolved, { type: Action.TargetConfirm })
}

const generate = (state: GuideUiState, profile: Profile): GuideUiState => {
  const document = { ref: `native:fmx/${profile}`, guide: guide(profile), body: "Synthetic guide body." }
  const loaded = guideUiReducer(state, { type: Action.GenerateGuideLoaded, guideDocument: document })
  const prepared = prepareGuidePrompt(
    document.guide, state.selectedRecommendation!.workflowId, document.ref, state.intent!, guideUiTaskContext(state),
  )
  const candidate = (index: 0 | 1 | 2): GuideGenerateCandidate =>
    renderWorkflowBodyCandidate(prepared.workflow, { title: `Choice ${index + 1}`, prompt: bodies[index], notes: "Bounded work." })
  return guideUiReducer(loaded, { type: Action.GenerateSucceeded, candidates: [candidate(0), candidate(1), candidate(2)] })
}

const candidates = (profile: Profile, base?: GuideUiState): GuideUiState =>
  generate(confirmLocalTarget(openSelection(profile, "review-project", base)), profile)
const preparingCandidates = (profile: Profile): GuideUiState => ({ ...candidates(profile), selectedProfile: advertisedProfile(profile) })

const chooseAction = (state: GuideUiState, action: FirstmateGuideAction, readiness: FirstmateFleetReadinessV1): GuideUiState => {
  let chosen = guideUiReducer(state, { type: Action.CandidatesConfirm })
  chosen = guideUiReducer(chosen, { type: Action.FirstmateReadinessResolved, inspectionId: chosen.fleetReadinessId, fleet: readiness })
  const moves = (firstmateActionOptions.indexOf(action) - chosen.firstmateActionIndex + firstmateActionOptions.length) % firstmateActionOptions.length
  for (let index = 0; index < moves; index += 1) {
    chosen = guideUiReducer(chosen, { type: Action.FirstmateActionMove, delta: 1 })
  }
  return guideUiReducer(chosen, { type: Action.FirstmateActionConfirm })
}

const queued = (profile: Profile): GuideUiState => chooseAction(candidates(profile), "submit", fleet(profile))
const reopenCandidate = (state: GuideUiState): GuideUiState =>
  guideUiReducer(guideUiReducer(state, { type: Action.ForkSelect, index: 0 }), { type: Action.FirstmateActionBack })
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u

describe.each(profiles)("Firstmate %s request decisions", (profile) => {
  it("does not replace the new-allocation checkout root when an independent job chooses an existing destination", () => {
    let first = chooseAction(candidates(profile), "start", fleet(profile, "stopped"))
    first = guideUiReducer(first, {
      type: Action.QueuePlacementWorktree,
      placement: { kind: "new-worktree", branch: "first-branch", baseRef: "HEAD" },
      primaryCheckoutPath: "/fixture/checkout-a",
    })
    const other = profile === "default" ? "pstack-workers" : "default"
    let second = chooseAction({
      ...candidates(other), queue: first.queue, primaryCheckoutPath: first.primaryCheckoutPath,
    }, "start", fleet(other, "stopped"))
    second = guideUiReducer(second, {
      type: Action.QueuePlacementWorktree,
      placement: { kind: "existing-worktree", path: "/fixture/checkout-b/worktree" },
      primaryCheckoutPath: "/fixture/checkout-b",
    })
    expect(second.errorMessage).toBeUndefined()
    expect(second.queue.entries).toHaveLength(2)
    expect(second.primaryCheckoutPath).toBe("/fixture/checkout-a")
    expect(second.queue.entries[0]?.primaryCheckoutPath).toBe("/fixture/checkout-a")
    expect(second.queue.entries[1]?.primaryCheckoutPath).toBe("/fixture/checkout-b")
  })

  it("allows an explicit Herdr start choice when the new source has no live Herdr proof", () => {
    const untested = { ...recommendation(profile), herdrCompatibility: { status: "untested" } }
    const matched = guideUiReducer(createInitialGuideUiState(originalIntent), {
      type: Action.MatchSucceeded, recommendations: [untested],
    })
    const selected = guideUiReducer(matched, {
      type: Action.RecommendationsConfirm, selectedProfile: selectedProfile(profile), recommendation: untested,
    })
    const generated = generate(confirmLocalTarget(selected), profile)
    const state = chooseAction(generated, "start", fleet(profile, "stopped"))
    expect(state.stage).toBe(Stage.QueuePlacement)
    expect(state.firstmate?.action).toBe("start")
    expect(state.errorMessage).toBeUndefined()
    expect(state.selectedRecommendation?.herdrCompatibility.status).toBe("untested")
  })

  it("confirms a real target before generation, and keeps the original intent separate from the specification", () => {
    const selecting = openSelection(profile)
    expect(selecting.stage).toBe(Stage.TargetChoice)
    expect(guideUiReducer(selecting, { type: Action.TargetConfirm })).toBe(selecting)
    const state = queued(profile)
    const job = state.queue.entries[0]!
    expect(job.guideContext).toMatchObject({
      originalIntent, workflowId: "review-project", projectTarget: localTarget(),
    })
    expect(job.firstmate).toMatchObject({ action: "submit", requestId: expect.stringMatching(uuidPattern) })
    expect(job.placement).toEqual({ kind: "existing-fleet" })
    expect(job.command.args).toEqual([profile])
    expect(job.profile.headlessPrompt).toBe(false)
    expect(job.prompt.match(/## Firstmate request context/gu)).toHaveLength(1)
    expect(job.prompt).not.toContain("/fixture/private-owned-fleet")
    expect(publicGuideLaunchCommand(catalog, `native:fmx/${profile}`, job.prompt, "review-project")).toMatchObject({
      args: [profile], promptHandling: "manual-paste",
    })
  })

  it("accepts a registered project without fabricated Git fields, and null only for fleet workflows", () => {
    for (const projectName of ["registered-c", "MyProject", "my_project", "my.project"]) {
      let state = guideUiReducer(openSelection(profile), { type: Action.TargetEdit, mode: "registered" })
      state = guideUiReducer(state, { type: Action.EditorChange, text: projectName })
      state = guideUiReducer(state, { type: Action.TargetSubmit })
      expect(state.projectTargetConfirmed).toBe(false)
      state = guideUiReducer(state, { type: Action.TargetConfirm })
      expect(state.projectTarget).toMatchObject({
        projectName, source: null, entryWorktree: null, baseRevision: null, dirty: null, dirtyChanges: "excluded",
      })
      const queued = chooseAction(generate(state, profile), "submit", fleet(profile)).queue.entries[0]!
      expect(queued.guideContext?.projectTarget?.projectName).toBe(projectName)
    }
    const invalid = guideUiReducer({ ...openSelection(profile), stage: Stage.TargetConfirm }, { type: Action.TargetConfirm })
    expect(invalid.errorMessage).toContain("Confirm a project target")
    const fleetTarget = guideUiReducer(openSelection(profile, "review-fleet-status"), { type: Action.TargetConfirm })
    expect(fleetTarget).toMatchObject({ projectTarget: null, projectTargetConfirmed: true, stage: Stage.Generating })
    const job = chooseAction(generate(fleetTarget, profile), "submit", fleet(profile)).queue.entries[0]!
    expect(job.guideContext).toMatchObject({ workflowId: "review-fleet-status", projectTarget: null })
  })

  it.each([Action.CandidatesConfirm, Action.CandidatesEnqueue] as const)("requires an explicit action after %s, even when readiness permits Send", (type) => {
    const choice = guideUiReducer(candidates(profile), { type })
    expect(choice).toMatchObject({ stage: Stage.FirstmateAction, fleetReadinessPending: true, firstmate: undefined })
    const pending = guideUiReducer(choice, { type: Action.FirstmateActionConfirm })
    expect(pending.stage).toBe(Stage.FirstmateAction)
    expect(pending.errorMessage).toContain("No action was selected")
    expect(pending.queue.entries).toEqual([])
    const ready = guideUiReducer(pending, { type: Action.FirstmateReadinessResolved, inspectionId: pending.fleetReadinessId, fleet: fleet(profile) })
    expect(ready.firstmate).toBeUndefined()
    expect(ready.queue.entries).toEqual([])
    const moved = guideUiReducer(ready, { type: Action.FirstmateActionMove, delta: 1 })
    const refreshed = guideUiReducer(moved, { type: Action.FirstmateReadinessRefresh })
    const checked = guideUiReducer(refreshed, {
      type: Action.FirstmateReadinessResolved, inspectionId: refreshed.fleetReadinessId, fleet: fleet(profile),
    })
    const blocked = guideUiReducer(checked, { type: Action.FirstmateActionConfirm })
    expect(blocked.stage).toBe(Stage.FirstmateAction)
    expect(blocked.errorMessage).toBe("A fresh supervisor is not allowed.")
    let allowed = guideUiReducer(blocked, { type: Action.FirstmateActionMove, delta: -1 })
    allowed = guideUiReducer(allowed, { type: Action.FirstmateActionConfirm })
    expect(allowed.queue.entries).toHaveLength(1)
    expect(allowed.queue.entries[0]?.firstmate?.action).toBe("submit")
  })

  it("keeps a confirmed startup action when refreshed readiness permits Send instead", () => {
    const approved = chooseAction(candidates(profile), "start", fleet(profile, "stopped"))
    const pending = guideUiReducer(approved, { type: Action.QueuePlacementBack })
    const refreshed = guideUiReducer(pending, {
      type: Action.FirstmateReadinessResolved, inspectionId: pending.fleetReadinessId, fleet: fleet(profile),
    })
    expect(refreshed.firstmate).toBe(approved.firstmate)
    expect(refreshed.queue.entries).toEqual([])
    const blocked = guideUiReducer(refreshed, { type: Action.FirstmateActionConfirm })
    expect(blocked.stage).toBe(Stage.FirstmateAction)
    expect(blocked.errorMessage).toBe("A fresh supervisor is not allowed.")
    expect(blocked.firstmate).toBe(approved.firstmate)
    expect(blocked.queue.entries).toEqual([])
  })

  it.each(["start", "recover"] as const)("requires a Herdr destination for %s and keeps the same ID until the payload changes", (action) => {
    const state = chooseAction(candidates(profile), action, fleet(profile, action === "start" ? "stopped" : "stale"))
    expect(state.stage).toBe(Stage.QueuePlacement)
    expect(state.queue.entries).toEqual([])
    const jobState = guideUiReducer(state, { type: Action.QueuePlacementHere })
    const id = jobState.queue.entries[0]?.firstmate?.requestId
    expect(id).toBe(state.firstmate?.requestId)
    expect(() => buildGuideUiBatch(jobState, "/fixture/control", null, false)).toThrow("Herdr is unavailable")
    const reopened = guideUiReducer(jobState, { type: Action.ForkSelect, index: 0 })
    const repeated = guideUiReducer(reopened, { type: Action.QueuePlacementHere })
    expect(repeated.queue.entries).toHaveLength(1)
    expect(repeated.queue.entries[0]?.firstmate?.requestId).toBe(id)
    expect(buildGuideUiBatch(repeated, "/fixture/control", { workspaceId: "4", paneId: "4-2", surface: "pane" }, true).context)
      .toEqual({ cwd: "/fixture/control", workspaceId: "4", callerPaneId: "4-2" })
  })

  it("sends outside Herdr with only cwd, but does not relax Herdr requirements for mixed native work", () => {
    const state = queued(profile)
    expect(buildGuideUiBatch(state, "/fixture/control", null, false)).toEqual({
      jobs: state.queue.entries, context: { cwd: "/fixture/control" },
    })
    const normal = createQueuedGuideJob(8, {
      surface: "native", launcher: "cdx", profile: "reviewer", commandPath: "/fixture/cdx", headlessPrompt: false,
    }, "Review.", { kind: "new-tab" })
    expect(() => buildGuideUiBatch({ ...state, queue: { ...state.queue, entries: [...state.queue.entries, normal] } }, "/fixture/control", null, false))
      .toThrow("use Herdr for normal queued jobs")
  })

  it("requires explicit reuse of an earlier startup destination instead of allocating one supervisor per request", () => {
    const first = guideUiReducer(chooseAction(candidates(profile), "start", fleet(profile, "stopped")), { type: Action.QueuePlacementHere })
    const second = chooseAction(candidates(profile, guideUiReducer(first, { type: Action.QueueAddAnother })), "start", fleet(profile, "stopped"))
    expect(queuedFirstmateSupervisor(second)?.id).toBe(first.queue.entries[0]?.id)
    const conflict = guideUiReducer(second, {
      type: Action.QueuePlacementWorktree, placement: { kind: "new-worktree", branch: "worktree/another", baseRef: "main" },
      primaryCheckoutPath: "/fixture/repository",
    })
    expect(conflict.queue.entries).toHaveLength(1)
    expect(conflict.errorMessage).toContain("already sets this instance's supervisor destination")
    const shared = guideUiReducer(conflict, { type: Action.QueuePlacementReuse })
    expect(shared.queue.entries).toHaveLength(2)
    expect(shared.queue.entries[1]?.placement).toEqual(shared.queue.entries[0]?.placement)
    expect(shared.queue.entries[1]?.firstmate?.requestId).not.toBe(shared.queue.entries[0]?.firstmate?.requestId)
  })

  it("queues and reuses one current-terminal destination without requiring Herdr", () => {
    const started = chooseAction(candidates(profile), "start", fleet(profile, "stopped"))
    const first = guideUiReducer(started, { type: Action.QueuePlacementTerminal })
    const second = chooseAction(
      candidates(profile, guideUiReducer(first, { type: Action.QueueAddAnother })), "start", fleet(profile, "stopped"),
    )
    const shared = guideUiReducer(second, { type: Action.QueuePlacementReuse })
    expect(shared.queue.entries).toHaveLength(2)
    expect(shared.queue.entries.map(({ placement }) => placement)).toEqual([
      { kind: "current-terminal" }, { kind: "current-terminal" },
    ])
    expect(new Set(shared.queue.entries.map((job) => job.firstmate?.requestId)).size).toBe(2)
    expect(buildGuideUiBatch(shared, "/fixture/control", null, false).context).toEqual({ cwd: "/fixture/control" })
  })

  it.each([Action.CandidatesMove, Action.TargetOpen, Action.CandidatesBack] as const)("invalidates only the unsubmitted request and action after %s", (type) => {
    const state = queued(profile)
    const unrelated = createQueuedGuideJob(8, selectedProfile(profile), "Unrelated.", { kind: "new-tab" })
    const reopened = reopenCandidate({ ...state, queue: { ...state.queue, entries: [...state.queue.entries, unrelated] } })
    const edited = guideUiReducer(reopened, type === Action.CandidatesMove ? { type, delta: 1 } : { type })
    expect(edited.queue.entries).toEqual([unrelated])
    expect(edited.firstmate).toBeUndefined()
    expect(edited.readiness).toBeUndefined()
    expect(edited.originalIntent).toBe(originalIntent)
  })

  it("keeps fixed frames outside direct and queue editors, rejects empty edits, and requires a new action after a change", () => {
    const state = queued(profile)
    const edit = guideUiReducer(state, { type: Action.QueueEditStart })
    expect(edit.textDraft).toBe(bodies[0])
    const empty = guideUiReducer(guideUiReducer(edit, { type: Action.EditorChange, text: "  " }), { type: Action.QueueEditSubmit })
    expect(empty.stage).toBe(Stage.QueuePromptEditor)
    expect(empty.errorMessage).toContain("non-empty")
    expect(empty.queue.entries).toBe(state.queue.entries)
    const changed = guideUiReducer(guideUiReducer(edit, { type: Action.EditorChange, text: "Review only committed errors." }), { type: Action.QueueEditSubmit })
    expect(changed.stage).toBe(Stage.Candidates)
    expect(changed.queue.entries).toEqual([])
    expect(changed.firstmate).toBeUndefined()
    const candidate = changed.candidates![changed.candidateIndex]!
    const frame = workflowPromptFrame(state.queue.entries[0]!.guideContext!.workflow)
    expect(candidate.prompt).toBe(`${frame.beforeBody}Review only committed errors.${frame.afterBody}`)
    const next = chooseAction(changed, "submit", fleet(profile))
    expect(next.queue.entries[0]?.firstmate?.requestId).not.toBe(state.queue.entries[0]?.firstmate?.requestId)
    expect(next.queue.entries[0]?.guideContext?.originalIntent).toBe(originalIntent)
  })

  it("does not let an unconfirmed target throw through the reducer during queue placement", () => {
    const state = chooseAction(candidates(profile), "start", fleet(profile, "stopped"))
    const unsafe = { ...state, projectTargetConfirmed: false }
    const result = guideUiReducer(unsafe, { type: Action.QueuePlacementHere })
    expect(result.stage).toBe(Stage.QueuePlacement)
    expect(result.errorMessage).toContain("requires explicit confirmation")
    expect(result.queue.entries).toEqual([])
  })

  it.each(["done", "reconciling"] as const)("freezes accepted and uncertain payloads after execution starts (%s)", (phase) => {
    const state = queued(profile)
    const batch = buildGuideUiBatch(state, "/fixture/control", null, false)
    let launched = guideUiReducer(state, { type: Action.LaunchStart, batch })
    launched = guideUiReducer(launched, { type: Action.LaunchProgress, event: { jobId: 1, phase, detail: "Saved or uncertain; same request ID." } })
    const original = JSON.stringify(launched.launchBatch)
    const actions: ReadonlyArray<GuideUiAction> = [
      { type: Action.QueueEditStart }, { type: Action.QueueEditSubmit }, { type: Action.QueueRemove },
      { type: Action.EditorChange, text: "Changed." }, { type: Action.TargetOpen },
      { type: Action.CandidatesMove, delta: 1 }, { type: Action.FirstmateActionConfirm },
      { type: Action.FirstmateReadinessRefresh }, { type: Action.FirstmateInstallationReview },
      { type: Action.FirstmateInstallationMove }, { type: Action.FirstmateInstallationConfirm },
      { type: Action.ForkDrop }, { type: Action.ForkMain }, { type: Action.LaunchStart, batch },
      { type: Action.AugmentApply },
    ]
    for (const action of actions) expect(guideUiReducer(launched, action)).toBe(launched)
    expect(JSON.stringify(launched.launchBatch)).toBe(original)
  })
})

describe("Firstmate context lifetime", () => {
  it("ignores stale target inspection results after retargeting or fork replacement", () => {
    const first = guideUiReducer(openSelection("default"), { type: Action.TargetCurrent })
    const second = guideUiReducer(first, { type: Action.TargetCurrent })
    const stale = { type: Action.TargetResolved, inspectionId: first.targetInspectionId, target: localTarget("/fixture/old") } as const
    expect(guideUiReducer(second, stale)).toBe(second)
    expect(guideUiReducer(second, { type: Action.TargetFailed, inspectionId: first.targetInspectionId, message: "Old inspection failed." })).toBe(second)
    const changed = guideUiReducer(second, { type: Action.TargetResolved, inspectionId: second.targetInspectionId, target: localTarget("/fixture/new") })
    expect(changed.proposedProjectTarget?.entryWorktree).toBe("/fixture/new")
    const sibling = openSelection("pstack-workers", "review-project", guideUiReducer(first, { type: Action.ForkMain }))
    const delivered = guideUiReducer(sibling, { type: Action.ForkDeliver, forkId: first.activeForkId!, action: stale })
    expect(delivered.activeForkId).toBe(sibling.activeForkId)
    expect(delivered.projectTargetConfirmed).toBe(false)
    expect(forkState(delivered, first.activeForkId!)?.proposedProjectTarget).toEqual(localTarget("/fixture/old"))
    let main = guideUiReducer(sibling, { type: Action.ForkMain })
    main = guideUiReducer(main, { type: Action.PromptReviewOpen })
    main = guideUiReducer(main, { type: Action.PromptReviewEdit, editing: true })
    main = guideUiReducer(main, { type: Action.PromptReviewChange, text: "A different request." })
    main = guideUiReducer(main, { type: Action.PromptReviewSubmit })
    main = guideUiReducer(main, { type: Action.MatchSucceeded, recommendations: [recommendation("default")] })
    const replaced = openSelection("default", "review-project", main)
    expect(replaced.activeForkId).not.toBe(first.activeForkId)
    expect(guideUiReducer(replaced, { type: Action.ForkDeliver, forkId: first.activeForkId!, action: stale })).toBe(replaced)
  })

  it("retains exact original text through augmentation and both profile forks without sending fleet runtime data to models", () => {
    let state = guideUiReducer(createInitialGuideUiState(), { type: Action.IntentChange, text: originalIntent })
    state = guideUiReducer(state, { type: Action.AugmentOpen })
    state = guideUiReducer(state, { type: Action.AugmentConfirm })
    expect(state.augmentJob?.kind).toBe(GuideAugmentKind.Research)
    state = guideUiReducer(state, { type: Action.AugmentSucceeded, runId: state.augmentJob!.runId, text: "Generated research note." })
    state = guideUiReducer(state, { type: Action.IntentSubmit })
    expect(state.intent).toBe("Generated research note.")
    expect(state.originalIntent).toBe(originalIntent)
    state = guideUiReducer(state, { type: Action.MatchSucceeded, recommendations: profiles.map((profile) => recommendation(profile)) })
    const first = candidates("default", state)
    const second = candidates("pstack-workers", guideUiReducer(first, { type: Action.ForkMain }))
    const restored = guideUiReducer(second, { type: Action.ForkSelect, index: 0 })
    expect(guideUiTaskContext(restored).originalIntent).toBe(originalIntent)
    expect(guideUiTaskContext(second).originalIntent).toBe(originalIntent)
    const context = guideUiTaskContext({ ...restored, fleetReadiness: fleet("default") })
    expect(context).not.toHaveProperty("fleet")
    expect(JSON.stringify(context)).not.toContain("/fixture/private-owned-fleet")
  })

  it("rejects oversized paste without loss and checks the final framed direct edit against 8000 characters", () => {
    const state = candidates("default")
    const editing = guideUiReducer(state, { type: Action.CandidatesDirectEditStart })
    const dispatch = vi.fn()
    handleGuidePaste(editing, dispatch, "x".repeat(8001))
    const error = guideUiReducer(editing, dispatch.mock.calls[0]![0] as GuideUiAction)
    expect(error.textDraft).toBe(editing.textDraft)
    expect(error.errorMessage).toContain("Nothing was truncated or added")
    const oversized = guideUiReducer(guideUiReducer(editing, { type: Action.EditorChange, text: "x".repeat(7999) }), { type: Action.DirectEditSubmit })
    expect(oversized.stage).toBe(Stage.DirectEditor)
    expect(oversized.errorMessage).toContain("8000")
    expect(oversized.candidates).toBe(state.candidates)
  })

  it("does not replace original intent when an unchanged augmented prompt is accepted from the editor", () => {
    let state = guideUiReducer(createInitialGuideUiState(originalIntent), { type: Action.PromptReviewOpen })
    state = guideUiReducer(state, { type: Action.AugmentOpen })
    state = guideUiReducer(state, { type: Action.AugmentConfirm })
    state = guideUiReducer(state, { type: Action.AugmentSucceeded, runId: state.augmentJob!.runId, text: "Generated context, not a new human request." })
    state = guideUiReducer(state, { type: Action.PromptReviewEdit, editing: true })
    state = guideUiReducer(state, { type: Action.PromptReviewSubmit })
    expect(state.originalIntent).toBe(originalIntent)
    expect(state.intent).toBe("Generated context, not a new human request.")
  })

  it("discards stale readiness after refresh and requires new target confirmation after a workflow change", () => {
    const initial = guideUiReducer(candidates("default"), { type: Action.CandidatesConfirm })
    const refreshed = guideUiReducer(initial, { type: Action.FirstmateReadinessRefresh })
    expect(guideUiReducer(refreshed, {
      type: Action.FirstmateReadinessResolved, inspectionId: initial.fleetReadinessId, fleet: fleet("default"),
    })).toBe(refreshed)
    expect(refreshed.firstmate).toBeUndefined()
    const old = queued("default")
    const choosing = guideUiReducer(reopenCandidate(old), { type: Action.CandidatesBack })
    const changed = openSelection("default", "review-fleet-status", choosing)
    expect(changed).toMatchObject({
      stage: Stage.TargetConfirm, projectTargetConfirmed: false, firstmate: undefined, candidates: undefined,
    })
    expect(changed.queue.entries).toEqual([])
    const confirmed = guideUiReducer(changed, { type: Action.TargetConfirm })
    const submitted = chooseAction(generate(confirmed, "default"), "submit", fleet("default"))
    expect(submitted.queue.entries[0]?.guideContext).toMatchObject({ originalIntent, projectTarget: null, workflowId: "review-fleet-status" })
    expect(submitted.queue.entries[0]?.firstmate?.requestId).not.toBe(old.queue.entries[0]?.firstmate?.requestId)
  })
})

describe("Firstmate preparation decisions", () => {
  const preparedChoice = (readiness = missingToolsFleet()): GuideUiState => {
    const state = guideUiReducer(preparingCandidates("default"), { type: Action.CandidatesConfirm })
    return guideUiReducer(state, { type: Action.FirstmateReadinessResolved, inspectionId: state.fleetReadinessId, fleet: readiness })
  }

  it("prepares new requests only and preserves the exact prompt, target, workflow and candidate on refresh", () => {
    const before = preparingCandidates("default")
    expect(before.fleetReadinessOperation).toBeUndefined()
    const entered = guideUiReducer(before, { type: Action.CandidatesConfirm })
    expect(entered.fleetReadinessOperation).toEqual({ kind: "prepare" })
    const checked = guideUiReducer(entered, {
      type: Action.FirstmateReadinessResolved, inspectionId: entered.fleetReadinessId, fleet: preparedFleet(),
    })
    expect(checked.firstmate).toBeUndefined()
    expect(checked.queue.entries).toEqual([])
    const refreshed = guideUiReducer(checked, { type: Action.FirstmateReadinessRefresh })
    for (const field of ["originalIntent", "selectedOriginalIntent", "selectedProfile", "selectedRecommendation", "selectedCandidate", "projectTarget", "projectTargetConfirmed", "candidates"] as const) {
      expect(refreshed[field]).toBe(checked[field])
    }
    expect(refreshed.fleetReadinessOperation).toEqual({ kind: "prepare" })
    expect(refreshed.fleetReadinessId).toBe(checked.fleetReadinessId + 1)
    expect(refreshed.fleetRepairs).toEqual(["Reused the verified managed-tool cache."])
    const legacy = guideUiReducer(candidates("default"), { type: Action.CandidatesConfirm })
    expect(legacy.fleetReadinessOperation).toEqual({ kind: "inspect" })
  })

  it("uses read-only inventory after a queued identity is bound, including another draft for that fleet", () => {
    const queued = chooseAction(preparingCandidates("default"), "submit", preparedFleet("default", "running"))
    const original = queued.queue.entries[0]!
    const reopened = guideUiReducer(queued, { type: Action.ForkSelect, index: 0 })
    expect(reopened.fleetReadinessOperation).toEqual({ kind: "inspect" })
    expect(reopened.firstmate).toBe(original.firstmate)
    const another = guideUiReducer({
      ...preparingCandidates("default"), queue: queued.queue,
      selectedProfile: { ...advertisedProfile("default"), commandPath: "/fixture/other-source/fmx" },
    }, { type: Action.CandidatesConfirm })
    expect(another.fleetReadinessOperation).toEqual({ kind: "inspect" })
    const changedIdentity = {
      ...preparedFleet("default", "running"),
      identity: { ...preparedFleet().identity!, instanceId: "00000000-0000-4000-8000-000000000002" },
    }
    const checked = guideUiReducer(reopened, {
      type: Action.FirstmateReadinessResolved, inspectionId: reopened.fleetReadinessId, fleet: changedIdentity,
    })
    const refused = guideUiReducer(checked, { type: Action.FirstmateActionConfirm })
    expect(refused.errorMessage).toContain("owned fleet identity changed")
    expect(refused.queue.entries).toEqual([original])
    expect(refused.firstmate).toBe(original.firstmate)
    expect(guideUiReducer(refused, { type: Action.FirstmateInstallationReview }).fleetInstallationReview).toBeUndefined()
  })

  it("defaults installation review to Cancel and does not select a fleet action or request", () => {
    const state = preparedChoice()
    const review = guideUiReducer(state, { type: Action.FirstmateInstallationReview })
    expect(review.fleetInstallationReview?.choice).toBe("cancel")
    const cancelled = guideUiReducer(review, { type: Action.FirstmateInstallationConfirm })
    expect(cancelled.fleetInstallationReview).toBeUndefined()
    expect(cancelled.fleetReadinessPending).toBe(false)
    expect(cancelled.fleetReadinessId).toBe(state.fleetReadinessId)
    expect(cancelled.firstmate).toBeUndefined()
    expect(cancelled.queue).toBe(state.queue)
    const reviewed = guideUiReducer(cancelled, { type: Action.FirstmateInstallationReview })
    const approved = guideUiReducer(
      guideUiReducer(reviewed, { type: Action.FirstmateInstallationMove }),
      { type: Action.FirstmateInstallationConfirm },
    )
    expect(approved.fleetReadinessOperation).toMatchObject({
      kind: "install", approval: {
        commandPath: "/fixture/fmx", profile: "default", sourceRevision: preparationRevision, installation: preparationPlan,
      },
    })
    expect(approved).toMatchObject({ fleetReadinessPending: true, firstmate: undefined, fleetInstallationReview: undefined })
    expect(approved.queue).toBe(state.queue)
    const finished = guideUiReducer(approved, {
      type: Action.FirstmateReadinessResolved, inspectionId: approved.fleetReadinessId, fleet: preparedFleet(),
    })
    expect(finished.firstmate).toBeUndefined()
    expect(finished.queue).toBe(state.queue)
    expect(finished.fleetRepairs).toEqual([
      "Repaired the owned idle profile configuration.", "Reused the verified managed-tool cache.",
    ])
    expect(guideUiReducer(finished, { type: Action.FirstmateReadinessRefresh }).fleetReadinessOperation).toEqual({ kind: "prepare" })
  })

  it.each(["plan", "profile", "source", "workers"] as const)("invalidates package approval when %s changes", (change) => {
    const reviewed = guideUiReducer(preparedChoice(), { type: Action.FirstmateInstallationReview })
    const chosen = guideUiReducer(reviewed, { type: Action.FirstmateInstallationMove })
    const selected = advertisedProfile("default")
    const changed = change === "profile" ? { ...chosen, selectedProfile: advertisedProfile("pstack-workers") }
      : change === "source" ? { ...chosen, selectedProfile: { ...selected, orchestration: { ...selected.orchestration, sourceRevision: "a".repeat(40) } } }
      : {
          ...chosen,
          fleetReadiness: {
            ...chosen.fleetReadiness!,
            ...(change === "workers" ? { activeWorkers: 1 } : {
              preparation: {
                ...chosen.fleetReadiness!.preparation!,
                installation: { ...preparationPlan, identity: "e".repeat(64) },
              },
            }),
          },
        }
    const result = guideUiReducer(changed, { type: Action.FirstmateInstallationConfirm })
    expect(result.fleetReadinessPending).toBe(false)
    expect(result.fleetInstallationReview).toBeUndefined()
    expect(result.errorMessage).toContain("changed")
    expect(result.firstmate).toBeUndefined()
    expect(result.queue.entries).toEqual([])
  })

  it("rejects old results after refresh or leaving the menu, without clearing the current failure or repair report", () => {
    const first = guideUiReducer(preparingCandidates("default"), { type: Action.CandidatesConfirm })
    const refreshed = guideUiReducer(first, { type: Action.FirstmateReadinessRefresh })
    const stale: GuideUiAction = { type: Action.FirstmateReadinessResolved, inspectionId: first.fleetReadinessId, fleet: preparedFleet() }
    expect(guideUiReducer(refreshed, stale)).toBe(refreshed)
    const failed = guideUiReducer(refreshed, {
      type: Action.FirstmateReadinessFailed, inspectionId: refreshed.fleetReadinessId,
      message: "Preparation stopped after a lock refusal.", fleet: missingToolsFleet(),
    })
    const moved = guideUiReducer(failed, { type: Action.FirstmateActionMove, delta: 1 })
    expect(moved.fleetReadinessError).toBe("Preparation stopped after a lock refusal.")
    expect(moved.fleetRepairs).toEqual(["Repaired the owned idle profile configuration."])
    expect(guideUiReducer(moved, { type: Action.FirstmateInstallationReview }).fleetInstallationReview).toBeUndefined()
    expect(guideUiReducer(moved, { type: Action.FirstmateActionConfirm }).firstmate).toBeUndefined()
    const retry = guideUiReducer(moved, { type: Action.FirstmateReadinessRefresh })
    const left = guideUiReducer(retry, { type: Action.FirstmateActionBack })
    expect(left.fleetReadinessPending).toBe(false)
    expect(guideUiReducer(left, {
      type: Action.FirstmateReadinessResolved, inspectionId: retry.fleetReadinessId, fleet: preparedFleet(),
    })).toBe(left)
  })

  it("forgets unconfirmed package approval when the fork is parked", () => {
    const reviewed = guideUiReducer(preparedChoice(), { type: Action.FirstmateInstallationReview })
    const id = reviewed.activeForkId!
    const parked = guideUiReducer(
      guideUiReducer(reviewed, { type: Action.FirstmateInstallationMove }),
      { type: Action.ForkMain },
    )
    expect(forkState(parked, id)?.fleetInstallationReview).toBeUndefined()
    const restored = guideUiReducer(parked, { type: Action.ForkSelect, index: 0 })
    expect(restored.fleetReadinessOperation).toEqual({ kind: "prepare" })
    expect(restored.firstmate).toBeUndefined()
  })
})

class TestInput extends Socket {
  isTTY = true
  isRaw = false
  override _read(): void {}
  setRawMode(mode: boolean): this { this.isRaw = mode; return this }
}

class TestOutput extends Socket {
  isTTY = true
  columns = 160
  rows = 48
  readonly frames: string[] = []
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const value = stripVTControlCharacters(chunk.toString("utf8"))
    if (value.trim().length > 0) this.frames.push(value)
    callback()
  }
  clearLine(direction: Direction, callback?: () => void): boolean { return clearLine(this, direction, callback) }
  clearScreenDown(callback?: () => void): boolean { return clearScreenDown(this, callback) }
  cursorTo(x: number, y?: number | (() => void), callback?: () => void): boolean {
    return typeof y === "function" ? cursorTo(this, x, undefined, y) : cursorTo(this, x, y, callback)
  }
  moveCursor(x: number, y: number, callback?: () => void): boolean { return moveCursor(this, x, y, callback) }
  getColorDepth(): number { return 1 }
  hasColors(): boolean { return false }
  getWindowSize(): [number, number] { return [this.columns, this.rows] }
}

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((accept) => { resolve = accept })
  return { promise, resolve }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.mocked(executeGuideBatch).mockReset()
})

const response = (stdout: string): CommandRunResult => ({ stdout, stderr: "", exitCode: 0 })
const modelConfig = { model: "synthetic-only", effort: GuideEffort.Low }
const recordingArtifactCache = () => {
  const cache = new GuideArtifactCache({
    cwd: "/unused",
    routing: { match: modelConfig, generate: modelConfig, optimize: modelConfig, refine: modelConfig, enrich: modelConfig },
    prompts: { match: "Match", generate: "Generate", optimize: "Optimize", refine: "Refine", enrich: "Enrich" },
  })
  const match = vi.spyOn(cache, "match").mockImplementation((_input, produce) => produce())
  const generation = vi.spyOn(cache, "generation").mockImplementation((_input, produce) => produce())
  const refinement = vi.spyOn(cache, "refinement").mockImplementation((_input, produce) => produce())
  return { cache, match, generation, refinement }
}
const herdr: HerdrEnvironment = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "4", HERDR_PANE_ID: "4-2" }
const fakeProvider = (profile: Profile, workflowId: string) => ({
  match: vi.fn<GuideProvider["match"]>(async () => ({
    candidates: [
      { profileRef: `native:fmx/${profile}`, workflowId, confidence: 0.9, reason: "Requested workflow.", tradeoff: "Needs explicit approval." },
      { profileRef: `native:fmx/${profile === "default" ? "pstack-workers" : "default"}`, workflowId, confidence: 0.8, reason: "Alternative.", tradeoff: "Worker appendix differs." },
      { profileRef: "native:cdx/reviewer", workflowId: "review-project", confidence: 0.7, reason: "Focused review.", tradeoff: "No fleet." },
    ],
  })),
  generate: vi.fn<GuideProvider["generate"]>(async () => ({
    candidates: bodies.map((prompt, index) => ({ title: `Choice ${index + 1}`, prompt, notes: "Synthetic bounded request." })),
  })),
  refine: vi.fn<GuideProvider["refine"]>(async (input) => ({
    candidate: { ...input.candidate, prompt: "Review committed error boundaries." },
  })),
  optimize: vi.fn<GuideProvider["optimize"]>(async (input) => ({ candidates: input.candidates })),
})

interface MountOptions {
  readonly profile?: Profile
  readonly workflowId?: string
  readonly initialIntent?: string
  readonly herdrEnv?: HerdrEnvironment
  readonly inventory?: (profile: Profile, options?: CommandRunOptions) => Promise<FirstmateFleetReadinessV1>
  readonly prepare?: (profile: Profile, args: ReadonlyArray<string>, options?: CommandRunOptions) => Promise<FirstmateFleetReadinessV1>
  readonly advertisedPreparation?: boolean
  readonly cache?: GuideArtifactCache
  readonly columns?: number
  readonly rows?: number
  readonly strict?: boolean
  readonly gitRoot?: (cwd: string) => Promise<string>
  readonly legacy?: boolean
  readonly inbox?: boolean
  readonly generationFailure?: boolean
  readonly instances?: InstanceRunner
  readonly creationStore?: MemoryCreationPlans
  readonly launchOrigin?: FirstmateInstanceControlContextV1
  readonly cwd?: string
}

const syntheticFirstmateControl = async (
  profile: Profile,
  options: MountOptions,
  args: ReadonlyArray<string>,
  commandOptions: CommandRunOptions | undefined,
  submissions: FirstmateSubmissionRequestV1[],
): Promise<CommandRunResult> => {
  if (args[0] === "prepare") {
    const readiness = await (options.prepare?.(profile, args, commandOptions) ?? Promise.resolve(preparedFleet(profile)))
    return response(preparationInventory(readiness))
  }
  if (args[0] === "inventory") {
    if (options.legacy) return response(JSON.stringify({ schemaVersion: 1, launcher: "fmx", profile, readiness: "healthy" }))
    const readiness = await (options.inventory?.(profile, commandOptions) ?? Promise.resolve(fleet(profile)))
    return response(JSON.stringify({ schemaVersion: 1, launcher: "fmx", profile, readiness: "busy", fleet: readiness }))
  }
  if (args[0] !== "submit" || !options.inbox) throw new Error(`Unexpected synthetic Firstmate operation: ${args[0]}`)
  if (commandOptions?.stdin === undefined) throw new Error("The synthetic inbox requires JSON on stdin.")
  const request = parseFirstmateSubmissionRequestV1(JSON.parse(commandOptions.stdin))
  submissions.push(request)
  return response(JSON.stringify({
    schemaVersion: 1, requestId: request.requestId, digest: firstmateSubmissionDigest(request),
    fleet: request.expectedFleet, state: "saved", noteId: `captain-${request.requestId}`,
    announcement: "sent", supervisorState: "stopped", error: null,
  }))
}

const mountedCatalog = (options: MountOptions): CombinedGuideCatalog => {
  const prepared = options.advertisedPreparation ? {
    ...catalog,
    native: catalog.native.map((entry) => entry.orchestration === undefined ? entry : {
      ...entry, orchestration: { ...entry.orchestration, preparation: { schemaVersion: 1 as const } },
    }),
  } : catalog
  return options.instances === undefined ? prepared : {
    ...prepared, native: prepared.native.map((entry) => entry.launcher === "fmx" && entry.name === "default"
      ? { ...entry, orchestration: instanceOrchestration } : entry),
  }
}
const mountedCwd = (options: MountOptions): string =>
  options.cwd ?? (options.instances === undefined ? "/fixture/source-a" : "/work/alpha")

const mount = async (options: MountOptions = {}) => {
  const profile = options.profile ?? "default"
  const provider = fakeProvider(profile, options.workflowId ?? "review-project")
  if (options.generationFailure) provider.generate.mockRejectedValue(new Error("Synthetic generation unavailable."))
  const stdin = new TestInput()
  const stdout = new TestOutput()
  stdout.columns = options.columns ?? stdout.columns
  stdout.rows = options.rows ?? stdout.rows
  const stderr = new TestOutput()
  const submissions: FirstmateSubmissionRequestV1[] = []
  const run = vi.fn<CommandRunner["run"]>(async (executable, args, commandOptions) => {
    if (executable === "/fixture/fmx") {
      if (options.instances !== undefined) return options.instances.run(executable, args, commandOptions)
      const requested = args[1] === "default" || args[1] === "pstack-workers" ? args[1] : profile
      return syntheticFirstmateControl(requested, options, args, commandOptions, submissions)
    }
    if (executable !== "git") throw new Error(`Unexpected synthetic command: ${executable} ${args.join(" ")}`)
    const cwd = args[args.indexOf("-C") + 1]!
    if (args.includes("--show-toplevel")) return response(await (options.gitRoot?.(cwd) ?? Promise.resolve(cwd)))
    if (args.includes("status")) return response(" M uncommitted.txt\n")
    if (args.includes("HEAD")) return response("c".repeat(40))
    throw new Error(`Unexpected synthetic git arguments: ${args.join(" ")}`)
  })
  const advertisedCatalog = mountedCatalog(options)
  const component = React.createElement(GuideApp, {
    catalog: options.legacy ? legacyFirstmateCatalog(catalog) : advertisedCatalog,
    guideRoot: "/unused", provider, runner: { run }, cwd: mountedCwd(options),
    routing: { match: modelConfig, generate: modelConfig, optimize: modelConfig, refine: modelConfig, enrich: modelConfig },
    herdrEnv: options.herdrEnv ?? {}, herdrAvailabilityProbe: options.herdrEnv !== undefined,
    initialIntent: options.initialIntent ?? originalIntent,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.instances === undefined ? {} : { firstmateCreationStore: options.creationStore ?? new MemoryCreationPlans() }),
    ...(options.launchOrigin === undefined ? {} : { launchOrigin: options.launchOrigin }),
  })
  const app = render(options.strict ? React.createElement(React.StrictMode, undefined, component) : component, {
    stdin, stdout, stderr, debug: true, interactive: true, patchConsole: false,
  })
  const exited = app.waitUntilExit()
  cleanups.push(async () => {
    app.unmount()
    await exited
    app.cleanup()
    stdin.destroy()
    stdout.destroy()
    stderr.destroy()
  })
  const screen = () => stdout.frames.at(-1) ?? ""
  const press = async (key: string) => {
    stdin.push(key)
    await new Promise<void>((resolve) => setImmediate(resolve))
    await app.waitUntilRenderFlush()
  }
  const waitFor = async (text: string) => vi.waitFor(() => expect(screen()).toContain(text))
  const paste = (value: string) => press(`\u001b[200~${value}\u001b[201~`)
  if (options.initialIntent !== "") await waitFor("Profile recommendations")
  return { app, exited, screen, press, paste, waitFor, provider, run, submissions }
}

const chooseTargetInUi = async (tui: Awaited<ReturnType<typeof mount>>, mode: "current" | "path" | "registered") => {
  const generationCount = tui.provider.generate.mock.calls.length
  await tui.press("\r")
  await tui.waitFor("Select the Firstmate project")
  await tui.press(mode === "current" ? "c" : mode === "path" ? "p" : "n")
  if (mode !== "current") {
    await tui.paste(mode === "path" ? "/fixture/project-c" : "registered-c")
    await tui.press("\r")
  }
  await tui.waitFor("Confirm Firstmate target")
  expect(tui.provider.generate).toHaveBeenCalledTimes(generationCount)
  await tui.press("\r")
  await tui.waitFor("Command:")
}

const enterFleetChoice = async (tui: Awaited<ReturnType<typeof mount>>) => {
  await tui.press("\r")
  await tui.waitFor("Choose a Firstmate action")
}

const selectSend = async (tui: Awaited<ReturnType<typeof mount>>) => {
  await enterFleetChoice(tui)
  await tui.waitFor("Supervisor: running")
  await tui.press("\r")
  await tui.waitFor("Batch queue.")
}

const reviewInstanceInUi = async (tui: Awaited<ReturnType<typeof mount>>, other = false) => {
  await tui.waitFor("Choose a Firstmate instance")
  await tui.waitFor(alpha.reference.instanceId)
  if (other) await tui.press("j")
  await tui.press("\r")
  await tui.waitFor("Confirm Firstmate instance")
  await tui.press("j")
  await tui.press("\r")
}
const registeredTargetAfterInstance = async (tui: Awaited<ReturnType<typeof mount>>, name = "registered-c") => {
  await tui.waitFor("Select the Firstmate project")
  await tui.press("n")
  await tui.paste(name)
  await tui.press("\r")
  await tui.waitFor("Confirm Firstmate target")
  await tui.press("\r")
  await tui.waitFor("Command:")
}
const completeRecordedQueue = async (tui: Awaited<ReturnType<typeof mount>>): Promise<GuideBatch> => {
  vi.mocked(executeGuideBatch).mockResolvedValue({ result: { entries: [] }, exitCode: 0 })
  await tui.press("\r")
  await vi.waitFor(() => expect(executeGuideBatch).toHaveBeenCalledTimes(1))
  return vi.mocked(executeGuideBatch).mock.calls[0]![0]
}

describe("named Firstmate instance keyboard flow", () => {
  it.each(["ready", "failed"] as const)("keeps the editor and bound request after a cancelled refresh returns %s", async (outcome) => {
    const instances = new InstanceRunner()
    const tui = await mount({
      instances, rows: 24, columns: 80,
      cwd: `${beta.root}/runtime`, launchOrigin: instanceProfile(beta).firstmateInstanceContext!,
    })
    await tui.press("\r")
    await reviewInstanceInUi(tui, true)
    await registeredTargetAfterInstance(tui)
    await tui.press("j")
    await enterFleetChoice(tui)
    await tui.waitFor("Preparation: ready.")
    const pending = deferred<void>()
    instances.reply = async ({ executable, args }) => {
      if (args[0] !== "prepare") return undefined
      await pending.promise
      if (outcome === "failed") throw new CommandRunnerError({
        kind: "exited", executable, args, exitCode: 1, stdout: "",
        stderr: "Late cancelled refresh failure.", message: "Preparation exited.",
      })
      return response(preparationInventory(instances.fleets.get(beta.reference.instanceId)!))
    }
    await tui.press("r")
    await tui.waitFor("Preparing: checking")
    const preparations = () => instances.calls.filter(({ args }) => args[0] === "prepare")
    expect(preparations()).toHaveLength(2)
    const cancelled = preparations()[1]!
    expect(cancelled.options?.signal?.aborted).toBe(false)
    await tui.press("b")
    await tui.waitFor("Command:")
    expect(cancelled.options?.signal?.aborted).toBe(true)
    await tui.press("e")
    await tui.waitFor("Edit prompt")
    instances.reply = undefined
    pending.resolve(undefined)
    await tui.press("")
    expect(tui.screen()).toContain("Edit prompt")
    expect(tui.screen()).not.toContain("Choose a Firstmate action")
    expect(tui.screen()).not.toContain("Late cancelled refresh failure.")
    expect(preparations()).toHaveLength(2)
    expect(instances.submissions).toEqual([])
    expect(executeGuideBatch).not.toHaveBeenCalled()
    await tui.press("\u001b")
    await tui.waitFor("Command:")
    await selectSend(tui)
    const queued = await completeRecordedQueue(tui)
    expect(queued.jobs[0]?.profile).toMatchObject({ firstmateInstance: beta.reference })
    expect(queued.jobs[0]?.guideContext).toMatchObject({
      originalIntent, workflowId: "review-project", projectTarget: { projectName: "registered-c" },
    })
    expect(queued.jobs[0]?.prompt).toContain(bodies[1])
    expect(tui.provider.generate).toHaveBeenCalledTimes(1)
    expect(preparations()).toHaveLength(3)
    expect(preparations().every(({ args }) => args[args.indexOf("--instance") + 1] === beta.reference.instanceId)).toBe(true)
    expect(preparations().every(({ options }) => options?.cwd === "/work/alpha")).toBe(true)
  })

  it("reviews an instance before preparation and preserves manual blocked focus on refresh at 80x24", async () => {
    const instances = new InstanceRunner()
    const tui = await mount({
      instances, rows: 24, columns: 80,
      cwd: `${beta.root}/runtime`, launchOrigin: instanceProfile(beta).firstmateInstanceContext!,
    })
    await tui.press("\r")
    await tui.waitFor("Choose a Firstmate instance")
    expect(tui.provider.generate).not.toHaveBeenCalled()
    expect(instances.calls.every(({ args }) => args[0] === "instances")).toBe(true)
    await reviewInstanceInUi(tui)
    await registeredTargetAfterInstance(tui)
    await enterFleetChoice(tui)
    await tui.waitFor("Supervisor: running")
    expect(instances.calls.filter(({ args }) => args[0] === "prepare")).toHaveLength(1)
    expect(instances.calls.find(({ args }) => args[0] === "prepare")?.options?.cwd).toBe("/work/alpha")
    await tui.press("k")
    await tui.press("k")
    await tui.press("r")
    await vi.waitFor(() => expect(instances.calls.filter(({ args }) => args[0] === "prepare")).toHaveLength(2))
    await tui.press("\r")
    expect(executeGuideBatch).not.toHaveBeenCalled()
    expect(instances.submissions).toEqual([])
    await tui.press("k")
    await tui.press("\r")
    await tui.waitFor("Batch queue.")
    const queued = await completeRecordedQueue(tui)
    expect(queued.jobs[0]?.profile).toMatchObject({ firstmateInstance: alpha.reference })
    expect(queued.jobs[0]?.firstmate?.action).toBe("submit")
    expect(queued.jobs[0]?.guideContext?.originalIntent).toBe(originalIntent)
    expect(queued.jobs[0]?.guideContext?.projectTarget?.projectName).toBe("registered-c")
    expect(tui.provider.generate).toHaveBeenCalledTimes(1)
    expect(tui.provider.generate.mock.calls[0]?.[0].orchestration).not.toHaveProperty("taskIdPrefix")
  })

  it("queues two default instances without suppressing preparation for the second UUID", async () => {
    const instances = new InstanceRunner()
    const tui = await mount({ instances })
    await tui.press("\r")
    await reviewInstanceInUi(tui)
    await registeredTargetAfterInstance(tui)
    await selectSend(tui)
    await tui.press("a")
    await tui.waitFor("Profile recommendations")
    await tui.press("\r")
    await reviewInstanceInUi(tui, true)
    await registeredTargetAfterInstance(tui, "registered-d")
    await selectSend(tui)
    const queued = await completeRecordedQueue(tui)
    expect(queued.jobs.map(({ profile }) => profile.surface === "native" ? profile.firstmateInstance : undefined))
      .toEqual([alpha.reference, beta.reference])
    expect(queued.jobs.map(({ guideContext }) => guideContext?.projectTarget?.projectName)).toEqual(["registered-c", "registered-d"])
    expect(new Set(queued.jobs.map(({ firstmate }) => firstmate?.requestId)).size).toBe(2)
    expect(instances.calls.filter(({ args }) => args[0] === "prepare").map(({ args }) => args[args.indexOf("--instance") + 1]))
      .toEqual([alpha.reference.instanceId, beta.reference.instanceId])
    expect(instances.submissions).toEqual([])
  })

  it("keeps the chosen specification, workflow, and target during an instance-only change", async () => {
    const instances = new InstanceRunner()
    const cache = recordingArtifactCache()
    const tui = await mount({ instances, cache: cache.cache })
    await tui.press("\r")
    await reviewInstanceInUi(tui)
    await registeredTargetAfterInstance(tui)
    await tui.press("j")
    await tui.press("f")
    await reviewInstanceInUi(tui, true)
    await tui.waitFor("Prompt candidates")
    await selectSend(tui)
    const queued = await completeRecordedQueue(tui)
    expect(tui.provider.generate).toHaveBeenCalledTimes(1)
    expect(cache.generation).toHaveBeenCalledTimes(1)
    expect(queued.jobs[0]?.profile).toMatchObject({ firstmateInstance: beta.reference })
    expect(queued.jobs[0]?.guideContext).toMatchObject({
      originalIntent, workflowId: "review-project", projectTarget: { projectName: "registered-c" },
    })
    expect(queued.jobs[0]?.prompt).toContain(bodies[1])
    for (const privateValue of [alpha.reference.instanceId, beta.reference.instanceId, alpha.root, beta.root]) {
      expect(JSON.stringify(tui.provider.generate.mock.calls)).not.toContain(privateValue)
      expect(JSON.stringify(cache.generation.mock.calls.map(([input]) => input))).not.toContain(privateValue)
    }
  })

  it("aborts discovery on leaving and ignores a late result without binding an instance", async () => {
    const instances = new InstanceRunner()
    const pending = deferred<CommandRunResult>()
    instances.reply = async ({ args }) => args[1] === "list" ? pending.promise : undefined
    const tui = await mount({ instances })
    await tui.press("\r")
    await vi.waitFor(() => expect(instances.calls).toHaveLength(1))
    await tui.press("b")
    await tui.press("b")
    await tui.waitFor("Profile recommendations")
    expect(instances.calls[0]?.options?.signal?.aborted).toBe(true)
    pending.resolve(instances.ok(instanceList([alpha, beta])))
    await tui.press("")
    expect(tui.provider.generate).not.toHaveBeenCalled()
    expect(instances.calls.every(({ args }) => args[0] === "instances")).toBe(true)
    expect(instances.submissions).toEqual([])
  })
})

describe.each(profiles)("Firstmate %s keyboard flow", (profile) => {
  it("focuses allowed Send after refresh without approving or sending work", async () => {
    const pending = deferred<FirstmateFleetReadinessV1>()
    const refused = { allowed: false, reason: "The synthetic fleet action gate is blocked." }
    const blocked = parseFirstmateFleetReadinessV1({
      ...fleet(profile), actions: { start: refused, recover: refused, submit: refused },
    })
    const inventory = vi.fn<NonNullable<MountOptions["inventory"]>>()
      .mockResolvedValueOnce(blocked).mockReturnValueOnce(pending.promise)
    const tui = await mount({ profile, inventory })
    await chooseTargetInUi(tui, "path")
    await enterFleetChoice(tui)
    await tui.waitFor("Supervisor: running")
    await tui.press("r")
    await vi.waitFor(() => expect(inventory).toHaveBeenCalledTimes(2))
    pending.resolve(fleet(profile))
    await tui.waitFor("Send work to the existing owned fleet · allowed")
    expect(executeGuideBatch).not.toHaveBeenCalled()
    expect(tui.submissions).toEqual([])
    await tui.press("\r")
    await tui.waitFor("Batch queue.")
    vi.mocked(executeGuideBatch).mockImplementation(async (batch) => ({
      exitCode: 1,
      result: { entries: [{ job: batch.jobs[0]!, status: "not-submitted", stage: "submission", message: "Synthetic inbox result." }] },
    }))
    await tui.press("L")
    await tui.exited
    const batch = vi.mocked(executeGuideBatch).mock.calls[0]![0]
    expect(batch.jobs).toHaveLength(1)
    expect(batch.jobs[0]).toMatchObject({
      firstmate: { action: "submit", expectedFleet: fleet(profile).identity },
      guideContext: { originalIntent, projectTarget: localTarget(), workflowId: "review-project" },
    })
    expect(tui.provider.generate).toHaveBeenCalledTimes(1)
    expect(tui.submissions).toEqual([])
  })

  it.each(["initial", "refresh"] as const)("keeps manual Recover focus through pending %s readiness", async (phase) => {
    const pending = deferred<FirstmateFleetReadinessV1>()
    const readiness = fleet(profile, "stopped")
    const inventory = vi.fn<NonNullable<MountOptions["inventory"]>>()
    if (phase === "refresh") inventory.mockResolvedValueOnce(readiness)
    inventory.mockReturnValueOnce(pending.promise)
    const tui = await mount({ profile, inventory, herdrEnv: herdr })
    await chooseTargetInUi(tui, "current")
    await enterFleetChoice(tui)
    if (phase === "refresh") {
      await tui.waitFor("Supervisor: stopped")
      await tui.press("r")
    }
    await vi.waitFor(() => expect(inventory).toHaveBeenCalledTimes(phase === "refresh" ? 2 : 1))
    await tui.press("j")
    pending.resolve(readiness)
    await tui.waitFor("Recover fleet · allowed")
    expect(executeGuideBatch).not.toHaveBeenCalled()
    expect(tui.submissions).toEqual([])
    await tui.press("\r")
    await tui.waitFor("Choose the supervisor destination")
    await tui.press("\r")
    await tui.waitFor("Batch queue.")
    vi.mocked(executeGuideBatch).mockImplementation(async (batch) => ({
      exitCode: 1,
      result: { entries: [{ job: batch.jobs[0]!, status: "not-submitted", stage: "submission", message: "Synthetic inbox result." }] },
    }))
    await tui.press("L")
    await tui.exited
    const batch = vi.mocked(executeGuideBatch).mock.calls[0]![0]
    expect(batch.jobs).toHaveLength(1)
    expect(batch.jobs[0]).toMatchObject({
      firstmate: { action: "recover", expectedFleet: readiness.identity },
      placement: { kind: "current-workspace-pane", direction: "right" },
      guideContext: { originalIntent, projectTarget: localTarget("/fixture/source-a"), workflowId: "review-project" },
    })
    expect(tui.provider.generate).toHaveBeenCalledTimes(1)
    expect(tui.submissions).toEqual([])
  })

  it.each(["start", "recover"] as const)("saves before a guarded current-terminal %s through the public keyboard flow", async (action) => {
    const actual = await vi.importActual<typeof import("../src/guide-batch.ts")>("../src/guide-batch.ts")
    const journal = firstmateMemoryJournal()
    vi.mocked(executeGuideBatch).mockImplementation((batch, services) =>
      actual.executeGuideBatch(batch, { ...services, firstmateJournal: journal.journal }))
    const readiness = fleet(profile, action === "start" ? "stopped" : "stale")
    const tui = await mount({ profile, inventory: async () => readiness, inbox: true })
    await chooseTargetInUi(tui, "path")
    await enterFleetChoice(tui)
    await tui.waitFor(`Supervisor: ${readiness.supervisor.state}`)
    await tui.press("\r")
    await tui.waitFor("Use the current terminal after saving requests")
    await tui.press("j")
    await tui.press("j")
    await tui.press("\r")
    await tui.waitFor("Batch queue.")
    expect(tui.submissions).toEqual([])
    await tui.press("L")
    const result = await tui.exited as GuideUiResult
    if (result.action !== "batch") throw new Error("The public Firstmate terminal route must use a durable batch.")
    expect(result.result.firstmateTerminalHandoff).toMatchObject({
      kind: "current-terminal", status: "handoff-ready", action, expectedFleet: readiness.identity,
    })
    expect(tui.submissions).toHaveLength(1)
    expect(tui.submissions[0]).toMatchObject({
      originalIntent, projectTarget: localTarget(), workflowId: "review-project", expectedFleet: readiness.identity,
    })
    const runInteractive = vi.fn(async () => {
      expect([...journal.entries.values()].map(({ status }) => status)).toEqual(["accepted"])
      expect(tui.submissions).toHaveLength(1)
    })
    const output: string[] = []
    expect(await executeGuideUiResult(result, { runner: { run: tui.run }, runInteractive, write: (text) => output.push(text) })).toBe(0)
    expect(runInteractive).toHaveBeenCalledExactlyOnceWith({
      executable: "/fixture/fmx", args: [profile, "--fmx-expected-fleet-json", JSON.stringify(readiness.identity)],
    }, { cwd: "/fixture/source-a", env: expect.objectContaining({ TRELLAGE_AUTOMATION: "1" }) })
    expect(tui.submissions).toHaveLength(1)
    expect(tui.run.mock.calls.some(([executable]) => executable === "herdr")).toBe(false)
    expect(output.join("")).toContain("Current-terminal handoff ready")
    expect(output.join("")).toContain("Dispatch and task completion are not confirmed")
    expect(output.join("")).not.toContain(originalIntent)
    expect(output.join("")).not.toContain(tui.submissions[0]!.generatedSpec)
  })

  it("keeps the legacy target, original intent and edited specification in the public current-terminal manual-paste route", async () => {
    const tui = await mount({ profile, legacy: true })
    await chooseTargetInUi(tui, "path")
    await tui.press("e")
    await tui.waitFor("Edit prompt")
    expect(tui.screen()).not.toContain("## Original human intent")
    await tui.paste(" Include caller evidence.")
    await tui.press("\r")
    await tui.waitFor("Command:")
    await tui.press("\r")
    await tui.waitFor("This terminal")
    await tui.press("\r")
    const result = await tui.exited as GuideUiResult
    if (result.action !== "current-terminal") throw new Error("Legacy Firstmate must retain its manual-paste terminal route.")
    expect(result.promptHandling).toBe("manual-paste")
    expect(result.command.args).toEqual([profile])
    expect(result.legacyFirstmate).toMatchObject({
      originalIntent, projectTarget: localTarget(), workflowId: "review-project", projectTargetConfirmed: true,
    })
    expect(result.prompt).toContain(originalIntent)
    expect(result.prompt).toContain("Include caller evidence.")
    expect(result.prompt).toContain('"entryWorktree": "/fixture/project-c"')
    expect(result.prompt.length).toBeLessThanOrEqual(8000)
    const output: string[] = []
    const runInteractive = vi.fn(async () => { expect(output.join("")).toContain(result.prompt) })
    expect(await executeGuideUiResult(result, { runner: { run: tui.run }, runInteractive, write: (text) => output.push(text) })).toBe(0)
    expect(runInteractive).toHaveBeenCalledTimes(1)
    expect(executeGuideBatch).not.toHaveBeenCalled()
    expect(tui.submissions).toEqual([])
    expect(tui.run.mock.calls.every(([executable, args]) => executable === "git" || args[0] === "inventory")).toBe(true)
  })

  it.each(["current", "path", "registered"] as const)("uses the %s target and the one-entry inbox path outside Herdr", async (mode) => {
    const tui = await mount({ profile })
    await chooseTargetInUi(tui, mode)
    const projectTarget = mode === "registered"
      ? registeredGuideProjectTarget("registered-c")
      : localTarget(mode === "current" ? "/fixture/source-a" : "/fixture/project-c")
    expect(tui.provider.generate.mock.calls[0]?.[0]).toMatchObject({ originalIntent, projectTarget })
    await selectSend(tui)
    const queuedId = tui.screen().match(uuidPattern.source.replace("^", "").replace("$", ""))?.[0]
    expect(queuedId).toMatch(uuidPattern)
    expect(executeGuideBatch).not.toHaveBeenCalled()
    expect(tui.screen()).not.toContain("This terminal")
    vi.mocked(executeGuideBatch).mockImplementation(async (batch) => ({
      exitCode: 1,
      result: { entries: [{ job: batch.jobs[0]!, status: "not-submitted", stage: "submission", message: "Synthetic inbox result." }] },
    }))
    await tui.press("L")
    const result = await tui.exited as GuideUiResult
    expect(result.action).toBe("batch")
    expect(executeGuideBatch).toHaveBeenCalledTimes(1)
    const batch = vi.mocked(executeGuideBatch).mock.calls[0]![0]
    expect(batch.context).toEqual({ cwd: "/fixture/source-a" })
    expect(batch.jobs).toHaveLength(1)
    expect(batch.jobs[0]).toMatchObject({
      firstmate: { action: "submit", requestId: queuedId },
      command: { executable: "/fixture/fmx", args: [profile] },
      guideContext: { originalIntent, projectTarget, workflowId: "review-project" },
    })
    expect(tui.run.mock.calls.every(([executable, args]) => executable === "git" || args[0] === "inventory")).toBe(true)
    expect(tui.run.mock.calls.filter(([executable]) => executable === "herdr")).toEqual([])
    expect(JSON.stringify(tui.provider.generate.mock.calls)).not.toContain("/fixture/private-owned-fleet")
    expect(JSON.stringify(tui.provider.optimize.mock.calls)).not.toContain("instanceId")
  })

  it.each(["start", "recover"] as const)("offers %s only after its explicit action and Herdr destination confirmation", async (action) => {
    const readiness = fleet(profile, action === "start" ? "stopped" : "stale")
    const tui = await mount({ profile, herdrEnv: herdr, inventory: async () => readiness })
    await chooseTargetInUi(tui, "current")
    await enterFleetChoice(tui)
    await tui.waitFor(`Supervisor: ${readiness.supervisor.state}`)
    await tui.press("\r")
    await tui.waitFor("Choose the supervisor destination")
    expect(executeGuideBatch).not.toHaveBeenCalled()
    expect(tui.run.mock.calls.every(([executable, args]) => executable === "git" || args[0] === "inventory")).toBe(true)
    await tui.press("\r")
    await tui.waitFor("Batch queue.")
    vi.mocked(executeGuideBatch).mockImplementation(async (batch) => ({
      exitCode: 1, result: { entries: [{ job: batch.jobs[0]!, status: "not-submitted", stage: "submission", message: "Synthetic inbox result." }] },
    }))
    await tui.press("L")
    await tui.exited
    const batch = vi.mocked(executeGuideBatch).mock.calls[0]![0]
    expect(batch.context).toEqual({ cwd: "/fixture/source-a", workspaceId: "4", callerPaneId: "4-2" })
    expect(batch.jobs[0]?.firstmate?.action).toBe(action)
    expect(batch.jobs[0]?.placement).toEqual({ kind: "current-workspace-pane", direction: "right" })
    expect(batch.jobs[0]?.command.args).toEqual([profile])
  })

  it("keeps fleet readiness out of refinement and optimization after the action screen is visited", async () => {
    const tui = await mount({ profile })
    await chooseTargetInUi(tui, "registered")
    await enterFleetChoice(tui)
    await tui.waitFor("Supervisor: running")
    await tui.press("b")
    await tui.waitFor("Command:")
    await tui.press("r")
    await tui.waitFor("Refinement feedback")
    await tui.paste("Keep the scope small.")
    await tui.press("\r")
    await tui.waitFor("Command:")
    expect(tui.provider.refine).toHaveBeenCalledTimes(1)
    expect(tui.provider.refine.mock.calls[0]?.[0]).toMatchObject({
      originalIntent, projectTarget: registeredGuideProjectTarget("registered-c"), candidate: { prompt: bodies[0] },
    })
    expect(JSON.stringify(tui.provider.refine.mock.calls)).not.toContain("/fixture/private-owned-fleet")
    expect(JSON.stringify(tui.provider.optimize.mock.calls)).not.toContain("instanceId")
    expect(executeGuideBatch).not.toHaveBeenCalled()
  })
})

describe("Firstmate preparation keyboard flow", () => {
  it.each([false, true])("prepares once per menu entry and never during generation (strict=%s)", async (strict) => {
    const pending = deferred<FirstmateFleetReadinessV1>()
    const prepare = vi.fn<NonNullable<MountOptions["prepare"]>>().mockReturnValueOnce(pending.promise)
      .mockResolvedValue(preparedFleet())
    const tui = await mount({ advertisedPreparation: true, prepare, strict })
    await chooseTargetInUi(tui, "registered")
    expect(prepare).not.toHaveBeenCalled()
    expect(tui.run.mock.calls.filter(([, args]) => args[0] === "prepare")).toEqual([])
    await enterFleetChoice(tui)
    await tui.waitFor("Preparing: checking and repairing")
    expect(prepare).toHaveBeenCalledTimes(1)
    for (const key of ["j", "k", "\u001b[6~", "\u001b[5~"]) await tui.press(key)
    expect(prepare).toHaveBeenCalledTimes(1)
    await tui.press("\r")
    await tui.waitFor("No action was selected")
    expect(tui.submissions).toEqual([])
    pending.resolve(preparedFleet())
    await tui.waitFor("Preparation: ready.")
    await tui.waitFor("Reported repair: Reused the verified managed-tool cache.")
    expect(tui.screen()).toContain("Recover fleet · allowed")
    expect(executeGuideBatch).not.toHaveBeenCalled()
    await tui.press("r")
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
    await tui.waitFor("Preparation: ready.")
    expect(tui.run.mock.calls.filter(([, args]) => args[0] === "prepare").map(([, args]) => args)).toEqual([
      ["prepare", "default", "--json", "--expected-source-revision", preparationRevision],
      ["prepare", "default", "--json", "--expected-source-revision", preparationRevision],
    ])
    expect(tui.run.mock.calls.every(([executable, args]) => executable === "git" || args[0] === "prepare")).toBe(true)
  })

  it("keeps a legacy backend inspect-only and shows skipped checks instead of failed authentication", async () => {
    const base = preparedFleet()
    const blocked = { allowed: false, reason: "Runtime drift; repair the managed runtime before checking worker prerequisites." }
    const { preparation: _preparation, ...old } = base
    const inventory = parseFirstmateFleetReadinessV1({
      ...old, runtime: "drift",
      prerequisites: [
        { id: "claude", ready: false, description: "Claude authentication" },
        { id: "github", ready: false, description: "GitHub authentication" },
      ],
      actions: { start: blocked, recover: blocked, submit: blocked },
    })
    const prepare = vi.fn<NonNullable<MountOptions["prepare"]>>()
    const tui = await mount({ inventory: async () => inventory, prepare })
    await chooseTargetInUi(tui, "current")
    await enterFleetChoice(tui)
    await tui.waitFor("not checked · claude: Claude authentication")
    expect(tui.screen()).toContain("not checked · github: GitHub authentication")
    expect(tui.screen()).not.toContain("blocked · claude")
    expect(tui.screen()).toContain("run /fixture/fmx doctor default")
    await tui.press("r")
    await vi.waitFor(() => expect(tui.run.mock.calls.filter(([, args]) => args[0] === "inventory")).toHaveLength(2))
    await tui.waitFor("not checked · claude")
    expect(prepare).not.toHaveBeenCalled()
    expect(executeGuideBatch).not.toHaveBeenCalled()
  })

  it("reviews the exact plan, cancels without mutation, and binds explicit installation to the current plan", async () => {
    let plan = preparationPlan
    const prepare = vi.fn<NonNullable<MountOptions["prepare"]>>(async (profile, args) => {
      const approved = args.indexOf("--install-prerequisites")
      if (approved < 0) return missingToolsFleet(profile, plan)
      expect(args[approved + 1]).toBe(plan.identity)
      return preparedFleet(profile)
    })
    const tui = await mount({ advertisedPreparation: true, prepare })
    await chooseTargetInUi(tui, "path")
    await enterFleetChoice(tui)
    await tui.waitFor("Missing managed tools: herdr 0.14.0, bv 0.9.3.")
    expect(tui.screen()).not.toContain("inventory never installs")
    expect(tui.screen()).toContain("ready · claude")
    expect(tui.screen()).toContain("ready · github")
    await tui.press("i")
    await tui.waitFor("Review managed-tool installation")
    for (const line of firstmateInstallationPlanLines({
      commandPath: "/fixture/fmx", profile: "default", sourceRevision: preparationRevision, installation: plan,
    })) expect(tui.screen()).toContain(line)
    expect(tui.screen()).toContain("❯ Cancel")
    await tui.press("\r")
    await tui.waitFor("Choose a Firstmate action")
    expect(prepare).toHaveBeenCalledTimes(1)
    await tui.press("i")
    await tui.press("j")
    await tui.waitFor("❯ Install listed managed tools")
    plan = {
      ...preparationPlan, identity: "e".repeat(64), destination: "/fixture/private-managed-tools/revised",
      tools: [{ name: "herdr", version: "0.15.0" }, { name: "bv", version: "0.9.3" }],
    }
    await tui.press("r")
    await tui.waitFor("Missing managed tools: herdr 0.15.0, bv 0.9.3.")
    expect(prepare).toHaveBeenCalledTimes(2)
    await tui.press("i")
    await tui.waitFor("❯ Cancel")
    expect(tui.screen()).toContain(plan.identity)
    expect(tui.screen()).toContain(plan.destination)
    await tui.press("\u001b")
    await tui.waitFor("Choose a Firstmate action")
    expect(prepare).toHaveBeenCalledTimes(2)
    await tui.press("i")
    await tui.press("j")
    await tui.press("\r")
    await tui.waitFor("Preparation: ready.")
    expect(prepare).toHaveBeenCalledTimes(3)
    expect(tui.run.mock.calls.filter(([, args]) => args[0] === "prepare").map(([, args]) => args)).toEqual([
      ["prepare", "default", "--json", "--expected-source-revision", preparationRevision],
      ["prepare", "default", "--json", "--expected-source-revision", preparationRevision],
      ["prepare", "default", "--json", "--expected-source-revision", preparationRevision, "--install-prerequisites", plan.identity],
    ])
    expect(tui.screen()).toContain("Reported repair: Repaired the owned idle profile configuration.")
    expect(tui.screen()).toContain("Recover fleet · allowed")
    expect(tui.screen()).not.toContain("Batch queue.")
    expect(tui.submissions).toEqual([])
    expect(executeGuideBatch).not.toHaveBeenCalled()
    await tui.press("b")
    await tui.waitFor("Command:")
    await tui.press("e")
    await tui.waitFor("Edit prompt")
    expect(tui.screen()).toContain(bodies[0])
    expect(tui.provider.generate).toHaveBeenCalledTimes(1)
    expect(tui.provider.generate.mock.calls[0]?.[0]).toMatchObject({
      originalIntent, projectTarget: localTarget(), workflowId: "review-project",
    })
  })

  it("keeps errors and reported repairs visible after a nonzero result, and retries only on r", async () => {
    const prepare = vi.fn<NonNullable<MountOptions["prepare"]>>().mockRejectedValueOnce(new CommandRunnerError({
      kind: "exited", executable: "/fixture/fmx", args: ["prepare", "default"], exitCode: 9,
      stdout: preparationInventory(missingToolsFleet()), stderr: "Managed lock changed; recheck the current plan.",
      message: "Preparation exited.",
    })).mockResolvedValue(preparedFleet())
    const tui = await mount({ advertisedPreparation: true, prepare })
    await chooseTargetInUi(tui, "registered")
    await enterFleetChoice(tui)
    await tui.waitFor("Firstmate preparation failed (exit 9)")
    expect(tui.screen()).toContain("Reported repair: Repaired the owned idle profile configuration.")
    expect(tui.screen()).toContain("Recover fleet · not checked")
    await tui.press("j")
    await tui.waitFor("Managed lock changed; recheck the current plan.")
    await tui.press("i")
    await tui.waitFor("No current managed-tool plan")
    expect(tui.screen()).not.toContain("Review managed-tool installation")
    await tui.press("\r")
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(executeGuideBatch).not.toHaveBeenCalled()
    await tui.press("r")
    await tui.waitFor("Preparation: ready.")
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(tui.screen()).not.toContain("Firstmate preparation failed")
    expect(tui.screen()).toContain("Reported repair: Repaired the owned idle profile configuration.")
  })

  it("aborts replaced and cancelled generations and ignores late results", async () => {
    const old = deferred<FirstmateFleetReadinessV1>()
    const next = deferred<FirstmateFleetReadinessV1>()
    const prepare = vi.fn<NonNullable<MountOptions["prepare"]>>()
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise).mockResolvedValue(preparedFleet())
    const tui = await mount({ advertisedPreparation: true, prepare })
    await chooseTargetInUi(tui, "current")
    await enterFleetChoice(tui)
    await tui.waitFor("Preparing: checking")
    await tui.press("r")
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
    expect(prepare.mock.calls[0]?.[2]?.signal?.aborted).toBe(true)
    old.resolve(missingToolsFleet())
    await tui.press("j")
    expect(tui.screen()).toContain("Preparing: checking")
    expect(tui.screen()).not.toContain("needs package-install approval")
    await tui.press("b")
    await tui.waitFor("Command:")
    expect(prepare.mock.calls[1]?.[2]?.signal?.aborted).toBe(true)
    next.resolve(missingToolsFleet())
    await enterFleetChoice(tui)
    await tui.waitFor("Preparation: ready.")
    expect(prepare).toHaveBeenCalledTimes(3)
    expect(tui.screen()).not.toContain("needs package-install approval")
    expect(executeGuideBatch).not.toHaveBeenCalled()
  })

  it("aborts a parked profile's preparation instead of repairing in the background", async () => {
    const old = deferred<FirstmateFleetReadinessV1>()
    const prepare = vi.fn<NonNullable<MountOptions["prepare"]>>((profile) =>
      profile === "default" ? old.promise : Promise.resolve(preparedFleet(profile)))
    const tui = await mount({ advertisedPreparation: true, prepare })
    await chooseTargetInUi(tui, "current")
    await enterFleetChoice(tui)
    await tui.waitFor("Preparing: checking")
    await tui.press("`")
    await tui.waitFor("Profile recommendations")
    expect(prepare.mock.calls[0]?.[2]?.signal?.aborted).toBe(true)
    await tui.press("j")
    await chooseTargetInUi(tui, "registered")
    await enterFleetChoice(tui)
    await tui.waitFor("Identity: owned (pstack-workers)")
    old.resolve(missingToolsFleet())
    await tui.press("j")
    expect(tui.screen()).toContain("Preparation: ready.")
    expect(tui.screen()).not.toContain("Missing managed tools")
    expect(prepare.mock.calls.map(([profile]) => profile)).toEqual(["default", "pstack-workers"])
  })

  it("aborts an approved installation when the user leaves, without selecting or submitting work", async () => {
    const installing = deferred<FirstmateFleetReadinessV1>()
    const prepare = vi.fn<NonNullable<MountOptions["prepare"]>>().mockResolvedValueOnce(missingToolsFleet())
      .mockReturnValueOnce(installing.promise)
    const tui = await mount({ advertisedPreparation: true, prepare })
    await chooseTargetInUi(tui, "registered")
    await enterFleetChoice(tui)
    await tui.waitFor("needs package-install approval")
    await tui.press("i")
    await tui.press("j")
    await tui.press("\r")
    await tui.waitFor("Installing approved managed tools")
    await tui.press("q")
    expect((await tui.exited as GuideUiResult).action).toBe("cancel")
    expect(prepare.mock.calls[1]?.[2]?.signal?.aborted).toBe(true)
    installing.resolve(preparedFleet())
    expect(tui.submissions).toEqual([])
    expect(executeGuideBatch).not.toHaveBeenCalled()
  })

  it("allows manual Send work when preparation is blocked for active workers and keeps queued requests inspect-only", async () => {
    const live = parseFirstmateFleetReadinessV1({
      ...preparedFleet("default", "running"), activeWorkers: 3,
      preparation: { schemaVersion: 1, state: "blocked", diagnostic: "Maintenance is blocked while workers are active.", repairs: [], installation: null },
    })
    const { preparation: _preparation, ...inspection } = live
    const tui = await mount({ advertisedPreparation: true, prepare: async () => live, inventory: async () => inspection })
    await chooseTargetInUi(tui, "current")
    await enterFleetChoice(tui)
    await tui.waitFor("Preparation: blocked.")
    expect(tui.screen()).toContain("Send work to the existing owned fleet · allowed")
    await tui.press("\r")
    await tui.waitFor("Batch queue.")
    expect(executeGuideBatch).not.toHaveBeenCalled()
    await tui.press("1")
    await tui.waitFor("Read-only inspection. No source or home repair.")
    await tui.press("r")
    await vi.waitFor(() => expect(tui.run.mock.calls.filter(([, args]) => args[0] === "inventory")).toHaveLength(2))
    expect(tui.run.mock.calls.filter(([, args]) => args[0] === "prepare")).toHaveLength(1)
    expect(tui.submissions).toEqual([])
  })

  it("keeps installation plans and live preparation data out of model calls and artifact-cache inputs", async () => {
    const recording = recordingArtifactCache()
    const tui = await mount({
      advertisedPreparation: true, prepare: async () => missingToolsFleet(), cache: recording.cache,
    })
    await chooseTargetInUi(tui, "registered")
    await enterFleetChoice(tui)
    await tui.waitFor("needs package-install approval")
    await tui.press("i")
    await tui.waitFor("Review managed-tool installation")
    await tui.press("b")
    await tui.press("b")
    await tui.waitFor("Command:")
    await tui.press("r")
    await tui.paste("Keep the scope small.")
    await tui.press("\r")
    await tui.waitFor("Command:")
    expect(tui.provider.refine).toHaveBeenCalledTimes(1)
    expect(recording.refinement).toHaveBeenCalledTimes(1)
    const recorded = JSON.stringify([
      ...Object.values(tui.provider).map((method) => method.mock.calls),
      recording.match.mock.calls, recording.generation.mock.calls, recording.refinement.mock.calls,
    ])
    for (const secret of [preparationPlan.identity, preparationPlan.destination, ...preparationPlan.sources, ...preparationPlan.statePaths, "instanceId", "fleetReadiness", "fleetInstallationReview"]) {
      expect(recorded).not.toContain(secret)
    }
    expect(tui.provider.refine.mock.calls[0]?.[0]).toMatchObject({
      originalIntent, projectTarget: registeredGuideProjectTarget("registered-c"),
    })
  })

  it.each([false, true])("keeps controls visible at 80x24 while details and the plan scroll (capture=%s)", async (capture) => {
    const tui = await mount({
      advertisedPreparation: true, prepare: async () => missingToolsFleet(), columns: 80, rows: 24,
      ...(capture ? {
        herdrEnv: {
          HERDR_ENV: "1",
          TRELLAGE_GUIDE_HERDR_CONTEXT_JSON: JSON.stringify({
            schemaVersion: 1, surface: "popup", workspaceId: "4", paneId: "4-2", cwd: "/fixture/source-a",
            capture: { source: "terminal", confidence: "snapshot" },
          }),
        },
      } : {}),
    })
    await chooseTargetInUi(tui, "current")
    await enterFleetChoice(tui)
    await tui.waitFor("i review tools")
    expect(tui.screen()).toContain("PgUp/PgDn details")
    expect(tui.screen().trimEnd().split("\n").length).toBeLessThanOrEqual(24)
    await tui.press("i")
    await tui.waitFor("Review managed-tool installation")
    expect(tui.screen()).toContain("b/Esc cancel")
    await tui.press("\u001b[6~")
    await tui.waitFor("No global npm packages, hooks, or authentication changes.")
    expect(tui.screen()).toContain("Enter confirm")
    expect(tui.screen().trimEnd().split("\n").length).toBeLessThanOrEqual(24)
    await tui.press("\u001b")
    await tui.waitFor("Choose a Firstmate action")
    expect(tui.screen()).toContain("PgUp/PgDn details")
  })
})

describe("Firstmate keyboard safety", () => {
  it.each([
    { legacy: false, length: 60_000 },
    { legacy: true, length: 4_000 },
  ])("keeps the complete original input in the bounded fallback path (legacy=$legacy)", async ({ legacy, length }) => {
    const intent = `Review the selected Firstmate project.\r\n${"Keep this requirement. ".repeat(3000)}`.slice(0, length)
    const tui = await mount({ legacy, initialIntent: intent, generationFailure: true })
    await tui.press("\r")
    await tui.waitFor("Select the Firstmate project")
    await tui.press("n")
    await tui.paste("MyProject")
    await tui.press("\r")
    await tui.waitFor("Confirm Firstmate target")
    await tui.press("\r")
    await tui.waitFor("Synthetic generation unavailable.")
    await tui.press("t")
    await tui.waitFor("Command:")
    expect(tui.provider.generate).toHaveBeenCalledTimes(1)
    expect(tui.provider.optimize).not.toHaveBeenCalled()
    if (legacy) {
      await tui.press("c")
      const result = await tui.exited as GuideUiResult
      if (result.action !== "print") throw new Error("Legacy fallback must support a complete paste artifact.")
      expect(result.prompt).toContain(intent)
      expect(result.prompt).toContain('"projectName": "MyProject"')
      expect(result.prompt.length).toBeLessThanOrEqual(8000)
      expect(result.prompt.match(/## Original human intent \(unchanged\)/gu)).toHaveLength(1)
      expect(result.notice).toContain("Complete legacy Firstmate")
      return
    }
    await selectSend(tui)
    vi.mocked(executeGuideBatch).mockImplementation(async (batch) => ({
      exitCode: 1,
      result: { entries: [{ job: batch.jobs[0]!, status: "not-submitted", stage: "submission", message: "Synthetic result." }] },
    }))
    await tui.press("L")
    await tui.exited
    const job = vi.mocked(executeGuideBatch).mock.calls[0]![0].jobs[0]!
    expect(job.guideContext?.originalIntent).toBe(intent)
    expect(job.prompt).not.toContain(intent)
    expect(job.prompt.length).toBeLessThanOrEqual(8000)
  })

  it("shows pending and blocked choices with distinct runtime, backend, prerequisites, consent, and supervisor states", async () => {
    const pending = deferred<FirstmateFleetReadinessV1>()
    const tui = await mount({ inventory: () => pending.promise })
    await chooseTargetInUi(tui, "current")
    await enterFleetChoice(tui)
    await tui.waitFor("Readiness check pending")
    await tui.press("\r")
    await tui.waitFor("No action was selected")
    const blocked = parseFirstmateFleetReadinessV1({
      ...fleet("default", "stopped"), backend: null, consentRequired: true,
      prerequisites: [{ id: "claude", ready: false, description: "Install and authorize Claude explicitly." }],
      actions: {
        start: { allowed: false, reason: "Startup requires prior host consent." },
        recover: { allowed: false, reason: "Recovery requires a backend and worker prerequisites." },
        submit: { allowed: false, reason: "No owned supervisor is running." },
      },
    })
    pending.resolve(blocked)
    await tui.waitFor("Supervisor: stopped")
    for (const line of firstmateFleetStatusLines(blocked)) expect(tui.screen()).toContain(line)
    await tui.press("\r")
    await tui.waitFor("Startup requires prior host consent.")
    expect(tui.screen()).toContain("Choose a Firstmate action")
    await tui.press("j")
    await tui.press("\r")
    await tui.waitFor("Recovery requires a backend and worker prerequisites.")
    expect(executeGuideBatch).not.toHaveBeenCalled()
    expect(tui.run.mock.calls.filter(([, args]) => args[0] === "inventory")).toHaveLength(1)
  })

  it("shows oversized paste errors in the intent and prompt editors", async () => {
    const tui = await mount({ initialIntent: "" })
    await tui.paste("x".repeat(60001))
    await tui.waitFor("Pasted text exceeds 60000")
    expect(tui.provider.match).not.toHaveBeenCalled()
    await tui.paste("Review the confirmed project.")
    await tui.press("\r")
    await tui.waitFor("Profile recommendations")
    await tui.press("p")
    await tui.press("e")
    await tui.paste("x".repeat(60001))
    await tui.waitFor("Pasted text exceeds 60000")
    expect(tui.provider.match).toHaveBeenCalledTimes(1)
  })

  it("shows direct and queue edit errors, keeps the prior request unchanged, and never silently accepts an empty edit", async () => {
    const tui = await mount()
    await chooseTargetInUi(tui, "current")
    await tui.press("e")
    await tui.waitFor("Edit prompt")
    await tui.paste("x".repeat(8001))
    await tui.waitFor("Pasted text exceeds 8000")
    for (const _character of bodies[0]) await tui.press("\u007f")
    await tui.paste("x".repeat(7900))
    await tui.press("\r")
    await tui.waitFor("final generated specification")
    expect(tui.screen()).toContain("8000")
    await tui.press("\u001b")
    await tui.waitFor("Command:")
    await selectSend(tui)
    const id = tui.screen().match(uuidPattern.source.replace("^", "").replace("$", ""))?.[0]
    await tui.press("e")
    await tui.waitFor("Edit queued prompt")
    for (const _character of bodies[0]) await tui.press("\u007f")
    await tui.press("\r")
    await tui.waitFor("Enter a non-empty specification")
    expect(tui.screen()).toContain("Edit queued prompt")
    await tui.paste("x".repeat(7900))
    await tui.press("\r")
    await tui.waitFor("final generated specification")
    await tui.press("\u001b")
    await tui.waitFor("Batch queue.")
    expect(tui.screen()).toContain(id)
    expect(executeGuideBatch).not.toHaveBeenCalled()
  })

  it("does not let a late inspection for the current repository replace an explicitly selected repository", async () => {
    const old = deferred<string>()
    const tui = await mount({ gitRoot: (cwd) => cwd === "/fixture/source-a" ? old.promise : Promise.resolve(cwd) })
    await tui.press("\r")
    await tui.press("c")
    await tui.waitFor("Inspecting the selected repository")
    await tui.press("p")
    await tui.paste("/fixture/project-c")
    await tui.press("\r")
    await tui.waitFor("Confirm Firstmate target")
    expect(tui.screen()).toContain("/fixture/project-c")
    old.resolve("/fixture/source-a")
    await tui.press("\r")
    await tui.waitFor("Command:")
    expect(tui.provider.generate.mock.calls[0]?.[0].projectTarget).toEqual(localTarget())
    expect(tui.provider.generate).toHaveBeenCalledTimes(1)
  })

  it("freezes the one-entry queue while saving and does not execute a second batch after input", async () => {
    const pending = deferred<{ readonly exitCode: number; readonly result: GuideBatchExecutionResult }>()
    let captured: GuideBatch | undefined
    vi.mocked(executeGuideBatch).mockImplementation((batch, services) => {
      captured = batch
      services.onProgress?.({ jobId: batch.jobs[0]!.id, phase: "saving", detail: "Saving the immutable request." })
      return pending.promise
    })
    const tui = await mount({
      advertisedPreparation: true,
      prepare: async () => preparedFleet("default", "running"),
    })
    await chooseTargetInUi(tui, "current")
    await selectSend(tui)
    await tui.press("L")
    await tui.waitFor("Queue frozen")
    const payload = JSON.stringify(captured)
    for (const key of ["e", "x", "t", "L", "1", "\r", "\t"]) await tui.press(key)
    expect(JSON.stringify(captured)).toBe(payload)
    expect(executeGuideBatch).toHaveBeenCalledTimes(1)
    expect(tui.run.mock.calls.filter(([, args]) => args[0] === "prepare")).toHaveLength(1)
    expect(tui.screen()).toContain("not dispatched or completed")
    expect(tui.screen()).toContain("do not paste or submit a new ID")
    pending.resolve({
      exitCode: 1,
      result: { entries: [{ job: captured!.jobs[0]!, status: "not-submitted", stage: "submission", message: "Synthetic result." }] },
    })
    expect((await tui.exited as GuideUiResult).action).toBe("batch")
  })
})
