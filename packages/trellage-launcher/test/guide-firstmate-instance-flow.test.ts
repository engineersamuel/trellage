import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm, lstat, readdir, symlink } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  canonicalFirstmateInstanceJson, firstmateWorktreeBindingDigest, parseFirstmateInstanceDescriptorV1,
  parseFirstmateSubmissionRequestV1, firstmateInstanceKey, parseFirstmateFleetReadinessV1,
} from "@trellage/guide-core"
import {
  initialFirstmateInstanceMenu, pauseFirstmateInstanceMenu, reduceFirstmateInstanceMenu,
  runFirstmateInstanceMenuOperation, firstmateLaunchOrigin,
  type FirstmateInstanceMenuState, type FirstmateInstanceMenuEnvironment,
} from "../src/guide-firstmate-instance-menu.ts"
import { createFirstmateInstanceContext, firstmateInstanceControlArgs } from "../src/guide-firstmate-instance-selection.ts"
import { FileFirstmateCreationPlanStore } from "../src/guide-firstmate-creation-store.ts"
import { createFirstmateJournalFactory, FileFirstmateSubmissionJournal } from "../src/guide-firstmate-journal.ts"
import { createQueuedGuideJob, executeGuideBatch, type QueuedGuideJob } from "../src/guide-batch.ts"
import { FirstmateSubmissionClient } from "../src/guide-firstmate.ts"
import { CommandRunnerError } from "../src/guide-launch.ts"
import { buildFirstmateSupervisorCommand } from "../src/guide-firstmate-terminal.ts"
import { inspectFirstmateReadiness, prepareFirstmateReadiness } from "../src/guide-preflight.ts"
import { prepareGuidePrompt } from "../src/guide-context.ts"
import { guideMatchCatalogEntries } from "../src/guide-catalog.ts"
import { renderWorkflowBodyCandidate } from "../src/guide-workflow-prompt.ts"
import { verifiedFirstmateOriginCwd } from "../src/guide-firstmate-origin.ts"
import { firstmateGuide, firstmateMemoryJournal, firstmateReceipt } from "./helpers/continuation-firstmate-fixtures.ts"
import { preparationPlan } from "./helpers/firstmate-preparation-fixtures.ts"
import {
  alpha, beta, instanceProfile, instanceFleet, instancePlan, instanceExample, instanceCatalog,
  InstanceRunner, MemoryCreationPlans,
} from "./helpers/firstmate-instance-flow.ts"

const roots: string[] = []
const testDirectory = path.dirname(fileURLToPath(import.meta.url))
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const directory = async () => {
  const root = path.join(testDirectory, `.fmi-guide-${randomUUID()}`)
  await mkdir(root, { mode: 0o700 })
  roots.push(root)
  return root
}
const setup = () => {
  const runner = new InstanceRunner()
  const creationStore = new MemoryCreationPlans()
  const env: FirstmateInstanceMenuEnvironment = { runner, creationStore, profile: instanceProfile(), cwd: "/work/alpha" }
  const run = async (state: FirstmateInstanceMenuState) =>
    reduceFirstmateInstanceMenu(state, await runFirstmateInstanceMenuOperation(env, state, new AbortController().signal))
  return { env, runner, creationStore, run }
}
const select = (state: FirstmateInstanceMenuState) =>
  reduceFirstmateInstanceMenu(reduceFirstmateInstanceMenu(reduceFirstmateInstanceMenu(state, { type: "confirm" }), { type: "move", delta: 1 }), { type: "confirm" })
const request = (descriptor = alpha, id = "00000000-0000-4000-8000-000000000001") =>
  parseFirstmateSubmissionRequestV1({
    schemaVersion: 1, requestId: id, expectedFleet: instanceFleet(descriptor).identity,
    originalIntent: "  Preserve this request.\r\nDo not merge.  ", generatedSpec: "Inspect the selected project.",
    workflowId: "review-project", projectTarget: null,
  })
