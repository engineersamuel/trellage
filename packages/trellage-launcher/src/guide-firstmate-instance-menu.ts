import path from "node:path"
import {
  canonicalFirstmateInstanceJson,
  firstmateWorktreeBindingDigest,
  parseFirstmateInstanceControlContextJson,
  sameFirstmateInstance,
  sameFirstmateWorktreeGeneration,
  validateFirstmateInstanceControlContextV1,
  type FirstmateInstanceControlContextV1,
  type FirstmateInstanceCreateResultV1,
  type FirstmateInstanceCreationPlanV1,
  type FirstmateInstanceDescriptorV1,
  type FirstmateInstanceReferenceV1,
  type FirstmateInstanceResolveResultV1,
  type FirstmateNamedInstanceDescriptorV1,
  type FirstmateWorktreeEvidenceV1,
} from "@trellage/guide-core"
import {
  createFirstmateInstancesClient, FirstmateInstanceCommandError,
} from "./guide-firstmate-instances.ts"
import { createFirstmateInstanceContext } from "./guide-firstmate-instance-selection.ts"
import type { CommandRunner, NativeSelectedProfile } from "./guide-launch.ts"
import { FileFirstmateCreationPlanStore, type FirstmateCreationPlanStore } from "./guide-firstmate-creation-store.ts"

export interface FirstmateInstanceMenuEnvironment {
  readonly runner: CommandRunner
  readonly profile: NativeSelectedProfile
  readonly cwd: string
  readonly launchOrigin?: FirstmateInstanceControlContextV1
  readonly creationStore?: FirstmateCreationPlanStore
}

export interface FirstmateInstanceChoice {
  readonly descriptor: FirstmateInstanceDescriptorV1
  readonly context: FirstmateInstanceControlContextV1
  readonly configurationCwd: string
}

type MenuOperation =
  | { readonly kind: "discover"; readonly path?: string }
  | { readonly kind: "refresh" }
  | { readonly kind: "plan"; readonly name: string; readonly path: string }
  | { readonly kind: "create"; readonly plan: FirstmateInstanceCreationPlanV1 }
  | { readonly kind: "select"; readonly choice: FirstmateInstanceChoice }
  | { readonly kind: "locator"; readonly descriptor: FirstmateNamedInstanceDescriptorV1; readonly path: string }

export interface FirstmateInstanceMenuState {
  readonly generation: number
  readonly operation?: MenuOperation | undefined
  readonly screen: "list" | "name" | "path" | "review" | "creation" | "locator"
  readonly instances: ReadonlyArray<FirstmateInstanceDescriptorV1>
  readonly entry: FirstmateWorktreeEvidenceV1 | null
  readonly locatorEvidence?: FirstmateWorktreeEvidenceV1 | undefined
  readonly configurationCwd: string
  readonly index: number
  readonly text: string
  readonly confirm: boolean
  readonly descriptor?: FirstmateInstanceDescriptorV1 | undefined
  readonly plan?: FirstmateInstanceCreationPlanV1 | undefined
  readonly approvedPlan?: FirstmateInstanceCreationPlanV1 | undefined
  readonly creationUncertain: boolean
  readonly recoveryPlans: ReadonlyArray<FirstmateInstanceCreationPlanV1>
  readonly creationResult?: FirstmateInstanceCreateResultV1 | undefined
  readonly accepted?: FirstmateInstanceChoice | undefined
  readonly error?: string | undefined
}

interface Discovery {
  readonly instances: ReadonlyArray<FirstmateInstanceDescriptorV1>
  readonly resolution: FirstmateInstanceResolveResultV1 | null
  readonly configurationCwd: string
  readonly recoveryPlans: ReadonlyArray<FirstmateInstanceCreationPlanV1>
  readonly selectedReference?: FirstmateInstanceReferenceV1
  readonly error?: string
}

type MenuResult =
  | { readonly kind: "discover"; readonly discovery: Discovery }
  | { readonly kind: "plan"; readonly plan: FirstmateInstanceCreationPlanV1 }
  | { readonly kind: "create"; readonly result: FirstmateInstanceCreateResultV1 }
  | { readonly kind: "select"; readonly choice: FirstmateInstanceChoice }
  | { readonly kind: "locator"; readonly descriptor: FirstmateNamedInstanceDescriptorV1 }

