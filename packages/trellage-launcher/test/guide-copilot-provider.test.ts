import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ModelInfo, SessionConfig, CopilotClientOptions } from "@github/copilot-sdk"
import {
  CopilotGuideProvider,
  GuideModelCapabilityError,
  GuideModelCleanupError,
  GuideModelResponseError,
  type GuideModelClient,
  type GuideModelMessage,
  type GuideModelSession,
} from "../src/copilot-guide-provider.js"
import type { GuideMatchCatalogEntry } from "../src/guide-catalog.js"
import type {
  GuideGenerateInput,
  GuideMatchInput,
  GuideOptimizeInput,
  GuideRefineInput,
} from "../src/guide-provider.js"

const prompts = {
  match: "MATCH SYSTEM PROMPT",
  generate: "GENERATE SYSTEM PROMPT",
  refine: "REFINE SYSTEM PROMPT",
  optimize: "OPTIMIZE SYSTEM PROMPT",
}

const workingModel: ModelInfo = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: 1_050_000 } },
  supportedReasoningEfforts: ["low", "medium", "high"],
}

const lunaModel: ModelInfo = {
  ...workingModel,
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
}

const message = (content: string): GuideModelMessage => ({ data: { content } })

/** A queued response: an assistant message, `undefined` (idle with no message), or an Error to throw. */
type QueuedResponse = GuideModelMessage | undefined | Error

class FakeSession implements GuideModelSession {
  readonly sessionId = "fake-session-1"
  readonly prompts: string[] = []
  disconnectCalls = 0
  private index = 0

  constructor(
    private readonly responses: ReadonlyArray<QueuedResponse>,
    private readonly disconnectError?: Error,
  ) {}

  async sendAndWait(options: { readonly prompt: string }): Promise<GuideModelMessage | undefined> {
    this.prompts.push(options.prompt)
    const response = this.responses[this.index]
    this.index += 1
    if (response instanceof Error) throw response
    return response
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1
    if (this.disconnectError !== undefined) throw this.disconnectError
  }
}

class FakeClient implements GuideModelClient {
  readonly createSessionCalls: SessionConfig[] = []
  readonly deleteSessionCalls: string[] = []
  startCalls = 0
  stopCalls = 0
  session: FakeSession | undefined

  constructor(
    private readonly models: ReadonlyArray<ModelInfo>,
    private readonly responses: ReadonlyArray<QueuedResponse>,
    private readonly failures: {
      readonly disconnect?: Error
      readonly deleteSession?: Error
      readonly stop?: Error
      readonly stopResults?: ReadonlyArray<Error>
    } = {},
  ) {}

  async start(): Promise<void> {
    this.startCalls += 1
  }

  async listModels(): Promise<ReadonlyArray<ModelInfo>> {
    return this.models
  }

  async createSession(config: SessionConfig): Promise<FakeSession> {
    this.createSessionCalls.push(config)
    this.session = new FakeSession(this.responses, this.failures.disconnect)
    return this.session
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleteSessionCalls.push(sessionId)
    if (this.failures.deleteSession !== undefined) throw this.failures.deleteSession
  }

  async stop(): Promise<ReadonlyArray<Error>> {
    this.stopCalls += 1
    if (this.failures.stop !== undefined) throw this.failures.stop
    return this.failures.stopResults ?? []
  }
}

const matchEntries: ReadonlyArray<GuideMatchCatalogEntry> = [
  {
    ref: "native:cdx/pstack",
    surface: "native",
    name: "pstack",
    launcher: "cdx",
    description: "Codex host-native launcher.",
    sandbox: false,
    guide: {
      schemaVersion: 1,
      capabilities: ["code-review"],
      bestFor: ["Reviewing diffs"],
      avoidFor: ["Long jobs"],
      prerequisites: [],
      workflows: [{ id: "review", description: "Review a diff.", examples: ["Review my PR"] }],
    },
  },
  {
    ref: "sandbox:prime-agent",
    surface: "sandbox",
    name: "prime-agent",
    harness: "copilot",
    description: "Sandboxed prime agent.",
    sandbox: true,
    guide: {
      schemaVersion: 1,
      capabilities: ["code-review"],
      bestFor: ["Reviewing diffs"],
      avoidFor: ["Long jobs"],
      prerequisites: [],
      workflows: [{ id: "review", description: "Review a diff.", examples: ["Review my PR"] }],
    },
  },
  {
    ref: "sandbox:other",
    surface: "sandbox",
    name: "other",
    harness: "copilot",
    description: "Another sandbox profile.",
    sandbox: true,
    guide: {
      schemaVersion: 1,
      capabilities: ["build"],
      bestFor: ["Building projects"],
      avoidFor: ["Reviews"],
      prerequisites: [],
      workflows: [{ id: "build", description: "Build the project.", examples: ["Build it"] }],
    },
  },
]

