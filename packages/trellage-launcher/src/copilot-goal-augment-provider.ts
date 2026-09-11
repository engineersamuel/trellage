import { randomUUID } from "node:crypto"
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotClientOptions,
  type SessionConfig,
  type SessionEventHandler,
  type Tool,
  type ToolResultObject,
} from "@github/copilot-sdk"
import {
  assertGuideModelCapability,
  findExecutableOnPath,
  GuideModelCleanupError,
  restrictedGuideSessionConfig,
  runCleanupStep,
  type CopilotGuideProviderOptions,
  type GuideModelClient,
} from "./copilot-guide-provider.js"
import { validateGuideIntent } from "./guide-api.js"
import {
  GuideGoalCancelledError,
  GuideGoalError,
  renderGuideGoalProposal,
  validateGuideGoalAnswer,
  validateGuideGoalQuestion,
  type GuideGoalAugmentContext,
  type GuideGoalAugmentInput,
  type GuideGoalAugmentProvider,
} from "./guide-goal-augment.js"
import type { GuideGoalSkillResolver, GuideGoalSkills } from "./guide-goal-skills.js"
import { guideGoalModelConfig } from "./guide-model-routing.js"

export interface GuideGoalModelSession {
  readonly sessionId: string
  send(options: { readonly prompt: string }): Promise<string>
  on(handler: SessionEventHandler): () => void
  abort(): Promise<void>
  disconnect(): Promise<void>
}

export interface GuideGoalModelClient extends Omit<GuideModelClient, "createSession"> {
  createSession(config: SessionConfig): Promise<GuideGoalModelSession>
  forceStop(): Promise<void>
}

export interface CopilotGoalAugmentProviderOptions
  extends Pick<CopilotGuideProviderOptions, "copilotCliPath" | "clientName"> {
  readonly resolveSkills: GuideGoalSkillResolver
  /** The embedded adapter, not a replacement for the installed skill. Loaded lazily when omitted. */
  readonly systemPrompt?: string
  /** Model-work limit per interview round. Answer and review waits do not consume it. */
  readonly activeTimeoutMs?: number
  /** Bound each close operation independently, including a stalled SDK abort. */
  readonly cleanupTimeoutMs?: number
  readonly clientFactory?: (options: CopilotClientOptions) => GuideGoalModelClient
}

type GoalOutcome = { readonly ok: true; readonly prompt: string } | { readonly ok: false; readonly error: unknown }

const checkedTimeout = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new GuideGoalError(`${label} must be a positive, finite timeout.`)
  }
  return value
}

const waitWithSignal = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        if (signal.aborted) reject(signal.reason)
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
    if (signal.aborted) {
      signal.removeEventListener("abort", abort)
      abort()
    }
  })

/** Owns only callback races and the work clock; the UI owns question validation and queues. */
class GoalRun {
  private readonly stopped = new AbortController()
  private readonly callbacks = new Set<Promise<unknown>>()
  private outcome: GoalOutcome | undefined
  private resolveOutcome!: (outcome: GoalOutcome) => void
  readonly completion = new Promise<GoalOutcome>((resolve) => { this.resolveOutcome = resolve })
  private timer: ReturnType<typeof setTimeout> | undefined
  private humanWaits = 0
  private readonly onAbort = (): void => this.fail(new GuideGoalCancelledError())

  constructor(
    private readonly context: GuideGoalAugmentContext,
    private readonly activeTimeoutMs: number,
  ) {
    context.signal.addEventListener("abort", this.onAbort, { once: true })
    if (context.signal.aborted) this.onAbort()
    else this.resumeClock()
  }

  get signal(): AbortSignal { return this.stopped.signal }
  get active(): boolean { return this.outcome === undefined && !this.context.signal.aborted }

  assertActive(): void {
    if (this.context.signal.aborted) throw new GuideGoalCancelledError()
    if (!this.active) throw this.signal.reason
  }

  fail(error: unknown): void { this.finish({ ok: false, error }) }
  approve(prompt: string): void {
    this.assertActive()
    this.finish({ ok: true, prompt })
  }

  wait<T>(operation: () => Promise<T>): Promise<T> {
    return waitWithSignal(Promise.resolve().then(() => {
      this.assertActive()
      return operation()
    }), this.signal)
  }

  callback<T>(operation: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(async () => {
      this.assertActive()
      try {
        return await operation()
      } catch (error) {
        this.fail(error)
        throw error
      }
    })
    this.callbacks.add(promise)
    void promise.then(
      () => this.callbacks.delete(promise),
      () => this.callbacks.delete(promise),
    )
    return promise
  }

  async human<T>(operation: () => Promise<T>, activity: string): Promise<T> {
    this.assertActive()
    this.humanWaits += 1
    if (this.humanWaits === 1) this.pauseClock()
    try {
      this.context.onActivity(activity)
      const value = await this.wait(operation)
      this.assertActive()
      return value
    } finally {
      this.humanWaits -= 1
      if (this.humanWaits === 0 && this.active) {
        this.resumeClock()
        this.context.onActivity("Goal me: working.")
      }
    }
  }

