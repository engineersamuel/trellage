import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import lockfile from "proper-lockfile"
import { getProcessInfo, listAgents } from "@trellage/conversation-source/herdr"
import { resolveGuideModelRouting, validateGuideIntent } from "./guide-api.ts"
import type { CombinedGuideCatalog } from "./guide-catalog.ts"
import {
  buildHerdrGuideLaunch,
  CommandRunnerError,
  createHerdrTab,
  getHerdrContext,
  herdrEnvironment,
  launchInHerdrPane,
  parseSelectedProfile,
  runInteractiveTerminalCommand,
  splitHerdrPane,
  type CommandRunner,
  type CommandSpec,
  type HerdrContext,
  type NativeSelectedProfile,
} from "./guide-launch.ts"
import type { GuideModelConfig, GuideModelRouting } from "./guide-model-routing.ts"
import { captureOptimizeEvidence, optimizeDigest } from "./guide-optimize-evidence.ts"
import {
  newOptimizeReview,
  optimizeReviewersFor,
  runOptimizeReview,
  type OptimizeApproval,
  type OptimizeModelCall,
  type OptimizeReview,
  type OptimizeReviewInput,
  type OptimizeReviewer,
} from "./guide-optimize-review.ts"
import { loadOptimizeArchitecture, optimizeArchitectureSkill } from "./guide-optimize-skills.ts"
import { OptimizeReviewStore, type OptimizeReviewSummary } from "./guide-optimize-store.ts"
import {
  assertGuideOptimizeTargetCurrent,
  guideOptimizeTargetIdentity,
  inspectGuideOptimizeTarget,
  selectedGuideOptimizeChanges,
  type GuideOptimizeScope,
  type GuideOptimizeTarget,
} from "./guide-optimize-target.ts"
import { checkSelectedProfileReadiness, ProfileReadinessKind } from "./guide-preflight.ts"
import { array, record } from "./guide-text.ts"

export interface GuideOptimizeRequest {
  readonly target: GuideOptimizeTarget
  readonly paths: ReadonlyArray<string>
  readonly approval: OptimizeApproval
  readonly destination: "terminal" | "pane" | "tab"
  readonly originalIntent?: string
  readonly intent?: string
  readonly otherEditorsStopped: boolean
}

export interface GuideOptimizeProfile {
  readonly ref: string
  readonly label: string
  readonly profile: NativeSelectedProfile
}

export interface GuideOptimizeReceipt {
  readonly paneId: string
  readonly message: string
}

export interface GuideOptimizeServices {
  readonly herdr: boolean
  readonly profiles: ReadonlyArray<GuideOptimizeProfile>
  readonly reviewers: ReadonlyArray<OptimizeReviewer>
  readonly coordinator: GuideModelConfig
  readonly destinations: ReadonlyArray<GuideOptimizeRequest["destination"]>
  inspect(scope: GuideOptimizeScope, signal: AbortSignal): Promise<GuideOptimizeTarget>
  review(input: OptimizeReviewInput, signal: AbortSignal, progress: (message: string) => void): Promise<OptimizeReview>
  history(signal: AbortSignal): Promise<ReadonlyArray<OptimizeReviewSummary>>
  readReview(id: string, signal: AbortSignal): Promise<OptimizeReview>
  approve(id: string, ids: ReadonlyArray<string>, signal: AbortSignal): Promise<OptimizeApproval>
  execute(request: GuideOptimizeRequest, profileRef: string, signal: AbortSignal): Promise<GuideOptimizeReceipt>
}

export interface GuideOptimizeTerminalResult {
  readonly action: "optimize-terminal"
  readonly request: GuideOptimizeRequest
  readonly selectedProfile: NativeSelectedProfile
}

export interface GuideOptimizeDependencies {
  readonly listAgents?: typeof listAgents
  readonly processReader?: typeof getProcessInfo
  readonly readiness?: typeof checkSelectedProfileReadiness
  readonly modelCall?: OptimizeModelCall
  readonly loadArchitecture?: typeof loadOptimizeArchitecture
}