const matchInput: GuideMatchInput = { intent: "Review my pull request", entries: matchEntries }

const validMatchResponse = JSON.stringify({
  candidates: [
    {
      profileRef: "native:cdx/pstack",
      workflowId: "review",
      confidence: 0.9,
      reason: "Best fit.",
      tradeoff: "Needs a git checkout.",
    },
    {
      profileRef: "sandbox:prime-agent",
      workflowId: "review",
      confidence: 0.6,
      reason: "Good fit.",
      tradeoff: "Sandboxed only.",
    },
    {
      profileRef: "sandbox:other",
      workflowId: "build",
      confidence: 0.3,
      reason: "Weak fit.",
      tradeoff: "Not for review.",
    },
  ],
})

const generateInput: GuideGenerateInput = {
  intent: "Review my pull request",
  profileRef: "native:cdx/pstack",
  workflowId: "review",
  guide: {
    schemaVersion: 1,
    capabilities: ["code-review"],
    bestFor: ["Reviewing diffs"],
    avoidFor: ["Long jobs"],
    prerequisites: [],
    workflows: [
      { id: "review", description: "Review a diff.", examples: ["Review my PR"], promptTemplate: "Review {{ref}}." },
    ],
  },
  guideBody: "# pstack\n\nThis guide describes how to review a pull request using the pstack profile.",
}

const validGenerateResponse = JSON.stringify({
  candidates: [
    { title: "Quick pass", prompt: "Review this diff for obvious bugs.", notes: "Fast, shallow." },
    { title: "Deep review", prompt: "Review this diff in depth, including tests.", notes: "Slower, thorough." },
    { title: "Security focus", prompt: "Review this diff for security issues only.", notes: "Narrow scope." },
  ],
})

const refineInput: GuideRefineInput = {
  ...generateInput,
  candidate: { title: "Quick pass", prompt: "Review this diff for obvious bugs.", notes: "Fast, shallow." },
  feedback: "Make it also check for missing tests.",
}

const validRefineResponse = JSON.stringify({
  candidate: {
    title: "Quick pass, with tests",
    prompt: "Review this diff for bugs and missing tests.",
    notes: "Adds test coverage check.",
  },
})

const optimizeInput: GuideOptimizeInput = {
  targetTool: "codex",
  profileRef: "native:cdx/hve",
  candidates: JSON.parse(validGenerateResponse).candidates,
}

