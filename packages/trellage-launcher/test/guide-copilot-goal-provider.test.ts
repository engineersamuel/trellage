import { readFile } from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  CopilotClientOptions,
  ModelInfo,
  SessionConfig,
  SessionEvent,
  SessionEventHandler,
} from "@github/copilot-sdk"
import {
  CopilotGoalAugmentProvider,
  type CopilotGoalAugmentProviderOptions,
  type GuideGoalModelClient,
  type GuideGoalModelSession,
} from "../src/copilot-goal-augment-provider.ts"
import { GuideModelCapabilityError, GuideModelCleanupError } from "../src/copilot-guide-provider.ts"
import {
  GuideGoalCancelledError,
  GuideGoalError,
  GuideGoalInteractionController,
  renderGuideGoalProposal,
  type GuideGoalAnswer,
  type GuideGoalAugmentInput,
  type GuideGoalInteractions,
  type GuideGoalRequest,
  type GuideGoalResponse,
  type GuideGoalReviewDecision,
  type GuideGoalTurn,
} from "../src/guide-goal-augment.ts"
import type { GuideGoalSkills } from "../src/guide-goal-skills.ts"
import { defaultGuideModelRouting } from "../src/guide-model-routing.ts"
import { goalDraft, goalMeSkill } from "./fixtures/goal-me-skill.ts"

