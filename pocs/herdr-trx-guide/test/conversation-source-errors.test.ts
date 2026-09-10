import assert from "node:assert/strict"
import { test } from "node:test"
import { ConversationAgent, ConversationRole, ConversationSurface } from "../../../packages/trellage-guide-core/dist/conversation.js"
import { runConversationSourceCli } from "../conversation-source.ts"

const snapshot = {
  schemaVersion: 1 as const,
  id: "d6710bf4-511e-48d2-98a7-cdba271cfb2f",
  source: {
    serverId: "test-server", surface: ConversationSurface.Host, agent: ConversationAgent.Copilot,
    sessionId: "test-session", workspaceId: "1", paneId: "1-1", cwd: "/synthetic",
  },
  capturedAt: "2026-01-01T00:00:00.000Z",
  cutoff: { messageId: "m1", recordIndex: 0 },
  revision: "a".repeat(64),
  messages: [{ id: "m1", role: ConversationRole.Assistant, text: "Synthetic completed answer.", recordIndex: 0 }],
  coverage: { complete: true, notices: [] },
}

for (const operation of ["--check", "--refresh"]) {
  test(`${operation} preserves a cleanup failure under an aborted signal`, async (t) => {
    const stderr: string[] = []
    const stdout: string[] = []
    t.mock.method(process.stderr, "write", (text: string) => { stderr.push(String(text)); return true })
    t.mock.method(process.stdout, "write", (text: string) => { stdout.push(String(text)); return true })
    const controller = new AbortController()
    const code = await runConversationSourceCli([operation, "/synthetic/request.json"], {
      env: { HERDR_PLUGIN_STATE_DIR: "/synthetic" },
      signal: controller.signal,
      readRequest: async () => snapshot,
      capture: async () => {
        controller.abort()
        throw new AggregateError([controller.signal.reason, new Error("synthetic-private-detail")], "release failed")
      },
    })
    assert.equal(code, 1)
    assert.match(stderr.join(""), /cleanup failed/)
    assert.doesNotMatch(stderr.join(""), /synthetic-private-detail/)
    assert.equal(stdout.join(""), "")
  })

  test(`${operation} reports only confirmed clean cancellation as cancelled`, async (t) => {
    const output: string[] = []
    t.mock.method(process.stderr, "write", (text: string) => { output.push(String(text)); return true })
    t.mock.method(process.stdout, "write", (text: string) => { output.push(String(text)); return true })
    const controller = new AbortController()
    const code = await runConversationSourceCli([operation, "/synthetic/request.json"], {
      env: { HERDR_PLUGIN_STATE_DIR: "/synthetic" },
      signal: controller.signal,
      readRequest: async () => snapshot,
      capture: async () => {
        controller.abort()
        throw controller.signal.reason
      },
    })
    assert.equal(code, 130)
    assert.equal(output.join(""), "")
  })
}