export type FirstmateInstanceMenuEvent =
  | { readonly type: "move"; readonly delta: 1 | -1 }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "name" | "path" | "refresh" | "confirm" | "cancel" | "locator" }
  | { readonly type: "resolved"; readonly generation: number; readonly result: MenuResult }
  | {
      readonly type: "failed"; readonly generation: number; readonly error: string
      readonly creationResult?: FirstmateInstanceCreateResultV1
    }

export const parseFirstmateLaunchOrigin = (value: string | undefined): FirstmateInstanceControlContextV1 | undefined =>
  value === undefined ? undefined : parseFirstmateInstanceControlContextJson(value)

export const firstmateLaunchOrigin = (
  inherited: FirstmateInstanceControlContextV1 | undefined, raw: string | undefined,
): FirstmateInstanceControlContextV1 | undefined => {
  const environment = parseFirstmateLaunchOrigin(raw)
  if (inherited !== undefined && environment !== undefined &&
      canonicalFirstmateInstanceJson(inherited) !== canonicalFirstmateInstanceJson(environment)) {
    throw new Error("Firstmate launch-origin hints disagree. Reopen the original pane; runtime cwd is not a fallback.")
  }
  return inherited ?? environment
}

export const initialFirstmateInstanceMenu = (cwd: string, generation = 1): FirstmateInstanceMenuState => ({
  generation, operation: { kind: "discover" }, screen: "list", instances: [], entry: null,
  configurationCwd: cwd, index: 0, text: "", confirm: false, creationUncertain: false, recoveryPlans: [],
})

const describeError = (cause: unknown): string => cause instanceof Error ? cause.message : "Instance operation failed."
const diagnostic = (value: { readonly diagnostics: ReadonlyArray<{ readonly message: string }> }): string =>
  value.diagnostics.map(({ message }) => message).join("\n")
const inside = (directory: string, root: string): boolean => directory === root || directory.startsWith(`${root}${path.sep}`)

const unboundProfile = (profile: NativeSelectedProfile): NativeSelectedProfile => {
  const { firstmateInstance: _reference, firstmateInstanceContext: _context, ...unbound } = profile
  return unbound
}

const originPath = async (
  env: FirstmateInstanceMenuEnvironment, instances: ReadonlyArray<FirstmateInstanceDescriptorV1>, signal: AbortSignal,
): Promise<string | null> => {
  const origin = env.launchOrigin
  if (origin === undefined) return env.cwd
  const profile = unboundProfile(env.profile)
  const owners = origin.reference.profile === profile.profile ? instances
    : await createFirstmateInstancesClient(env.runner, { ...profile, profile: origin.reference.profile }, env.cwd).list({ signal })
  const owner = owners.find(({ reference }) => reference !== null && sameFirstmateInstance(reference, origin.reference))
  if (owner === undefined) throw new Error("Captured launch origin no longer identifies an owned fleet. Select an entry worktree explicitly.")
  validateFirstmateInstanceControlContextV1(origin, owner)
  return origin.entryWorktree?.locators.worktree ?? null
}

const inspectDiscoveryEntry = async (
  env: FirstmateInstanceMenuEnvironment,
  instances: ReadonlyArray<FirstmateInstanceDescriptorV1>,
  entryPath: string,
  selectedPath: string | undefined,
  signal: AbortSignal,
): Promise<FirstmateInstanceResolveResultV1> => {
  if (instances.some(({ root }) => inside(path.resolve(entryPath), root))) {
    throw new Error("A managed Firstmate runtime is not an entry worktree. Enter the original worktree path explicitly.")
  }
  const resolution = await createFirstmateInstancesClient(env.runner, unboundProfile(env.profile), env.cwd).resolve(entryPath, { signal })
  const original = selectedPath === undefined ? env.launchOrigin?.entryWorktree : undefined
  if (original != null && (resolution.worktree === null ||
      firstmateWorktreeBindingDigest(original) !== firstmateWorktreeBindingDigest(resolution.worktree))) {
    throw new Error("Captured entry-worktree evidence changed. Select and inspect the worktree explicitly; no fleet was selected.")
  }
  return resolution
}

