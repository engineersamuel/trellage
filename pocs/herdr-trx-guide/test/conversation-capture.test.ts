import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFile, link, open, rename, symlink, truncate, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import {
  bindFocusedConversation, captureFocusedConversation, focusedConversationChoice,
} from "../lib/conversation-capture.ts"
import { parseConversationRecords } from "../lib/conversation-parser.ts"
import { conversationCapturePolicy, validateConversationCapturePolicy } from "../lib/conversation-policy.ts"
import { ConversationSourceError, readStableConversationRecords } from "../lib/conversation-reader.ts"
import { captureSandboxConversation } from "../lib/sandbox-bridge.ts"
import { checkConversationSource } from "../conversation-source.ts"
import {
  assistantRecord, captureFixture, humanRecord, jsonl,
  metadataRecord, sessionId, writeHarnessHistory,
} from "./helpers/conversation-fixtures.ts"

const parse = (agent, records, cwd = "/repo") => parseConversationRecords(
  agent, records.map((value, recordIndex) => ({ value, recordIndex })), { sessionId, cwd },
)

for (const agent of ["copilot", "codex", "claude"]) {
  for (const surface of ["host", "native"]) {
    test(`${surface} ${agent} captures only the focused exact conversation while working`, async (t) => {
      const fixture = await captureFixture(t, agent, surface)
      const binding = await bindFocusedConversation(fixture.context, fixture.dependencies)
      const snapshot = await captureFocusedConversation({ ...fixture.context, binding }, fixture.dependencies)
      assert.deepEqual(snapshot.messages.map(({ role, text }) => ({ role, text })), [
        { role: "user", text: "Original human goal" },
        { role: "assistant", text: "Completed visible answer" },
      ])
      assert.equal(snapshot.source.surface, surface)
      assert.equal(snapshot.source.sessionId, sessionId)
      assert.equal(snapshot.source.paneId, fixture.context.paneId)
      assert.equal(snapshot.source.profile, surface === "native" ? "fixture-profile" : undefined)
      assert.deepEqual(snapshot.cutoff, {
        messageId: snapshot.messages[1].id, recordIndex: snapshot.messages[1].recordIndex,
      })
      assert.match(snapshot.coverage.notices.join(" "), /Newer user-visible/u)
      assert.equal(snapshot.coverage.complete, true)
      assert.ok(fixture.agentInfo.state_change_seq > 1)
      assert.ok(snapshot.messages.every((message) => /^msg-[a-f0-9]{64}$/u.test(message.id)))
      const second = await captureFocusedConversation(fixture.context, fixture.dependencies)
      assert.deepEqual(snapshot.messages, second.messages)
      assert.equal(snapshot.revision, second.revision)
      assert.notEqual(snapshot.id, second.id)
    })
  }

  test(`${agent} preserves repeated human text but deduplicates exact event identities`, () => {
    const first = humanRecord(agent, "one", "Please explain again")
    const records = [
      metadataRecord(agent, "/repo"), first, first,
      humanRecord(agent, "two", "Please explain again"),
      assistantRecord(agent, "answer", "Explanation"),
    ]
    const result = parse(agent, records)
    assert.deepEqual(result.messages.map((message) => message.text), [
      "Please explain again", "Please explain again", "Explanation",
    ])
    assert.notEqual(result.messages[0].id, result.messages[1].id)
  })

  test(`${agent} refuses conflicting record IDs and absent completion`, () => {
    const first = humanRecord(agent, "one", "First")
    assert.throws(() => parse(agent, [
      first, humanRecord(agent, "one", "Changed"), assistantRecord(agent, "answer", "Done"),
    ]), /identity|ID/u)
    assert.throws(() => parse(agent, [
      humanRecord(agent, "one", "Question"), assistantRecord(agent, "partial", "Still working", false),
    ]), /no unambiguous completed/u)
  })
}

