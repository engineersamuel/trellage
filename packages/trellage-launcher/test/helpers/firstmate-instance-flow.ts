import { readFileSync } from "node:fs"
import {
  canonicalFirstmateInstanceJson, firstmateInstanceCreationPlanDigest, firstmateInstanceListSnapshotDigest,
  firstmateWorktreeGenerationDigest, parseFirstmateInstanceDescriptorV1, parseFirstmateInstancePlanResultV1,
  parseFirstmateInstanceCreationPlanV1, parseFirstmateOrchestrationV1, parseFirstmateFleetReadinessV1,
  type FirstmateInstanceDescriptorV1, type FirstmateNamedInstanceDescriptorV1,
  type FirstmateInstanceCreationPlanV1, type FirstmateInstanceCreationPlanBodyV1,
  type FirstmateWorktreeEvidenceV1, type FirstmateFleetReadinessV1,
} from "@trellage/guide-core"
import { createFirstmateInstanceContext } from "../../src/guide-firstmate-instance-selection.ts"
import type { FirstmateCreationPlanStore } from "../../src/guide-firstmate-creation-store.ts"
import type { CommandRunner, CommandRunOptions, CommandRunResult, NativeSelectedProfile } from "../../src/guide-launch.ts"
import { preparedFleet, preparationInventory } from "./firstmate-preparation-fixtures.ts"
import { firstmateReceipt, firstmateRuntimeCatalog } from "./continuation-firstmate-fixtures.ts"
import { parseFirstmateSubmissionRequestV1 } from "@trellage/guide-core"

const wire = JSON.parse(process.env.TRELLAGE_TEST_FIRSTMATE_INSTANCE_FIXTURE ??
  readFileSync(new URL("../../../trellage-guide-core/test/fixtures/firstmate-instances-v1.json", import.meta.url), "utf8")) as Record<string, unknown>
export const instanceExample = (name: string): unknown => {
  if (!Object.hasOwn(wire, name)) throw new Error(`Unknown wire example: ${name}`)
  return structuredClone(wire[name])
}
const named = (value: unknown): FirstmateNamedInstanceDescriptorV1 => {
  const parsed = parseFirstmateInstanceDescriptorV1(value)
  if (parsed.mode !== "named") throw new Error("Named instance required.")
  return parsed
}
export const alpha = named(instanceExample("descriptor"))
const betaGeneration = {
  ...alpha.worktree.evidence.generation,
  worktree: { device: "1", inode: "40", birthtimeNs: "50" },
  privateGitDir: { device: "1", inode: "41", birthtimeNs: "51" },
}
export const beta = named({
  ...alpha, name: "beta", reference: { ...alpha.reference, instanceId: "33333333-3333-4333-8333-333333333333" },
  root: "/state/firstmate/instances/33333333-3333-4333-8333-333333333333", taskIdPrefix: "fi456def",
  worktree: {
    status: "bound",
    evidence: {
      ...alpha.worktree.evidence, generation: betaGeneration, generationDigest: firstmateWorktreeGenerationDigest(betaGeneration),
      locators: { ...alpha.worktree.evidence.locators, worktree: "/work/beta", privateGitDir: "/repos/project/.git/worktrees/beta" },
    },
  },
})
export const instancePlan = (descriptor = alpha): FirstmateInstanceCreationPlanV1 => {
  const parsed = parseFirstmateInstancePlanResultV1(instanceExample("plan"))
  if (parsed.state !== "ready") throw new Error("Ready plan required.")
  const body: FirstmateInstanceCreationPlanBodyV1 = {
    ...parsed.plan, name: descriptor.name, reference: descriptor.reference, destination: descriptor.root,
    taskIdPrefix: descriptor.taskIdPrefix, worktree: descriptor.worktree.evidence, runtimeRequirements: descriptor.runtime.required,
    permittedWrites: [{ kind: "instance-root", path: descriptor.root }, parsed.plan.permittedWrites[1]],
  }
  return parseFirstmateInstanceCreationPlanV1({ ...body, approvalDigest: firstmateInstanceCreationPlanDigest(body) })
}
export const instanceOrchestration = parseFirstmateOrchestrationV1({
  schemaVersion: 1, kind: "firstmate", sourceRevision: alpha.runtime.required.sourceRevision,
  taskIdPrefix: "fmd", workerPolicy: null, workerHarness: "claude", workerEfforts: ["low", "medium", "high"],
  dispatchRules: "claude-single", submission: { schemaVersion: 1, maxRequestBytes: 524288 },
  preparation: { schemaVersion: 1 }, instances: { schemaVersion: 1 },
})
export const instanceProfile = (descriptor?: FirstmateNamedInstanceDescriptorV1): NativeSelectedProfile => ({
  surface: "native", launcher: "fmx", profile: "default", commandPath: "/profiles/fmx",
  headlessPrompt: false, orchestration: instanceOrchestration,
  ...(descriptor === undefined ? {} : {
    firstmateInstance: descriptor.reference,
    firstmateInstanceContext: createFirstmateInstanceContext(descriptor, alpha.worktree.evidence,
      descriptor === alpha ? "entry-match" : "confirmed-join"),
  }),
})
export const instanceCatalog = () => ({
  ...firstmateRuntimeCatalog(),
  native: firstmateRuntimeCatalog().native.map((entry) => entry.launcher === "fmx" && entry.name === "default"
    ? { ...entry, orchestration: instanceOrchestration } : entry),
})
export const instanceFleet = (
  descriptor = alpha, state: "running" | "stopped" | "stale" = "running",
): FirstmateFleetReadinessV1 => parseFirstmateFleetReadinessV1({
  ...preparedFleet("default", state),
  identity: {
    profile: "default", instanceId: descriptor.reference.instanceId,
    home: `${descriptor.root}/home`, sourceRevision: descriptor.runtime.required.sourceRevision,
  },
})
export const instanceList = (instances: ReadonlyArray<FirstmateInstanceDescriptorV1>) => ({
  schemaVersion: 1, profile: "default", state: "page", instances, diagnostics: [],
  page: { snapshotDigest: firstmateInstanceListSnapshotDigest("default", instances), offset: 0, total: instances.length, nextCursor: null },
})
export class MemoryCreationPlans implements FirstmateCreationPlanStore {
  readonly plans = new Map<string, FirstmateInstanceCreationPlanV1>()
  readonly saved: FirstmateInstanceCreationPlanV1[] = []
  async list(profile: string) { return [...this.plans.values()].filter((plan) => plan.reference.profile === profile) }
  async save(plan: FirstmateInstanceCreationPlanV1) {
    const existing = this.plans.get(plan.reference.instanceId)
    if (existing !== undefined && canonicalFirstmateInstanceJson(existing) !== canonicalFirstmateInstanceJson(plan)) throw new Error("Creation UUID changed.")
    this.saved.push(structuredClone(plan))
    this.plans.set(plan.reference.instanceId, structuredClone(plan))
  }
  async complete(plan: FirstmateInstanceCreationPlanV1) { this.plans.delete(plan.reference.instanceId) }
}
export type InstanceCall = { readonly executable: string; readonly args: ReadonlyArray<string>; readonly options?: CommandRunOptions }
export class InstanceRunner implements CommandRunner {
  readonly calls: InstanceCall[] = []
  instances: FirstmateInstanceDescriptorV1[] = [alpha, beta]
  readonly worktrees = new Map<string, FirstmateWorktreeEvidenceV1>([alpha, beta].map((item) => [item.worktree.evidence.locators.worktree, item.worktree.evidence]))
  readonly fleets = new Map([alpha, beta].map((item) => [item.reference.instanceId, instanceFleet(item)]))
  readonly submissions: ReturnType<typeof parseFirstmateSubmissionRequestV1>[] = []
  reply?: ((call: InstanceCall) => Promise<CommandRunResult | undefined>) | undefined