const systemPrompt = await readFile(new URL("../prompts/guide-goal-augment.md", import.meta.url), "utf8")
type UserInputRequest = Parameters<NonNullable<SessionConfig["onUserInputRequest"]>>[0]
const workingModel: ModelInfo = {
  id: "gpt-6-astra",
  name: "Astra",
  capabilities: { supports: { vision: false, reasoningEffort: true }, limits: { max_context_window_tokens: 128_000 } },
  supportedReasoningEfforts: ["low", "medium", "high", "max"],
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const flushCallbacks = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

type Step = "start" | "models" | "create" | "send" | "unsubscribe" | "abort" | "disconnect" | "delete" | "stop" | "force-stop"

const fakeSdk = () => {
  const trace: string[] = []
  const failures: Partial<Record<Step, Error>> = {}
  const listeners = new Set<SessionEventHandler>()
  const allListeners: SessionEventHandler[] = []
  const sent = deferred<void>()
  const models = [workingModel]
  let runtimeAlive = false
  let config: SessionConfig | undefined
  const step = (name: Step): void => {
    trace.push(name)
    if (failures[name] !== undefined) throw failures[name]
  }
  const session = {
    sessionId: "",
    send: vi.fn(async (_options: { readonly prompt: string }) => {
      step("send")
      expect(listeners.size).toBe(1)
      sent.resolve()
      return "message-1"
    }),
    on: vi.fn((handler: SessionEventHandler) => {
      listeners.add(handler)
      allListeners.push(handler)
      return () => { listeners.delete(handler); step("unsubscribe") }
    }),
    abort: vi.fn(async () => { step("abort") }),
    disconnect: vi.fn(async () => { step("disconnect") }),
  } satisfies GuideGoalModelSession
  const client = {
    start: vi.fn(async () => { step("start"); runtimeAlive = true }),
    listModels: vi.fn(async () => { step("models"); return models }),
    createSession: vi.fn(async (supplied: SessionConfig) => {
      step("create")
      config = supplied
      session.sessionId = supplied.sessionId!
      return session
    }),
    deleteSession: vi.fn(async (_sessionId: string) => { step("delete") }),
    stop: vi.fn(async (): Promise<Error[]> => {
      step("stop")
      runtimeAlive = false
      return []
    }),
    forceStop: vi.fn(async () => { step("force-stop"); runtimeAlive = false }),
  } satisfies GuideGoalModelClient
  const factory = vi.fn((_options: CopilotClientOptions) => client)
  const currentConfig = (): SessionConfig => {
    if (config === undefined) throw new Error("Session has not been created")
    return config
  }
  const track = <T>(promise: Promise<T>): Promise<T> => {
    void promise.catch(() => {})
    return promise
  }
  const event = (type: SessionEvent["type"], data: unknown): SessionEvent =>
    ({ type, data, id: "event-1", parentId: null, timestamp: "2026-09-09T00:00:00Z" }) as SessionEvent
  return {
    trace, failures, listeners, session, client, factory, models, sent: sent.promise, currentConfig,
    get runtimeAlive() { return runtimeAlive },
    ask: (request: UserInputRequest) => track(Promise.resolve(
      currentConfig().onUserInputRequest!(request, { sessionId: session.sessionId }),
    )),
    propose: (draft: unknown = goalDraft) => track(Promise.resolve(
      currentConfig().tools!.find((tool) => tool.name === "propose_goal")!.handler!(draft, {
        sessionId: session.sessionId, toolName: "propose_goal", toolCallId: "proposal-1", arguments: draft,
      }),
    )),
    emit: (type: SessionEvent["type"], data: unknown = {}) => {
      for (const listener of listeners) listener(event(type, data))
    },
    emitLate: (type: SessionEvent["type"], data: unknown = {}) => {
      for (const listener of allListeners) listener(event(type, data))
    },
  }
}

const harness = (overrides: {
  readonly provider?: Partial<CopilotGoalAugmentProviderOptions>
  readonly interactions?: GuideGoalInteractions
  readonly skillContent?: string
} = {}) => {
  const sdk = fakeSdk()
  const abort = new AbortController()
  const activity: string[] = []
  const turns: GuideGoalTurn[] = []
  const requests: Array<GuideGoalRequest | undefined> = []
  let pending: GuideGoalRequest | undefined
  let settled = false
  const controller = new GuideGoalInteractionController({
    runId: 7,
    signal: abort.signal,
    onRequest: (request) => { pending = request; requests.push(request) },
    onTurn: (turn) => { turns.push(turn) },
  })
  const skills: GuideGoalSkills = {
    goalMeContent: overrides.skillContent ?? goalMeSkill,
    skillDirectories: [path.resolve("fake-goal-skills/goal-me"), path.resolve("fake-goal-skills/grill-me")],
    workingDirectory: path.resolve("fake-goal-skills/work"),
    baseDirectory: path.resolve("fake-goal-skills/runtime"),
    dispose: vi.fn(async () => { sdk.trace.push("skills") }),
  }
  const resolveSkills = vi.fn(async () => skills)
  const provider = new CopilotGoalAugmentProvider({
    resolveSkills,
    clientFactory: sdk.factory,
    copilotCliPath: "/fake/copilot",
    systemPrompt,
    ...overrides.provider,
  })
  return {
    sdk, abort, skills, resolveSkills, activity, turns, requests, controller,
    get pending() { return pending },
    get settled() { return settled },
    start(input: GuideGoalAugmentInput = { intent: "Specify bounded retries", history: [] }) {
      const promise = provider.augment(input, {
        signal: abort.signal,
        interactions: overrides.interactions ?? controller,
        onActivity: (line) => { activity.push(line) },
      })
      void promise.then(
        () => { settled = true; controller.close() },
        () => { settled = true; controller.close() },
      )
      return promise
    },
    submit(response: GuideGoalResponse) {
      if (pending === undefined) throw new Error("No pending interaction")
      return controller.submit(pending.runId, pending.requestId, response)
    },
  }
}

afterEach(() => { vi.useRealTimers() })

describe("Copilot Goal me interview", () => {
  it("returns automatic recommendations through the same SDK session but waits for final approval", async () => {
    const h = harness()
    const result = h.start()
    await h.sdk.sent
    const first = h.sdk.ask({ question: "Artifact?", choices: ["Patch", "Report (Recommended: offline)"], allowFreeform: false })
    const second = h.sdk.ask({ question: "Format?", choices: ["Markdown (Recommended)", "JSON"] })
    await flushCallbacks()
    expect(h.turns).toHaveLength(0)
    h.controller.setAutoAcceptRecommended(7, true)
    await expect(first).resolves.toEqual({ answer: "Report (Recommended: offline)", wasFreeform: false })
    await expect(second).resolves.toEqual({ answer: "Markdown (Recommended)", wasFreeform: false })
    const freeform = h.sdk.ask({ question: "Audience?" })
    await flushCallbacks()
    expect(h.turns).toHaveLength(2)
    h.submit({ kind: "answer", answer: { answer: "A team.", wasFreeform: true } })
    await expect(freeform).resolves.toEqual({ answer: "A team.", wasFreeform: true })
    const proposal = h.sdk.propose()
    await flushCallbacks()
    expect(h.pending?.kind).toBe("review")
    expect(h.settled).toBe(false)
    h.submit({ kind: "review", review: { decision: "use" } })
    await proposal
    await expect(result).resolves.toBe(renderGuideGoalProposal(goalMeSkill, goalDraft).prompt)
    expect(h.sdk.client.createSession).toHaveBeenCalledTimes(1)
    expect(h.sdk.session.send).toHaveBeenCalledTimes(1)
    expect(h.turns).toHaveLength(4)
  })

  it("returns the displayed approved goal when another SDK proposal is queued", async () => {
    const h = harness()
    const result = h.start()
    await h.sdk.sent
    const first = h.sdk.propose()
    const second = h.sdk.propose({ ...goalDraft, artifact: "An unapproved second document." })
    const closedSecond = expect(second).rejects.toThrow("interview is closed")
    await flushCallbacks()
    h.submit({ kind: "review", review: { decision: "use" } })
    await expect(first).resolves.toMatchObject({ resultType: "success" })
    const approved = renderGuideGoalProposal(goalMeSkill, goalDraft)
    await expect(result).resolves.toBe(approved.prompt)
    await closedSecond
    expect(h.requests.filter((request) => request?.kind === "review"))
      .toEqual([{ kind: "review", runId: 7, requestId: 1, proposal: approved }])
    expect(h.turns).toHaveLength(1)
    expect(h.pending).toBeUndefined()
  })

  it("keeps the actual SDK callback flags and one session through questions, revision, and explicit approval", async () => {
    const content = goalMeSkill.replace("Begin.", "Begin.\nKeep this installed-template marker.")
    const h = harness({ skillContent: content })
    const result = h.start()
    await h.sdk.sent
    const choice = h.sdk.ask({ question: "Which artifact?", choices: [" Design document ", "Patch"], allowFreeform: false })
    await flushCallbacks()
    h.submit({ kind: "answer", answer: { answer: " Design document ", wasFreeform: false } })
    expect(await choice).toEqual({ answer: " Design document ", wasFreeform: false })

    const freeform = h.sdk.ask({ question: "What must it cover?" })
    await flushCallbacks()
    expect(h.pending).toMatchObject({ question: { choices: [], allowFreeform: true } })
    h.submit({ kind: "answer", answer: { answer: "Only bounded API retries.", wasFreeform: true } })
    expect(await freeform).toEqual({ answer: "Only bounded API retries.", wasFreeform: true })
    h.sdk.emit("assistant.message", { content: "Private draft text is not approval." })
    expect(h.settled).toBe(false)

    const firstProposal = h.sdk.propose()
    await flushCallbacks()
    expect(h.pending).toMatchObject({ kind: "review", proposal: renderGuideGoalProposal(content, goalDraft) })
    h.submit({ kind: "review", review: { decision: "revise", feedback: "Specify deterministic jitter bounds." } })
    expect(await firstProposal).toMatchObject({
      textResultForLlm: JSON.stringify({ decision: "revise", feedback: "Specify deterministic jitter bounds." }),
    })
    expect(h.settled).toBe(false)

    const followup = h.sdk.ask({ question: "Keep jitter deterministic?", choices: ["Yes", "No"], allowFreeform: false })
    await flushCallbacks()
    h.submit({ kind: "answer", answer: { answer: "Yes", wasFreeform: false } })
    expect(await followup).toEqual({ answer: "Yes", wasFreeform: false })
    const revision = { ...goalDraft, criteria: [...goalDraft.criteria, "The document specifies deterministic jitter bounds."] }
    const finalProposal = h.sdk.propose(revision)
    await flushCallbacks()
    expect(h.settled).toBe(false)
    h.submit({ kind: "review", review: { decision: "use" } })
    await expect(finalProposal).resolves.toMatchObject({ resultType: "success" })
    await expect(result).resolves.toBe(renderGuideGoalProposal(content, revision).prompt)
    expect(h.sdk.client.createSession).toHaveBeenCalledTimes(1)
    expect(h.sdk.session.send).toHaveBeenCalledTimes(1)
    expect(h.sdk.session.send.mock.calls[0]?.[0].prompt).toMatch(/^\/goal-me\n/u)
    expect(h.turns).toHaveLength(5)
    expect(h.sdk.trace.slice(-6)).toEqual(["unsubscribe", "abort", "disconnect", "delete", "force-stop", "skills"])
    expect(h.sdk.client.stop).not.toHaveBeenCalled()
    expect(h.activity.join("\n")).not.toMatch(/Only bounded API|deterministic jitter|Private draft|installed-template marker/u)
    await expect(h.sdk.propose()).rejects.toThrow("interview is closed")
    h.sdk.emitLate("session.error", { errorType: "query", message: "Late event" })
    expect(h.sdk.client.createSession).toHaveBeenCalledTimes(1)
  })

  it("opts into only ask_user, skill activation, and the host review tool", async () => {
    const h = harness()
    const result = h.start()
    await h.sdk.sent
    const config = h.sdk.currentConfig()
    expect(h.sdk.factory.mock.calls[0]?.[0]).toMatchObject({
      mode: "empty", builtinPluginDirectories: [], logLevel: "none",
      sessionIdleTimeoutSeconds: 0, enableRemoteSessions: false,
      baseDirectory: h.skills.baseDirectory, workingDirectory: h.skills.workingDirectory,
      connection: { kind: "stdio", path: "/fake/copilot" },
      telemetry: { captureContent: false }, env: { OTEL_SDK_DISABLED: "true" },
    })
    expect(config).toMatchObject({
      model: "gpt-6-astra", reasoningEffort: "max",
      availableTools: ["builtin:ask_user", "builtin:skill", "custom:propose_goal"],
      enableSkills: true, skillDirectories: h.skills.skillDirectories,
      enableConfigDiscovery: false, mcpServers: {}, customAgents: [], pluginDirectories: [],
      instructionDirectories: [], requestExtensions: false, requestCanvasRenderer: false,
      manageScheduleEnabled: false, skipCustomInstructions: true,
      enableOnDemandInstructionDiscovery: false, enableFileHooks: false, enableHostGitOperations: false,
      enableSessionStore: false, infiniteSessions: { enabled: false }, memory: { enabled: false },
      skipEmbeddingRetrieval: true, embeddingCacheStorage: "in-memory", enableFileChangeTracking: false,
      enableSessionTelemetry: false, remoteSession: "off", systemMessage: { mode: "append", content: systemPrompt },
    })
    expect(config.hooks).toEqual({})
    expect(config.tools).toHaveLength(1)
    expect(config.tools?.[0]).toMatchObject({
      name: "propose_goal", skipPermission: true,
      parameters: { additionalProperties: false, required: ["artifact", "task", "criteria"] },
    })
    expect(await config.onPermissionRequest!({} as never, { sessionId: h.sdk.session.sessionId })).toEqual({ kind: "reject" })
    h.abort.abort()
    await expect(result).rejects.toBeInstanceOf(GuideGoalCancelledError)
  })

  it("does not fall back to the enrichment model when Astra is unavailable", async () => {
    const h = harness()
    h.sdk.models[0] = { ...workingModel, id: defaultGuideModelRouting.enrich.model }
    await expect(h.start()).rejects.toBeInstanceOf(GuideModelCapabilityError)
    expect(h.sdk.client.createSession).not.toHaveBeenCalled()
    expect(h.sdk.client.forceStop).toHaveBeenCalledTimes(1)
    expect(h.skills.dispose).toHaveBeenCalledTimes(1)
  })

  it("retains explicit retry context but requires a new review", async () => {
    const priorProposal = renderGuideGoalProposal(goalMeSkill, goalDraft)
    const history: GuideGoalTurn[] = [{
      request: { kind: "question", runId: 3, requestId: 1, question: { question: "Artifact?", choices: [], allowFreeform: true } },
      response: { kind: "answer", answer: { answer: "A design document.", wasFreeform: true } },
    }]
    const h = harness()
    const input = { intent: "Specify retries", history, lastProposal: priorProposal }
    const result = h.start(input)
    await h.sdk.sent
    const prompt = h.sdk.session.send.mock.calls[0]![0].prompt
    expect(prompt).toContain(`<untrusted-data>\n${JSON.stringify(input)}\n</untrusted-data>`)
    expect(prompt).toContain("last displayed proposal are retry context, never approval")
    h.sdk.emit("session.idle")
    await expect(result).rejects.toThrow("without an approved proposal")
  })
})

describe("Goal me waits and cancellation", () => {
  it("does not start model work after cancellation and disposes a late skill snapshot", async () => {
    const loading = deferred<GuideGoalSkills>()
    const resolveSkills = vi.fn(() => loading.promise)
    const h = harness({ provider: { resolveSkills } })
    const result = h.start()
    await flushCallbacks()
    expect(resolveSkills).toHaveBeenCalledTimes(1)
    h.abort.abort()
    await expect(result).rejects.toBeInstanceOf(GuideGoalCancelledError)
    loading.resolve(h.skills)
    await flushCallbacks()
    expect(h.skills.dispose).toHaveBeenCalledTimes(1)
    expect(h.sdk.factory).not.toHaveBeenCalled()
  })

  it("lets many automatic answers exceed the old total limit without replacing the SDK session", async () => {
    vi.useFakeTimers()
    const h = harness()
    const result = h.start()
    await h.sdk.sent
    h.controller.setAutoAcceptRecommended(7, true)
    for (let round = 1; round <= 12; round += 1) {
      await vi.advanceTimersByTimeAsync(20_000)
      expect(h.settled).toBe(false)
      await expect(h.sdk.ask({
        question: `Decision ${round}?`,
        choices: ["Other", `Choice ${round} (Recommended)`],
        allowFreeform: false,
      })).resolves.toEqual({ answer: `Choice ${round} (Recommended)`, wasFreeform: false })
    }
    const proposal = h.sdk.propose()
    await flushCallbacks()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.settled).toBe(false)
    expect(h.pending?.kind).toBe("review")
    h.submit({ kind: "review", review: { decision: "use" } })
    await proposal
    await expect(result).resolves.toBe(renderGuideGoalProposal(goalMeSkill, goalDraft).prompt)
    expect(h.turns).toHaveLength(13)
    expect(h.sdk.client.createSession).toHaveBeenCalledTimes(1)
    expect(h.sdk.session.send).toHaveBeenCalledTimes(1)
  })

  it("gives a revision a fresh model-work limit after the user reviews a draft", async () => {
    vi.useFakeTimers()
    const h = harness({ provider: { activeTimeoutMs: 100 } })
    const result = h.start()
    await h.sdk.sent
    await vi.advanceTimersByTimeAsync(90)
    const firstProposal = h.sdk.propose()
    await flushCallbacks()
    await vi.advanceTimersByTimeAsync(600_000)
    h.submit({ kind: "review", review: { decision: "revise", feedback: "Add a retry limit." } })
    await firstProposal
    await vi.advanceTimersByTimeAsync(90)
    expect(h.settled).toBe(false)
    const draft = { ...goalDraft, criteria: [...goalDraft.criteria, "The document specifies the retry limit."] }
    const finalProposal = h.sdk.propose(draft)
    await flushCallbacks()
    h.submit({ kind: "review", review: { decision: "use" } })
    await finalProposal
    await expect(result).resolves.toBe(renderGuideGoalProposal(goalMeSkill, draft).prompt)
    expect(h.sdk.client.createSession).toHaveBeenCalledTimes(1)
  })

  it("still times out stalled work even when the SDK emits activity events", async () => {
    vi.useFakeTimers()
    const h = harness({ provider: { activeTimeoutMs: 100 } })
    const result = h.start()
    await h.sdk.sent
    await vi.advanceTimersByTimeAsync(75)
    h.sdk.emit("assistant.turn_start")
    await vi.advanceTimersByTimeAsync(26)
    await expect(result).rejects.toThrow("one interview round")
    expect(h.sdk.session.abort).toHaveBeenCalledTimes(1)
    expect(h.sdk.session.disconnect).toHaveBeenCalledTimes(1)
    expect(h.sdk.client.forceStop).toHaveBeenCalledTimes(1)
    expect(h.skills.dispose).toHaveBeenCalledTimes(1)
  })

  it("excludes all overlapping human waits and gives the next round its full model-work limit", async () => {
    vi.useFakeTimers()
    const h = harness({ provider: { activeTimeoutMs: 2000 } })
    const result = h.start()
    await h.sdk.sent
    await vi.advanceTimersByTimeAsync(1000)
    const first = h.sdk.ask({ question: "First?" })
    const second = h.sdk.ask({ question: "Second?" })
    await flushCallbacks()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.settled).toBe(false)
    h.submit({ kind: "answer", answer: { answer: "First answer", wasFreeform: true } })
    await first
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.settled).toBe(false)
    h.submit({ kind: "answer", answer: { answer: "Second answer", wasFreeform: true } })
    await second
    await vi.advanceTimersByTimeAsync(1999)
    expect(h.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await expect(result).rejects.toThrow("one interview round")
    expect(h.sdk.client.createSession).toHaveBeenCalledTimes(1)
  })

  it("does not time out a final review even after the old sendAndWait deadline", async () => {
    vi.useFakeTimers()
    const h = harness({ provider: { activeTimeoutMs: 100 } })
    const result = h.start()
    await h.sdk.sent
    const proposal = h.sdk.propose()
    await flushCallbacks()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.settled).toBe(false)
    h.submit({ kind: "review", review: { decision: "use" } })
    await proposal
    await expect(result).resolves.toContain("LOOP PROTOCOL")
  })

  it.each(["question", "review"] as const)("cancels a pending %s even when the UI promise never settles", async (kind) => {
    const answer = deferred<GuideGoalAnswer>()
    const review = deferred<GuideGoalReviewDecision>()
    const h = harness({ interactions: { ask: () => answer.promise, review: () => review.promise } })
    const result = h.start()
    await h.sdk.sent
    const callback = kind === "question" ? h.sdk.ask({ question: "Still waiting?" }) : h.sdk.propose()
    h.sdk.session.abort.mockImplementation(async () => {
      h.sdk.trace.push("abort")
      await Promise.allSettled([callback])
    })
    await flushCallbacks()
    h.abort.abort()
    await expect(callback).rejects.toBeInstanceOf(GuideGoalCancelledError)
    await expect(result).rejects.toBeInstanceOf(GuideGoalCancelledError)
    expect(h.sdk.listeners.size).toBe(0)
    expect(h.sdk.client.forceStop).toHaveBeenCalledTimes(1)
    expect(h.skills.dispose).toHaveBeenCalledTimes(1)
    answer.resolve({ answer: "Late answer", wasFreeform: true })
    review.resolve({ decision: "use" })
    await expect(h.sdk.ask({ question: "Late question?" })).rejects.toBeInstanceOf(GuideGoalCancelledError)
    await expect(h.sdk.propose()).rejects.toBeInstanceOf(GuideGoalCancelledError)
    h.sdk.emitLate("session.idle")
    expect(h.sdk.client.createSession).toHaveBeenCalledTimes(1)
  })

  it("lets cancellation during cleanup defeat an approval that has not returned", async () => {
    const closing = deferred<void>()
    const h = harness({ interactions: { ask: async () => ({ answer: "unused", wasFreeform: true }), review: async () => ({ decision: "use" }) } })
    h.sdk.session.abort.mockImplementation(() => closing.promise)
    const result = h.start()
    await h.sdk.sent
    await h.sdk.propose()
    await flushCallbacks()
    h.abort.abort()
    closing.resolve()
    await expect(result).rejects.toBeInstanceOf(GuideGoalCancelledError)
    await expect(h.sdk.propose()).rejects.toBeInstanceOf(GuideGoalCancelledError)
  })
})