const job = (descriptor = alpha, id = 1, action: "submit" | "start" = "submit"): QueuedGuideJob => {
  const profile = instanceProfile(descriptor)
  const originalIntent = `Inspect independent request ${id}.`
  const prepared = prepareGuidePrompt(firstmateGuide, "review-fleet-status", "native:fmx/default", originalIntent, {
    originalIntent, projectTarget: null, orchestration: profile.orchestration!,
  })
  const candidate = renderWorkflowBodyCandidate(prepared.workflow, { title: "Inspect", prompt: `Inspect request ${id}.`, notes: "No code changes." })
  return createQueuedGuideJob(id, profile, candidate.prompt, action === "submit" ? { kind: "existing-fleet" } : { kind: "current-terminal" }, {
    originalIntent, workflowId: prepared.workflow.id, projectTarget: null, projectTargetConfirmed: true, workflow: prepared.workflow,
  }, {
    action, requestId: `00000000-0000-4000-8000-${id.toString().padStart(12, "0")}`, expectedFleet: instanceFleet(descriptor).identity!,
  })
}

describe("explicit instance selection and creation", () => {
  it.each([alpha, beta])("keeps nested configuration cwd through refresh and preparation for $name", async (descriptor) => {
    const f = setup()
    const cwd = "/work/alpha/packages/api"
    f.runner.worktrees.set(cwd, alpha.worktree.evidence)
    const env = { ...f.env, cwd }
    const run = async (state: FirstmateInstanceMenuState) => reduceFirstmateInstanceMenu(state,
      await runFirstmateInstanceMenuOperation(env, state, new AbortController().signal))
    let state = await run(initialFirstmateInstanceMenu(cwd))
    if (descriptor === beta) state = reduceFirstmateInstanceMenu(state, { type: "move", delta: 1 })
    state = await run(select(state))
    const before = state.accepted!
    const profile = {
      ...env.profile, firstmateInstance: before.context.reference, firstmateInstanceContext: before.context,
    }
    await prepareFirstmateReadiness(f.runner, profile, before.configurationCwd)
    const refreshing = reduceFirstmateInstanceMenu(state, { type: "refresh" })
    state = reduceFirstmateInstanceMenu(refreshing, await runFirstmateInstanceMenuOperation(
      { ...env, profile }, refreshing, new AbortController().signal,
    ))
    state = await run(select(state))
    expect(state.accepted?.context).toEqual(before.context)
    expect(state.configurationCwd).toBe(cwd)
    await prepareFirstmateReadiness(f.runner, profile, state.accepted!.configurationCwd)
    expect(f.runner.calls.filter(({ args }) => args[0] === "prepare").map(({ args, options }) => ({
      instance: args[args.indexOf("--instance") + 1], cwd: options?.cwd,
    }))).toEqual([
      { instance: descriptor.reference.instanceId, cwd }, { instance: descriptor.reference.instanceId, cwd },
    ])
  })

  it("changes configuration cwd only after an explicit path choice", async () => {
    const f = setup()
    const selectedPath = "/work/beta/packages/client"
    f.runner.worktrees.set(selectedPath, beta.worktree.evidence)
    let state = await f.run(initialFirstmateInstanceMenu(f.env.cwd))
    state = reduceFirstmateInstanceMenu(state, { type: "path" })
    state = reduceFirstmateInstanceMenu(state, { type: "text", text: selectedPath })
    state = await f.run(reduceFirstmateInstanceMenu(state, { type: "confirm" }))
    state = await f.run(select(state))
    expect(state.accepted?.context.reference).toEqual(beta.reference)
    expect(state.accepted?.context.entryWorktree).toEqual(beta.worktree.evidence)
    expect(state.configurationCwd).toBe(selectedPath)
    state = await f.run(reduceFirstmateInstanceMenu(state, { type: "refresh" }))
    expect(state.configurationCwd).toBe(selectedPath)
    expect(state.entry).toEqual(beta.worktree.evidence)
  })

  it("recommends the entry instance without selecting, preparing, starting, or submitting", async () => {
    const f = setup()
    const initial = await f.run(initialFirstmateInstanceMenu(f.env.cwd))
    expect(initial.instances[initial.index]?.reference).toEqual(alpha.reference)
    expect(initial.accepted).toBeUndefined()
    expect(initial.entry).toEqual(alpha.worktree.evidence)
    const accepted = await f.run(select(initial))
    expect(accepted.accepted?.context).toEqual(createFirstmateInstanceContext(alpha, alpha.worktree.evidence, "entry-match"))
    expect(f.runner.calls.every(({ args }) => args[0] === "instances")).toBe(true)
    expect(f.creationStore.saved).toEqual([])
  })

  it("requires a separate explicit join without replacing the entry association", async () => {
    const f = setup()
    let state = await f.run(initialFirstmateInstanceMenu(f.env.cwd))
    state = reduceFirstmateInstanceMenu(state, { type: "move", delta: 1 })
    state = await f.run(select(state))
    expect(state.accepted?.context).toMatchObject({ reference: beta.reference, selection: "confirmed-join", entryWorktree: alpha.worktree.evidence })
    expect(beta.worktree.evidence.locators.worktree).toBe("/work/beta")
    expect(state.configurationCwd).toBe("/work/alpha")
  })

  it("keeps a saved UUID focused instead of substituting the entry default", async () => {
    const f = setup()
    const state = initialFirstmateInstanceMenu(f.env.cwd)
    const event = await runFirstmateInstanceMenuOperation({ ...f.env, profile: instanceProfile(beta) }, state, new AbortController().signal)
    const selected = reduceFirstmateInstanceMenu(state, event)
    expect(selected.instances[selected.index]?.reference).toEqual(beta.reference)
    f.runner.instances = [alpha]
    const missing = reduceFirstmateInstanceMenu(state, await runFirstmateInstanceMenuOperation(
      { ...f.env, profile: instanceProfile(beta) }, state, new AbortController().signal,
    ))
    expect(missing.index).toBe(-1)
    expect(missing.accepted).toBeUndefined()
    expect(missing.error).toContain("No entry-worktree default was substituted")
  })

  it("cancels a reviewed creation without writing a plan or invoking create", async () => {
    const f = setup()
    f.runner.instances = []
    let state = await f.run(initialFirstmateInstanceMenu(f.env.cwd))
    state = reduceFirstmateInstanceMenu(state, { type: "name" })
    state = await f.run(reduceFirstmateInstanceMenu(state, { type: "confirm" }))
    expect(state.plan).toEqual(instancePlan())
    expect(state.confirm).toBe(false)
    state = reduceFirstmateInstanceMenu(state, { type: "confirm" })
    expect(state.screen).toBe("list")
    expect(f.creationStore.saved).toEqual([])
    expect(f.runner.calls.some(({ args }) => args[1] === "create")).toBe(false)
  })

  it("durably retains an uncertain creation and retries the original plan after reopening", async () => {
    const f = setup()
    f.runner.instances = []
    let state = await f.run(initialFirstmateInstanceMenu(f.env.cwd))
    state = await f.run(reduceFirstmateInstanceMenu(reduceFirstmateInstanceMenu(state, { type: "name" }), { type: "confirm" }))
    f.runner.reply = async ({ executable, args }) => {
      if (args[1] !== "create") return undefined
      throw new CommandRunnerError({
        kind: "exited", executable, args, message: "Fixture creation interrupted.", exitCode: 1,
        stderr: "fixture interrupted", stdout: JSON.stringify(instanceExample("createIncomplete")),
      })
    }
    state = await f.run(reduceFirstmateInstanceMenu(reduceFirstmateInstanceMenu(state, { type: "move", delta: 1 }), { type: "confirm" }))
    expect(state.creationUncertain).toBe(true)
    expect(state.approvedPlan).toEqual(instancePlan())
    expect(f.creationStore.plans.get(alpha.reference.instanceId)).toEqual(instancePlan())
    state = await f.run(initialFirstmateInstanceMenu(f.env.cwd, 100))
    expect(state.operation).toBeUndefined()
    expect(state.approvedPlan?.reference).toEqual(alpha.reference)
    expect(state.creationUncertain).toBe(true)
    f.runner.reply = undefined
    state = await f.run(reduceFirstmateInstanceMenu(state, { type: "refresh" }))
    expect(state.accepted).toBeUndefined()
    expect(state.screen).toBe("review")
    const calls = f.runner.calls.filter(({ args }) => args[1] === "create")
    expect(calls).toHaveLength(2)
    expect(calls[0]?.options?.stdin).toBe(canonicalFirstmateInstanceJson(instancePlan()))
    expect(calls[1]?.options?.stdin).toBe(calls[0]?.options?.stdin)
    expect(calls[0]?.options?.terminationGraceMs).toBe(10_000)
    expect(f.creationStore.plans.size).toBe(0)
  })

  it("rejects descriptor changes and stale generations without selecting a replacement", async () => {
    const f = setup()
    const discovered = await f.run(initialFirstmateInstanceMenu(f.env.cwd))
    const pending = select(discovered)
    const event = await runFirstmateInstanceMenuOperation(f.env, pending, new AbortController().signal)
    const cancelled = pauseFirstmateInstanceMenu(pending)
    expect(reduceFirstmateInstanceMenu(cancelled, event)).toBe(cancelled)
    f.runner.instances[0] = parseFirstmateInstanceDescriptorV1({ ...alpha, diagnostics: [{ code: "busy", message: "State changed." }] })
    const rejected = await f.run(pending)
    expect(rejected.accepted).toBeUndefined()
    expect(rejected.error).toContain("changed during review")
  })

  it("does not retain confirmation when a creation plan is refreshed", async () => {
    const f = setup()
    f.runner.instances = []
    let state = await f.run(initialFirstmateInstanceMenu(f.env.cwd))
    state = await f.run(reduceFirstmateInstanceMenu(reduceFirstmateInstanceMenu(state, { type: "name" }), { type: "confirm" }))
    state = reduceFirstmateInstanceMenu(state, { type: "move", delta: 1 })
    state = await f.run(reduceFirstmateInstanceMenu(state, { type: "refresh" }))
    state = await f.run(reduceFirstmateInstanceMenu(reduceFirstmateInstanceMenu(state, { type: "name" }), { type: "confirm" }))
    expect(state.confirm).toBe(false)
    expect(state.approvedPlan).toBeUndefined()
    expect(f.runner.calls.some(({ args }) => args[1] === "create")).toBe(false)
    expect(f.creationStore.saved).toEqual([])
  })

  it("requires generation proof and explicit approval for a moved locator", async () => {
    const f = setup()
    const moved = parseFirstmateInstanceDescriptorV1({
      ...alpha, worktree: { ...alpha.worktree, evidence: {
        ...alpha.worktree.evidence, locators: { ...alpha.worktree.evidence.locators, worktree: "/work/alpha-moved" },
      } },
    })
    if (moved.mode !== "named") throw new Error("Named moved fixture required.")
    let state = await f.run(initialFirstmateInstanceMenu(f.env.cwd))
    state = {
      ...state, entry: null, locatorEvidence: moved.worktree.evidence,
      configurationCwd: "/work/alpha-moved/packages/api",
    }
    state = reduceFirstmateInstanceMenu(state, { type: "locator" })
    state = reduceFirstmateInstanceMenu(state, { type: "confirm" })
    expect(f.runner.calls.some(({ args }) => args[1] === "refresh-locator")).toBe(false)
    state = reduceFirstmateInstanceMenu(state, { type: "locator" })
    state = reduceFirstmateInstanceMenu(reduceFirstmateInstanceMenu(state, { type: "move", delta: 1 }), { type: "confirm" })
    f.runner.reply = async ({ args }) => args[1] === "refresh-locator" ? f.runner.ok(moved) : undefined
    state = await f.run(state)
    expect(state.descriptor?.reference).toEqual(alpha.reference)
    expect(state.entry?.locators.worktree).toBe("/work/alpha-moved")
    expect(state.configurationCwd).toBe("/work/alpha-moved/packages/api")
    expect(state.accepted).toBeUndefined()
    expect(f.runner.calls.at(-1)?.args).toEqual([
      "instances", "refresh-locator", "default", "--instance", alpha.reference.instanceId,
      "--worktree", "/work/alpha-moved", "--json", "--expected-binding-digest",
      firstmateWorktreeBindingDigest(alpha.worktree.evidence), "--confirm",
    ])
  })

  it("never fabricates a missing legacy UUID or sends unsupported commands to old backends", async () => {
    const f = setup()
    f.runner.instances = [parseFirstmateInstanceDescriptorV1(instanceExample("legacyMissingIdentity"))]
    const state = await f.run(initialFirstmateInstanceMenu(f.env.cwd))
    const refused = reduceFirstmateInstanceMenu(reduceFirstmateInstanceMenu(reduceFirstmateInstanceMenu(state, { type: "confirm" }), { type: "move", delta: 1 }), { type: "confirm" })
    expect(refused.accepted).toBeUndefined()
    expect(refused.operation).toBeUndefined()
    expect(refused.error).toBeDefined()
    const { instances: _capability, ...legacy } = instanceProfile().orchestration!
    f.runner.calls.length = 0
    await expect(runFirstmateInstanceMenuOperation({
      ...f.env, profile: { ...instanceProfile(), orchestration: legacy },
    }, initialFirstmateInstanceMenu(f.env.cwd), new AbortController().signal)).rejects.toThrow(/instance support/)
    expect(f.runner.calls).toEqual([])
  })
})

