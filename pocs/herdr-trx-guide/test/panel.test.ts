import assert from "node:assert/strict"
import test from "node:test"

import {
  invokeGuideChoice,
  orderedSourceChoices,
  panelInvocationSource,
  sourcePickerStatus,
  waitForCaptureQueueGrowth,
} from "../custom-popup.ts"
import { ExactCaptureUnavailableError } from "../lib/capture.ts"
import { inspectCaptureOptions, selectedTextChoice } from "../lib/capture-options.ts"

const context = {
  workspaceId: "w1",
  paneId: "w1:p1",
  cwd: "/repo",
}

test("puts highlighted text before exact results and the capture queue last", () => {
  const choices = orderedSourceChoices(
    [{ kind: "exact", paneId: "w1:p1", preview: "Current pane result" }],
    "Highlighted text",
    { schemaVersion: 1, entries: [{ id: "one", answer: "Previously queued text" }] },
  )
  assert.deepEqual(choices.map((choice) => choice.kind), ["selection", "exact", "queue"])
  assert.equal(choices[0].preview, "Highlighted text")
  assert.equal(choices[2].label, "Open capture queue in trx guide (1)")
})

test("marks a selected source for enqueue without putting text in action context", async () => {
  let written
  const calls = []
  await invokeGuideChoice({
    choice: selectedTextChoice("Queued highlighted text"),
    operation: "enqueue",
    context,
    stateDir: "/plugin-state",
    choiceWriter: async (_stateDir, value) => {
      written = value
      return "trellage-guide-choice:v1:55555555-5555-4555-8555-555555555555"
    },
    request: async (method, params) => calls.push({ method, params }),
  })
  assert.deepEqual(written, {
    schemaVersion: 1,
    kind: "selection",
    operation: "enqueue",
    selectedText: "Queued highlighted text",
  })
  assert.equal(calls[0].params.context.selected_text.includes("Queued highlighted text"), false)
})

test("shows all capture diagnostics when no exact result is available", () => {
  assert.equal(
    sourcePickerStatus("", ["No exact session identity.", "Terminal snapshot is truncated."], ""),
    "No exact session identity. Terminal snapshot is truncated.",
  )
})

test("waits for an asynchronously invoked action to persist the queued capture", async () => {
  let calls = 0
  const queue = await waitForCaptureQueueGrowth("/plugin-state", 1, async () => {
    calls += 1
    return {
      schemaVersion: 1,
      entries: calls < 3 ? [{ id: "one", answer: "First" }] : [
        { id: "one", answer: "First" },
        { id: "two", answer: "Second" },
      ],
    }
  })
  assert.equal(calls, 3)
  assert.equal(queue.entries.length, 2)
})

test("invokes the guide action with highlighted text and source context", async () => {
  const calls = []
  const selection = "界".repeat(60_000)
  const choiceToken = "trellage-guide-choice:v1:11111111-1111-4111-8111-111111111111"
  await invokeGuideChoice({
    choice: selectedTextChoice(selection),
    context,
    stateDir: "/plugin-state",
    request: async (method, params) => calls.push({ method, params }),
    choiceWriter: async (stateDir, value) => {
      assert.equal(stateDir, "/plugin-state")
      assert.deepEqual(value, {
        schemaVersion: 1,
        kind: "selection",
        selectedText: selection,
      })
      return choiceToken
    },
  })
  assert.deepEqual(calls, [
    {
      method: "plugin.action.invoke",
      params: {
        action_id: "trellage.guide-handoff.open",
        context: {
          workspace_id: "w1",
          focused_pane_id: "w1:p1",
          focused_pane_cwd: "/repo",
          invocation_source: panelInvocationSource,
          selected_text: choiceToken,
        },
      },
    },
  ])
  assert.deepEqual(Object.keys(calls[0].params.context).sort(), [
    "focused_pane_cwd",
    "focused_pane_id",
    "invocation_source",
    "selected_text",
    "workspace_id",
  ])
  assert.ok(JSON.stringify(calls[0].params.context).length < 1024)
})

test("invokes the latest-result path without clipboard text", async () => {
  const calls = []
  const choiceToken = "trellage-guide-choice:v1:22222222-2222-4222-8222-222222222222"
  await invokeGuideChoice({
    choice: {
      kind: "exact",
      paneId: "w1:p2",
      stateChangeSeq: 12,
      sessionId: "session-1",
    },
    context,
    stateDir: "/plugin-state",
    request: async (method, params) => calls.push({ method, params }),
    choiceWriter: async (stateDir, value) => {
      assert.equal(stateDir, "/plugin-state")
      assert.deepEqual(value, {
        schemaVersion: 1,
        kind: "exact",
        paneId: "w1:p2",
        stateChangeSeq: 12,
        sessionId: "session-1",
      })
      return choiceToken
    },
  })
  assert.equal(calls[0].params.context.selected_text, choiceToken)
  assert.equal(calls[0].params.context.invocation_source, panelInvocationSource)
  assert.equal(calls[0].params.context.source_pane_id, undefined)
  assert.equal(calls[0].params.context.capture_mode, undefined)
  assert.equal(calls[0].params.context.expected_session_id, undefined)
  assert.equal(calls[0].params.context.expected_state_change_seq, undefined)
})

