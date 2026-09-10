import os from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CopilotClientOptions, ModelInfo, SessionConfig } from "@github/copilot-sdk"
import {
  CopilotGuideProvider,
  RestrictedGuideEventType,
  runRestrictedGuideModelRequest,
  type GuideModelMessage,
  type RestrictedGuideModelClient,
  type RestrictedGuideModelRequest,
  type RestrictedGuideModelSession,
} from "../src/copilot-guide-provider.js"
import {
  analyzeConversation,
  continuationModelInputBudget,
  continuationPolicy,
  createCopilotContinuationProvider,
  type ContinuationSummaryInput,
} from "../src/continuation-provider.js"
import type { GuideGenerateInput } from "../src/guide-provider.js"
import { assessmentFixture, continuationEntries, conversationFixture, summaryFixture } from "./helpers/continuation-provider-fixtures.js"

const deferred = <Value>() => {
  let resolve!: (value: Value) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const availableModel: ModelInfo = {
  id: "fixture-model",
  name: "Offline fixture model",
  capabilities: {
    supports: { vision: false, reasoningEffort: true },
    limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 900_000 },
  },
  supportedReasoningEfforts: ["medium", "high"],
}

type Event = { readonly type: string; readonly data: unknown }

class FakeSession implements RestrictedGuideModelSession {
  readonly sessionId = "offline-session"
  readonly prompts: string[] = []
  readonly handlers = new Set<(event: Event) => void>()
  readonly started = deferred<void>()
  abortCalls = 0
  disconnectCalls = 0
  unsubscribeCalls = 0
  sendAndWaitCalls = 0
  sendBehavior: (session: FakeSession) => void | Promise<void> = (session) => session.reply("{}")
  abortBehavior: () => void | Promise<void> = () => undefined
  disconnectBehavior: () => void | Promise<void> = () => undefined

  emit(type: string, data: unknown = {}): void {
    for (const handler of this.handlers) handler({ type, data })
  }

  reply(content: string): void {
    this.emit(RestrictedGuideEventType.Message, { content })
    this.emit(RestrictedGuideEventType.Idle)
  }

  on(handler: (event: Event) => void): () => void {
    this.handlers.add(handler)
    return () => { this.unsubscribeCalls += 1; this.handlers.delete(handler) }
  }

  async send(input: { readonly prompt: string }): Promise<string> {
    this.prompts.push(input.prompt)
    this.started.resolve()
    await this.sendBehavior(this)
    return "message-request"
  }

  async sendAndWait(): Promise<GuideModelMessage | undefined> {
    this.sendAndWaitCalls += 1
    throw new Error("Cancellable requests must not leave a sendAndWait idle waiter")
  }

  async abort(): Promise<void> {
    this.abortCalls += 1
    await this.abortBehavior()
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1
    await this.disconnectBehavior()
  }
}

class FakeClient implements RestrictedGuideModelClient {
  readonly session = new FakeSession()
  readonly configs: SessionConfig[] = []
  readonly deleted: string[] = []
  readonly stages: string[] = []
  models: ReadonlyArray<ModelInfo> = [availableModel]
  startBehavior: () => void | Promise<void> = () => undefined
  modelBehavior: () => void | Promise<void> = () => undefined
  createBehavior: () => FakeSession | Promise<FakeSession> = () => this.session
  deleteBehavior: () => void | Promise<void> = () => undefined
  stopBehavior: () => ReadonlyArray<Error> | Promise<ReadonlyArray<Error>> = () => []
  forceStopBehavior: () => void | Promise<void> = () => undefined

  async start(): Promise<void> { this.stages.push("start"); await this.startBehavior() }
  async listModels(): Promise<ReadonlyArray<ModelInfo>> {
    this.stages.push("models")
    await this.modelBehavior()
    return this.models
  }
  async createSession(config: SessionConfig): Promise<FakeSession> {
    this.stages.push("create")
    this.configs.push(config)
    return this.createBehavior()
  }
  async deleteSession(id: string): Promise<void> {
    this.stages.push("delete")
    this.deleted.push(id)
    await this.deleteBehavior()
  }
  async stop(): Promise<ReadonlyArray<Error>> { this.stages.push("stop"); return this.stopBehavior() }
  async forceStop(): Promise<void> { this.stages.push("force-stop"); await this.forceStopBehavior() }
}