describe("private creation and submission recovery", () => {
  it("writes private immutable creation plans and reads them after restart", async () => {
    const root = path.join(await directory(), "creations")
    const store = new FileFirstmateCreationPlanStore(root)
    expect(await store.list("default")).toEqual([])
    await store.save(instancePlan())
    expect(await new FileFirstmateCreationPlanStore(root).list("default")).toEqual([instancePlan()])
    expect((await lstat(path.join(root, "default", `${alpha.reference.instanceId}.json`))).mode & 0o777).toBe(0o600)
    expect((await lstat(root)).mode & 0o777).toBe(0o700)
    await store.save(instancePlan())
    await store.complete(instancePlan())
    expect(await store.list("default")).toEqual([])
  })

  it("refuses linked recovery files without writing through them", async () => {
    const root = await directory()
    const store = new FileFirstmateCreationPlanStore(path.join(root, "creations"))
    await store.save(instancePlan())
    const file = path.join(store.root, "default", `${alpha.reference.instanceId}.json`)
    const before = await readFile(file, "utf8")
    await symlink(file, path.join(store.root, "default", `${beta.reference.instanceId}.json`))
    await expect(store.list("default")).rejects.toThrow(/regular files/)
    expect(await readFile(file, "utf8")).toBe(before)
  })

  it("uses sibling named roots without legacy migration or fallback, including identical request IDs", async () => {
    const root = await directory()
    const flat = path.join(root, "firstmate-submissions")
    const factory = createFirstmateJournalFactory(flat)
    const legacy = { ...alpha.reference, mode: "legacy" as const }
    await factory(legacy).prepare(request())
    expect(await factory(alpha.reference).get(request().requestId)).toBeUndefined()
    await factory(alpha.reference).prepare(request())
    await factory(beta.reference).prepare(request(beta))
    const reopened = createFirstmateJournalFactory(flat)
    expect((await reopened(alpha.reference).listPending()).map(({ request }) => request.expectedFleet.instanceId)).toEqual([alpha.reference.instanceId])
    expect((await reopened(beta.reference).listPending()).map(({ request }) => request.expectedFleet.instanceId)).toEqual([beta.reference.instanceId])
    expect(await new FileFirstmateSubmissionJournal(flat).listPending()).toHaveLength(1)
    expect(await readdir(path.join(root, "firstmate-instance-submissions", "default"))).toEqual(expect.arrayContaining([alpha.reference.instanceId, beta.reference.instanceId]))
    await expect(reopened(alpha.reference).prepare(request(beta))).rejects.toThrow(/instance journal/)
    await reopened({ ...beta.reference, mode: "legacy" }).prepare(request(beta, "00000000-0000-4000-8000-000000000002"))
    expect(await new FileFirstmateSubmissionJournal(flat).listPending()).toHaveLength(2)
    expect(await reopened(alpha.reference).listPending()).toHaveLength(1)
  })
})

