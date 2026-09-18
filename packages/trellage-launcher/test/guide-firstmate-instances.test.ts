import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  canonicalFirstmateInstanceJson,
  firstmateInstanceCreationPlanDigest,
  firstmateInstanceListCursor,
  firstmateInstanceListSnapshotDigest,
  firstmateWorktreeBindingDigest,
  firstmateWorktreeGenerationDigest,
  parseFirstmateInstanceControlContextV1,
  parseFirstmateInstanceCreationPlanV1,
  parseFirstmateInstanceDescriptorV1,
  parseFirstmateInstancePlanResultV1,
  parseFirstmateOrchestrationV1,
  type FirstmateInstanceDescriptorV1,
  type FirstmateInstanceReferenceV1,
  type FirstmateNamedInstanceDescriptorV1,
} from "@trellage/guide-core"
import {
  createFirstmateInstanceContext,
  firstmateInstanceControlArgs,
  firstmateInstanceSelectorArgs,
  selectedFirstmateInstance,
} from "../src/guide-firstmate-instance-selection.ts"
import {
  FirstmateInstanceCommandError,
  createFirstmateInstancesClient,
} from "../src/guide-firstmate-instances.ts"
import {
  CommandRunnerError,
  type CommandRunOptions,
  type CommandRunResult,
  type CommandRunner,
  type NativeSelectedProfile,
} from "../src/guide-launch.ts"

const fixture: unknown = JSON.parse(readFileSync(
  new URL("../../trellage-guide-core/test/fixtures/firstmate-instances-v1.json", import.meta.url), "utf8",
))
const example = (name: string): unknown => {
  if (fixture === null || typeof fixture !== "object" || !Object.hasOwn(fixture, name)) {
    throw new Error(`Missing wire fixture: ${name}`)
  }
  return Reflect.get(fixture, name)
}
const named = (value: unknown): FirstmateNamedInstanceDescriptorV1 => {
  const result = parseFirstmateInstanceDescriptorV1(value)
  if (result.mode !== "named") throw new Error("Expected a named fixture.")
  return result
}
const descriptor = named(example("descriptor"))
const context = parseFirstmateInstanceControlContextV1(example("controlContext"))
const planResult = parseFirstmateInstancePlanResultV1(example("plan"))
if (planResult.state !== "ready") throw new Error("Expected a ready creation plan.")
const plan = planResult.plan
const otherId = "33333333-3333-4333-8333-333333333333"
const sourceRevision = plan.sourceRevision
const capability = parseFirstmateOrchestrationV1({
  schemaVersion: 1,
  kind: "firstmate",
  sourceRevision,
  taskIdPrefix: "fmd",
  workerPolicy: null,
  workerHarness: "claude",
  workerEfforts: ["high"],
  dispatchRules: "claude-single",
  submission: { schemaVersion: 1, maxRequestBytes: 524288 },
  preparation: { schemaVersion: 1 },
  instances: { schemaVersion: 1 },
})
const unbound: NativeSelectedProfile = {
  surface: "native",
  launcher: "fmx",
  commandPath: "/opt/trellage/bin/fmx",
  profile: "default",
  headlessPrompt: false,
  orchestration: capability,
}
const selected: NativeSelectedProfile = {
  ...unbound,
  firstmateInstance: descriptor.reference,
  firstmateInstanceContext: context,
}
const legacyReference: FirstmateInstanceReferenceV1 = {
  schemaVersion: 1, profile: "default", mode: "legacy", instanceId: otherId,
}
const oldCapability = parseFirstmateOrchestrationV1({
  schemaVersion: capability.schemaVersion,
  kind: capability.kind,
  sourceRevision,
  taskIdPrefix: capability.taskIdPrefix,
  workerPolicy: capability.workerPolicy,
  workerHarness: capability.workerHarness,
  workerEfforts: capability.workerEfforts,
  dispatchRules: capability.dispatchRules,
  submission: capability.submission,
})
const ok = (value: unknown, stderr = ""): CommandRunResult => ({ stdout: JSON.stringify(value), stderr, exitCode: 0 })
const commandFailure = (stdout: string, kind: CommandRunnerError["kind"] = "exited") => new CommandRunnerError({
  kind, executable: unbound.commandPath, args: [], message: "Fixture command failed.",
  exitCode: 1, stdout, stderr: "The operation did not complete.",
})
type Reply = CommandRunResult | Error | ((options?: CommandRunOptions) => CommandRunResult | Promise<CommandRunResult>)
class Runner implements CommandRunner {
  readonly calls: Array<{ executable: string; args: ReadonlyArray<string>; options?: CommandRunOptions }> = []
  constructor(private readonly replies: Array<Reply>) {}
  async run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args, ...(options === undefined ? {} : { options }) })
    const reply = this.replies.shift()
    if (reply === undefined) throw new Error("Unexpected command.")
    if (reply instanceof Error) throw reply
    return typeof reply === "function" ? reply(options) : reply
  }
}
const secondDescriptor = (): FirstmateNamedInstanceDescriptorV1 => {
  const generation = {
    ...descriptor.worktree.evidence.generation,
    worktree: { device: "1", inode: "20", birthtimeNs: "30" },
    privateGitDir: { device: "1", inode: "21", birthtimeNs: "31" },
  }
  return named({
    ...descriptor, name: "beta", reference: { ...descriptor.reference, instanceId: otherId },
    root: `/state/firstmate/instances/${otherId}`, taskIdPrefix: "fi456def",
    worktree: {
      status: "bound",
      evidence: {
        ...descriptor.worktree.evidence, generation, generationDigest: firstmateWorktreeGenerationDigest(generation),
        locators: { ...descriptor.worktree.evidence.locators, worktree: "/work/beta", privateGitDir: "/repos/project/.git/worktrees/beta" },
      },
    },
  })
}
const pages = (instances: ReadonlyArray<FirstmateInstanceDescriptorV1>) => {
  const snapshotDigest = firstmateInstanceListSnapshotDigest("default", instances)
  return instances.map((instance, offset) => ({
    schemaVersion: 1, profile: "default", diagnostics: [], state: "page", instances: [instance],
    page: {
      snapshotDigest, offset, total: instances.length,
      nextCursor: offset + 1 === instances.length ? null : firstmateInstanceListCursor({ schemaVersion: 1, snapshotDigest, offset: offset + 1 }),
    },
  }))
}