const request = (
  client: FakeClient,
  overrides: Partial<RestrictedGuideModelRequest> = {},
): RestrictedGuideModelRequest => ({
  model: "fixture-model",
  effort: "medium",
  systemPrompt: "Return raw JSON only.",
  prompt: '{"untrustedData":"Synthetic conversation"}',
  maximumResponseBytes: 1024,
  timeoutMs: 100,
  cleanupTimeoutMs: 5,
  inspectModel: () => undefined,
  clientFactory: () => client,
  ...overrides,
})

const promises = { assess: "ASSESS raw JSON.", summarize: "SUMMARIZE raw JSON." }
afterEach(() => vi.useRealTimers())

describe("restricted continuation SDK execution", () => {
  it("uses empty runtime configuration, tools, hooks, discovery, persistence, and permissions", async () => {
    const client = new FakeClient()
    let options: CopilotClientOptions | undefined
    const output = await runRestrictedGuideModelRequest(request(client, {
      copilotCliPath: "/offline/copilot",
      clientFactory: (value) => { options = value; return client },
    }))
    expect(output).toBe("{}")
    expect(options).toMatchObject({ mode: "empty", builtinPluginDirectories: [], workingDirectory: os.homedir() })
    expect(options?.baseDirectory).not.toContain(process.cwd())
    const config = client.configs[0]!
    expect(config).toMatchObject({
      model: "fixture-model", reasoningEffort: "medium", workingDirectory: os.homedir(),
      enableConfigDiscovery: false,
      tools: [], availableTools: [], mcpServers: {}, customAgents: [],
      enableSkills: false, skillDirectories: [], pluginDirectories: [], instructionDirectories: [], hooks: {},
      requestExtensions: false, requestCanvasRenderer: false, manageScheduleEnabled: false,
      skipCustomInstructions: true, enableOnDemandInstructionDiscovery: false, enableFileHooks: false,
      enableHostGitOperations: false, enableSessionStore: false, infiniteSessions: { enabled: false },
      memory: { enabled: false }, skipEmbeddingRetrieval: true, embeddingCacheStorage: "in-memory",
      enableFileChangeTracking: false, enableSessionTelemetry: false, remoteSession: "off",
      systemMessage: { mode: "append", content: "Return raw JSON only." },
    })
    expect(await config.onPermissionRequest?.({ kind: "read" } as never, { sessionId: "offline-session" })).toEqual({ kind: "reject" })
    expect(client.session.sendAndWaitCalls).toBe(0)
    expect(client.session.abortCalls).toBe(0)
    expect(client.session.disconnectCalls).toBe(1)
    expect(client.deleted).toEqual(["offline-session"])
    expect(client.stages.at(-1)).toBe("stop")
    expect(client.session.handlers.size).toBe(0)
  })

  it("uses only the final assistant answer, not commentary, reasoning, or tool events", async () => {
    const client = new FakeClient()
    client.session.sendBehavior = (session) => {
      session.emit("assistant.reasoning", { content: "PRIVATE REASONING" })
      session.emit("tool.execution_complete", { content: "PRIVATE TOOL RESULT" })
      session.emit(RestrictedGuideEventType.Message, { content: '{"first":true}' })
      session.reply('{"last":true}')
    }
    expect(await runRestrictedGuideModelRequest(request(client))).toBe('{"last":true}')
    expect(client.session.unsubscribeCalls).toBe(1)
  })

  it("does not create a client when already cancelled", async () => {
    const controller = new AbortController()
    controller.abort("private reason")
    const factory = vi.fn()
    await expect(runRestrictedGuideModelRequest(request(new FakeClient(), { signal: controller.signal, clientFactory: factory })))
      .rejects.toMatchObject({ name: "AbortError", code: "cancelled" })
    expect(factory).not.toHaveBeenCalled()
  })

  it("actually aborts a running request even when abort emits no idle event", async () => {
    const controller = new AbortController()
    const client = new FakeClient()
    client.session.sendBehavior = () => undefined
    const result = runRestrictedGuideModelRequest(request(client, { signal: controller.signal }))
    const caught = result.catch((error: unknown) => error)
    await client.session.started.promise
    controller.abort("private cancellation reason")
    expect(await caught).toMatchObject({ name: "AbortError", code: "cancelled", cleanupFailures: [] })
    expect(client.session.abortCalls).toBe(1)
    expect(client.session.disconnectCalls).toBe(1)
    expect(client.deleted).toEqual(["offline-session"])
    expect(client.session.handlers.size).toBe(0)
    expect(client.stages.at(-1)).toBe("stop")
  })

  it("aborts on deadline and releases its event waiter", async () => {
    vi.useFakeTimers()
    const client = new FakeClient()
    client.session.sendBehavior = () => undefined
    const result = runRestrictedGuideModelRequest(request(client, { timeoutMs: 10 })).catch((error: unknown) => error)
    await client.session.started.promise
    await vi.advanceTimersByTimeAsync(20)
    expect(await result).toMatchObject({ code: "timed-out" })
    expect(client.session.abortCalls).toBe(1)
    expect(client.session.handlers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["start", "metadata", "create", "send", "runtime"])("does not retry a %s failure and still cleans up", async (stage) => {
    const client = new FakeClient()
    const fail = () => { throw new Error("PRIVATE TRANSPORT CONTENT") }
    if (stage === "start") client.startBehavior = fail
    if (stage === "metadata") client.modelBehavior = fail
    if (stage === "create") client.createBehavior = fail
    if (stage === "send") client.session.sendBehavior = fail
    if (stage === "runtime") client.session.sendBehavior = (session) => session.emit(RestrictedGuideEventType.Error, { message: "PRIVATE TRANSPORT CONTENT" })
    const error = await runRestrictedGuideModelRequest(request(client)).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain("PRIVATE TRANSPORT CONTENT")
    expect(client.stages.filter((value) => value === "start")).toHaveLength(1)
    expect(client.session.prompts.length).toBeLessThanOrEqual(1)
    expect(client.stages).toContain("stop")
  })

  it.each(["missing", "oversized", "malformed"])("rejects a %s assistant response without leaking it", async (kind) => {
    const client = new FakeClient()
    client.session.sendBehavior = (session) => {
      if (kind === "oversized") session.reply("PRIVATE ".repeat(1024))
      else if (kind === "malformed") {
        session.emit(RestrictedGuideEventType.Message, { content: 123 })
        session.emit(RestrictedGuideEventType.Idle)
      } else session.emit(RestrictedGuideEventType.Idle)
    }
    const error = await runRestrictedGuideModelRequest(request(client)).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain("PRIVATE")
    expect(client.session.prompts).toHaveLength(1)
    expect(client.deleted).toHaveLength(1)
  })

  it("reports all cleanup failures while preserving cancellation and invokes forceStop", async () => {
    const controller = new AbortController()
    const client = new FakeClient()
    const fail = () => { throw new Error("PRIVATE CLEANUP DETAIL") }
    client.session.sendBehavior = () => undefined
    client.session.abortBehavior = fail
    client.session.disconnectBehavior = fail
    client.deleteBehavior = fail
    client.stopBehavior = fail
    client.forceStopBehavior = fail
    const result = runRestrictedGuideModelRequest(request(client, { signal: controller.signal })).catch((error: unknown) => error)
    await client.session.started.promise
    controller.abort()
    const error = await result
    expect(error).toMatchObject({
      name: "AbortError", code: "cancelled",
      cleanupFailures: expect.arrayContaining(["abort", "disconnect", "delete-session", "stop", "force-stop"]),
    })
    expect(String(error)).toContain("cleanup failed")
    expect(String(error)).not.toContain("PRIVATE CLEANUP DETAIL")
    expect(client.stages).toContain("delete")
    expect(client.stages).toContain("stop")
    expect(client.stages).toContain("force-stop")
  })

  it("bounds hanging abort and stop operations, forcing runtime termination", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const client = new FakeClient()
    client.session.sendBehavior = () => undefined
    client.session.abortBehavior = () => new Promise(() => undefined)
    client.stopBehavior = () => new Promise(() => undefined)
    const result = runRestrictedGuideModelRequest(request(client, { signal: controller.signal })).catch((error: unknown) => error)
    await client.session.started.promise
    controller.abort()
    await vi.advanceTimersByTimeAsync(30)
    expect(await result).toMatchObject({
      code: "cancelled", cleanupFailures: expect.arrayContaining(["abort", "stop"]),
    })
    expect(client.stages).toContain("force-stop")
    expect(client.deleted).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("surfaces stop's returned errors after otherwise successful inference", async () => {
    const client = new FakeClient()
    client.stopBehavior = () => [new Error("private runtime path")]
    await expect(runRestrictedGuideModelRequest(request(client))).rejects.toMatchObject({
      code: "cleanup-failed", cleanupFailures: ["stop"],
    })
    expect(client.stages.at(-1)).toBe("force-stop")
  })

  it("cancels a pending startup by force-stopping the owned client, without creating a session", async () => {
    const controller = new AbortController()
    const client = new FakeClient()
    const started = deferred<void>()
    const pending = deferred<void>()
    client.startBehavior = () => { started.resolve(); return pending.promise }
    client.forceStopBehavior = () => pending.reject(new Error("closed"))
    const result = runRestrictedGuideModelRequest(request(client, { signal: controller.signal })).catch((error: unknown) => error)
    await started.promise
    controller.abort()
    expect(await result).toMatchObject({ code: "cancelled" })
    expect(client.configs).toHaveLength(0)
    expect(client.stages).toContain("force-stop")
  })

  it("cleans up a late createSession result after cancellation without sending a prompt", async () => {
    const controller = new AbortController()
    const client = new FakeClient()
    const creating = deferred<void>()
    const pending = deferred<FakeSession>()
    client.createBehavior = () => { creating.resolve(); return pending.promise }
    client.forceStopBehavior = () => pending.resolve(client.session)
    const result = runRestrictedGuideModelRequest(request(client, { signal: controller.signal })).catch((error: unknown) => error)
    await creating.promise
    controller.abort()
    expect(await result).toMatchObject({ code: "cancelled" })
    expect(client.session.prompts).toHaveLength(0)
    expect(client.session.abortCalls).toBeGreaterThanOrEqual(1)
    expect(client.session.disconnectCalls).toBeGreaterThanOrEqual(1)
    expect(client.deleted).toContain("offline-session")
  })
})

describe("Copilot continuation model budgets and bounded repair", () => {
  it("accounts for both metadata limits and output/runtime reserves", () => {
    expect(continuationModelInputBudget(availableModel)).toBe(continuationPolicy.maxInputBytes)
    expect(continuationModelInputBudget({
      ...availableModel,
      capabilities: { ...availableModel.capabilities, limits: { max_context_window_tokens: 100_000, max_prompt_tokens: 70_000 } },
    })).toBe(100_000 - continuationPolicy.outputReserveTokens - continuationPolicy.runtimeReserveTokens)
    for (const value of [NaN, Infinity, 0, -1, 4.5]) {
      expect(() => continuationModelInputBudget({
        ...availableModel,
        capabilities: { ...availableModel.capabilities, limits: { max_context_window_tokens: value } },
      })).toThrow("metadata")
    }
  })

  it("uses the selected model and effort, and permits exactly one completed-response repair", async () => {
    const clients: FakeClient[] = []
    const provider = createCopilotContinuationProvider({
      model: "fixture-model", effort: "high", prompts: promises,
      clientFactory: () => {
        const client = new FakeClient()
        client.session.sendBehavior = (session) => session.reply(clients.length === 1 ? "{ invalid" : JSON.stringify(assessmentFixture()))
        clients.push(client)
        return client
      },
    })
    const result = await analyzeConversation(conversationFixture(), continuationEntries, provider)
    expect(result.assessment.actions).toHaveLength(5)
    expect(clients).toHaveLength(2)
    expect(clients.every((client) => client.configs[0]?.model === "fixture-model" && client.configs[0]?.reasoningEffort === "high")).toBe(true)
    expect(JSON.parse(clients[1]!.session.prompts[0]!).repair).toBe("invalid-assessment")
    expect(clients.every((client) => client.deleted.length === 1 && client.stages.at(-1) === "stop")).toBe(true)
  })

  it.each(["missing-model", "effort", "reasoning", "disabled", "budget"])("fails %s before any inference session", async (kind) => {
    const client = new FakeClient()
    if (kind === "missing-model") client.models = []
    if (kind === "effort") client.models = [{ ...availableModel, supportedReasoningEfforts: ["high"] }]
    if (kind === "reasoning") client.models = [{
      ...availableModel,
      capabilities: { ...availableModel.capabilities, supports: { vision: false, reasoningEffort: false } },
    }]
    if (kind === "disabled") client.models = [{ ...availableModel, policy: { state: "disabled", terms: "" } }]
    if (kind === "budget") client.models = [{
      ...availableModel,
      capabilities: { ...availableModel.capabilities, limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 9000 } },
    }]
    const provider = createCopilotContinuationProvider({
      model: "fixture-model", effort: "medium", prompts: promises, clientFactory: () => client,
    })
    await expect(analyzeConversation(conversationFixture(10, 8000), continuationEntries, provider)).rejects.toThrow()
    expect(client.configs).toHaveLength(0)
    expect(client.session.prompts).toHaveLength(0)
    expect(client.stages).toContain("stop")
  })

  it("repairs a completed oversized SDK response only after its runtime is cleaned up", async () => {
    const clients: FakeClient[] = []
    const provider = createCopilotContinuationProvider({
      model: "fixture-model", effort: "medium", prompts: promises,
      clientFactory: () => {
        const client = new FakeClient()
        client.session.sendBehavior = (session) => session.reply(clients.length === 1
          ? "x".repeat(continuationPolicy.maxResponseBytes + 1)
          : JSON.stringify(assessmentFixture()))
        clients.push(client)
        return client
      },
    })
    const result = await analyzeConversation(conversationFixture(), continuationEntries, provider)
    expect(result.assessment.actions).toHaveLength(5)
    expect(clients).toHaveLength(2)
    expect(clients[0]?.session.abortCalls).toBe(1)
    expect(clients[0]?.deleted).toEqual(["offline-session"])
    expect(clients[0]?.stages.at(-1)).toBe("stop")
  })

  it("does not retry an oversized response when cleanup failed", async () => {
    const client = new FakeClient()
    client.session.sendBehavior = (session) => session.reply("x".repeat(continuationPolicy.maxResponseBytes + 1))
    client.deleteBehavior = () => { throw new Error("private path") }
    const factory = vi.fn(() => client)
    const provider = createCopilotContinuationProvider({
      model: "fixture-model", effort: "medium", prompts: promises, clientFactory: factory,
    })
    await expect(analyzeConversation(conversationFixture(), continuationEntries, provider)).rejects.toThrow("cleanup failed")
    expect(factory).toHaveBeenCalledTimes(1)
    expect(client.stages).toContain("force-stop")
  })

  it("cancels a repair request through the actual SDK abort path without a third call", async () => {
    const controller = new AbortController()
    const clients: FakeClient[] = []
    const repairing = deferred<void>()
    const provider = createCopilotContinuationProvider({
      model: "fixture-model", effort: "medium", prompts: promises,
      clientFactory: () => {
        const client = new FakeClient()
        client.session.sendBehavior = (session) => {
          if (clients.length === 1) session.reply("{ invalid")
          else repairing.resolve()
        }
        clients.push(client)
        return client
      },
    })
    const result = analyzeConversation(conversationFixture(), continuationEntries, provider, {
      signal: controller.signal,
    }).catch((error: unknown) => error)
    await repairing.promise
    controller.abort()
    expect(await result).toMatchObject({ name: "AbortError", code: "cancelled" })
    expect(clients).toHaveLength(2)
    expect(clients[1]?.session.abortCalls).toBe(1)
    expect(clients[1]?.deleted).toEqual(["offline-session"])
  })

  it("propagates actual cancellation through analyzeConversation", async () => {
    const client = new FakeClient()
    client.session.sendBehavior = () => undefined
    const controller = new AbortController()
    const provider = createCopilotContinuationProvider({
      model: "fixture-model", effort: "medium", prompts: promises, clientFactory: () => client,
    })
    const result = analyzeConversation(conversationFixture(), continuationEntries, provider, {
      signal: controller.signal,
    }).catch((error: unknown) => error)
    await client.session.started.promise
    controller.abort()
    expect(await result).toMatchObject({ name: "AbortError", code: "cancelled", summaries: [] })
    expect(client.session.abortCalls).toBe(1)
    expect(client.deleted).toEqual(["offline-session"])
  })

  it("aborts a running summary while retaining the preceding completed chunk", async () => {
    const controller = new AbortController()
    const clients: FakeClient[] = []
    const summarizing = deferred<void>()
    const saved: number[] = []
    const provider = createCopilotContinuationProvider({
      model: "fixture-model", effort: "medium", prompts: promises,
      clientFactory: () => {
        const client = new FakeClient()
        client.session.sendBehavior = (session) => {
          if (clients.length > 1) { summarizing.resolve(); return }
          const input = JSON.parse(session.prompts[0]!).untrustedData as ContinuationSummaryInput
          session.reply(JSON.stringify(summaryFixture(input)))
        }
        clients.push(client)
        return client
      },
    })
    const result = analyzeConversation(conversationFixture(30, 6000), continuationEntries, provider, {
      signal: controller.signal,
      onSummaries: async (summaries) => { saved.push(summaries.length) },
    }).catch((error: unknown) => error)
    await summarizing.promise
    controller.abort()
    expect(await result).toMatchObject({ name: "AbortError", code: "cancelled", summaries: [expect.objectContaining({ key: expect.any(String) })] })
    expect(saved).toEqual([1])
    expect(clients).toHaveLength(2)
    expect(clients[1]?.session.abortCalls).toBe(1)
    expect(clients[1]?.deleted).toEqual(["offline-session"])
  })

  it("keeps ordinary guide generation cancellable without using continuation schema or tools", async () => {
    const client = new FakeClient()
    client.session.sendBehavior = () => undefined
    const controller = new AbortController()
    const provider = new CopilotGuideProvider({
      model: "fixture-model", effort: "medium", signal: controller.signal,
      prompts: { match: "match", generate: "generate", refine: "refine", optimize: "optimize", enrich: "enrich" },
      clientFactory: () => client,
    })
    const input: GuideGenerateInput = {
      intent: "Explain the design.", profileRef: "native:cpx/default", workflowId: "assist",
      guide: {
        schemaVersion: 1, capabilities: ["explanation"], bestFor: ["Design"], avoidFor: ["Unbounded work"], prerequisites: [],
        workflows: [{ id: "assist", description: "Explain.", examples: ["Explain this."], promptTemplate: "{{intent}}" }],
      },
      guideBody: "# Guide\nExplain the design.",
    }
    const result = provider.generate(input).catch((error: unknown) => error)
    await client.session.started.promise
    controller.abort()
    expect(await result).toMatchObject({ name: "AbortError", code: "cancelled" })
    expect(client.session.abortCalls).toBe(1)
    expect(client.session.sendAndWaitCalls).toBe(0)
    expect(client.configs[0]?.systemMessage).toEqual({ mode: "append", content: "generate" })
  })

  it("preserves custom guide instructions and successful generation with a signal", async () => {
    const client = new FakeClient()
    const candidates = [
      { title: "Diagram", prompt: "Draw the components.", notes: "Visual." },
      { title: "Decisions", prompt: "Explain the trade-offs.", notes: "Text." },
      { title: "Walkthrough", prompt: "Walk through one request.", notes: "Example." },
    ]
    client.session.sendBehavior = (session) => session.reply(JSON.stringify({ candidates }))
    const provider = new CopilotGuideProvider({
      model: "fixture-model", effort: "medium", signal: new AbortController().signal,
      systemMessageMode: "replace", clientName: "custom-guide",
      prompts: { match: "match", generate: "generate", refine: "refine", optimize: "optimize", enrich: "enrich" },
      clientFactory: () => client,
    })
    const result = await provider.generate({
      intent: "Explain.", profileRef: "native:cpx/default", workflowId: "assist", guideBody: "# Guide",
      guide: {
        schemaVersion: 1, capabilities: ["explanation"], bestFor: ["Design"], avoidFor: ["Unbounded work"], prerequisites: [],
        workflows: [{ id: "assist", description: "Explain.", examples: ["Explain this."], promptTemplate: "{{intent}}" }],
      },
    })
    expect(result).toEqual({ candidates })
    expect(client.configs[0]?.systemMessage).toEqual({ mode: "replace", content: "generate" })
    expect(client.configs[0]?.clientName).toBe("custom-guide")
    expect(client.session.sendAndWaitCalls).toBe(0)
  })
})
