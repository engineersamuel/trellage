import assert from "node:assert/strict"
import { appendFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { ConversationAgent, ConversationRole, ConversationSurface } from "@trellage/guide-core/conversation"
import { bindFocusedConversation, captureFocusedConversation } from "../src/conversation-capture.ts"
import { checkConversationSource } from "../src/cli.ts"
import { parseConversationRecords } from "../src/conversation-parser.ts"
import {
  assistantRecord, captureFixture, humanRecord, jsonl, metadataRecord, sessionId, writeHistory,
} from "./fixtures.ts"

for (const agent of Object.values(ConversationAgent)) {
  for (const surface of [ConversationSurface.Host, ConversationSurface.Native] as const) {
    test(`${surface} ${agent} captures only the exact source through completed visible output`, async (t) => {
      const fixture = await captureFixture(t, agent, surface)
      const binding = await bindFocusedConversation(fixture.context, fixture.dependencies)
      const snapshot = await captureFocusedConversation({ ...fixture.context, binding }, fixture.dependencies)
      assert.deepEqual(snapshot.messages.map(({ role, text }) => ({ role, text })), [
        { role: ConversationRole.User, text: "Synthetic human goal" },
        { role: ConversationRole.Assistant, text: "Synthetic completed answer" },
      ])
      assert.equal(snapshot.source.sessionId, sessionId)
      assert.equal(snapshot.source.surface, surface)
      assert.equal(snapshot.source.profile, surface === ConversationSurface.Native ? "fixture-profile" : undefined)
      assert.match(snapshot.coverage.notices.join(" "), /Newer user-visible/)
      const repeated = await captureFocusedConversation(fixture.context, fixture.dependencies)
      assert.equal(repeated.revision, snapshot.revision)
      assert.deepEqual(repeated.messages, snapshot.messages)
      assert.notEqual(repeated.id, snapshot.id)
    })
  }

  test(`${agent} retains the original goal before the former tail and text limits`, async (t) => {
    const fixture = await captureFixture(t, agent)
    const completed = "x".repeat(70_001)
    await writeFile(fixture.transcriptPath, jsonl([
      metadataRecord(agent, fixture.cwd), humanRecord(agent, "original", "Original synthetic goal"),
      { type: "tool.execution_complete", data: { output: "ignored".repeat(1_600_000) } },
      assistantRecord(agent, "completed", completed),
    ]))
    const snapshot = await captureFocusedConversation(fixture.context, fixture.dependencies)
    assert.equal(snapshot.messages[0]?.text, "Original synthetic goal")
    assert.equal(snapshot.messages[1]?.text, completed)
    assert.equal(snapshot.coverage.complete, true)
  })
}

test("Codex mixed blocks exclude injected instructions, tools, and private assistant channels", () => {
  const records = [
    {
      type: "response_item",
      payload: {
        id: "human", type: "message", role: "user",
        content: [
          { type: "input_text", text: "EXCLUDED_SYNTHETIC_INSTRUCTIONS" },
          { type: "input_text", text: "Visible synthetic request" },
        ],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["agents_md.instructions", "user.text"],
        },
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message", role: "assistant", phase: "final_answer", channel: "analysis",
        content: [{ type: "output_text", text: "EXCLUDED_SYNTHETIC_REASONING" }],
      },
    },
    { type: "response_item", payload: { type: "function_call_output", output: "EXCLUDED_SYNTHETIC_TOOL" } },
    assistantRecord(ConversationAgent.Codex, "completed", "Visible synthetic answer"),
  ]
  const result = parseConversationRecords(
    ConversationAgent.Codex, records.map((value, recordIndex) => ({ value, recordIndex })), { sessionId, cwd: "/synthetic" },
  )
  assert.deepEqual(result.messages.map((message) => message.text), ["Visible synthetic request", "Visible synthetic answer"])
  assert.doesNotMatch(JSON.stringify(result), /EXCLUDED_SYNTHETIC/)
})

test("Native lookup never substitutes the same session ID from the host home", async (t) => {
  const fixture = await captureFixture(t, ConversationAgent.Copilot, ConversationSurface.Native)
  await writeHistory(path.join(fixture.root, ".copilot"), ConversationAgent.Copilot, fixture.cwd, [
    humanRecord(ConversationAgent.Copilot, "wrong-human", "WRONG_SYNTHETIC_SOURCE"),
    assistantRecord(ConversationAgent.Copilot, "wrong-assistant", "WRONG_SYNTHETIC_RESULT"),
  ])
  const snapshot = await captureFocusedConversation(fixture.context, fixture.dependencies)
  assert.equal(snapshot.messages[0]?.text, "Synthetic human goal")
  assert.equal(snapshot.source.profile, "fixture-profile")
})

test("freshness changes for new visible activity but not tool output, without disclosing text", async (t) => {
  const fixture = await captureFixture(t)
  await writeFile(fixture.transcriptPath, jsonl(fixture.records.slice(0, 3)))
  const previous = await captureFocusedConversation(fixture.context, fixture.dependencies)
  await appendFile(fixture.transcriptPath, jsonl([{ type: "tool.execution_complete", data: { output: "INTERNAL_ONLY" } }]))
  const unchanged = await captureFocusedConversation(fixture.context, fixture.dependencies)
  assert.equal(unchanged.revision, previous.revision)
  await appendFile(fixture.transcriptPath, jsonl([humanRecord(ConversationAgent.Copilot, "next", "PRIVATE_SYNTHETIC_INPUT")]))
  const current = await captureFocusedConversation(fixture.context, fixture.dependencies)
  const result = await checkConversationSource(previous, { capture: async () => current })
  assert.equal(result.sameSource, true)
  assert.equal(result.advanced, true)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SYNTHETIC_INPUT|Synthetic human goal/)
})

test("an aborted capture makes no source request", async (t) => {
  const fixture = await captureFixture(t)
  const controller = new AbortController()
  controller.abort()
  let called = false
  await assert.rejects(captureFocusedConversation(fixture.context, {
    ...fixture.dependencies, signal: controller.signal,
    getAgentForPane: async () => { called = true; return fixture.agentInfo },
  }), { name: "AbortError" })
  assert.equal(called, false)
})