const discover = async (
  env: FirstmateInstanceMenuEnvironment, selectedPath: string | undefined, signal: AbortSignal,
  configurationCwd?: string,
): Promise<Discovery> => {
  const profile = unboundProfile(env.profile)
  const client = createFirstmateInstancesClient(env.runner, profile, env.cwd)
  const instances = await client.list({ signal })
  const recoveryPlans = await (env.creationStore ?? new FileFirstmateCreationPlanStore()).list(profile.profile)
  const selection = env.profile.firstmateInstance === undefined ? {} : { selectedReference: env.profile.firstmateInstance }
  try {
    const entryPath = selectedPath ?? await originPath(env, instances, signal)
    if (entryPath === null) {
      return { instances, recoveryPlans, ...selection, resolution: null, configurationCwd: configurationCwd ?? env.cwd, error: "Captured launch origin has no worktree. Choose a worktree or explicitly join a fleet; runtime cwd is not an origin." }
    }
    const resolution = await inspectDiscoveryEntry(env, instances, entryPath, selectedPath, signal)
    return {
      instances, recoveryPlans, ...selection, resolution,
      configurationCwd: configurationCwd ?? (selectedPath !== undefined || env.launchOrigin !== undefined ? entryPath : env.cwd),
      ...(resolution.state === "blocked" ? { error: diagnostic(resolution) } : {}),
    }
  } catch (cause) {
    signal.throwIfAborted()
    return { instances, recoveryPlans, ...selection, resolution: null, configurationCwd: configurationCwd ?? env.cwd, error: describeError(cause) }
  }
}

const menuChoice = (state: FirstmateInstanceMenuState): FirstmateInstanceChoice => {
  const descriptor = state.descriptor
  if (descriptor === undefined) throw new Error("Choose an owned instance.")
  const entryMatch = descriptor.mode === "named" && state.entry !== null &&
    firstmateWorktreeBindingDigest(state.entry) === firstmateWorktreeBindingDigest(descriptor.worktree.evidence)
  return {
    descriptor,
    context: createFirstmateInstanceContext(descriptor, state.entry, entryMatch ? "entry-match" : "confirmed-join"),
    configurationCwd: state.configurationCwd,
  }
}

const verifyChoice = async (
  env: FirstmateInstanceMenuEnvironment, choice: FirstmateInstanceChoice, signal: AbortSignal,
): Promise<FirstmateInstanceChoice> => {
  const client = createFirstmateInstancesClient(env.runner, unboundProfile(env.profile), choice.configurationCwd)
  const instances = await client.list({ signal })
  const current = instances.find(({ reference }) => reference !== null && sameFirstmateInstance(reference, choice.context.reference))
  if (current === undefined || canonicalFirstmateInstanceJson(current) !== canonicalFirstmateInstanceJson(choice.descriptor)) {
    throw new Error("Instance evidence changed during review. Refresh and review the same instance again.")
  }
  if (choice.context.entryWorktree !== null) {
    const resolved = await client.resolve(choice.context.entryWorktree.locators.worktree, { signal })
    if (resolved.worktree === null || firstmateWorktreeBindingDigest(resolved.worktree) !==
        firstmateWorktreeBindingDigest(choice.context.entryWorktree)) {
      throw new Error("The reviewed entry worktree changed. Nothing was selected.")
    }
  }
  validateFirstmateInstanceControlContextV1(choice.context, current)
  if (current.mode === "named" && current.runtime.required.sourceRevision !== env.profile.orchestration?.sourceRevision) {
    throw new Error("The selected instance requires another source revision. Refresh its runtime before control.")
  }
  return { ...choice, descriptor: current }
}

