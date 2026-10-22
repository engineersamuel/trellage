import type { GuideModelSelector } from "./guide-model-selector.ts"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import lockfile from "proper-lockfile"
import { getProcessInfo, listAgents } from "@trellage/conversation-source/herdr"
import { resolveGuideModelRouting, validateGuideIntent } from "./guide-api.ts"
import type { CompositionCatalog } from "./composition-catalog.ts"
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
import type { OptimizeModelCall, OptimizeReviewInput, OptimizeReviewer } from "./review-findings.ts"
import type { ReviewClientFactory } from "./copilot-review-provider.ts"
import type { OptimizeReviewSummary } from "./review-records.ts"
import {
  assertGuideReviewTargetCurrent,
  guideReviewTargetIdentity,
  inspectGuideReviewTarget,
  selectedGuideReviewChanges,
  type GuideReviewScope,
  type GuideReviewTarget,
} from "./review-target.ts"
import { checkSelectedProfileReadiness, ProfileReadinessKind } from "./guide-preflight.ts"
import { array, record } from "./guide-text.ts"
import { assignReviewModels, reviewCheckCatalog, reviewCoordinatorModel, type ReviewCheckAssignment } from "./review-catalog.ts"
import type { ReviewEvent, ReviewRun } from "./review-contracts.ts"
import { runSharedReview } from "./review-coordinator.ts"
import { SharedReviewStore, type SharedReviewApproval } from "./review-store.ts"
import { displayReviewers, reviewAuthority, assertReviewEvidenceCurrent } from "./review-view-model.ts"
import { executeReviewPlanWorktree, type ReviewPlanTerminalResult } from "./review-planning.ts"

export interface GuideReviewRequest {
  readonly automatic?: true
  readonly target: GuideReviewTarget
  readonly paths: ReadonlyArray<string>
  readonly approval: SharedReviewApproval
  readonly destination: "terminal" | "pane" | "tab"
  readonly originalIntent?: string
  readonly intent?: string
  readonly otherEditorsStopped: boolean
}

export interface ReviewAgentProfile {
  readonly ref: string
  readonly label: string
  readonly profile: NativeSelectedProfile
}

export interface GuideReviewReceipt {
  readonly paneId: string
  readonly message: string
}

export interface GuideReviewServices {
  readonly assignments?: ReadonlyArray<ReviewCheckAssignment>
  readonly defaultReviewerIds?: ReadonlyArray<string>
  readonly herdr: boolean
  readonly profiles: ReadonlyArray<ReviewAgentProfile>
  refreshProfiles?(signal: AbortSignal): Promise<void>
  readonly reviewers: ReadonlyArray<OptimizeReviewer>
  readonly coordinator: GuideModelConfig
  readonly destinations: ReadonlyArray<GuideReviewRequest["destination"]>
  inspect(scope: GuideReviewScope, signal: AbortSignal): Promise<GuideReviewTarget>
  review(input: OptimizeReviewInput, signal: AbortSignal, progress: (message: string) => void,
    events?: (event: ReviewEvent) => void): Promise<ReviewRun>
  history(signal: AbortSignal): Promise<ReadonlyArray<OptimizeReviewSummary>>
  readReview(id: string, signal: AbortSignal): Promise<ReviewRun>
  approve(id: string, ids: ReadonlyArray<string>, signal: AbortSignal): Promise<SharedReviewApproval>
  execute(request: GuideReviewRequest, profileRef: string, signal: AbortSignal): Promise<GuideReviewReceipt>
  plan?(review: ReviewRun, destination: "terminal" | "worktree", signal: AbortSignal):
    Promise<ReviewPlanTerminalResult | GuideReviewReceipt>
}

export interface GuideReviewTerminalResult {
  readonly action: "review-terminal"
  readonly request: GuideReviewRequest
  readonly selectedProfile: NativeSelectedProfile
}

export interface GuideReviewDependencies {
  readonly selectModel?: GuideModelSelector
  readonly listAgents?: typeof listAgents
  readonly processReader?: typeof getProcessInfo
  readonly readiness?: typeof checkSelectedProfileReadiness
  readonly modelCall?: OptimizeModelCall
  readonly clientFactory?: ReviewClientFactory
}

const nativeLaunchers = new Set(["copilot", "codex", "claude"])
const readyStatus = (value: unknown): boolean => value === "idle" || value === "done"
const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export const reviewAgentProfiles = (catalog: CompositionCatalog): ReadonlyArray<ReviewAgentProfile> =>
  catalog.entries
    .filter((entry) => nativeLaunchers.has(entry.harness))
    .map((entry) => {
      const profile = parseSelectedProfile({
        surface: "native",
        harness: entry.harness,
        commandPath: entry.commandPath,
        profiles: entry.profiles,
        headlessPrompt: entry.headless.prompt,
      })
      return { ref: entry.ref, label: `${entry.harness} ${entry.profiles.join("+")}`, profile }
    })

