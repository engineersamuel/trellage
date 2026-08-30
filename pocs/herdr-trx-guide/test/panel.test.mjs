import assert from "node:assert/strict"
import test from "node:test"

import {
  invokeGuideChoice,
  orderedSourceChoices,
  panelInvocationSource,
  sourcePickerStatus,
} from "../custom-popup.mjs"
import { ExactCaptureUnavailableError } from "../lib/capture.mjs"
import { inspectCaptureOptions, selectedTextChoice } from "../lib/capture-options.mjs"

const context = {
  workspaceId: "w1",
  paneId: "w1:p1",
  cwd: "/repo",
}

test("puts focused-pane captures before unrelated clipboard text", () => {
  const choices = orderedSourceChoices(
    [{ kind: "terminal", paneId: "w1:p1", preview: "Current pane result" }],
    "Old clipboard text",
  )
  assert.deepEqual(choices.map((choice) => choice.kind), ["terminal", "selection"])
  assert.equal(choices[0].preview, "Current pane result")
})

test("shows all capture diagnostics when no exact result is available", () => {
  assert.equal(
    sourcePickerStatus("", ["No exact session identity.", "Terminal snapshot is truncated."], ""),
    "No exact session identity. Terminal snapshot is truncated.",
  )
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

test("offers exact and explicitly labeled terminal choices for each completed agent", async () => {
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
      mode === "exact"
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
  assert.match(result.choices[1].detail, /Not exact/)
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
      if (mode === "exact") throw new ExactCaptureUnavailableError()
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