const performFirstmateInstanceMenuOperation = async (
  env: FirstmateInstanceMenuEnvironment, state: FirstmateInstanceMenuState, operation: MenuOperation, signal: AbortSignal,
  client: ReturnType<typeof createFirstmateInstancesClient>,
): Promise<MenuResult> => {
  switch (operation.kind) {
    case "discover": return { kind: "discover", discovery: await discover(env, operation.path, signal) }
    case "refresh": return {
      kind: "discover",
      discovery: await discover(env, state.entry?.locators.worktree ?? state.configurationCwd, signal, state.configurationCwd),
    }
    case "plan": {
      const planned = await client.plan(operation.name, operation.path, { signal })
      if (planned.state !== "ready") throw new Error(diagnostic(planned))
      if (state.entry === null || firstmateWorktreeBindingDigest(state.entry) !== firstmateWorktreeBindingDigest(planned.plan.worktree)) {
        throw new Error("The creation plan changed the reviewed entry worktree. Refresh and review a new plan; nothing was approved.")
      }
      return { kind: "plan", plan: planned.plan }
    }
    case "create": return { kind: "create", result: await createWithRecovery(env, state, operation.plan, signal) }
    case "select": return { kind: "select", choice: await verifyChoice(env, operation.choice, signal) }
    case "locator": return { kind: "locator", descriptor: await client.refreshLocator(operation.descriptor, operation.path, { signal }) }
  }
}

export const runFirstmateInstanceMenuOperation = async (
  env: FirstmateInstanceMenuEnvironment, state: FirstmateInstanceMenuState, signal: AbortSignal,
): Promise<FirstmateInstanceMenuEvent> => {
  const operation = state.operation
  if (operation === undefined) throw new Error("No instance operation is pending.")
  const client = createFirstmateInstancesClient(env.runner, unboundProfile(env.profile), state.configurationCwd)
  try {
    const result = await performFirstmateInstanceMenuOperation(env, state, operation, signal, client)
    signal.throwIfAborted()
    return { type: "resolved", generation: state.generation, result }
  } catch (cause) {
    return {
      type: "failed", generation: state.generation, error: describeError(cause),
      ...((cause instanceof FirstmateInstanceCommandError || cause instanceof CreationRecoveryError) && cause.creationResult !== undefined
        ? { creationResult: cause.creationResult } : {}),
    }
  }
}

class CreationRecoveryError extends Error {
  constructor(readonly creationResult: FirstmateInstanceCreateResultV1, cause: unknown) {
    super(`Creation returned ${creationResult.state}, but local recovery evidence could not be updated: ${describeError(cause)}. Keep the original plan and UUID.`)
  }
}

const createWithRecovery = async (
  env: FirstmateInstanceMenuEnvironment, state: FirstmateInstanceMenuState,
  plan: FirstmateInstanceCreationPlanV1, signal: AbortSignal,
): Promise<FirstmateInstanceCreateResultV1> => {
  const store = env.creationStore ?? new FileFirstmateCreationPlanStore()
  signal.throwIfAborted()
  await store.save(plan)
  signal.throwIfAborted()
  const result = await createFirstmateInstancesClient(env.runner, unboundProfile(env.profile), state.configurationCwd).create(plan, { signal })
  if (result.state === "created" || result.state === "existing") {
    try { await store.complete(plan) } catch (cause) { throw new CreationRecoveryError(result, cause) }
  }
  return result
}

const recoverCreationPlan = (state: FirstmateInstanceMenuState, plan: FirstmateInstanceCreationPlanV1): FirstmateInstanceMenuState => ({
  ...state, screen: "creation", plan, approvedPlan: plan, creationUncertain: true, confirm: false,
  error: "An approved creation is unfinished. Review this saved plan and explicitly retry the SAME UUID; no creation was started automatically.",
})

const discoveredMenu = (state: FirstmateInstanceMenuState, discovery: Discovery): FirstmateInstanceMenuState => {
  const { instances, resolution, configurationCwd, error, recoveryPlans } = discovery
  const recommended = resolution?.state === "matched"
    ? instances.findIndex(({ reference }) => reference !== null && sameFirstmateInstance(reference, resolution.descriptor.reference)) : -1
  const next: FirstmateInstanceMenuState = {
    ...state, screen: "list", instances, entry: resolution?.state === "blocked" ? null : resolution?.worktree ?? null, configurationCwd,
    locatorEvidence: resolution?.worktree ?? undefined,
    index: Math.max(0, recommended), descriptor: undefined, error, recoveryPlans,
  }
  const selected = discovery.selectedReference
  if (selected !== undefined) {
    const index = instances.findIndex(({ reference }) => reference !== null && sameFirstmateInstance(selected, reference))
    return {
      ...next, index,
      ...(index < 0 ? { error: `Saved instance ${selected.instanceId} is missing. No entry-worktree default was substituted.` } : {}),
    }
  }
  const pending = recoveryPlans.filter((plan) => next.entry !== null && sameFirstmateWorktreeGeneration(plan.worktree, next.entry))
  if (pending.length > 1) return { ...next, error: "Multiple approved creations reference this worktree. Select an exact saved instance; no new plan is permitted." }
  return pending[0] === undefined ? next : recoverCreationPlan(next, pending[0])
}

