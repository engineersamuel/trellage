import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { captureFocusedConversation } from "../src/conversation-capture.ts"
import {
  captureSandboxConversation, type SandboxConversationRunnerInput,
} from "../src/sandbox-bridge.ts"
import { captureFixture } from "./fixtures.ts"

for (const failSecondPage of [false, true]) {
  test(`sealed Sandbox pages ${failSecondPage ? "reject a changed source" : "preserve canonical evidence"} and release once`, async (t) => {
    const fixture = await captureFixture(t)
    const snapshot = await captureFocusedConversation(fixture.context, fixture.dependencies)
    const identity = {
      agent: snapshot.source.agent, profile: "fixture-profile", sessionId: snapshot.source.sessionId,
      containerId: "a".repeat(64), invocationId: "b".repeat(32),
    }
    const snapshotId = "c".repeat(64)
    const calls: SandboxConversationRunnerInput[] = []
    const operation = captureSandboxConversation({
      identity, cwd: fixture.cwd, env: fixture.env,
      bridgeRunner: async (input) => {
        calls.push(input)
        if (input.operation === "release-conversation") return JSON.stringify({
          schemaVersion: 1, ...identity, snapshotId: input.snapshotId, released: true,
        })
        const second = input.cursor !== undefined
        return JSON.stringify({
          schemaVersion: 1, ...identity,
          sessionId: second && failSecondPage ? "different-synthetic-session" : identity.sessionId,
          snapshotId, capturedAt: snapshot.capturedAt, cutoff: snapshot.cutoff,
          revision: createHash("sha256").update(JSON.stringify(snapshot.messages)).digest("hex"),
          activityRevision: "d".repeat(64), coverage: { complete: true, notices: [] },
          messages: [snapshot.messages[second ? 1 : 0]],
          page: { index: second ? 1 : 0, total: 2, nextCursor: second ? null : snapshotId + "e".repeat(64) },
        })
      },
    })
    if (failSecondPage) await assert.rejects(operation, /different source identity/)
    else assert.deepEqual((await operation).messages, snapshot.messages)
    assert.deepEqual(calls.map((call) => call.operation), [
      "export-conversation", "export-conversation", "release-conversation",
    ])
    assert.equal(calls.at(-1)?.snapshotId, snapshotId)
    assert.equal(calls.at(-1)?.signal?.aborted, false)
  })
}