  async run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    const call = { executable, args, ...(options === undefined ? {} : { options }) }
    this.calls.push(call)
    const custom = await this.reply?.(call)
    if (custom !== undefined) return custom
    return args[0] === "instances" ? this.instanceCommand(args, options) : this.controlCommand(args, options)
  }

  private instanceCommand(args: ReadonlyArray<string>, options?: CommandRunOptions): CommandRunResult {
    if (args[1] === "list") return this.ok(instanceList(this.instances))
    if (args[1] === "resolve") {
      const worktree = this.worktrees.get(args[args.indexOf("--worktree") + 1]!) ?? null
      const descriptor = this.instances.find((entry) => entry.mode === "named" &&
        entry.worktree.evidence.generationDigest === worktree?.generationDigest) ?? null
      return this.ok({ schemaVersion: 1, profile: "default", diagnostics: [], state: descriptor === null ? "not-found" : "matched", descriptor, worktree })
    }
    if (args[1] === "plan") return this.ok({ schemaVersion: 1, profile: "default", diagnostics: [], state: "ready", plan: instancePlan() })
    if (args[1] === "create") {
      const plan = parseFirstmateInstanceCreationPlanV1(JSON.parse(options?.stdin ?? "null"))
      const descriptor = plan.reference.instanceId === alpha.reference.instanceId ? alpha : beta
      if (!this.instances.some((item) => item.reference?.instanceId === plan.reference.instanceId)) this.instances.push(descriptor)
      return this.ok({ schemaVersion: 1, reference: plan.reference, approvalDigest: plan.approvalDigest, state: "created", descriptor, diagnostics: [] })
    }
    throw new Error(`Unexpected instance command: ${args.join(" ")}`)
  }

  private controlCommand(args: ReadonlyArray<string>, options?: CommandRunOptions): CommandRunResult {
    const id = args[args.indexOf("--instance") + 1]
    if (!id || !args.includes("--instance")) throw new Error("Named control has no explicit instance.")
    const fleet = this.fleets.get(id)
    if (fleet === undefined) throw new Error("Unknown selected instance.")
    if (args[0] === "inventory" || args[0] === "prepare") return { stdout: preparationInventory(fleet), stderr: "", exitCode: 0 }
    if (args[0] === "submit") {
      const request = parseFirstmateSubmissionRequestV1(JSON.parse(options?.stdin ?? "null"))
      if (request.expectedFleet.instanceId !== id) throw new Error("Cross-instance delivery.")
      this.submissions.push(request)
      return this.ok({ ...firstmateReceipt(request), noteId: `captain-note-${request.requestId}`, announcement: "sent", error: null })
    }
    throw new Error(`Unexpected control command: ${args.join(" ")}`)
  }

  ok(value: unknown): CommandRunResult { return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 } }
}