const begin = (state: FirstmateInstanceMenuState, operation: MenuOperation): FirstmateInstanceMenuState => ({
  ...state, generation: state.generation + 1, operation, confirm: false, accepted: undefined, error: undefined,
})

export const pauseFirstmateInstanceMenu = (state: FirstmateInstanceMenuState): FirstmateInstanceMenuState => ({
  ...state, generation: state.generation + 1, operation: undefined, confirm: false,
  ...(state.operation?.kind === "create" ? {
    creationUncertain: true, screen: "creation" as const,
    error: "Creation was interrupted. Keep this approved plan and UUID; explicitly retry the same creation.",
  } : {}),
})

const resolvedMenu = (state: FirstmateInstanceMenuState, result: MenuResult): FirstmateInstanceMenuState => {
  const idle = { ...state, operation: undefined, confirm: false, error: undefined }
  switch (result.kind) {
    case "discover": return discoveredMenu(idle, result.discovery)
    case "plan": return { ...idle, screen: "creation", plan: result.plan, approvedPlan: undefined, creationUncertain: false }
    case "create": {
      const complete = result.result.state === "created" || result.result.state === "existing"
      return {
        ...idle, screen: complete ? "review" : "creation", creationResult: result.result,
        descriptor: result.result.descriptor ?? undefined, creationUncertain: !complete,
        ...(complete ? {} : { error: diagnostic(result.result) }),
      }
    }
    case "select": return { ...idle, accepted: result.choice }
    case "locator": return {
      ...idle, screen: "review", descriptor: result.descriptor, entry: result.descriptor.worktree.evidence,
      instances: state.instances.map((item) => item.reference !== null && sameFirstmateInstance(item.reference, result.descriptor.reference) ? result.descriptor : item),
    }
  }
}

const confirmLocator = (state: FirstmateInstanceMenuState): FirstmateInstanceMenuState => {
  const evidence = state.entry ?? state.locatorEvidence
  if (state.descriptor?.mode !== "named" || evidence == null ||
      !sameFirstmateWorktreeGeneration(state.descriptor.worktree.evidence, evidence)) {
    throw new Error("Locator refresh requires proved matching worktree generations. Enter the moved worktree path first.")
  }
  return begin(state, { kind: "locator", descriptor: state.descriptor, path: evidence.locators.worktree })
}

const confirmCreation = (state: FirstmateInstanceMenuState): FirstmateInstanceMenuState => {
  const plan = state.approvedPlan ?? state.plan
  if (plan === undefined) throw new Error("Review a complete creation plan first.")
  return begin({ ...state, approvedPlan: plan, creationUncertain: true }, { kind: "create", plan })
}

const confirmMenu = (state: FirstmateInstanceMenuState): FirstmateInstanceMenuState => {
  if (state.creationUncertain && state.screen !== "creation") {
    throw new Error("Reconcile the original approved creation before selecting another instance.")
  }
  if (state.screen === "name") {
    if (state.entry === null) throw new Error("Inspect a real entry worktree before planning creation.")
    return begin(state, { kind: "plan", name: state.text, path: state.entry.locators.worktree })
  }
  if (state.screen === "path") return begin(state, { kind: "discover", path: state.text })
  if (state.screen === "list") {
    const descriptor = state.instances[state.index]
    if (descriptor === undefined) throw new Error("No existing instance is selected. Create one, or enter another worktree.")
    const pending = state.recoveryPlans.find((plan) => descriptor.reference !== null && sameFirstmateInstance(plan.reference, descriptor.reference))
    if (pending !== undefined) return recoverCreationPlan(state, pending)
    return { ...state, screen: "review", descriptor, confirm: false, error: undefined }
  }
  if (!state.confirm) return { ...state, screen: "list", descriptor: undefined, error: undefined }
  if (state.screen === "review") return begin(state, { kind: "select", choice: menuChoice(state) })
  return state.screen === "creation" ? confirmCreation(state) : confirmLocator(state)
}