describe("CopilotGuideProvider — match/generate/refine happy paths", () => {
  it("matches, validates against the entries' workflow index, and cleans up", async () => {
    let capturedClientOptions: CopilotClientOptions | undefined
    const client = new FakeClient([workingModel], [message(validMatchResponse)])
    const provider = new CopilotGuideProvider({
      prompts,
      copilotCliPath: "/opt/bin/copilot",
      clientFactory: (options) => {
        capturedClientOptions = options
        return client
      },
    })

    const result = await provider.match(matchInput)

    expect(result.candidates).toHaveLength(3)
    expect(result.candidates.map((c) => c.profileRef)).toEqual([
      "native:cdx/pstack",
      "sandbox:prime-agent",
      "sandbox:other",
    ])
    expect(client.createSessionCalls).toHaveLength(1)
    expect(client.startCalls).toBe(1)
    const config = client.createSessionCalls[0]
    expect(config).toBeDefined()
    expect(config).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      enableConfigDiscovery: false,
      tools: [],
      availableTools: [],
      mcpServers: {},
      customAgents: [],
      skillDirectories: [],
      pluginDirectories: [],
      instructionDirectories: [],
      requestExtensions: false,
      requestCanvasRenderer: false,
      manageScheduleEnabled: false,
      skipCustomInstructions: true,
      enableOnDemandInstructionDiscovery: false,
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableSessionStore: false,
      enableSkills: false,
      infiniteSessions: { enabled: false },
      memory: { enabled: false },
      skipEmbeddingRetrieval: true,
      embeddingCacheStorage: "in-memory",
      enableFileChangeTracking: false,
      enableSessionTelemetry: false,
      remoteSession: "off",
      systemMessage: { mode: "append", content: "MATCH SYSTEM PROMPT" },
    })
    const decision = await config?.onPermissionRequest?.({} as never, { sessionId: "fake-session-1" })
    expect(decision).toEqual({ kind: "reject" })
    expect(client.session?.disconnectCalls).toBe(1)
    expect(client.deleteSessionCalls).toEqual(["fake-session-1"])
    expect(client.stopCalls).toBe(1)
    expect(client.session?.prompts).toHaveLength(1)

    // Item 5: client and session working directories are outside the repository.
    expect(capturedClientOptions?.workingDirectory).toBeDefined()
    expect(capturedClientOptions?.connection).toMatchObject({ kind: "stdio", path: "/opt/bin/copilot" })
    const workingDirectory = capturedClientOptions?.workingDirectory as string
    expect(path.isAbsolute(workingDirectory)).toBe(true)
    expect(workingDirectory.startsWith(process.cwd())).toBe(false)
    expect(workingDirectory.startsWith(os.tmpdir())).toBe(true)
    expect(config?.workingDirectory).toBe(workingDirectory)
  })

  it("generates exactly three candidates using the generate prompt", async () => {
    const client = new FakeClient([workingModel, lunaModel], [message(validGenerateResponse)])
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    const result = await provider.generate(generateInput)

    expect(result.candidates).toHaveLength(3)
    expect(client.createSessionCalls[0]).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      systemMessage: { mode: "append", content: "GENERATE SYSTEM PROMPT" },
    })
    expect(client.session?.disconnectCalls).toBe(1)
    expect(client.stopCalls).toBe(1)
  })

  it("refines to exactly one candidate using the refine prompt", async () => {
    const client = new FakeClient([workingModel], [message(validRefineResponse)])
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    const result = await provider.refine(refineInput)

    expect(result.candidate.title).toBe("Quick pass, with tests")
    expect(client.createSessionCalls[0]).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      systemMessage: { mode: "append", content: "REFINE SYSTEM PROMPT" },
    })
    expect(client.session?.disconnectCalls).toBe(1)
    expect(client.stopCalls).toBe(1)
  })

  it("invokes Prompt Master with only the approved skill enabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-prompt-master-test-"))
    const skillDirectory = path.join(root, "prompt-master")
    try {
      await mkdir(skillDirectory)
      await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: prompt-master\n---\n")
      const client = new FakeClient([workingModel], [message(validGenerateResponse)])
      const provider = new CopilotGuideProvider({
        prompts,
        promptMasterSkillDirectory: skillDirectory,
        clientFactory: () => client,
      })

      const result = await provider.optimize(optimizeInput)

      expect(result.candidates).toHaveLength(3)
      expect(client.createSessionCalls[0]).toMatchObject({
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        tools: [],
        availableTools: [],
        skillDirectories: [skillDirectory],
        enableSkills: true,
        systemMessage: { mode: "append", content: "OPTIMIZE SYSTEM PROMPT" },
      })
      expect(client.session?.prompts[0]).toMatch(/^\/prompt-master Optimize these prompts/u)
      expect(client.session?.prompts[0]).toContain('"targetTool":"codex"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("honors a configured replace system message mode", async () => {
    const client = new FakeClient([workingModel], [message(validMatchResponse)])
    const provider = new CopilotGuideProvider({ prompts, systemMessageMode: "replace", clientFactory: () => client })

    await provider.match(matchInput)

    expect(client.createSessionCalls[0]).toMatchObject({
      systemMessage: { mode: "replace", content: "MATCH SYSTEM PROMPT" },
    })
  })

  it("honors global model and effort options for a non-Match phase", async () => {
    const customModel: ModelInfo = { ...workingModel, id: "custom-model", supportedReasoningEfforts: ["high"] }
    const client = new FakeClient([customModel], [message(validGenerateResponse)])
    const provider = new CopilotGuideProvider({
      prompts,
      model: "custom-model",
      effort: "high",
      clientFactory: () => client,
    })

    await provider.generate(generateInput)

    expect(client.createSessionCalls[0]).toMatchObject({ model: "custom-model", reasoningEffort: "high" })
  })
})