test("Copilot excludes tools, nested traffic, internal users, reasoning, and commentary", () => {
  const records = [
    humanRecord("copilot", "human", "Human request"),
    { type: "user.message", id: "internal", data: { source: "system", content: "Hidden instructions" } },
    { type: "assistant.reasoning", data: { content: "Hidden reasoning" } },
    { type: "assistant.message", id: "comment", data: { phase: "commentary", content: "Transient progress" } },
    { type: "assistant.message", id: "tool", data: { content: "Before tool", toolRequests: [{ name: "bash" }] } },
    { type: "tool.execution_complete", data: { result: "Hidden tool output" } },
    assistantRecord("copilot", "answer", "Visible answer"),
    { type: "session.task_complete", id: "complete", data: { summary: "Duplicate summary presentation" } },
    { type: "assistant.message", agentId: "child", data: { content: "Nested answer", phase: "final_answer" } },
    { type: "user.message", data: { parentToolCallId: "nested-tool", content: "Nested input" } },
  ]
  const result = parse("copilot", records)
  assert.deepEqual(result.messages.map((message) => message.text), ["Human request", "Visible answer"])
})

test("Copilot supports legacy turn-end and task-completion records without a false partial cutoff", () => {
  const result = parse("copilot", [
    humanRecord("copilot", "one", "Question"),
    assistantRecord("copilot", "plain", "Legacy final", false),
    { type: "assistant.turn_end" },
    humanRecord("copilot", "two", "Next question"),
    { type: "session.task_complete", id: "completed", data: { summary: "Completion answer" } },
    assistantRecord("copilot", "display", "Final presentation"),
    humanRecord("copilot", "pending", "Do more"),
  ])
  assert.deepEqual(result.messages.map((message) => message.text), [
    "Question", "Legacy final", "Next question", "Final presentation",
  ])
})

test("Codex ignores internal wrappers, mirrored assistant events, and commentary", () => {
  const internalUser = humanRecord("codex", "injected", "Hidden repository instructions")
  internalUser.payload.internal_chat_message_metadata_passthrough.content_item_kinds = ["agents_md.instructions"]
  const commentary = assistantRecord("codex", "progress", "Working")
  commentary.payload.phase = "commentary"
  const result = parse("codex", [
    metadataRecord("codex", "/repo"), internalUser, humanRecord("codex", "human", "Human request"),
    commentary, { type: "response_item", payload: { type: "reasoning", text: "Hidden thinking" } },
    { type: "event_msg", payload: { type: "agent_message", message: "Display copy" } },
    assistantRecord("codex", "answer", "Visible final"),
    { type: "event_msg", payload: { type: "agent_message", message: "Display copy" } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: "Display copy" } },
    { type: "response_item", agentId: "child", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Nested answer" }] } },
  ])
  assert.deepEqual(result.messages.map((message) => message.text), ["Human request", "Visible final"])
})