const menuText = (state: FirstmateInstanceMenuState, text: string): FirstmateInstanceMenuState => {
  const maximum = state.screen === "name" ? 64 : 4096
  if (text.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(text)) throw new Error(`Enter one line of at most ${maximum} characters.`)
  return { ...state, text, error: undefined }
}

const nameMenu = (state: FirstmateInstanceMenuState): FirstmateInstanceMenuState => {
  if (state.creationUncertain) throw new Error("Reconcile the original approved creation before requesting another plan.")
  if (state.recoveryPlans.some((plan) => state.entry !== null && sameFirstmateWorktreeGeneration(plan.worktree, state.entry))) {
    throw new Error("This worktree has a saved creation approval. Reconcile that exact UUID instead of requesting a new plan.")
  }
  const name = path.basename(state.entry?.locators.worktree ?? "fleet").toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64)
  return { ...state, screen: "name", text: name, plan: undefined, confirm: false, error: undefined }
}

const moveMenu = (state: FirstmateInstanceMenuState, delta: 1 | -1): FirstmateInstanceMenuState =>
  state.screen === "list" ? {
    ...state, descriptor: undefined, index: state.instances.length === 0 ? 0 : (state.index + delta + state.instances.length) % state.instances.length,
  } : { ...state, confirm: !state.confirm }

const refreshMenu = (state: FirstmateInstanceMenuState): FirstmateInstanceMenuState =>
  state.creationUncertain && state.approvedPlan !== undefined
    ? begin(state, { kind: "create", plan: state.approvedPlan })
    : begin(state, { kind: "refresh" })

const editMenu = (state: FirstmateInstanceMenuState, event: FirstmateInstanceMenuEvent): FirstmateInstanceMenuState => {
  switch (event.type) {
    case "move": return moveMenu(state, event.delta)
    case "text": return menuText(state, event.text)
    case "name": return nameMenu(state)
    case "path": return { ...state, screen: "path", text: state.entry?.locators.worktree ?? "", error: undefined }
    case "locator": return { ...state, screen: "locator", descriptor: state.descriptor ?? state.instances[state.index], confirm: false, error: undefined }
    case "refresh": return refreshMenu(state)
    case "confirm": return confirmMenu(state)
    default: return state
  }
}

const cancelledMenu = (state: FirstmateInstanceMenuState): FirstmateInstanceMenuState => ({
  ...pauseFirstmateInstanceMenu(state), screen: state.creationUncertain ? "creation" : "list",
  ...(state.creationUncertain ? {} : { descriptor: undefined }),
})

export const reduceFirstmateInstanceMenu = (
  state: FirstmateInstanceMenuState, event: FirstmateInstanceMenuEvent,
): FirstmateInstanceMenuState => {
  if (event.type === "resolved" || event.type === "failed") {
    if (event.generation !== state.generation || state.operation === undefined) return state
    return event.type === "resolved" ? resolvedMenu(state, event.result) : {
      ...state, operation: undefined, confirm: false, error: event.error,
      ...(event.creationResult === undefined ? {} : { creationResult: event.creationResult }),
    }
  }
  if (event.type === "cancel") return cancelledMenu(state)
  if (state.operation !== undefined) return state
  try {
    return editMenu(state, event)
  } catch (cause) {
    return { ...state, error: describeError(cause) }
  }
}

export const firstmateInstanceDescriptorLines = (descriptor: FirstmateInstanceDescriptorV1): ReadonlyArray<string> => [
  `Profile: fmx/${descriptor.profile}; ${descriptor.mode} instance: ${descriptor.name}`,
  `UUID: ${descriptor.reference?.instanceId ?? "missing identity; not selectable"}`,
  `State: ${descriptor.creationState}; runtime: ${descriptor.runtime.state}; association: ${descriptor.worktree.status}`,
  `Private root: ${descriptor.root}`,
  `Task namespace: ${descriptor.taskIdPrefix}-`,
  ...(descriptor.mode === "named" ? [
    `Bound worktree: ${descriptor.worktree.evidence.locators.worktree}`,
    `Private Git directory: ${descriptor.worktree.evidence.locators.privateGitDir}`,
    `Common Git directory: ${descriptor.worktree.evidence.locators.commonGitDir}`,
    `Generation digest: ${descriptor.worktree.evidence.generationDigest}`,
    `Binding digest: ${firstmateWorktreeBindingDigest(descriptor.worktree.evidence)}`,
    `Runtime variant: ${descriptor.runtime.required.variant}`,
    `Source revision: ${descriptor.runtime.required.sourceRevision}`,
    `Runtime content: ${descriptor.runtime.required.effectiveContentDigest}`,
  ] : ["Legacy shared fleet; joining does not bind it to this worktree."]),
  ...descriptor.diagnostics.map(({ code, message }) => `${code}: ${message}`),
]