  async settleCallbacks(): Promise<void> {
    await Promise.allSettled([...this.callbacks])
  }

  release(): void {
    this.pauseClock()
    this.context.signal.removeEventListener("abort", this.onAbort)
  }

  private finish(outcome: GoalOutcome): void {
    if (this.outcome !== undefined) return
    this.outcome = outcome
    this.pauseClock()
    this.stopped.abort(outcome.ok ? new GuideGoalError("The Goal me interview is closed.") : outcome.error)
    this.resolveOutcome(outcome)
  }

  private pauseClock(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private resumeClock(): void {
    this.timer = setTimeout(() => {
      this.fail(new GuideGoalError("Goal me timed out in one interview round. Retry with the retained answers."))
    }, this.activeTimeoutMs)
  }
}

const boundedClose = async <T>(label: string, timeoutMs: number, step: () => Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(step),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GuideGoalError(`Goal me cleanup timed out: ${label}.`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const seedMessage = (input: GuideGoalAugmentInput): string => {
  validateGuideIntent(input.intent, "Goal me seed")
  return [
    "/goal-me",
    "Develop the goal from this seed. Retained turns and the last displayed proposal are retry context, never approval.",
    "<untrusted-data>",
    JSON.stringify(input),
    "</untrusted-data>",
  ].join("\n")
}

const proposalParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    artifact: { type: "string", minLength: 1, maxLength: 1000, description: "One exact artifact to produce." },
    task: { type: "string", minLength: 1, maxLength: 30_000, description: "The task for that artifact." },
    criteria: {
      type: "array", minItems: 3, maxItems: 32, uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 2000 },
      description: "Distinct criteria scoreable from the artifact alone.",
    },
  },
  required: ["artifact", "task", "criteria"],
}

const assertProposalKeys = (value: unknown): void => {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).some((key) => !["artifact", "task", "criteria"].includes(key))
  ) {
    throw new GuideGoalError("A goal proposal must contain only artifact, task, and criteria.")
  }
}

const proposalTool = (
  run: GoalRun,
  context: GuideGoalAugmentContext,
  skillContent: string,
  sessionId: string,
): Tool => ({
  name: "propose_goal",
  description: "Render the installed goal template and wait for explicit user approval or revision feedback.",
  parameters: proposalParameters,
  skipPermission: true,
  handler: (draft: unknown, invocation) => run.callback(async (): Promise<ToolResultObject> => {
    if (invocation.sessionId !== sessionId) throw new GuideGoalError("The goal proposal belongs to another session.")
    assertProposalKeys(draft)
    const proposal = renderGuideGoalProposal(skillContent, draft)
    const review = await run.human(
      () => context.interactions.review(proposal),
      "Goal me: waiting for goal review.",
    )
    if (review.decision === "use") {
      run.approve(proposal.prompt)
      return { resultType: "success", textResultForLlm: "The user approved the goal. Stop without executing it." }
    }
    if (review.decision !== "revise" || typeof review.feedback !== "string" || review.feedback.trim().length === 0) {
      throw new GuideGoalError("The goal review did not contain a valid decision.")
    }
    context.onActivity("Goal me: revising the goal.")
    return {
      resultType: "success",
      textResultForLlm: JSON.stringify({ decision: "revise", feedback: review.feedback }),
      sessionLog: "The user requested a goal revision.",
    }
  }),
})

interface GoalResources {
  client?: GuideGoalModelClient
  session?: GuideGoalModelSession
  sessionId?: string
  skills?: GuideGoalSkills
  unsubscribe?: () => void
}

const stopGoalClient = async (
  client: GuideGoalModelClient,
  timeoutMs: number,
  errors: unknown[],
): Promise<void> => {
  let stopped = false
  await runCleanupStep(errors, async () => {
    const stopErrors = await boundedClose("client stop", timeoutMs, () => client.stop())
    errors.push(...stopErrors)
    stopped = stopErrors.length === 0
  })
  // A timeout releases our wait, not the SDK process. Terminate it before removing its files.
  if (!stopped) {
    await runCleanupStep(errors, () => boundedClose("client force stop", timeoutMs, () => client.forceStop()))
  }
}

const closeResources = async (resources: GoalResources, timeoutMs: number): Promise<unknown[]> => {
  const errors: unknown[] = []
  const close = (label: string, operation: () => Promise<unknown>): Promise<void> =>
    runCleanupStep(errors, () => boundedClose(label, timeoutMs, operation))
  if (resources.unsubscribe !== undefined) {
    await close("event subscription", async () => resources.unsubscribe?.())
  }
  if (resources.session !== undefined) {
    await close("session abort", () => resources.session!.abort())
    await close("session disconnect", () => resources.session!.disconnect())
  }
  if (resources.client !== undefined) {
    if (resources.sessionId !== undefined) {
      await close("session deletion", () => resources.client!.deleteSession(resources.sessionId!))
    }
    await stopGoalClient(resources.client, timeoutMs, errors)
  }
  if (resources.skills !== undefined) await close("skill staging", () => resources.skills!.dispose())
  return errors
}