describe("instance-bound control and batches", () => {
  it("binds installation approval to instance and cwd, not a shared lock hash", async () => {
    const runner = new InstanceRunner()
    const profile = instanceProfile(alpha)
    const approval = {
      commandPath: profile.commandPath, profile: "default", sourceRevision: profile.orchestration!.sourceRevision,
      firstmateInstance: profile.firstmateInstance!, firstmateInstanceContext: profile.firstmateInstanceContext!,
      configurationCwd: "/work/alpha", installation: preparationPlan,
    }
    await expect(prepareFirstmateReadiness(runner, instanceProfile(beta), "/work/alpha", { approval })).rejects.toThrow(/different instance/)
    await expect(prepareFirstmateReadiness(runner, profile, "/work/beta", { approval })).rejects.toThrow(/configuration directory/)
    expect(runner.calls).toEqual([])
    await prepareFirstmateReadiness(runner, profile, "/work/alpha", { approval })
    expect(runner.calls[0]?.args).toEqual([
      "prepare", "default", "--json", "--expected-source-revision", profile.orchestration!.sourceRevision,
      ...firstmateInstanceControlArgs(profile), "--install-prerequisites", preparationPlan.identity,
    ])
  })

  it("rejects cross-delivery before transport and validates inventory against the selected UUID", async () => {
    const runner = new InstanceRunner()
    const client = new FirstmateSubmissionClient(runner, instanceProfile(alpha), "/work/alpha")
    expect(await client.submit(request(beta))).toMatchObject({ status: "rejected" })
    expect(runner.calls).toEqual([])
    runner.reply = async () => runner.ok({
      schemaVersion: 1, launcher: "fmx", profile: "default", readiness: "healthy", fleet: instanceFleet(beta),
    })
    await expect(inspectFirstmateReadiness(runner, instanceProfile(alpha), "/work/alpha")).rejects.toThrow(/fleet|instance/i)
  })

  it("delivers two default instances independently and groups repeated jobs only by UUID", async () => {
    const runner = new InstanceRunner()
    const memories = new Map([alpha, beta].map((item) => [firstmateInstanceKey(item.reference), firstmateMemoryJournal()]))
    const jobs = [job(alpha, 1), job(beta, 2), job(alpha, 3)]
    const before = JSON.stringify(jobs)
    const result = await executeGuideBatch({ jobs, context: { cwd: "/work/alpha" } }, {
      runner, write: () => undefined, firstmateJournalFor: (reference) => memories.get(firstmateInstanceKey(reference))!.journal,
    })
    expect(result.result.entries.map(({ status }) => status), JSON.stringify(result.result.entries.map((entry) =>
      ({ status: entry.status, message: "message" in entry ? entry.message : "" })))).toEqual(["accepted", "accepted", "accepted"])
    expect(JSON.stringify(jobs)).toBe(before)
    expect([...memories.get(firstmateInstanceKey(alpha.reference))!.entries.values()].map(({ request }) => request.requestId))
      .toEqual([jobs[0]!.firstmate!.requestId, jobs[2]!.firstmate!.requestId])
    expect([...memories.get(firstmateInstanceKey(beta.reference))!.entries.values()].map(({ request }) => request.requestId))
      .toEqual([jobs[1]!.firstmate!.requestId])
    expect(runner.submissions.map(({ expectedFleet }) => expectedFleet.instanceId).sort())
      .toEqual([alpha.reference.instanceId, alpha.reference.instanceId, beta.reference.instanceId].sort())
  })

  it("rejects two current-terminal instances before saving either request", async () => {
    const runner = new InstanceRunner()
    const memory = firstmateMemoryJournal()
    const result = await executeGuideBatch({ jobs: [job(alpha, 1, "start"), job(beta, 2, "start")], context: { cwd: "/work/alpha" } }, {
      runner, write: () => undefined, firstmateJournalFor: () => memory.journal,
    })
    expect(result.result.entries.every(({ status }) => status === "invalid")).toBe(true)
    expect(memory.entries.size).toBe(0)
    expect(runner.calls).toEqual([])
  })

  it("does not save unrelated Send work when two other instances claim the current terminal", async () => {
    const third = {
      ...beta, name: "gamma", taskIdPrefix: "fi789abc",
      reference: { ...beta.reference, instanceId: "55555555-5555-4555-8555-555555555555" },
      root: "/state/firstmate/instances/55555555-5555-4555-8555-555555555555",
    }
    const runner = new InstanceRunner()
    const memory = firstmateMemoryJournal()
    const jobs = [job(alpha, 1, "start"), job(beta, 2, "start"), job(third, 3)]
    const result = await executeGuideBatch({ jobs, context: { cwd: "/work/alpha" } }, {
      runner, write: () => undefined, firstmateJournalFor: () => memory.journal,
    })
    expect(result.result.entries.every(({ status }) => status === "invalid")).toBe(true)
    expect(memory.entries.size).toBe(0)
    expect(runner.calls).toEqual([])
  })

  it.each(["home", "command", "source", "context", "mode"] as const)("rejects conflicting %s within one UUID instead of making a new group", async (change) => {
    const first = job(alpha, 1)
    const second = job(alpha, 2)
    const profile = instanceProfile(alpha)
    let changed = second
    if (change === "home") changed = { ...second, firstmate: { ...second.firstmate!, expectedFleet: { ...second.firstmate!.expectedFleet!, home: `${beta.root}/home` } } }
    if (change === "command") changed = { ...second, profile: { ...profile, commandPath: "/another/fmx" } }
    if (change === "source") changed = { ...second, profile: { ...profile, orchestration: { ...profile.orchestration!, sourceRevision: "c".repeat(40) } } }
    if (change === "context") changed = { ...second, profile: { ...profile, firstmateInstanceContext: {
      ...profile.firstmateInstanceContext!, expectedRuntimeDigest: "f".repeat(64),
    } } }
    if (change === "mode") changed = { ...second, profile: {
      ...profile, firstmateInstance: { ...alpha.reference, mode: "legacy" },
      firstmateInstanceContext: {
        schemaVersion: 1, reference: { ...alpha.reference, mode: "legacy" },
        expectedBindingDigest: null, expectedRuntimeDigest: null, entryWorktree: null, selection: "confirmed-join",
      },
    } }
    const runner = new InstanceRunner()
    const memory = firstmateMemoryJournal()
    const result = await executeGuideBatch({ jobs: [first, changed], context: { cwd: "/work/alpha" } }, {
      runner, write: () => undefined, firstmateJournalFor: () => memory.journal, firstmateJournal: memory.journal,
    })
    expect(result.result.entries.every(({ status }) => status === "invalid")).toBe(true)
    expect(memory.entries.size).toBe(0)
    expect(runner.calls).toEqual([])
  })

  it("preserves an uncertain instance while another default instance completes", async () => {
    const runner = new InstanceRunner()
    const memories = new Map([alpha, beta].map((item) => [firstmateInstanceKey(item.reference), firstmateMemoryJournal()]))
    runner.reply = async ({ args }) => {
      if (args[0] === "submit" && args.includes(alpha.reference.instanceId)) throw new Error("Reply lost after possible save.")
      return undefined
    }
    const jobs = [job(alpha, 1), job(beta, 2)]
    const before = JSON.stringify(jobs)
    const result = await executeGuideBatch({ jobs, context: { cwd: "/work/alpha" } }, {
      runner, write: () => undefined, firstmateJournalFor: (reference) => memories.get(firstmateInstanceKey(reference))!.journal,
    })
    expect(result.result.entries.map(({ status }) => status)).toEqual(["submission-unknown", "accepted"])
    expect(JSON.stringify(jobs)).toBe(before)
    expect(memories.get(firstmateInstanceKey(alpha.reference))!.entries.get(jobs[0]!.firstmate!.requestId)?.status).toBe("unknown")
    expect(memories.get(firstmateInstanceKey(beta.reference))!.entries.get(jobs[1]!.firstmate!.requestId)?.status).toBe("accepted")
  })

  it("rejects mixed checked checkout roots before durable saves", async () => {
    const jobs = [job(alpha, 1, "start"), job(beta, 2, "start")].map((entry, index) => ({
      ...entry, primaryCheckoutPath: index === 0 ? "/repos/alpha" : "/repos/beta",
      placement: { kind: "new-worktree" as const, branch: `fixture-${index}`, baseRef: "HEAD" },
    }))
    const runner = new InstanceRunner()
    const memory = firstmateMemoryJournal()
    const result = await executeGuideBatch({ jobs, context: {
      cwd: "/work/alpha", workspaceId: "actual-workspace", callerPaneId: "actual-pane", primaryCheckoutPath: "/repos/alpha",
    } }, { runner, write: () => undefined, firstmateJournalFor: () => memory.journal })
    expect(result.result.entries.every(({ status }) => status === "invalid")).toBe(true)
    expect(memory.entries.size).toBe(0)
    expect(runner.calls).toEqual([])
  })
  it("keeps canonical startup arguments instance-bound without embedding task text", () => {
    const queued = job(alpha, 1, "start")
    const command = buildFirstmateSupervisorCommand(instanceProfile(alpha), queued.firstmate!.expectedFleet!)
    expect(command.args).toEqual(expect.arrayContaining([...firstmateInstanceControlArgs(instanceProfile(alpha))]))
    expect(command.args.filter((arg) => arg === "--instance")).toHaveLength(1)
    expect(command.args.join(" ")).not.toContain(queued.prompt)
  })
})