export const assertGuideReviewNoWriters = async (
  target: GuideReviewTarget,
  env: NodeJS.ProcessEnv,
  dependencies: GuideReviewDependencies = {},
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

export const buildGuideReviewPrompt = (request: GuideReviewRequest): string => {
  selectedGuideReviewChanges(request.target, request.paths)
  if (request.approval === undefined || request.approval.findings.length === 0)
    throw new Error("Approve saved review findings before implementation.")
  const allowed = [...new Set(request.approval.findings.flatMap((entry) => entry.paths))]
  if (allowed.some((filename) => !request.paths.includes(filename)))
    throw new Error("Approved finding exceeds the reviewed scope.")
  const changes = selectedGuideReviewChanges(request.target, allowed)
  const target = request.target
  const parts = [
    ...(request.automatic ? ["Use Copilot hve to plan, then implement only these approved findings without another approval prompt."] : []),
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

const requireConfirmation = (request: GuideReviewRequest): void => {
  if (request.automatic && request.destination !== "tab")
    throw new Error("Automatic implementation is available only in a same-worktree Herdr tab.")
  if (!request.otherEditorsStopped)
    throw new Error("Confirm that other agents and editors have stopped changing this worktree.")
  selectedGuideReviewChanges(request.target, request.paths)
  buildGuideReviewPrompt(request)
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

const withTargetLock = async <Value>(target: GuideReviewTarget, operation: () => Promise<Value>): Promise<Value> => {
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
  readonly modelOverrides?: Partial<GuideModelConfig>
  readonly runner: CommandRunner
  readonly cwd: string
  readonly context: HerdrContext | null
  readonly catalog: CompositionCatalog
  readonly env?: NodeJS.ProcessEnv
  readonly dependencies?: GuideReviewDependencies
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
  dependencies: GuideReviewDependencies = {},
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
  request: GuideReviewRequest,
  signal?: AbortSignal,
  ignoredPane?: string,
): Promise<GuideReviewRequest> => {
  requireConfirmation(request)
  const saved = await (await reviewAuthority(request.target.gitDirectory, request.approval.reviewId)).approved(request.approval)
  const expected = {
    target: saved.request.target,
    paths: saved.request.paths,
    originalIntent: saved.request.originalIntent,
    intent: saved.request.intent,
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
  const target = await assertGuideReviewTargetCurrent(options.runner, request.target, signal)
  selectedGuideReviewChanges(target, request.paths)
  const env = options.env ?? process.env
  if (options.context !== null) {
    const ignoredPanes = new Set(ignoredPane === undefined ? [] : [ignoredPane])
    if (await hasForegroundGuideProcess(options.context, env, options.dependencies, signal))
      ignoredPanes.add(options.context.paneId)
    await assertGuideReviewNoWriters(target, env, options.dependencies, ignoredPanes, signal)
  }
  return { ...request, target }
}

const assertReviewedEvidenceCurrent = async (
  runner: CommandRunner,
  request: GuideReviewRequest,
  signal: AbortSignal,
): Promise<void> => {
  const store = await reviewAuthority(request.target.gitDirectory, request.approval.reviewId)
  await assertReviewEvidenceCurrent(store, request.approval, runner, signal)
}

const readyProfile = async (
  runner: CommandRunner,
  profile: NativeSelectedProfile,
  cwd: string,
  dependencies: GuideReviewDependencies,
  signal?: AbortSignal,
): Promise<void> => {
  if (!nativeLaunchers.has(profile.harness)) throw new Error("Choose a Native Copilot, Codex, or Claude composition.")
  const readiness = await (dependencies.readiness ?? checkSelectedProfileReadiness)(runner, profile, cwd, signal)
  if (readiness.kind === ProfileReadinessKind.Blocked) throw new Error(`${readiness.summary}. ${readiness.diagnostic}`)
}

const runFreshAgent = async (
  options: OptimizeRuntime,
  request: GuideReviewRequest,
  profileRef: string,
  signal: AbortSignal,
): Promise<GuideReviewReceipt> => {
  if (options.context === null) throw new Error("A new Herdr agent requires a destination workspace.")
  if (request.destination === "terminal") throw new Error("Use the current-terminal handoff for this destination.")
  const profile = reviewAgentProfiles(options.catalog).find((entry) => entry.ref === profileRef)?.profile
  if (profile === undefined) throw new Error("The selected Native profile is no longer available.")
  const dependencies = options.dependencies ?? {}
  const prompt = buildGuideReviewPrompt(request)
  const launch = buildHerdrGuideLaunch(profile, prompt)
  if (request.automatic && (profile.harness !== "copilot" || profile.profiles.length !== 1 || profile.profiles[0] !== "hve" || request.destination !== "tab"))
    throw new Error("Automatic approved implementation requires Copilot hve in a same-worktree Herdr tab.")
  const command = request.automatic ? {
    executable: launch.command.executable,
    args: ["run", profile.harness, ...profile.profiles, "--", "--plan", "--mode", "autopilot", "--allow-all", "--no-ask-user", "-i", prompt],
  } : launch.command
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
  const store = await reviewAuthority(request.target.gitDirectory, request.approval.reviewId)
  let reserved = false
  try {
    await launchInHerdrPane(runner, {
      paneId,
      cwd: request.target.cwd,
      command,
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
  store: Pick<SharedReviewStore, "finishExecution">,
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

export const createGuideReviewServices = (initialOptions: OptimizeRuntime): GuideReviewServices => {
  let options = initialOptions
  const routing = options.routing ?? resolveGuideModelRouting({}, options.env ?? process.env)
  const assignments = assignReviewModels(reviewCheckCatalog.map((check) => check.id), routing, options.modelOverrides)
  const coordinator = reviewCoordinatorModel(options.modelOverrides)
  return {
    assignments,
    herdr: options.context !== null,
    get profiles() { return reviewAgentProfiles(options.catalog) },
    refreshProfiles: async (signal) => {
      signal.throwIfAborted()
    },
    reviewers: displayReviewers(assignments),
    coordinator,
    destinations:
      options.context === null
        ? ["terminal"]
        : options.context.surface === "popup"
          ? ["pane", "tab"]
          : ["pane", "tab", "terminal"],
    inspect: (scope, signal) => inspectGuideReviewTarget(options.runner, options.cwd, scope, signal),
    review: async (input, signal, progress, events) => {
      const local = await guideReviewTargetIdentity(options.runner, options.cwd, signal)
      if (local.cwd !== input.target.cwd || local.gitDirectory !== input.target.gitDirectory)
        throw new Error("Review target is not this Guide worktree.")
      const run = await runSharedReview({
        request: { target: input.target, paths: input.paths,
          checks: input.reviewerIds.map((id) => {
            const assignment = assignments.find((entry) => entry.id === id)
            if (!assignment) throw new Error(`Unsupported review check: ${id}`)
            return assignment
          }), coordinator,
          ...(input.originalIntent === undefined ? {} : { originalIntent: input.originalIntent }),
          ...(input.intent === undefined ? {} : { intent: input.intent }) },
        confirmed: true, runner: options.runner, signal,
        ...(options.env ? { env: options.env } : {}),
        ...(options.dependencies?.selectModel ? { selectModel: options.dependencies.selectModel } : {}),
        ...(options.dependencies?.modelCall ? { modelCall: options.dependencies.modelCall } : {}),
        ...(options.dependencies?.clientFactory ? { clientFactory: options.dependencies.clientFactory } : {}),
        onEvent: (event) => {
          events?.(event)
          if (event.kind === "activity") progress(`${event.checkId}: ${event.text}`)
        },
      })
      return run
    },
    history: async (signal) => {
      return new SharedReviewStore((await guideReviewTargetIdentity(options.runner, options.cwd, signal)).gitDirectory).list()
    },
    readReview: async (id, signal) => {
      const identity = await guideReviewTargetIdentity(options.runner, options.cwd, signal)
      return (await reviewAuthority(identity.gitDirectory, id)).read(id)
    },
    approve: async (id, ids, signal) => {
      const identity = await guideReviewTargetIdentity(options.runner, options.cwd, signal)
      const store = await reviewAuthority(identity.gitDirectory, id)
      const review = await store.read(id)
      await assertGuideReviewTargetCurrent(options.runner, review.request.target, signal)
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
    plan: async (review, destination, signal) => {
      const profile = reviewAgentProfiles(options.catalog).find((entry) =>
        entry.profile.harness === "copilot" && entry.profile.profiles.length === 1 && entry.profile.profiles[0] === "hve")?.profile
      if (!profile) throw new Error("Planning unavailable: install Native Copilot hve.")
      const authority = await reviewAuthority(review.request.target.gitDirectory, review.id)
      const result: ReviewPlanTerminalResult = { action: "review-plan-terminal", id: review.id,
        gitDirectory: review.request.target.gitDirectory, cwd: review.request.target.cwd, namespace: authority.namespace, selectedProfile: profile }
      return destination === "terminal" ? result : executeReviewPlanWorktree(result, options.runner, options.context, signal)
    },
  }
}

export const executeGuideReviewTerminal = async (
  result: GuideReviewTerminalResult,
  services: {
    readonly runner: CommandRunner
    readonly runInteractive?: (
      command: CommandSpec,
      options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
    ) => Promise<void>
    readonly readiness?: typeof checkSelectedProfileReadiness
    readonly context?: HerdrContext | null
    readonly dependencies?: Pick<GuideReviewDependencies, "listAgents" | "processReader">
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
        ...(services.dependencies ? { dependencies: services.dependencies } : {}),
      },
      result.request,
    )
    const signal = new AbortController().signal
    await assertReviewedEvidenceCurrent(services.runner, request, signal)
    const target = await assertGuideReviewTargetCurrent(services.runner, request.target)
    const prompt = buildGuideReviewPrompt({ ...request, target })
    const launch = buildHerdrGuideLaunch(result.selectedProfile, prompt)
    if (launch.promptDelivery !== "command") {
      throw new Error("This profile cannot start an interactive agent with the optimization prompt.")
    }
    const store = await reviewAuthority(target.gitDirectory, request.approval.reviewId)
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