const planLines = (plan: FirstmateInstanceCreationPlanV1): ReadonlyArray<string> => [
  `Create ${plan.name} on fmx/${plan.reference.profile}`,
  `Planned UUID: ${plan.reference.instanceId}`, `Task namespace: ${plan.taskIdPrefix}-`,
  `Destination: ${plan.destination}`, `Entry worktree: ${plan.worktree.locators.worktree}`,
  `Private Git directory: ${plan.worktree.locators.privateGitDir}`,
  `Common Git directory: ${plan.worktree.locators.commonGitDir}`,
  `Generation digest: ${plan.worktree.generationDigest}`,
  `Generation evidence: ${JSON.stringify(plan.worktree.generation)}`,
  `Source revision: ${plan.sourceRevision}`, `Runtime: ${plan.runtimeRequirements.variant}`,
  `Base manifest: ${plan.runtimeRequirements.baseManifestDigest}`,
  `Supplement manifest: ${plan.runtimeRequirements.supplementManifestDigest}`,
  `Runtime content: ${plan.runtimeRequirements.effectiveContentDigest}`,
  ...plan.permittedWrites.map(({ kind, path }) => `Native permitted write (${kind}): ${path}`),
  "Approval identity:", plan.approvalDigest,
  "Creation grants setup for this instance only. No package installation, authentication changes, supervisor start, workers, or task submission.",
  "Guide saves this exact plan privately before creation. An interrupted operation retains the original UUID for explicit retry.",
]

const menuTitles: Readonly<Record<FirstmateInstanceMenuState["screen"], string>> = {
  name: "Name the new Firstmate instance",
  path: "Entry worktree path",
  creation: "Review Firstmate instance creation",
  locator: "Review proved worktree locator refresh",
  review: "Confirm Firstmate instance",
  list: "Choose a Firstmate instance",
}

export const firstmateInstanceMenuIsEditor = (state: FirstmateInstanceMenuState): boolean =>
  state.screen === "name" || state.screen === "path"

const menuReview = (state: FirstmateInstanceMenuState): boolean =>
  state.screen === "review" || state.screen === "creation" || state.screen === "locator"

const menuDecisionLabel = (state: FirstmateInstanceMenuState): string =>
  state.screen === "creation" ? "Create this instance" : state.screen === "locator" ? "Refresh proved locators" : "Use this instance"

const menuInstanceLines = (state: FirstmateInstanceMenuState): ReadonlyArray<string> => {
  if (state.screen === "creation" && state.plan !== undefined) return planLines(state.approvedPlan ?? state.plan)
  const descriptor = state.screen === "list" ? state.instances[state.index] : state.descriptor ?? state.instances[state.index]
  return descriptor === undefined ? ["No existing instance. Enter a worktree and review creation."]
    : firstmateInstanceDescriptorLines(descriptor)
}

const menuDecisionLines = (state: FirstmateInstanceMenuState): ReadonlyArray<string> => {
  if (!menuReview(state)) return []
  const descriptor = state.descriptor
  const entryMatch = descriptor?.mode === "named" && state.entry !== null &&
    firstmateWorktreeBindingDigest(state.entry) === firstmateWorktreeBindingDigest(descriptor.worktree.evidence)
  return [
    ...(state.screen === "review" ? [
      entryMatch ? "Use this entry-worktree instance."
        : "Join this existing fleet explicitly. This does not replace the entry worktree's default association.",
    ] : []),
    ...(state.screen === "locator" ? [
      `Proposed locator: ${(state.entry ?? state.locatorEvidence)?.locators.worktree ?? "not proved"}`,
      "Refresh locators only after Native proves the same filesystem generations. UUID, home, namespace, and saved requests cannot change.",
    ] : []),
    `${state.confirm ? " " : ">"} Cancel`,
    `${state.confirm ? ">" : " "} ${menuDecisionLabel(state)}`,
  ]
}