describe("unbound model context and private origin", () => {
  it("keeps instance namespaces out of model catalog entries and fixed frames", () => {
    const catalog = instanceCatalog()
    const entry = guideMatchCatalogEntries(catalog).find(({ ref }) => ref === "native:fmx/default")!
    expect(entry.orchestration).not.toHaveProperty("taskIdPrefix")
    const first = job(alpha)
    const second = job(beta)
    expect(first.prompt).toBe(second.prompt)
    for (const value of [alpha.reference.instanceId, alpha.root, alpha.taskIdPrefix, beta.reference.instanceId, beta.root, beta.taskIdPrefix]) {
      expect(JSON.stringify(entry)).not.toContain(value)
      expect(first.prompt).not.toContain(value)
    }
    expect(first.prompt).toContain("verified task namespace")
  })

  it("validates inherited origin separately from runtime cwd, rejecting stale evidence without fallback", async () => {
    const runner = new InstanceRunner()
    const origin = instanceProfile(beta).firstmateInstanceContext!
    expect(firstmateLaunchOrigin(undefined, JSON.stringify(origin))).toEqual(origin)
    expect(() => firstmateLaunchOrigin(instanceProfile(alpha).firstmateInstanceContext, JSON.stringify(origin))).toThrow(/disagree/)
    expect(await verifiedFirstmateOriginCwd(runner, instanceCatalog(), `${beta.root}/runtime`, origin)).toBe("/work/alpha")
    runner.worktrees.set("/work/alpha", beta.worktree.evidence)
    await expect(verifiedFirstmateOriginCwd(runner, instanceCatalog(), `${beta.root}/runtime`, origin)).rejects.toThrow(/evidence changed/)
    expect(runner.calls.every(({ args }) => args[0] === "instances")).toBe(true)
  })
})