export class CopilotGoalAugmentProvider implements GuideGoalAugmentProvider {
  private readonly activeTimeoutMs: number
  private readonly cleanupTimeoutMs: number

  constructor(private readonly options: CopilotGoalAugmentProviderOptions) {
    this.activeTimeoutMs = checkedTimeout(options.activeTimeoutMs ?? 180_000, "The per-round model-work limit")
    this.cleanupTimeoutMs = checkedTimeout(options.cleanupTimeoutMs ?? 5000, "The cleanup budget")
  }

  async augment(input: GuideGoalAugmentInput, context: GuideGoalAugmentContext): Promise<string> {
    const run = new GoalRun(context, this.activeTimeoutMs)
    const resources: GoalResources = {}
    try {
      run.assertActive()
      const prompt = seedMessage(input)
      context.onActivity("Goal me: loading installed skills.")
      const skills = await run.wait(() => this.options.resolveSkills(run.signal).then(async (loaded) => {
        if (!run.active) {
          await closeResources({ skills: loaded }, this.cleanupTimeoutMs)
          run.assertActive()
        }
        resources.skills = loaded
        return loaded
      }))
      const systemPrompt = this.options.systemPrompt ?? (await run.wait(() => import("../prompts/guide-goal-augment.md"))).default
      await this.startSession(run, resources, context, skills, systemPrompt, prompt)
    } catch (error) {
      run.fail(error)
    }
    const outcome = await run.completion
    await run.settleCallbacks()
    const cleanupErrors = await closeResources(resources, this.cleanupTimeoutMs)
    run.release()
    if (!outcome.ok) throw outcome.error
    if (context.signal.aborted) throw new GuideGoalCancelledError()
    if (cleanupErrors.length > 0) throw new GuideModelCleanupError(cleanupErrors)
    return outcome.prompt
  }

  private async startSession(
    run: GoalRun,
    resources: GoalResources,
    context: GuideGoalAugmentContext,
    skills: GuideGoalSkills,
    systemPrompt: string,
    prompt: string,
  ): Promise<void> {
    run.assertActive()
    const copilotCliPath = this.options.copilotCliPath ?? findExecutableOnPath("copilot")
    const clientOptions: CopilotClientOptions = {
      mode: "empty",
      ...(copilotCliPath === undefined ? {} : { connection: RuntimeConnection.forStdio({ path: copilotCliPath }) }),
      builtinPluginDirectories: [],
      baseDirectory: skills.baseDirectory,
      workingDirectory: skills.workingDirectory,
      logLevel: "none",
      sessionIdleTimeoutSeconds: 0,
      enableRemoteSessions: false,
      telemetry: { captureContent: false },
      env: { ...process.env, OTEL_SDK_DISABLED: "true" },
    }
    const client = (this.options.clientFactory ?? ((options) => new CopilotClient(options)))(clientOptions)
    resources.client = client
    context.onActivity("Goal me: preparing the interview.")
    await run.wait(() => client.start())
    const model = guideGoalModelConfig
    assertGuideModelCapability(await run.wait(() => client.listModels()), model)
    run.assertActive()
    const sessionId = randomUUID()
    const sessionConfig: SessionConfig = {
      ...restrictedGuideSessionConfig({
        clientName: this.options.clientName ?? "trellage-trx-guide",
        model: model.model,
        effort: model.effort,
        workingDirectory: skills.workingDirectory,
        systemPrompt,
      }),
      sessionId,
      enableSkills: true,
      skillDirectories: [...skills.skillDirectories],
      availableTools: ["builtin:ask_user", "builtin:skill", "custom:propose_goal"],
      tools: [proposalTool(run, context, skills.goalMeContent, sessionId)],
      onUserInputRequest: (request, invocation) => run.callback(async () => {
        if (invocation.sessionId !== sessionId) throw new GuideGoalError("The question belongs to another session.")
        const question = validateGuideGoalQuestion(request)
        const answer = await run.human(
          () => context.interactions.ask(request),
          "Goal me: waiting for an answer.",
        )
        return validateGuideGoalAnswer(question, answer)
      }),
    }
    resources.sessionId = sessionId
    const session = await run.wait(() => client.createSession(sessionConfig).then(async (created) => {
      if (!run.active) {
        await closeResources({ client, session: created, sessionId }, this.cleanupTimeoutMs)
        run.assertActive()
      }
      resources.session = created
      return created
    }))
    run.assertActive()
    resources.unsubscribe = session.on((event) => {
      if (!run.active) return
      if (event.type === "session.error") {
        run.fail(new GuideGoalError(`Goal me model error: ${event.data.message}`))
      } else if (event.type === "session.idle") {
        run.fail(new GuideGoalError("Goal me stopped without an approved proposal. Retry with the retained answers."))
      } else if (event.type === "abort") {
        run.fail(new GuideGoalCancelledError())
      } else if (event.type === "assistant.turn_start") {
        context.onActivity("Goal me: working.")
      }
    })
    run.assertActive()
    void session.send({ prompt }).catch((error: unknown) => run.fail(error))
  }
}