const nativeLaunchers = new Set(["cpx", "cdx", "cldx"])
const readyStatus = (value: unknown): boolean => value === "idle" || value === "done"
const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export const guideOptimizeProfiles = (catalog: CombinedGuideCatalog): ReadonlyArray<GuideOptimizeProfile> =>
  catalog.native
    .filter((entry) => nativeLaunchers.has(entry.launcher))
    .map((entry) => {
      const profile = parseSelectedProfile({
        surface: "native",
        launcher: entry.launcher,
        commandPath: entry.commandPath,
        profile: entry.name,
        headlessPrompt: entry.headless.prompt,
      })
      if (profile.surface !== "native") throw new Error("Optimize requires a Native profile in the current worktree.")
      return { ref: `native:${entry.launcher}/${entry.name}`, label: `${entry.launcher} ${entry.name}`, profile }
    })

export const assertGuideOptimizeNoWriters = async (
  target: GuideOptimizeTarget,
  env: NodeJS.ProcessEnv,
  dependencies: GuideOptimizeDependencies = {},
  ignoredPanes: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
): Promise<void> => {
  const agents = await (dependencies.listAgents ?? listAgents)({
    socketPath: env.HERDR_SOCKET_PATH,
    ...(signal === undefined ? {} : { signal }),
  })
  for (const agent of agents) {
    if (
      (typeof agent.pane_id === "string" && ignoredPanes.has(agent.pane_id)) ||
      typeof agent.agent !== "string" ||
      readyStatus(agent.agent_status)
    )
      continue
    const directory = agent.foreground_cwd ?? agent.cwd
    if (typeof directory !== "string" || !path.isAbsolute(directory)) {
      throw new Error(
        `Busy agent in pane ${JSON.stringify(agent.pane_id)} has no verified working directory. Stop it before optimizing shared files.`,
      )
    }
    const canonical = await realpath(directory)
    if (canonical === target.cwd || canonical.startsWith(`${target.cwd}${path.sep}`)) {
      throw new Error(
        `Agent in pane ${String(agent.pane_id)} is ${String(agent.agent_status)} in this worktree. Stop or finish it first.`,
      )
    }
  }
}

export const buildGuideOptimizePrompt = (request: GuideOptimizeRequest): string => {
  selectedGuideOptimizeChanges(request.target, request.paths)
  if (request.approval === undefined || request.approval.findings.length === 0)
    throw new Error("Approve saved review findings before implementation.")
  const allowed = [...new Set(request.approval.findings.flatMap((entry) => entry.paths))]
  if (allowed.some((filename) => !request.paths.includes(filename)))
    throw new Error("Approved finding exceeds the reviewed scope.")
  const changes = selectedGuideOptimizeChanges(request.target, allowed)
  const target = request.target
  const parts = [
    "Implement only the explicitly approved optimization findings below. Do not perform a new open-ended cleanup.",
    "Inspect the actual Git changes and related code before deciding. Preserve task requirements, behavior, and unrelated changes.",
    "Read repository instructions, relevant documentation, existing helpers, and tests for context. Do not turn this into unrelated repository-wide cleanup.",
    "Inspect staged and unstaged diffs and selected untracked files. For branch scope, also compare its stated merge-base with HEAD.",
    "Modify only the selected paths. If a necessary change falls outside them, report it instead of expanding the scope.",
    "Do not follow symbolic links or modify another worktree. Do not stage, commit, stash, reset, or discard changes.",
    "Use the original task below to preserve requirements, not to restart its workflow or repeat previous delivery commands.",
    "Run the relevant existing checks after any code change. It is valid to make no change.",
    "Reviewer agreement is not proof. Independently verify each proposal and leave it unchanged if its evidence is wrong or its risk is unresolved.",
    `## Change target\n${JSON.stringify(
      {
        worktree: target.cwd,
        head: target.head,
        scope: target.scope,
        comparisonBase: target.base ?? null,
        selectedPaths: changes.map((entry) => entry.path),
      },
      null,
      2,
    )}`,
    `## Approved findings from review ${request.approval.reviewId}\n${JSON.stringify(request.approval.findings, null, 2)}`,
  ]
  if (request.originalIntent !== undefined) parts.push(`## Original task (unchanged)\n${request.originalIntent}`)
  if (request.intent !== undefined && request.intent !== request.originalIntent) {
    parts.push(`## Current Guide task and constraints (unchanged)\n${request.intent}`)
  }
  return validateGuideIntent(
    parts.join("\n\n"),
    "Implementation request; approve fewer findings or shorten the supplied task if it exceeds the prompt limit",
  )
}

const requireConfirmation = (request: GuideOptimizeRequest): void => {
  if (!request.otherEditorsStopped)
    throw new Error("Confirm that other agents and editors have stopped changing this worktree.")
  selectedGuideOptimizeChanges(request.target, request.paths)
  buildGuideOptimizePrompt(request)
}