const menuControls = (state: FirstmateInstanceMenuState): ReadonlyArray<string> => {
  if (firstmateInstanceMenuIsEditor(state)) return ["Enter Review | Esc Cancel edit"]
  if (menuReview(state)) return [
    `${state.confirm ? menuDecisionLabel(state) : "Cancel"} selected | j/k Choose | Enter Confirm | Esc Cancel`,
    "r Retry/refresh | p Entry path | m Review locator refresh | PgUp/PgDn Details",
  ]
  return [
    `Focus: ${state.instances[state.index]?.name ?? "no existing instance"} (${Math.min(state.index + 1, state.instances.length)}/${state.instances.length})`,
    "j/k Choose | Enter Review | n Create | p Entry path",
    "r Refresh | m Review locator refresh | Esc Back | PgUp/PgDn Details",
  ]
}

interface InstanceInputKey {
  readonly return?: boolean
  readonly escape?: boolean
  readonly upArrow?: boolean
  readonly downArrow?: boolean
  readonly backspace?: boolean
  readonly delete?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
}

const instanceEditorEvent = (
  state: FirstmateInstanceMenuState, input: string, key: InstanceInputKey,
): FirstmateInstanceMenuEvent | undefined => {
  if (key.return) return { type: "confirm" }
  if (key.escape) return { type: "cancel" }
  if (key.backspace || key.delete) return { type: "text", text: [...state.text].slice(0, -1).join("") }
  return input.length > 0 && !key.ctrl && !key.meta ? { type: "text", text: state.text + input } : undefined
}

export const firstmateInstanceMenuKeyEvent = (
  state: FirstmateInstanceMenuState, input: string, key: InstanceInputKey,
): FirstmateInstanceMenuEvent | undefined => {
  if (firstmateInstanceMenuIsEditor(state)) return instanceEditorEvent(state, input, key)
  if (key.escape || input === "b") return { type: "cancel" }
  if (key.return) return { type: "confirm" }
  if (key.upArrow || input === "k") return { type: "move", delta: -1 }
  if (key.downArrow || input === "j") return { type: "move", delta: 1 }
  const actions: Readonly<Record<string, FirstmateInstanceMenuEvent | undefined>> = {
    n: { type: "name" }, p: { type: "path" }, r: { type: "refresh" }, m: { type: "locator" },
  }
  return actions[input]
}

export const firstmateInstanceMenuDocument = (state: FirstmateInstanceMenuState): {
  readonly title: string; readonly body: string; readonly controls: ReadonlyArray<string>
} => {
  const body = [
    ...(state.operation === undefined ? [] : [`Checking: ${state.operation.kind}. No task or supervisor action is approved.`]),
    ...(state.error === undefined ? [] : [`Problem: ${state.error}`]),
    ...(state.creationResult === undefined ? [] : [
      `Last creation result: ${state.creationResult.state}`,
      ...state.creationResult.diagnostics.map(({ code, message }) => `${code}: ${message}`),
    ]),
    `Entry worktree: ${state.entry?.locators.worktree ?? "not verified; do not infer from runtime cwd"}`,
    `Preparation configuration cwd: ${state.configurationCwd}`,
    "Instance binding is separate from project target and supervisor destination.",
    ...(state.screen === "list" ? state.instances.map((item, index) =>
      `${index === state.index ? ">" : " "} ${item.name} (${item.mode}) — ${item.creationState}; ${item.worktree.status}`) : []),
    ...(firstmateInstanceMenuIsEditor(state) ? [`Value: ${state.text}`] : []),
    ...menuInstanceLines(state),
    ...(state.creationUncertain ? [`Creation is uncertain. Retry only approved UUID ${state.approvedPlan?.reference.instanceId ?? "not available"}.`] : []),
    ...menuDecisionLines(state),
  ]
  return {
    title: menuTitles[state.screen], body: body.join("\n"), controls: menuControls(state),
  }
}