test("serializes a conversation choice with exact revalidation fields", async () => {
  let written
  await invokeGuideChoice({
    choice: {
      kind: "conversation",
      paneId: "w1:p2",
      stateChangeSeq: 13,
      sessionId: "session-2",
    },
    context,
    stateDir: "/plugin-state",
    request: async () => undefined,
    choiceWriter: async (_stateDir, value) => {
      written = value
      return "trellage-guide-choice:v1:66666666-6666-4666-8666-666666666666"
    },
  })

  assert.deepEqual(written, {
    schemaVersion: 1,
    kind: "conversation",
    paneId: "w1:p2",
    stateChangeSeq: 13,
    sessionId: "session-2",
  })
})

test("invokes an explicit terminal snapshot path", async () => {
  const calls = []
  const choiceToken = "trellage-guide-choice:v1:33333333-3333-4333-8333-333333333333"
  await invokeGuideChoice({
    choice: {
      kind: "terminal",
      paneId: "w1:p3",
      stateChangeSeq: 14,
    },
    context,
    stateDir: "/plugin-state",
    request: async (method, params) => calls.push({ method, params }),
    choiceWriter: async (_stateDir, value) => {
      assert.deepEqual(value, {
        schemaVersion: 1,
        kind: "terminal",
        paneId: "w1:p3",
        stateChangeSeq: 14,
      })
      return choiceToken
    },
  })
  assert.equal(calls[0].params.context.selected_text, choiceToken)
  assert.equal(calls[0].params.context.capture_mode, undefined)
  assert.equal(calls[0].params.context.source_pane_id, undefined)
})

test("removes the private choice when Herdr rejects action invocation", async () => {
  const removed = []
  const choiceToken = "trellage-guide-choice:v1:44444444-4444-4444-8444-444444444444"
  await assert.rejects(
    invokeGuideChoice({
      choice: selectedTextChoice("Highlighted text"),
      context,
      stateDir: "/plugin-state",
      request: async () => {
        throw new Error("request failed")
      },
      choiceWriter: async () => choiceToken,
      choiceRemover: async (stateDir, token) => removed.push({ stateDir, token }),
    }),
    /request failed/u,
  )
  assert.deepEqual(removed, [{ stateDir: "/plugin-state", token: choiceToken }])
})

test("offers conversation, exact result, and explicitly labeled terminal choices", async () => {
  const result = await inspectCaptureOptions(context, {
    candidateResolver: async () => [
      {
        workspace_id: "w1",
        pane_id: "w1:p2",
        agent: "copilot",
        agent_status: "done",
        state_change_seq: 12,
      },
    ],
    processReader: async () => ({ foreground_processes: [] }),
    capture: async ({ mode }) =>
      mode === "conversation"
        ? {
            answer: "Conversation transcript",
            source: "conversation-transcript",
            confidence: "exact",
            sessionId: "session-1",
            messageCount: 4,
            omittedMessageCount: 1,
          }
        : mode === "exact"
        ? {
            answer: "Exact answer",
            source: "transcript",
            confidence: "exact",
            sessionId: "session-1",
          }
        : {
            answer: "Terminal screen",
            source: "terminal",
            confidence: "snapshot",
          },
  })

  assert.deepEqual(
    result.choices.map((choice) => ({
      kind: choice.kind,
      label: choice.label,
      preview: choice.preview,
    })),
    [
      {
        kind: "conversation",
        label: "Open current Copilot conversation",
        preview: "Conversation transcript",
      },
      {
        kind: "exact",
        label: "Open exact Copilot result",
        preview: "Exact answer",
      },
      {
        kind: "terminal",
        label: "Open Copilot terminal snapshot",
        preview: "Terminal screen",
      },
    ],
  )
  assert.match(result.choices[0].detail, /4 recent messages, 1 older omitted/u)
  assert.match(result.choices[2].detail, /Not exact/u)
})

test("keeps terminal capture explicit when exact identity is unavailable", async () => {
  const result = await inspectCaptureOptions(context, {
    candidateResolver: async () => [
      {
        workspace_id: "w1",
        pane_id: "w1:p2",
        agent: "codex",
        agent_status: "done",
        state_change_seq: 15,
      },
    ],
    processReader: async () => ({ foreground_processes: [] }),
    capture: async ({ mode }) => {
      if (mode === "exact" || mode === "conversation") throw new ExactCaptureUnavailableError()
      return {
        answer: "Visible terminal output",
        source: "terminal",
        confidence: "snapshot",
      }
    },
  })

  assert.deepEqual(result.choices.map((choice) => choice.kind), ["terminal"])
  assert.match(result.choices[0].detail, /Not exact/u)
  assert.match(result.notes[0], /no exact session identity/u)
})