const safeTargetLock = async (directory: string): Promise<string> => {
  const parent = await lstat(directory)
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()) {
    throw new Error("The optimization lock requires owned, regular Git metadata.")
  }
  const file = path.join(directory, "trellage-optimize.lock")
  try {
    const info = await lstat(file)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) {
      throw new Error("The optimization lock path is unsafe. It was not changed.")
    }
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause
  }
  return file
}

const withTargetLock = async <Value>(target: GuideOptimizeTarget, operation: () => Promise<Value>): Promise<Value> => {
  const release = await lockfile.lock(target.gitDirectory, {
    lockfilePath: await safeTargetLock(target.gitDirectory),
    realpath: false,
    retries: 0,
  })
  try {
    return await operation()
  } finally {
    await release()
  }
}

interface OptimizeRuntime {
  readonly runner: CommandRunner
  readonly cwd: string
  readonly context: HerdrContext | null
  readonly catalog: CombinedGuideCatalog
  readonly env?: NodeJS.ProcessEnv
  readonly dependencies?: GuideOptimizeDependencies
  readonly routing?: GuideModelRouting
}

const herdrRunner = (options: OptimizeRuntime): CommandRunner =>
  options.env === undefined
    ? options.runner
    : {
        run: (executable, args, commandOptions) =>
          options.runner.run(executable, args, {
            ...commandOptions,
            env: { ...process.env, ...options.env },
          }),
      }

const hasForegroundGuideProcess = async (
  context: HerdrContext,
  env: NodeJS.ProcessEnv,
  dependencies: GuideOptimizeDependencies = {},
  signal?: AbortSignal,
): Promise<boolean> => {
  if (context.surface !== "pane") return false
  const info = await (dependencies.processReader ?? getProcessInfo)(context.paneId, {
    socketPath: env.HERDR_SOCKET_PATH,
    ...(signal === undefined ? {} : { signal }),
  })
  if (info.pane_id !== context.paneId) throw new Error("Herdr returned process information for a different Guide pane.")
  const foreground = array(info.foreground_processes, "Herdr foreground processes")
  return foreground.some((entry) => record(entry, "foreground process").pid === process.pid)
}

const currentRequest = async (
  options: Pick<OptimizeRuntime, "runner" | "context" | "env" | "dependencies">,
  request: GuideOptimizeRequest,
  signal?: AbortSignal,
  ignoredPane?: string,
): Promise<GuideOptimizeRequest> => {
  requireConfirmation(request)
  const saved = await new OptimizeReviewStore(request.target.gitDirectory).approved(request.approval)
  const expected = {
    target: saved.input.target,
    paths: saved.input.paths,
    originalIntent: saved.input.originalIntent,
    intent: saved.input.intent,
  }
  if (
    !isDeepStrictEqual(expected, {
      target: request.target,
      paths: request.paths,
      originalIntent: request.originalIntent,
      intent: request.intent,
    })
  )
    throw new Error("Implementation context differs from the approved review.")
  const target = await assertGuideOptimizeTargetCurrent(options.runner, request.target, signal)
  selectedGuideOptimizeChanges(target, request.paths)
  const env = options.env ?? process.env
  if (options.context !== null) {
    const ignoredPanes = new Set(ignoredPane === undefined ? [] : [ignoredPane])
    if (await hasForegroundGuideProcess(options.context, env, options.dependencies, signal))
      ignoredPanes.add(options.context.paneId)
    await assertGuideOptimizeNoWriters(target, env, options.dependencies, ignoredPanes, signal)
  }
  return { ...request, target }
}

const assertReviewedEvidenceCurrent = async (
  runner: CommandRunner,
  request: GuideOptimizeRequest,
  signal: AbortSignal,
): Promise<void> => {
  const review = await new OptimizeReviewStore(request.target.gitDirectory).approved(request.approval)
  const current = await captureOptimizeEvidence(runner, request.target, request.paths, signal)
  const expected = optimizeDigest({
    sources: review.evidence.sources.filter((entry) => !entry.id.startsWith("@skill/")),
    excluded: review.evidence.excluded,
  })
  if (current.fingerprint !== expected)
    throw new Error("Review context changed. Run a new review before implementation.")
}