describe("Firstmate instance execution selection", () => {
  it("preserves unqualified legacy commands and old-backend argument vectors", () => {
    expect(firstmateInstanceSelectorArgs(unbound)).toEqual([])
    expect(firstmateInstanceControlArgs(unbound)).toEqual([])
    const legacy = { ...unbound, firstmateInstance: legacyReference }
    expect(firstmateInstanceSelectorArgs(legacy)).toEqual(["--instance", "legacy"])
    expect(firstmateInstanceControlArgs({ ...legacy, orchestration: oldCapability })).toEqual([])
  })

  it("routes by UUID and binds control to the confirmed context", () => {
    expect(firstmateInstanceSelectorArgs(selected)).toEqual(["--instance", descriptor.reference.instanceId])
    expect(firstmateInstanceControlArgs(selected)).toEqual([
      "--instance", descriptor.reference.instanceId, "--fmx-instance-context-json", canonicalFirstmateInstanceJson(context),
    ])
    expect(() => firstmateInstanceControlArgs({
      ...selected, firstmateInstance: { ...descriptor.reference, instanceId: otherId },
    })).toThrow(/another instance/)
  })

  it("permits read-only selection without control approval but blocks mutation", () => {
    const inspection = { ...unbound, firstmateInstance: descriptor.reference }
    expect(firstmateInstanceSelectorArgs(inspection)).toEqual(["--instance", descriptor.reference.instanceId])
    expect(() => firstmateInstanceControlArgs(inspection)).toThrow(/confirmed instance context/)
  })

  it("refuses unsupported backends, profile mismatch, and orphaned context", () => {
    expect(() => firstmateInstanceSelectorArgs({ ...selected, orchestration: oldCapability })).toThrow(/does not support/)
    expect(() => firstmateInstanceSelectorArgs({ ...selected, profile: "pstack-workers" })).toThrow(/selected profile/)
    expect(() => firstmateInstanceSelectorArgs({ ...selected, launcher: "cldx" })).toThrow(/Native fmx/)
    expect(() => firstmateInstanceSelectorArgs({ ...unbound, firstmateInstanceContext: context })).toThrow(/explicit instance reference/)
  })

  it("requires explicit join for another entry without changing the binding", () => {
    const before = structuredClone(descriptor)
    expect(createFirstmateInstanceContext(descriptor, descriptor.worktree.evidence, "entry-match")).toEqual(context)
    expect(() => createFirstmateInstanceContext(descriptor, secondDescriptor().worktree.evidence, "entry-match")).toThrow(/entry-match/)
    const joined = createFirstmateInstanceContext(descriptor, null, "confirmed-join")
    expect(joined.reference).toEqual(descriptor.reference)
    expect(joined.entryWorktree).toBeNull()
    expect(descriptor).toEqual(before)
  })

  it("allows repair expectations for drift but not lost identity or stale binding", () => {
    expect(createFirstmateInstanceContext({
      ...descriptor, runtime: { ...descriptor.runtime, state: "drift" },
      diagnostics: [{ code: "runtime-drift", message: "The runtime requires repair." }],
    }, null, "confirmed-join").expectedRuntimeDigest).toBe(context.expectedRuntimeDigest)
    expect(() => createFirstmateInstanceContext(
      parseFirstmateInstanceDescriptorV1(example("legacyMissingIdentity")), null, "confirmed-join",
    )).toThrow(/no verified setup identity/)
    expect(() => createFirstmateInstanceContext({
      ...descriptor, worktree: { ...descriptor.worktree, status: "missing" },
      diagnostics: [{ code: "worktree-missing", message: "The bound worktree is missing." }],
    }, null, "confirmed-join")).toThrow(/valid binding/)
  })

  it("keeps old saved requests legacy-bound and rejects another UUID", () => {
    const fleet = { profile: "default", instanceId: otherId, home: "/state/firstmate/default/home", sourceRevision }
    expect(selectedFirstmateInstance(unbound, fleet)).toEqual(legacyReference)
    expect(() => selectedFirstmateInstance(selected, fleet)).toThrow(/fleet profile and UUID/)
  })
})