describe("CopilotGuideProvider — repair semantics", () => {
  it("sends exactly one repair request when the completed response is schema-invalid, then succeeds", async () => {
    const invalidResponse = message(JSON.stringify({ candidates: [] }))
    const client = new FakeClient([workingModel], [invalidResponse, message(validMatchResponse)])
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    const result = await provider.match(matchInput)

    expect(result.candidates).toHaveLength(3)
    expect(client.session?.prompts).toHaveLength(2)
    expect(client.session?.disconnectCalls).toBe(1)
    expect(client.stopCalls).toBe(1)
  })

  it("sends exactly one repair request when the completed response is not valid JSON, then succeeds", async () => {
    const invalidResponse = message("not json at all")
    const client = new FakeClient([workingModel], [invalidResponse, message(validMatchResponse)])
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    const result = await provider.match(matchInput)

    expect(result.candidates).toHaveLength(3)
    expect(client.session?.prompts).toHaveLength(2)
  })

  it("fails without a second repair when the repair response is again invalid", async () => {
    const invalidResponse = message(JSON.stringify({ candidates: [] }))
    const client = new FakeClient([workingModel], [invalidResponse, invalidResponse])
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    await expect(provider.match(matchInput)).rejects.toThrow(/match result\.candidates/u)
    expect(client.session?.prompts).toHaveLength(2)
    expect(client.session?.disconnectCalls).toBe(1)
    expect(client.stopCalls).toBe(1)
  })

  it("does not attempt a repair when sendAndWait throws (transport failure)", async () => {
    const transportError = new Error("network unreachable")
    const client = new FakeClient([workingModel], [transportError])
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    await expect(provider.match(matchInput)).rejects.toThrow("network unreachable")
    expect(client.session?.prompts).toHaveLength(1)
    expect(client.session?.disconnectCalls).toBe(1)
    expect(client.stopCalls).toBe(1)
  })

  it("does not attempt a repair when sendAndWait resolves undefined (timeout/no message)", async () => {
    const client = new FakeClient([workingModel], [undefined])
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    await expect(provider.match(matchInput)).rejects.toThrow(GuideModelResponseError)
    expect(client.session?.prompts).toHaveLength(1)
    expect(client.session?.disconnectCalls).toBe(1)
    expect(client.stopCalls).toBe(1)
  })
})

describe("CopilotGuideProvider — model capability rejection", () => {
  it("rejects before creating a session when the configured model is not listed", async () => {
    const client = new FakeClient([], [message(validMatchResponse)])
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    await expect(provider.match(matchInput)).rejects.toThrow(GuideModelCapabilityError)
    expect(client.createSessionCalls).toHaveLength(0)
    expect(client.stopCalls).toBe(1)
  })

  it("rejects before creating a session when the model does not support reasoning effort", async () => {
    const noEffortModel: ModelInfo = {
      ...workingModel,
      capabilities: { ...workingModel.capabilities, supports: { vision: false, reasoningEffort: false } },
    }
    const client = new FakeClient([noEffortModel], [message(validMatchResponse)])
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    await expect(provider.match(matchInput)).rejects.toThrow(GuideModelCapabilityError)
    expect(client.createSessionCalls).toHaveLength(0)
    expect(client.stopCalls).toBe(1)
  })

  it("rejects before creating a session when the configured effort is unsupported, naming the supported efforts", async () => {
    const lowOnlyModel: ModelInfo = { ...workingModel, supportedReasoningEfforts: ["low"] }
    const client = new FakeClient([lowOnlyModel], [message(validMatchResponse)])
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    await expect(provider.match(matchInput)).rejects.toThrow(GuideModelCapabilityError)
    await expect(provider.match(matchInput)).rejects.toThrow(/supports: low/u)
    expect(client.createSessionCalls).toHaveLength(0)
  })
})

describe("CopilotGuideProvider — session/client boundary hardening", () => {
  it("defaults both client and session working directories to a path under os.tmpdir()", async () => {
    let capturedClientOptions: CopilotClientOptions | undefined
    const client = new FakeClient([workingModel], [message(validMatchResponse)])
    const provider = new CopilotGuideProvider({
      prompts,
      clientFactory: (options) => {
        capturedClientOptions = options
        return client
      },
    })

    await provider.match(matchInput)

    expect(capturedClientOptions?.workingDirectory?.startsWith(os.tmpdir())).toBe(true)
    expect(client.createSessionCalls[0]?.workingDirectory).toBe(capturedClientOptions?.workingDirectory)
  })

  it("honors a configured workingDirectory for both the client and the session", async () => {
    let capturedClientOptions: CopilotClientOptions | undefined
    const client = new FakeClient([workingModel], [message(validMatchResponse)])
    const customDirectory = path.join(os.tmpdir(), "custom-trx-guide-dir")
    const provider = new CopilotGuideProvider({
      prompts,
      workingDirectory: customDirectory,
      clientFactory: (options) => {
        capturedClientOptions = options
        return client
      },
    })

    await provider.match(matchInput)

    expect(capturedClientOptions?.workingDirectory).toBe(customDirectory)
    expect(client.createSessionCalls[0]?.workingDirectory).toBe(customDirectory)
  })
})