const readyProfile = async (
  runner: CommandRunner,
  profile: NativeSelectedProfile,
  cwd: string,
  dependencies: GuideOptimizeDependencies,
  signal?: AbortSignal,
): Promise<void> => {
  if (!nativeLaunchers.has(profile.launcher)) throw new Error("Choose a Native Copilot, Codex, or Claude profile.")
  const readiness = await (dependencies.readiness ?? checkSelectedProfileReadiness)(runner, profile, cwd, signal)
  if (readiness.kind === ProfileReadinessKind.Blocked) throw new Error(`${readiness.summary}. ${readiness.diagnostic}`)
}

const runFreshAgent = async (
  options: OptimizeRuntime,
  request: GuideOptimizeRequest,
  profileRef: string,
  signal: AbortSignal,
): Promise<GuideOptimizeReceipt> => {
  if (options.context === null) throw new Error("A new Herdr agent requires a destination workspace.")
  if (request.destination === "terminal") throw new Error("Use the current-terminal handoff for this destination.")
  const profile = guideOptimizeProfiles(options.catalog).find((entry) => entry.ref === profileRef)?.profile
  if (profile === undefined) throw new Error("The selected Native profile is no longer available.")
  const dependencies = options.dependencies ?? {}
  const prompt = buildGuideOptimizePrompt(request)
  const launch = buildHerdrGuideLaunch(profile, prompt)
  if (launch.promptDelivery !== "command") throw new Error("This profile cannot start with an optimization request.")
  await readyProfile(options.runner, profile, request.target.cwd, dependencies, signal)
  await currentRequest(options, request, signal)
  await assertReviewedEvidenceCurrent(options.runner, request, signal)
  signal.throwIfAborted()
  const runner = herdrRunner(options)
  const paneId =
    request.destination === "tab"
      ? await createHerdrTab(runner, { workspaceId: options.context.workspaceId, cwd: request.target.cwd })
      : await splitHerdrPane(runner, {
          anchorPaneId: options.context.paneId,
          cwd: request.target.cwd,
          direction: "right",
        })
  const store = new OptimizeReviewStore(request.target.gitDirectory)
  let reserved = false
  try {
    await launchInHerdrPane(runner, {
      paneId,
      cwd: request.target.cwd,
      command: launch.command,
      beforeLaunch: async () => {
        await currentRequest(options, request, signal, paneId)
        await assertReviewedEvidenceCurrent(options.runner, request, signal)
        signal.throwIfAborted()
        await store.beginExecution(request.approval)
        reserved = true
      },
    })
    await store.finishExecution(request.approval.reviewId, "launched")
    return {
      paneId,
      message: "Approved optimization launched in one fresh agent in this worktree. Work is not yet verified.",
    }
  } catch (cause) {
    if (reserved)
      await markUnknownExecution(store, request.approval.reviewId, cause, `New agent pane ${paneId} remains open.`)
    throw new Error(
      `New agent pane ${paneId} remains open. ${errorText(cause)} Inspect it before retrying; no automatic resend.`,
      { cause },
    )
  }
}

const markUnknownExecution = async (
  store: OptimizeReviewStore,
  id: string,
  cause: unknown,
  destination: string,
): Promise<void> => {
  try {
    await store.finishExecution(id, "unknown")
  } catch (saveError) {
    throw new AggregateError(
      [cause, saveError],
      `${destination} Delivery or its receipt is uncertain. Do not resend this review.`,
      { cause: saveError },
    )
  }
}

export const runGuideOptimizeReview = async (
  options: Pick<OptimizeRuntime, "runner" | "cwd" | "env" | "dependencies">,
  routing: GuideModelRouting,
  input: OptimizeReviewInput,
  signal: AbortSignal,
  progress: (message: string) => void,
): Promise<OptimizeReview> => {
  const local = await guideOptimizeTargetIdentity(options.runner, options.cwd, signal)
  if (local.cwd !== input.target.cwd || local.gitDirectory !== input.target.gitDirectory)
    throw new Error("The review target is not this Guide worktree.")
  progress("Capturing a fixed source snapshot. Review sessions cannot edit your worktree.")
  const evidence = await captureOptimizeEvidence(options.runner, input.target, input.paths, signal)
  const initial = newOptimizeReview(input, evidence, optimizeReviewersFor(routing), routing.optimize)
  const skills = input.reviewerIds.includes(optimizeArchitectureSkill)
    ? await (options.dependencies?.loadArchitecture ?? loadOptimizeArchitecture)(
        options.runner,
        signal,
        options.env ?? process.env,
      )
    : []
  const sources = [...evidence.sources, ...skills]
  const snapshot = { sources, excluded: evidence.excluded }
  const review = { ...initial, evidence: { ...snapshot, fingerprint: optimizeDigest(snapshot) } }
  await assertGuideOptimizeTargetCurrent(options.runner, input.target, signal)
  const store = new OptimizeReviewStore(input.target.gitDirectory)
  await store.save(review)
  return runOptimizeReview(review, (state) => store.save(state), signal, progress, options.dependencies?.modelCall)
}