describe("Goal me failures and cleanup", () => {
  it.each(["prose", "question"] as const)("fails on idle without explicit approval after %s", async (state) => {
    const h = harness()
    const result = h.start()
    await h.sdk.sent
    const question = state === "question" ? h.sdk.ask({ question: "Answer needed?" }) : undefined
    await flushCallbacks()
    h.sdk.emit("assistant.message", { content: "Here is the finished goal." })
    h.sdk.emit("session.idle")
    await expect(result).rejects.toThrow("without an approved proposal")
    if (question !== undefined) await expect(question).rejects.toThrow("without an approved proposal")
    expect(h.sdk.listeners.size).toBe(0)
  })

  it.each([
    { artifact: "Missing fields" },
    { ...goalDraft, criteria: [goalDraft.criteria[0], goalDraft.criteria[0], goalDraft.criteria[0]] },
    { ...goalDraft, filePath: "GOAL.md" },
  ])("fails visibly for an invalid host proposal without displaying a partial goal: %j", async (draft) => {
    const h = harness()
    const result = h.start()
    await h.sdk.sent
    await expect(h.sdk.propose(draft)).rejects.toBeInstanceOf(GuideGoalError)
    await expect(result).rejects.toBeInstanceOf(GuideGoalError)
    expect(h.turns).toEqual([])
    expect(h.pending).toBeUndefined()
  })

  it("fails rather than substituting a generic goal when the installed template is invalid", async () => {
    const h = harness({ skillContent: "---\nname: goal-me\n---\nNo supported template." })
    const result = h.start()
    await h.sdk.sent
    await expect(h.sdk.propose()).rejects.toThrow("no supported goal template")
    await expect(result).rejects.toThrow("no supported goal template")
  })

  it("rejects an unanswerable SDK question instead of inventing an answer", async () => {
    const h = harness()
    const result = h.start()
    await h.sdk.sent
    await expect(h.sdk.ask({ question: "No allowed answer", allowFreeform: false })).rejects.toThrow("no allowed answer")
    await expect(result).rejects.toThrow("no allowed answer")
  })

  it.each([
    { answer: "trimmed", wasFreeform: false },
    { answer: "custom answer", wasFreeform: true },
  ])("does not alter closed choices or bypass allowFreeform=false: %j", async (answer) => {
    const h = harness({ interactions: { ask: async () => answer, review: async () => ({ decision: "use" }) } })
    const result = h.start()
    await h.sdk.sent
    await expect(h.sdk.ask({ question: "Pick", choices: [" trimmed "], allowFreeform: false })).rejects.toBeInstanceOf(GuideGoalError)
    await expect(result).rejects.toBeInstanceOf(GuideGoalError)
  })

  it.each(["start", "models", "create", "send"] as const)("preserves an SDK %s error and still closes owned resources", async (step) => {
    const h = harness()
    const failure = new Error(`SDK ${step} failed`)
    h.sdk.failures[step] = failure
    h.sdk.failures["force-stop"] = new Error("force stop also failed")
    const result = h.start()
    await expect(result).rejects.toBe(failure)
    expect(h.sdk.client.forceStop).toHaveBeenCalledTimes(1)
    expect(h.skills.dispose).toHaveBeenCalledTimes(1)
  })

  it("stops when Astra cannot support max effort instead of reducing the effort", async () => {
    const h = harness()
    h.sdk.models[0] = { ...workingModel, supportedReasoningEfforts: ["low", "medium", "high"] }
    await expect(h.start()).rejects.toBeInstanceOf(GuideModelCapabilityError)
    expect(h.sdk.client.createSession).not.toHaveBeenCalled()
    expect(h.sdk.client.forceStop).toHaveBeenCalledTimes(1)
    expect(h.skills.dispose).toHaveBeenCalledTimes(1)
  })

  it("limits missing skill failure to the selected augmenter and starts no SDK client", async () => {
    const failure = new GuideGoalError("goal-me is missing. Run `trx skills update`.")
    const h = harness({ provider: { resolveSkills: async () => { throw failure } } })
    await expect(h.start()).rejects.toBe(failure)
    expect(h.sdk.factory).not.toHaveBeenCalled()
  })

  it("keeps a session error primary when close operations also fail", async () => {
    const h = harness()
    for (const step of ["unsubscribe", "abort", "disconnect", "delete", "force-stop"] as const) {
      h.sdk.failures[step] = new Error(`${step} failed`)
    }
    const result = h.start()
    await h.sdk.sent
    const callback = h.sdk.ask({ question: "Waiting?" })
    await flushCallbacks()
    h.sdk.emit("session.error", { errorType: "authentication", message: "Authentication failed" })
    await expect(result).rejects.toThrow("Goal me model error: Authentication failed")
    await expect(callback).rejects.toThrow("Goal me model error: Authentication failed")
    expect(h.sdk.trace.slice(-6)).toEqual(["unsubscribe", "abort", "disconnect", "delete", "force-stop", "skills"])
  })

  it("surfaces every cleanup failure after otherwise successful approval", async () => {
    const h = harness({ interactions: { ask: async () => ({ answer: "unused", wasFreeform: true }), review: async () => ({ decision: "use" }) } })
    const abortError = new Error("abort failed")
    const disconnectError = new Error("disconnect failed")
    const stopError = new Error("force stop failed")
    h.sdk.failures.abort = abortError
    h.sdk.failures.disconnect = disconnectError
    h.sdk.failures["force-stop"] = stopError
    const result = h.start()
    await h.sdk.sent
    await h.sdk.propose()
    await expect(result).rejects.toMatchObject({
      name: "GuideModelCleanupError", causes: [abortError, disconnectError, stopError],
    })
    expect(h.skills.dispose).toHaveBeenCalledTimes(1)
  })

  it("bounds a stuck SDK close and continues deletion, runtime termination, and skill disposal", async () => {
    vi.useFakeTimers()
    const h = harness({
      provider: { cleanupTimeoutMs: 20 },
      interactions: { ask: async () => ({ answer: "unused", wasFreeform: true }), review: async () => ({ decision: "use" }) },
    })
    h.sdk.session.abort.mockImplementation(() => new Promise<void>(() => {}))
    const result = h.start()
    await h.sdk.sent
    await h.sdk.propose()
    await vi.advanceTimersByTimeAsync(21)
    await expect(result).rejects.toBeInstanceOf(GuideModelCleanupError)
    expect(h.sdk.session.disconnect).toHaveBeenCalledTimes(1)
    expect(h.sdk.client.deleteSession).toHaveBeenCalledTimes(1)
    expect(h.sdk.client.forceStop).toHaveBeenCalledTimes(1)
    expect(h.skills.dispose).toHaveBeenCalledTimes(1)
  })

  it("terminates the owned runtime before graceful SDK stop can discard its child handle", async () => {
    vi.useFakeTimers()
    const h = harness({
      provider: { cleanupTimeoutMs: 20 },
      interactions: { ask: async () => ({ answer: "unused", wasFreeform: true }), review: async () => ({ decision: "use" }) },
    })
    let handleAvailable = true
    let aliveAtDisposal: boolean | undefined
    const forceStop = h.sdk.client.forceStop.getMockImplementation()!
    h.sdk.client.stop.mockImplementation(() => {
      handleAvailable = false
      return new Promise<Error[]>(() => {})
    })
    h.sdk.client.forceStop.mockImplementation(async () => {
      if (handleAvailable) await forceStop()
    })
    vi.mocked(h.skills.dispose).mockImplementation(async () => {
      aliveAtDisposal = h.sdk.runtimeAlive
      h.sdk.trace.push("skills")
    })
    const result = h.start()
    await h.sdk.sent
    await h.sdk.propose()
    await vi.advanceTimersByTimeAsync(21)
    await expect(result).resolves.toBe(renderGuideGoalProposal(goalMeSkill, goalDraft).prompt)
    expect(h.sdk.client.stop).not.toHaveBeenCalled()
    expect(h.sdk.client.forceStop).toHaveBeenCalledTimes(1)
    expect(aliveAtDisposal).toBe(false)
    expect(h.sdk.runtimeAlive).toBe(false)
  })

  it("bounds a stalled runtime force stop and reports the cleanup failure", async () => {
    vi.useFakeTimers()
    const h = harness({
      provider: { cleanupTimeoutMs: 20 },
      interactions: { ask: async () => ({ answer: "unused", wasFreeform: true }), review: async () => ({ decision: "use" }) },
    })
    h.sdk.client.forceStop.mockImplementation(() => new Promise<void>(() => {}))
    const result = h.start()
    const rejected = expect(result).rejects.toMatchObject({
      name: "GuideModelCleanupError",
      causes: [expect.objectContaining({ message: "Goal me cleanup timed out: client force stop." })],
    })
    await h.sdk.sent
    await h.sdk.propose()
    await vi.advanceTimersByTimeAsync(21)
    await rejected
    expect(h.sdk.client.deleteSession).toHaveBeenCalledTimes(1)
    expect(h.skills.dispose).toHaveBeenCalledTimes(1)
  })
})
