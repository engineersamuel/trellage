import { describe, expect, it } from "vitest"

import type { ModelInfo } from "@github/copilot-sdk"
import { GuideModelCleanupError, GuideModelResponseError, type GuideModelClient, type GuideModelSession } from "../src/copilot-guide-provider.js"
import { DoctorFailureDiagnosisProvider } from "../src/admin-diagnosis-provider.js"

const model: ModelInfo = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  capabilities: { supports: { vision: false, reasoningEffort: true }, limits: { max_context_window_tokens: 128_000 } },
  supportedReasoningEfforts: ["low", "medium", "high"],
}

const okContent = JSON.stringify({ summary: "restart the daemon", suggestedFix: "run `cpx repair hve`", confidence: "high" })

class FakeSession implements GuideModelSession {
  readonly sessionId = "session-1"
  responses: Array<string | undefined>
  disconnectCalls = 0
  capturedPrompts: string[] = []

  constructor(responses: Array<string | undefined>) {
    this.responses = responses
  }

  async sendAndWait(options: { readonly prompt: string }): Promise<{ readonly data: { readonly content: string } } | undefined> {
    this.capturedPrompts.push(options.prompt)
    const next = this.responses.shift()
    return next === undefined ? undefined : { data: { content: next } }
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1
  }
}

class FakeClient implements GuideModelClient {
  deletedSessionIds: string[] = []
  stopCalls = 0
  stopErrors: ReadonlyArray<Error> = []
  session: FakeSession

  constructor(responses: Array<string | undefined>) {
    this.session = new FakeSession(responses)
  }

  async start(): Promise<void> {}

  async listModels(): Promise<ReadonlyArray<ModelInfo>> {
    return [model]
  }

  async createSession(): Promise<GuideModelSession> {
    return this.session
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deletedSessionIds.push(sessionId)
  }

  async stop(): Promise<ReadonlyArray<Error>> {
    this.stopCalls += 1
    return this.stopErrors
  }
}

const buildProvider = (client: FakeClient): DoctorFailureDiagnosisProvider =>
  new DoctorFailureDiagnosisProvider({ clientFactory: () => client })

describe("DoctorFailureDiagnosisProvider", () => {
  it("parses a successful, well-formed response", async () => {
    const client = new FakeClient([okContent])
    const provider = buildProvider(client)
    const result = await provider.diagnose({ ref: "native:cpx/hve", name: "hve", capturedOutput: "boom" })
    expect(result).toMatchObject({ summary: "restart the daemon", suggestedFix: "run `cpx repair hve`", confidence: "high" })
    expect(client.session.disconnectCalls).toBe(1)
    expect(client.deletedSessionIds).toEqual(["session-1"])
    expect(client.stopCalls).toBe(1)
  })

  it("rejects an oversized response without attempting JSON.parse", async () => {
    const oversized = JSON.stringify({ summary: "x".repeat(200_000), suggestedFix: "y" })
    const client = new FakeClient([oversized])
    const provider = buildProvider(client)
    await expect(provider.diagnose({ ref: "r", name: "n", capturedOutput: "boom" })).rejects.toThrow(GuideModelResponseError)
  })

  it("repairs exactly once on an invalid first response, then succeeds", async () => {
    const client = new FakeClient(["not json", okContent])
    const provider = buildProvider(client)
    const result = await provider.diagnose({ ref: "r", name: "n", capturedOutput: "boom" })
    expect(result.summary).toBe("restart the daemon")
    expect(client.session.capturedPrompts.length).toBe(2)
  })

  it("fails terminally when the repaired response is also invalid (no infinite retry)", async () => {
    const client = new FakeClient(["not json", "still not json"])
    const provider = buildProvider(client)
    await expect(provider.diagnose({ ref: "r", name: "n", capturedOutput: "boom" })).rejects.toThrow(GuideModelResponseError)
    expect(client.session.capturedPrompts.length).toBe(2)
  })

  it("always runs cleanup in order even when the diagnosis call throws", async () => {
    const client = new FakeClient([undefined])
    const provider = buildProvider(client)
    await expect(provider.diagnose({ ref: "r", name: "n", capturedOutput: "boom" })).rejects.toThrow()
    expect(client.session.disconnectCalls).toBe(1)
    expect(client.deletedSessionIds).toEqual(["session-1"])
    expect(client.stopCalls).toBe(1)
  })

  it("surfaces a cleanup failure only when there was no primary error", async () => {
    const client = new FakeClient([okContent])
    client.stopErrors = [new Error("stop failed")]
    const provider = buildProvider(client)
    await expect(provider.diagnose({ ref: "r", name: "n", capturedOutput: "boom" })).rejects.toThrow(GuideModelCleanupError)
  })

  it("constructs a session with no tools, no persistence, and reject-all permissions", async () => {
    const client = new FakeClient([okContent])
    let capturedConfig: Record<string, unknown> | undefined
    const originalCreateSession = client.createSession.bind(client)
    client.createSession = async (config?: unknown) => {
      capturedConfig = config as Record<string, unknown>
      return originalCreateSession()
    }
    const provider = buildProvider(client)
    await provider.diagnose({ ref: "r", name: "n", capturedOutput: "boom" })
    expect(capturedConfig).toBeDefined()
    expect(capturedConfig?.tools).toEqual([])
    expect(capturedConfig?.availableTools).toEqual([])
    expect(capturedConfig?.mcpServers).toEqual({})
    expect(capturedConfig?.enableSkills).toBe(false)
    expect(capturedConfig?.enableSessionStore).toBe(false)
    const permissionRequest = capturedConfig?.onPermissionRequest as (() => { kind: string }) | undefined
    expect(permissionRequest?.()).toEqual({ kind: "reject" })
  })
})