describe("Firstmate instance command transport", () => {
  it("refuses discovery without an actual advertised instance capability", () => {
    const runner = new Runner([])
    expect(() => createFirstmateInstancesClient(runner, { ...unbound, orchestration: oldCapability }, "/work")).toThrow(/instance support/)
    expect(runner.calls).toHaveLength(0)
  })

  it("collects two default instances through a complete verified snapshot", async () => {
    const instances = [descriptor, secondDescriptor()]
    const source = pages(instances)
    const runner = new Runner(source.map((page) => ok(page)))
    expect(await createFirstmateInstancesClient(runner, unbound, "/work/configuration").list()).toEqual(instances)
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["instances", "list", "default", "--json", "--limit", "32"],
      ["instances", "list", "default", "--json", "--limit", "32", "--cursor", source[0]!.page.nextCursor],
    ])
    expect(runner.calls.every(({ options }) => options?.cwd === "/work/configuration")).toBe(true)
  })

  it("does not retry or return a partial list after a stale cursor", async () => {
    const source = pages([descriptor, secondDescriptor()])
    const runner = new Runner([ok(source[0]), ok(example("listStaleCursor"))])
    await expect(createFirstmateInstancesClient(runner, unbound, "/work").list()).rejects.toThrow(/restart listing/)
    expect(runner.calls).toHaveLength(2)
  })

  it("rejects a changed snapshot and a false final snapshot digest", async () => {
    const source = pages([descriptor, secondDescriptor()])
    const changed = { ...source[1]!, page: { ...source[1]!.page, snapshotDigest: "f".repeat(64) } }
    await expect(createFirstmateInstancesClient(new Runner([ok(source[0]), ok(changed)]), unbound, "/work").list()).rejects.toThrow(/changed or skipped/)
    const final = pages([descriptor])[0]!
    await expect(createFirstmateInstancesClient(new Runner([
      ok({ ...final, page: { ...final.page, snapshotDigest: "f".repeat(64) } }),
    ]), unbound, "/work").list()).rejects.toThrow(/complete snapshot/)
  })

  it("fails explicitly instead of silently truncating an excessive instance list", async () => {
    const page = pages([descriptor])[0]!
    const oversized = {
      ...page, page: {
        ...page.page, total: 1025,
        nextCursor: firstmateInstanceListCursor({ schemaVersion: 1, snapshotDigest: page.page.snapshotDigest, offset: 1 }),
      },
    }
    await expect(createFirstmateInstancesClient(new Runner([ok(oversized)]), unbound, "/work").list()).rejects.toThrow(/partial list/)
  })

  it("keeps resolve and planning read-only with the original configuration cwd", async () => {
    const runner = new Runner([ok(example("resolve")), ok(example("plan"))])
    const client = createFirstmateInstancesClient(runner, unbound, "/work/configuration")
    expect((await client.resolve("/work/alpha")).state).toBe("matched")
    expect((await client.plan("alpha", "/work/alpha")).state).toBe("ready")
    expect(runner.calls[0]!.args).toEqual(["instances", "resolve", "default", "--worktree", "/work/alpha", "--json"])
    expect(runner.calls[1]!.args).toEqual([
      "instances", "plan", "default", "--name", "alpha", "--worktree", "/work/alpha",
      "--json", "--expected-source-revision", sourceRevision,
    ])
    expect(runner.calls.every(({ options }) => options?.stdin === undefined && options?.cwd === "/work/configuration")).toBe(true)
  })

  it("retains blocked plan results without inventing creation consent", async () => {
    const runner = new Runner([ok(example("planBlocked"))])
    const result = await createFirstmateInstancesClient(runner, unbound, "/work").plan("alpha", "/work/alpha")
    expect(result.state).toBe("blocked")
    expect(runner.calls).toHaveLength(1)
  })

  it("rejects a plan for another requested name", async () => {
    const runner = new Runner([ok(example("plan"))])
    await expect(createFirstmateInstancesClient(runner, unbound, "/work").plan("beta", "/work/alpha")).rejects.toThrow(/selected name/)
  })

  it("sends exactly the approved inner plan with the same UUID and approval", async () => {
    const runner = new Runner([ok(example("create"))])
    const result = await createFirstmateInstancesClient(runner, unbound, "/work/configuration").create(plan)
    expect(result.state).toBe("created")
    expect(runner.calls[0]!.args).toEqual(["instances", "create", "default", "--json", "--approve-creation", plan.approvalDigest])
    expect(runner.calls[0]!.options).toMatchObject({
      stdin: canonicalFirstmateInstanceJson(plan), cwd: "/work/configuration",
      timeoutMs: 180_000, terminationGraceMs: 10_000, outputOverflow: "terminate",
    })
  })

  it("does not send a stale source plan", () => {
    const runner = new Runner([])
    const changedBody = { ...plan, sourceRevision: "d".repeat(40), runtimeRequirements: { ...plan.runtimeRequirements, sourceRevision: "d".repeat(40) } }
    const changed = parseFirstmateInstanceCreationPlanV1({
      ...changedBody, approvalDigest: firstmateInstanceCreationPlanDigest(changedBody),
    })
    expect(() => createFirstmateInstancesClient(runner, unbound, "/work").create(changed)).toThrow(/plan changed/)
    expect(runner.calls).toHaveLength(0)
  })

  it("preserves valid creation evidence on nonzero transport without returning success", async () => {
    const runner = new Runner([commandFailure(JSON.stringify(example("create")))])
    const call = createFirstmateInstancesClient(runner, unbound, "/work").create(plan)
    await expect(call).rejects.toMatchObject({
      name: "FirstmateInstanceCommandError", approvedPlan: plan,
      creationResult: { state: "created", reference: plan.reference },
    })
    expect(runner.calls).toHaveLength(1)
  })

  it("retains the approved UUID when creation has no valid response", async () => {
    const runner = new Runner([commandFailure("{", "timed-out")])
    const call = createFirstmateInstancesClient(runner, unbound, "/work").create(plan)
    await expect(call).rejects.toMatchObject({ approvedPlan: plan, creationResult: undefined })
    expect(runner.calls).toHaveLength(1)
  })

  it("surfaces blocked and incomplete creation without generating another plan", async () => {
    const runner = new Runner([ok(example("createBlocked")), ok(example("createIncomplete"))])
    const client = createFirstmateInstancesClient(runner, unbound, "/work")
    expect((await client.create(plan)).state).toBe("blocked")
    expect((await client.create(plan)).state).toBe("incomplete")
    expect(runner.calls.every(({ options }) => options?.stdin === canonicalFirstmateInstanceJson(plan))).toBe(true)
  })

  it("aborts streamed output overflow and keeps the original creation plan", async () => {
    let aborted = false
    const runner = new Runner([(options) => {
      options?.onOutput?.("x".repeat(65_537), "stdout")
      aborted = options?.signal?.aborted === true
      return ok(example("create"))
    }])
    await expect(createFirstmateInstancesClient(runner, unbound, "/work").create(plan)).rejects.toMatchObject({ approvedPlan: plan })
    expect(aborted).toBe(true)
    expect(runner.calls).toHaveLength(1)
  })

  it("does not start an already cancelled creation", async () => {
    const runner = new Runner([])
    const controller = new AbortController()
    controller.abort()
    await expect(createFirstmateInstancesClient(runner, unbound, "/work").create(plan, { signal: controller.signal })).rejects.toBeDefined()
    expect(runner.calls).toHaveLength(0)
  })

  it("rejects malformed successful output with creation identity intact", async () => {
    const runner = new Runner([{ stdout: "{", stderr: "", exitCode: 0 }])
    await expect(createFirstmateInstancesClient(runner, unbound, "/work").create(plan)).rejects.toMatchObject({
      name: "FirstmateInstanceCommandError", approvedPlan: plan,
    })
  })

  it("refreshes only a proved locator for the same instance and generation", async () => {
    const moved = named({
      ...descriptor, worktree: {
        ...descriptor.worktree, evidence: {
          ...descriptor.worktree.evidence,
          locators: { ...descriptor.worktree.evidence.locators, worktree: "/work/moved-alpha" },
        },
      },
    })
    const runner = new Runner([ok(moved)])
    expect(await createFirstmateInstancesClient(runner, unbound, "/work").refreshLocator(descriptor, "/work/moved-alpha")).toEqual(moved)
    expect(runner.calls[0]!.args).toEqual([
      "instances", "refresh-locator", "default", "--instance", descriptor.reference.instanceId,
      "--worktree", "/work/moved-alpha", "--json", "--expected-binding-digest",
      firstmateWorktreeBindingDigest(descriptor.worktree.evidence), "--confirm",
    ])
  })

  it("never accepts another instance as a locator refresh", async () => {
    const runner = new Runner([ok(secondDescriptor())])
    await expect(createFirstmateInstancesClient(runner, unbound, "/work").refreshLocator(descriptor, "/work/beta"))
      .rejects.toBeInstanceOf(FirstmateInstanceCommandError)
  })
})
