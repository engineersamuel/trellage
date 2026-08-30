import assert from "node:assert/strict"
import test from "node:test"

import { captureFinalAnswer } from "../lib/capture.mjs"
import {
  assertCompletedAgent,
  guideIntentMaximumLength,
  parseInvocationContext,
  parsePanelChoice,
  validateAnswer,
} from "../lib/context.mjs"

const context = {
  workspaceId: "w1",
  paneId: "w1:p1",
  cwd: "/repo",
}

const doneAgent = {
  workspace_id: "w1",
  pane_id: "w1:p1",
  agent: "copilot",
  agent_status: "done",
  state_change_seq: 7,
  cwd: "/repo",
}

test("parses a multiline selected-text invocation", () => {
  const parsed = parseInvocationContext(
    JSON.stringify({
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused_pane_id: "w1:p1",
      focused_pane_cwd: "/repo",
      focused_pane_agent: "copilot",
      selected_text: "First line\n\nSecond line",
      invocation_source: "trellage-guide-panel",
    }),
  )
  assert.equal(parsed.selectedText, "First line\n\nSecond line")
  assert.equal(parsed.tabId, "w1:t1")
  assert.equal(parsed.agent, "copilot")
  assert.equal(parsed.invocationSource, "trellage-guide-panel")
})

test("parses private source-picker choices", () => {
  assert.deepEqual(
    parsePanelChoice({
      schemaVersion: 1,
      kind: "selection",
      selectedText: "Highlighted\ntext",
    }),
    {
      kind: "selection",
      selectedText: "Highlighted\ntext",
    },
  )
  assert.deepEqual(
    parsePanelChoice({
      schemaVersion: 1,
      kind: "exact",
      paneId: "w1:p2",
      stateChangeSeq: 9,
      sessionId: "session-1",
    }),
    {
      kind: "exact",
      sourcePaneId: "w1:p2",
      captureMode: "exact",
      expectedSessionId: "session-1",
      expectedStateChangeSeq: 9,
    },
  )
  assert.throws(
    () =>
      parsePanelChoice({
        schemaVersion: 1,
        kind: "exact",
        paneId: "w1:p2",
        stateChangeSeq: 9,
      }),
    /session id is missing/u,
  )
})

test("accepts done or matching seen-idle completion state", () => {
  assert.doesNotThrow(() => assertCompletedAgent(doneAgent, null))
  assert.doesNotThrow(() =>
    assertCompletedAgent(
      { ...doneAgent, agent_status: "idle" },
      {
        schemaVersion: 1,
        paneId: "w1:p1",
        agent: "copilot",
        stateChangeSeq: 7,
      },
    ),
  )
  assert.throws(
    () =>
      assertCompletedAgent(
        { ...doneAgent, agent_status: "idle" },
        { schemaVersion: 1, paneId: "w1:p1", agent: "copilot", stateChangeSeq: 6 },
      ),
    /recorded completed/,
  )
})

test("enforces the shared multiline answer boundary", () => {
  assert.equal(validateAnswer(`\n${"a".repeat(guideIntentMaximumLength)}\n`, "Answer").length, guideIntentMaximumLength)
  assert.throws(() => validateAnswer("a".repeat(guideIntentMaximumLength + 1), "Answer"), /at most 60000/)
  assert.equal(
    [...validateAnswer("😀".repeat(guideIntentMaximumLength), "Answer")].length,
    guideIntentMaximumLength,
  )
  assert.throws(() => validateAnswer("😀".repeat(guideIntentMaximumLength + 1), "Answer"), /at most 60000/)
  assert.throws(() => validateAnswer("bad\u0000answer", "Answer"), /control/)
})

test("selected text has priority over transcript and terminal output", async () => {
  let structuredCalled = false
  let terminalCalled = false
  const result = await captureFinalAnswer({
    context: { ...context, selectedText: "Selected\nanswer" },
    agentInfo: undefined,
    structuredLookup: async () => {
      structuredCalled = true
      return { text: "Transcript", sessionId: "session" }
    },
    terminalReader: async () => {
      terminalCalled = true
      return { text: "Terminal", truncated: false }
    },
  })
  assert.deepEqual(result, {
    answer: "Selected\nanswer",
    source: "selection",
    confidence: "user-selected",
  })
  assert.equal(structuredCalled, false)
  assert.equal(terminalCalled, false)
})

test("uses a structured final message before terminal fallback", async () => {
  const result = await captureFinalAnswer({
    context,
    agentInfo: doneAgent,
    marker: null,
    processInfo: {},
    structuredLookup: async () => ({
      text: "Structured\nanswer",
      sessionId: "session-1",
      identitySource: "herdr-session-id",
    }),
    terminalReader: async () => {
      throw new Error("terminal should not be read")
    },
  })
  assert.deepEqual(result, {
    answer: "Structured\nanswer",
    source: "transcript",
    confidence: "exact",
    agent: "copilot",
    sessionId: "session-1",
    identitySource: "herdr-session-id",
  })
})

test("does not replace an oversized structured answer with terminal fallback", async () => {
  let terminalCalled = false
  await assert.rejects(
    captureFinalAnswer({
      context,
      agentInfo: doneAgent,
      marker: null,
      processInfo: {},
      structuredLookup: async () => ({
        text: "a".repeat(guideIntentMaximumLength + 1),
        sessionId: "session-1",
      }),
      terminalReader: async () => {
        terminalCalled = true
        return { text: "Short terminal text", truncated: false }
      },
    }),
    /at most 60000/,
  )
  assert.equal(terminalCalled, false)
})

test("requires explicit terminal capture and rejects truncated output", async () => {
  const base = {
    context,
    agentInfo: doneAgent,
    marker: null,
    processInfo: {},
    structuredLookup: async () => undefined,
  }
  assert.deepEqual(
    await captureFinalAnswer({
      ...base,
      mode: "terminal",
      terminalReader: async () => ({ text: "Terminal\nanswer", truncated: false }),
    }),
    {
      answer: "Terminal\nanswer",
      source: "terminal",
      confidence: "snapshot",
      agent: "copilot",
    },
  )
  await assert.rejects(
    captureFinalAnswer({
      ...base,
      mode: "terminal",
      terminalReader: async () => ({ text: "Partial", truncated: true }),
    }),
    /truncated/,
  )
})

test("does not silently replace a missing exact session with terminal output", async () => {
  let terminalCalled = false
  await assert.rejects(
    captureFinalAnswer({
      context,
      agentInfo: doneAgent,
      marker: null,
      processInfo: {},
      structuredLookup: async () => undefined,
      terminalReader: async () => {
        terminalCalled = true
        return { text: "Terminal", truncated: false }
      },
    }),
    /No exact session identity/,
  )
  assert.equal(terminalCalled, false)
})