export const createGuideOptimizeServices = (options: OptimizeRuntime): GuideOptimizeServices => {
  const routing = options.routing ?? resolveGuideModelRouting({}, options.env ?? process.env)
  const storeForWorktree = async (signal: AbortSignal) =>
    new OptimizeReviewStore(
      (await inspectGuideOptimizeTarget(options.runner, options.cwd, { kind: "uncommitted" }, signal)).gitDirectory,
    )
  return {
    herdr: options.context !== null,
    profiles: guideOptimizeProfiles(options.catalog),
    reviewers: optimizeReviewersFor(routing),
    coordinator: routing.optimize,
    destinations:
      options.context === null
        ? ["terminal"]
        : options.context.surface === "popup"
          ? ["pane", "tab"]
          : ["pane", "tab", "terminal"],
    inspect: (scope, signal) => inspectGuideOptimizeTarget(options.runner, options.cwd, scope, signal),
    review: (input, signal, progress) => runGuideOptimizeReview(options, routing, input, signal, progress),
    history: async (signal) => (await storeForWorktree(signal)).list(),
    readReview: async (id, signal) => (await storeForWorktree(signal)).read(id),
    approve: async (id, ids, signal) => {
      const store = await storeForWorktree(signal)
      const review = await store.read(id)
      await assertGuideOptimizeTargetCurrent(options.runner, review.input.target, signal)
      signal.throwIfAborted()
      return store.approve(id, ids)
    },
    execute: async (request, profileRef, signal) => {
      requireConfirmation(request)
      const initial = await currentRequest(options, request, signal)
      return withTargetLock(initial.target, async () => {
        const checked = await currentRequest(options, request, signal)
        return runFreshAgent(options, checked, profileRef, signal)
      })
    },
  }
}

export const executeGuideOptimizeTerminal = async (
  result: GuideOptimizeTerminalResult,
  services: {
    readonly runner: CommandRunner
    readonly runInteractive?: (
      command: CommandSpec,
      options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
    ) => Promise<void>
    readonly readiness?: typeof checkSelectedProfileReadiness
    readonly context?: HerdrContext | null
  },
): Promise<number> => {
  requireConfirmation(result.request)
  if (result.request.destination !== "terminal")
    throw new Error("This review requires its confirmed Herdr destination.")
  return withTargetLock(result.request.target, async () => {
    await readyProfile(
      services.runner,
      result.selectedProfile,
      result.request.target.cwd,
      services.readiness === undefined ? {} : { readiness: services.readiness },
    )
    const context = services.context === undefined ? getHerdrContext(herdrEnvironment()) : services.context
    const request = await currentRequest(
      {
        runner: services.runner,
        context,
      },
      result.request,
    )
    const signal = new AbortController().signal
    await assertReviewedEvidenceCurrent(services.runner, request, signal)
    const target = await assertGuideOptimizeTargetCurrent(services.runner, request.target)
    const prompt = buildGuideOptimizePrompt({ ...request, target })
    const launch = buildHerdrGuideLaunch(result.selectedProfile, prompt)
    if (launch.promptDelivery !== "command") {
      throw new Error("This profile cannot start an interactive agent with the optimization prompt.")
    }
    const store = new OptimizeReviewStore(target.gitDirectory)
    await store.beginExecution(request.approval)
    try {
      await (services.runInteractive ?? runInteractiveTerminalCommand)(launch.command, {
        cwd: target.cwd,
        env: { ...process.env, TRELLAGE_AUTOMATION: "1" },
      })
      await store.finishExecution(request.approval.reviewId, "launched")
      return 0
    } catch (cause) {
      await markUnknownExecution(store, request.approval.reviewId, cause, "Inspect the agent in this terminal.")
      if (cause instanceof CommandRunnerError && cause.kind === "exited") return cause.exitCode ?? 130
      throw cause
    }
  })
}