describe("CopilotGuideProvider — cleanup failure handling", () => {
  it("still attempts deleteSession and stop when disconnect throws, and surfaces the cleanup error", async () => {
    const client = new FakeClient([workingModel], [message(validMatchResponse)], {
      disconnect: new Error("disconnect failed"),
    })
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    await expect(provider.match(matchInput)).rejects.toThrow(GuideModelCleanupError)
    expect(client.session?.disconnectCalls).toBe(1)
    expect(client.deleteSessionCalls).toEqual(["fake-session-1"])
    expect(client.stopCalls).toBe(1)
  })

  it("still attempts stop when deleteSession throws, and surfaces the cleanup error", async () => {
    const client = new FakeClient([workingModel], [message(validMatchResponse)], {
      deleteSession: new Error("deleteSession failed"),
    })
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    await expect(provider.match(matchInput)).rejects.toThrow(GuideModelCleanupError)
    expect(client.session?.disconnectCalls).toBe(1)
    expect(client.deleteSessionCalls).toEqual(["fake-session-1"])
    expect(client.stopCalls).toBe(1)
  })

  it("surfaces cleanup errors returned by client.stop", async () => {
    const stopError = new Error("child process did not stop")
    const client = new FakeClient([workingModel], [message(validMatchResponse)], {
      stopResults: [stopError],
    })
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    await expect(provider.match(matchInput)).rejects.toMatchObject({
      name: "GuideModelCleanupError",
      causes: [stopError],
    })
    expect(client.session?.disconnectCalls).toBe(1)
    expect(client.deleteSessionCalls).toEqual(["fake-session-1"])
    expect(client.stopCalls).toBe(1)
  })

  it("attempts every cleanup step even when disconnect, deleteSession, and stop all throw", async () => {
    const client = new FakeClient([workingModel], [message(validMatchResponse)], {
      disconnect: new Error("disconnect failed"),
      deleteSession: new Error("deleteSession failed"),
      stop: new Error("stop failed"),
    })
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    await expect(provider.match(matchInput)).rejects.toThrow(GuideModelCleanupError)
    expect(client.session?.disconnectCalls).toBe(1)
    expect(client.deleteSessionCalls).toEqual(["fake-session-1"])
    expect(client.stopCalls).toBe(1)
  })

  it("does not mask a primary validation error with a cleanup failure", async () => {
    const invalidResponse = message(JSON.stringify({ candidates: [] }))
    const client = new FakeClient([workingModel], [invalidResponse, invalidResponse], {
      disconnect: new Error("disconnect failed"),
      stop: new Error("stop failed"),
    })
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    // The primary schema-validation error must win over any cleanup error.
    await expect(provider.match(matchInput)).rejects.toThrow(/match result\.candidates/u)
    expect(client.session?.disconnectCalls).toBe(1)
    expect(client.deleteSessionCalls).toEqual(["fake-session-1"])
    expect(client.stopCalls).toBe(1)
  })

  it("does not mask a primary transport error with a cleanup failure", async () => {
    const transportError = new Error("network unreachable")
    const client = new FakeClient([workingModel], [transportError], {
      disconnect: new Error("disconnect failed"),
      deleteSession: new Error("deleteSession failed"),
      stop: new Error("stop failed"),
    })
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    await expect(provider.match(matchInput)).rejects.toThrow("network unreachable")
    expect(client.session?.disconnectCalls).toBe(1)
    expect(client.deleteSessionCalls).toEqual(["fake-session-1"])
    expect(client.stopCalls).toBe(1)
  })

  it("succeeds without a cleanup error when every cleanup step succeeds", async () => {
    const client = new FakeClient([workingModel], [message(validMatchResponse)])
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    await expect(provider.match(matchInput)).resolves.toMatchObject({ candidates: expect.any(Array) as unknown })
  })
})

describe("CopilotGuideProvider — bounded response parsing", () => {
  it("rejects a completed response exceeding the response size bound without hanging, and still repairs once", async () => {
    const oversized = message("x".repeat(64 * 1024 + 1))
    const client = new FakeClient([workingModel], [oversized, message(validMatchResponse)])
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    const result = await provider.match(matchInput)

    expect(result.candidates).toHaveLength(3)
    expect(client.session?.prompts).toHaveLength(2)
  })

  it("fails with GuideModelResponseError when both the first response and the repair are oversized", async () => {
    const oversized = message("x".repeat(64 * 1024 + 1))
    const client = new FakeClient([workingModel], [oversized, oversized])
    const provider = new CopilotGuideProvider({ prompts, clientFactory: () => client })

    await expect(provider.match(matchInput)).rejects.toThrow(GuideModelResponseError)
    expect(client.session?.prompts).toHaveLength(2)
  })
})