test("Codex supports event-only legacy user/final records with a task-complete boundary", () => {
  const result = parse("codex", [
    metadataRecord("codex", "/repo"),
    { type: "event_msg", id: "human", payload: { type: "user_message", message: "Legacy human" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Untrusted wrapper" }] } },
    { type: "event_msg", id: "assistant", payload: { type: "agent_message", message: "Legacy final" } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ])
  assert.deepEqual(result.messages.map((message) => message.text), ["Legacy human", "Legacy final"])
  assert.throws(() => parse("codex", [
    { type: "session_meta", payload: { id: sessionId, cwd: "/repo", source: { subagent: {} } } },
  ]), /Nested Codex/u)
})

test("Codex preserves older event-only input when later records use explicit user metadata", () => {
  const first = [
    metadataRecord("codex", "/repo"),
    { type: "event_msg", id: "old-human", payload: { type: "user_message", message: "Old human goal" } },
    { type: "event_msg", id: "old-assistant", payload: { type: "agent_message", message: "Old answer" } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ]
  const modern = humanRecord("codex", "new-human", "New human question")
  const result = parse("codex", [
    ...first, modern,
    { type: "event_msg", payload: { type: "user_message", message_id: "new-human", message: "New human question" } },
    assistantRecord("codex", "new-assistant", "New answer"),
  ])
  assert.deepEqual(result.messages.map((message) => message.text), [
    "Old human goal", "Old answer", "New human question", "New answer",
  ])
})

test("Codex mixed input blocks exclude injected instructions and internal assistant channels", () => {
  const human = humanRecord("codex", "human", "unused")
  human.payload.content = [
    { type: "input_text", text: "Injected instructions" },
    { type: "input_text", text: "Actual human question" },
  ]
  human.payload.internal_chat_message_metadata_passthrough.content_item_kinds = [
    "agents_md.instructions", "user.text",
  ]
  const analysis = assistantRecord("codex", "reasoning", "Hidden reasoning", false)
  analysis.payload.channel = "analysis"
  const result = parse("codex", [
    human, analysis, { type: "event_msg", payload: { type: "task_complete" } },
    assistantRecord("codex", "answer", "Visible answer"),
  ])
  assert.deepEqual(result.messages.map((message) => message.text), ["Actual human question", "Visible answer"])
  human.payload.internal_chat_message_metadata_passthrough.content_item_kinds.push("skills.instructions")
  assert.throws(() => parse("codex", [human, assistantRecord("codex", "answer", "Visible")]), /cannot be separated/u)
})

test("Claude assembles fragments by message and record identity without text-based deduplication", () => {
  const fragment = (uuid, content, stop_reason = null) => ({
    type: "assistant", uuid, message: { id: "response", stop_reason, content },
  })
  const first = fragment("fragment-1", [{ type: "text", text: "Repeated visible text" }])
  const result = parse("claude", [
    humanRecord("claude", "human", "Human request"),
    { type: "user", isMeta: true, message: { content: "Hidden instructions" } },
    { type: "user", message: { content: [{ type: "text", text: "Hidden tool wrapper" }, { type: "tool_result", content: "Hidden output" }] } },
    { type: "assistant", isSidechain: true, message: { id: "nested", content: [{ type: "text", text: "Nested answer" }], stop_reason: "end_turn" } },
    first, first, fragment("fragment-2", [{ type: "text", text: "Repeated visible text" }]),
    fragment("fragment-final", [], "end_turn"),
    assistantRecord("claude", "pending", "Incomplete later message", false),
  ])
  assert.deepEqual(result.messages.map((message) => message.text), [
    "Human request", "Repeated visible text\nRepeated visible text",
  ])
  assert.equal(result.cutoff.recordIndex, 7)
})

test("Claude cannot extend a completed cutoff with a later unfinished fragment", () => {
  const result = parse("claude", [
    humanRecord("claude", "first-human", "First question"),
    assistantRecord("claude", "first-answer", "First completed answer"),
    humanRecord("claude", "second-human", "Second question"),
    assistantRecord("claude", "second-answer", "Initial presentation"),
    {
      type: "assistant", uuid: "later-fragment",
      message: { id: "second-answer", stop_reason: null, content: [{ type: "text", text: "Still incomplete" }] },
    },
  ])
  assert.deepEqual(result.messages.map((message) => message.text), ["First question", "First completed answer"])
  assert.match(result.coverage.notices.join(" "), /Newer user-visible/u)
})

test("Claude rejects whitespace-only assistant message IDs without trimming valid IDs", () => {
  const human = humanRecord("claude", "human", "Human request")
  for (const id of ["", " ", "\t\r\n", "\u00a0", "\u0085", "\u001c\u001d\u001e\u001f", "\u2003", "\ufeff"]) {
    assert.throws(() => parse("claude", [
      human, assistantRecord("claude", id, "Completed answer"),
    ]), /stable message ID/u)
  }
  const id = " answer-\u03bb-\ud83d\ude00 "
  const result = parse("claude", [human, assistantRecord("claude", id, "Completed answer")])
  assert.equal(result.messages[1].id, `msg-${createHash("sha256")
    .update(JSON.stringify(["claude", sessionId, "assistant", id])).digest("hex")}`)
})

test("capture rejects malformed Unicode identities and event metadata without disclosing their values", async (t) => {
  const invalidUnicode = (error: unknown) => {
    assert.ok(error instanceof ConversationSourceError)
    assert.match(error.message, /Unicode/u)
    assert.doesNotMatch(error.message, /PRIVATE/u)
    return true
  }
  for (const agent of ["copilot", "codex", "claude"]) {
    const fixture = await captureFixture(t, agent)
    const answer = assistantRecord(agent, "answer", "Completed answer")
    for (const invalid of [
      assistantRecord(agent, "PRIVATE-\ud800", "Completed answer"),
      { ...answer, metadata: { label: "PRIVATE-\ud800" } },
      { ...answer, metadata: { ["PRIVATE-\udc00"]: "hidden metadata" } },
    ]) {
      const records = [...fixture.records.slice(0, 2), invalid]
      assert.throws(() => parse(agent, records, fixture.cwd), invalidUnicode)
      await writeFile(fixture.transcriptPath, jsonl(records))
      await assert.rejects(captureFocusedConversation(fixture.context, fixture.dependencies), invalidUnicode)
    }
  }
})

test("Copilot legacy top-level content still requires a completion boundary", () => {
  const result = parse("copilot", [
    { type: "user.message", id: "human", content: "Top-level human request" },
    { type: "assistant.message", id: "assistant", content: "Top-level final answer" },
    { type: "session.idle" },
  ])
  assert.deepEqual(result.messages.map((message) => message.text), [
    "Top-level human request", "Top-level final answer",
  ])
})

test("reports compaction and absent attachment contents without treating summaries as human history", () => {
  const result = parse("claude", [
    { type: "user", isCompactSummary: true, message: { content: "Synthetic older-history summary" } },
    { type: "user", uuid: "human", message: { content: [{ type: "text", text: "Use the image" }, { type: "image", source: { data: "not-read" } }] } },
    assistantRecord("claude", "answer", "Done"),
  ])
  assert.equal(result.coverage.complete, false)
  assert.match(result.coverage.notices.join(" "), /compaction/u)
  assert.match(result.coverage.notices.join(" "), /Attachment/u)
  assert.equal(result.messages[0].text, "Use the image")
})

for (const agent of ["copilot", "codex", "claude"]) {
test(`${agent} full capture preserves a goal before 8 MiB and more than 60,000 visible characters`, async (t) => {
  const fixture = await captureFixture(t, agent)
  const longAnswer = "界".repeat(70_001)
  await writeFile(fixture.transcriptPath, jsonl([
    metadataRecord(agent, fixture.cwd),
    humanRecord(agent, "original", "Original goal beyond the legacy tail"),
    { type: "tool.execution_complete", data: { output: "x".repeat(9 * 1024 * 1024) } },
    assistantRecord(agent, "final", longAnswer),
  ]))
  const snapshot = await captureFocusedConversation(fixture.context, fixture.dependencies)
  assert.equal(snapshot.messages[0].text, "Original goal beyond the legacy tail")
  assert.equal(snapshot.messages[1].text, longAnswer)
  assert.equal(snapshot.coverage.complete, true)
  assert.doesNotMatch(snapshot.coverage.notices.join(" "), /older omitted/u)
})
}

test("stable reader accepts append-only growth and discloses one incomplete trailing record", async (t) => {
  const fixture = await captureFixture(t)
  const source = jsonl(fixture.records.slice(0, 3))
  await writeFile(fixture.transcriptPath, `${source}{"type":"user.message","data":`)
  const read = await readStableConversationRecords(fixture.transcriptPath, [fixture.home], {
    afterPrefixRead: () => appendFile(fixture.transcriptPath, '{"content":"new"}}\n'),
  })
  assert.equal(read.records.length, 3)
  assert.match(read.notices.join(" "), /incomplete trailing/u)
  assert.deepEqual(parseConversationRecords("copilot", read.records, {
    sessionId, cwd: fixture.cwd,
  }).messages.map((message) => message.text), ["Original human goal", "Completed visible answer"])
})

test("reader rejects a changed prefix, replacement, and truncation instead of reading another tail", async (t) => {
  const fixture = await captureFixture(t)
  const original = jsonl(fixture.records)
  const operations = [
    async () => {
      const handle = await open(fixture.transcriptPath, "r+")
      try { await handle.write(Buffer.from("X"), 0, 1, 2) } finally { await handle.close() }
    },
    async () => {
      await rename(fixture.transcriptPath, `${fixture.transcriptPath}.previous`)
      await writeFile(fixture.transcriptPath, original, { mode: 0o600 })
    },
    () => truncate(fixture.transcriptPath, 1),
  ]
  for (const afterPrefixRead of operations) {
    await writeFile(fixture.transcriptPath, original)
    await assert.rejects(
      readStableConversationRecords(fixture.transcriptPath, [fixture.home], { afterPrefixRead }),
      /changed|replaced|truncated/u,
    )
  }
})

test("reader fails on malformed committed records, malformed tails, invalid UTF-8, and record budgets", async (t) => {
  const fixture = await captureFixture(t)
  for (const suffix of ['{"SECRET malformed":}\n', '{"SECRET malformed":}', '["not-an-object"]\n']) {
    await writeFile(fixture.transcriptPath, jsonl(fixture.records.slice(0, 3)) + suffix)
    await assert.rejects(readStableConversationRecords(fixture.transcriptPath, [fixture.home]), (error) => {
      assert.doesNotMatch(error.message, /SECRET/u)
      return /malformed|not an object/u.test(error.message)
    })
  }
  await writeFile(fixture.transcriptPath, Buffer.from([0xff, 0x0a]))
  await assert.rejects(readStableConversationRecords(fixture.transcriptPath, [fixture.home]), /UTF-8/u)
  await writeFile(fixture.transcriptPath, jsonl(fixture.records))
  await assert.rejects(readStableConversationRecords(fixture.transcriptPath, [fixture.home], {
    policy: { ...conversationCapturePolicy, maximumRecordBytes: 10 },
  }), /record byte limit/u)
  await assert.rejects(readStableConversationRecords(fixture.transcriptPath, [fixture.home], {
    policy: { ...conversationCapturePolicy, maximumTranscriptBytes: 10 },
  }), /transcript byte limit/u)
})

test("never falls back from a shell or unknown exact identity to another agent or Native home", async (t) => {
  const fixture = await captureFixture(t)
  const unavailable = await focusedConversationChoice(fixture.context, {
    ...fixture.dependencies,
    getAgentForPane: async () => { throw new Error("No focused agent") },
  })
  assert.equal(unavailable.disabled, true)
  assert.match(unavailable.detail, /No other pane/u)
  fixture.agentInfo.agent_session = undefined
  fixture.processInfo.foreground_processes = []
  await assert.rejects(captureFocusedConversation(fixture.context, fixture.dependencies), /no exact session/u)
  const other = await captureFixture(t, "copilot", "native")
  other.agentInfo.tokens = undefined
  await assert.rejects(captureFocusedConversation(other.context, other.dependencies), /no supported session root/u)
})

test("Native capture ignores same-ID transcripts in host and other profile homes", async (t) => {
  const fixture = await captureFixture(t, "copilot", "native")
  const wrong = [
    metadataRecord("copilot", fixture.cwd), humanRecord("copilot", "wrong-user", "Wrong source"),
    assistantRecord("copilot", "wrong-answer", "Wrong answer"),
  ]
  await writeHarnessHistory(path.join(fixture.root, ".copilot"), "copilot", fixture.cwd, wrong)
  await writeHarnessHistory(path.join(fixture.root, ".local", "share", "trellage", "profiles", "copilot", "other", "home"), "copilot", fixture.cwd, wrong)
  const snapshot = await captureFocusedConversation(fixture.context, fixture.dependencies)
  assert.equal(snapshot.messages[0].text, "Original human goal")
  assert.equal(snapshot.source.profile, "fixture-profile")
})

test("revalidates exact source identity after capture without using changing activity sequences", async (t) => {
  const fixture = await captureFixture(t)
  let calls = 0
  await assert.rejects(captureFocusedConversation(fixture.context, {
    ...fixture.dependencies,
    getAgentForPane: async () => ({
      ...fixture.agentInfo, state_change_seq: ++calls,
      pane_id: calls === 1 ? fixture.context.paneId : "reused-pane",
    }),
  }), /original focused pane/u)
  fixture.processInfo.foreground_processes.push({
    name: "copilot", argv: ["copilot", "--session-id", "22222222-2222-4222-8222-222222222222"],
  })
  await assert.rejects(captureFocusedConversation(fixture.context, fixture.dependencies), /Conflicting exact process/u)
})

test("rejects symlink and hardlink transcript substitution", async (t) => {
  const fixture = await captureFixture(t)
  const alias = `${fixture.transcriptPath}.alias`
  await symlink(fixture.transcriptPath, alias)
  await assert.rejects(readStableConversationRecords(alias, [fixture.home]), /symbolic links/u)
  const hard = `${fixture.transcriptPath}.hard`
  await link(fixture.transcriptPath, hard)
  await assert.rejects(readStableConversationRecords(fixture.transcriptPath, [fixture.home]), /owned regular file/u)
})

test("meaningful activity advances freshness while tool-only appends do not", async (t) => {
  const fixture = await captureFixture(t)
  await writeFile(fixture.transcriptPath, jsonl(fixture.records.slice(0, 3)))
  const before = await captureFocusedConversation(fixture.context, fixture.dependencies)
  await appendFile(fixture.transcriptPath, jsonl([{ type: "tool.execution_complete", data: { result: "Internal only" } }]))
  const toolOnly = await captureFocusedConversation(fixture.context, fixture.dependencies)
  assert.equal(toolOnly.revision, before.revision)
  await appendFile(fixture.transcriptPath, jsonl([humanRecord("copilot", "later", "New human request")]))
  const after = await captureFocusedConversation(fixture.context, fixture.dependencies)
  assert.deepEqual(after.cutoff, before.cutoff)
  assert.notEqual(after.revision, before.revision)
  const status = await checkConversationSource(before, { capture: async () => after })
  assert.equal(status.sameSource, true)
  assert.equal(status.advanced, true)
  assert.doesNotMatch(JSON.stringify(status), /New human request|Original human goal/u)
  const changed = await checkConversationSource(before, {
    capture: async () => ({ ...after, source: { ...after.source, sessionId: "another-session" } }),
  })
  assert.equal(changed.sameSource, false)
})

for (const agent of ["copilot", "codex", "claude"]) {
  test(`${agent} tool activity after an unfinished assistant record does not advance freshness`, async (t) => {
    const fixture = await captureFixture(t, agent)
    const before = await captureFocusedConversation(fixture.context, fixture.dependencies)
    const tool = agent === "copilot"
      ? { type: "tool.execution_start", data: {} }
      : agent === "codex"
        ? { type: "response_item", payload: { type: "function_call", name: "synthetic-tool", arguments: "{}" } }
        : {
            type: "assistant", uuid: "tool-fragment",
            message: {
              id: "assistant-2", stop_reason: "tool_use",
              content: [{ type: "tool_use", id: "synthetic-tool", name: "synthetic-tool" }],
            },
          }
    await appendFile(fixture.transcriptPath, jsonl([tool]))
    const after = await captureFocusedConversation(fixture.context, fixture.dependencies)
    assert.deepEqual(after.messages, before.messages)
    assert.equal(after.revision, before.revision)
  })
}

test("capture policy has finite validated independent byte and record limits", () => {
  assert.throws(() => validateConversationCapturePolicy({ ...conversationCapturePolicy, maximumRecords: Infinity }), /policy/u)
  assert.throws(() => validateConversationCapturePolicy({ ...conversationCapturePolicy, maximumRecordBytes: 0 }), /policy/u)
  assert.throws(() => validateConversationCapturePolicy({ ...conversationCapturePolicy, other: 1 }), /policy/u)
  assert.ok(conversationCapturePolicy.maximumTranscriptBytes > 8 * 1024 * 1024)
  assert.ok(conversationCapturePolicy.maximumTextBytes > 60_000)
})

test("normalized UTF-8 byte and message-count limits preserve exact boundaries without truncation", () => {
  const records = [
    humanRecord("copilot", "human", "界界界"),
    assistantRecord("copilot", "answer", "1"),
  ].map((value, recordIndex) => ({ value, recordIndex }))
  const policy = {
    ...conversationCapturePolicy, maximumMessageBytes: 9, maximumTextBytes: 10, maximumMessages: 2,
  }
  assert.equal(parseConversationRecords("copilot", records, { sessionId, cwd: "/repo", policy }).messages.length, 2)
  assert.throws(() => parseConversationRecords("copilot", records, {
    sessionId, cwd: "/repo", policy: { ...policy, maximumMessageBytes: 8 },
  }), /message byte limit/u)
  assert.throws(() => parseConversationRecords("copilot", records, {
    sessionId, cwd: "/repo", policy: { ...policy, maximumTextBytes: 9 },
  }), /capture budget/u)
  assert.throws(() => parseConversationRecords("copilot", records, {
    sessionId, cwd: "/repo", policy: { ...policy, maximumMessages: 1 },
  }), /capture budget/u)
})

test("cancellation fails before source reading without selecting another source", async (t) => {
  const fixture = await captureFixture(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(captureFocusedConversation(fixture.context, {
    ...fixture.dependencies, signal: controller.signal,
  }), /abort/u)
})

for (const agent of ["copilot", "codex", "claude"]) {
  test(`Sandbox ${agent} wraps bounded bridge pages without host fallback and tracks pending activity`, async (t) => {
    const fixture = await captureFixture(t, agent)
    const containerId = "a".repeat(64)
    const invocationId = "b".repeat(32)
    fixture.agentInfo.tokens = {
      trellage_surface: "sandbox", trellage_agent: agent, trellage_profile: "fixture-profile",
      trellage_container_id: containerId, trellage_invocation_id: invocationId, trellage_pgrp: "12345",
    }
    const messages = [
      { id: "user-evidence", role: "user", text: "Sandbox original goal", recordIndex: 1 },
      { id: "assistant-evidence", role: "assistant", text: "Sandbox completed answer", recordIndex: 4 },
    ]
    const revision = createHash("sha256").update(JSON.stringify(messages)).digest("hex")
    let activityRevision = "c".repeat(64)
    const operations = []
    const bridgeRunner = async ({ identity, operation, snapshotId }) => {
      operations.push(operation)
      assert.equal(identity.agent, agent)
      assert.equal(identity.sessionId, sessionId)
      assert.equal(identity.containerId, containerId)
      assert.equal(identity.invocationId, invocationId)
      const source = { schemaVersion: 1, agent, profile: "fixture-profile", containerId, invocationId, sessionId }
      if (operation === "release-conversation") {
        return JSON.stringify({ ...source, snapshotId, released: true })
      }
      assert.equal(operation, "export-conversation")
      return JSON.stringify({
        ...source, snapshotId: "d".repeat(64), capturedAt: "2026-09-10T00:00:00.000Z",
        cutoff: { messageId: "assistant-evidence", recordIndex: 4 },
        revision, activityRevision, coverage: { complete: true, notices: [] },
        messages, page: { index: 0, total: 1, nextCursor: null },
      })
    }
    const dependencies = {
      ...fixture.dependencies,
      transcriptResolver: async () => { throw new Error("Host transcript fallback must not run") },
      recordReader: async () => { throw new Error("Host transcript reading must not run") },
      sandboxLookup: (options) => captureSandboxConversation({ ...options, bridgeRunner }),
    }
    const choice = await focusedConversationChoice(fixture.context, dependencies)
    assert.equal(choice.disabled, false)
    assert.deepEqual(operations, [])
    const first = await captureFocusedConversation({ ...fixture.context, binding: choice.binding }, dependencies)
    assert.equal(first.source.surface, "sandbox")
    assert.equal(first.source.containerId, containerId)
    assert.equal(first.source.invocationId, invocationId)
    assert.deepEqual(first.messages, messages)
    assert.deepEqual(operations, ["export-conversation", "release-conversation"])
    activityRevision = "e".repeat(64)
    const next = await captureFocusedConversation(fixture.context, dependencies)
    assert.deepEqual(next.cutoff, first.cutoff)
    assert.notEqual(next.revision, first.revision)
    assert.equal((await checkConversationSource(first, { capture: async () => next })).advanced, true)
  })
}

test("Sandbox bridge failures do not substitute a host transcript or screen capture", async (t) => {
  const fixture = await captureFixture(t)
  fixture.agentInfo.tokens = {
    trellage_surface: "sandbox", trellage_agent: "copilot", trellage_profile: "fixture-profile",
    trellage_container_id: "a".repeat(64), trellage_invocation_id: "b".repeat(32), trellage_pgrp: "12345",
  }
  let hostReads = 0
  await assert.rejects(captureFocusedConversation(fixture.context, {
    ...fixture.dependencies,
    transcriptResolver: async () => { hostReads += 1; throw new Error("Must not run") },
    sandboxLookup: async () => { throw new Error("Unsupported bridge version") },
  }), /Unsupported bridge version/u)
  assert.equal(hostReads, 0)
})
