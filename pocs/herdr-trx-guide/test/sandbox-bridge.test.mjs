import assert from "node:assert/strict"
import test from "node:test"

import { captureFinalAnswer } from "../lib/capture.mjs"
import {
  captureSandboxFinalMessage,
  sandboxBridgeMaximumOutputBytes,
} from "../lib/sandbox-bridge.mjs"

const identity = {
  surface: "sandbox",
  agent: "claude",
  profile: "claude-research",
  invocationId: "a".repeat(32),
  containerId: "b".repeat(64),
}

test("parses an exact result from the Trellage Sandbox session bridge", async () => {
  const result = await captureSandboxFinalMessage({
    identity,
    bridgeRunner: async () =>
      JSON.stringify({
        version: 1,
        agent: "claude",
        profile: "claude-research",
        session_id: "11111111-1111-4111-8111-111111111111",
        answer: "Sandbox answer",
      }),
  })

  assert.deepEqual(result, {
    text: "Sandbox answer",
    source: "sandbox-transcript",
    agent: "claude",
    sessionId: "11111111-1111-4111-8111-111111111111",
    identitySource: "trellage-sandbox-bridge",
    profile: "claude-research",
  })
})

test("rejects mismatched Sandbox bridge output", async () => {
  await assert.rejects(
    captureSandboxFinalMessage({
      identity,
      bridgeRunner: async () =>
        JSON.stringify({
          version: 1,
          agent: "codex",
          profile: "claude-research",
          session_id: "session",
          answer: "Wrong agent",
        }),
    }),
    /mismatched session data/u,
  )
})

test("the bridge buffer holds a maximum-length unescaped Unicode answer", () => {
  const source = JSON.stringify({
    version: 1,
    agent: "claude",
    profile: "claude-research",
    session_id: "session",
    answer: "界".repeat(60_000),
  })
  assert.ok(Buffer.byteLength(source, "utf8") < sandboxBridgeMaximumOutputBytes)
})

test("capture uses the Sandbox bridge instead of host transcript discovery", async () => {
  let structuredCalled = false
  let bridgeCwd
  const result = await captureFinalAnswer({
    context: {
      paneId: "w1:p1",
      workspaceId: "w1",
      cwd: "/repo",
    },
    agentInfo: {
      pane_id: "w1:p1",
      workspace_id: "w1",
      cwd: "/repo",
      foreground_cwd: "/repo",
      agent: "claude",
      agent_status: "done",
      state_change_seq: 8,
      processInfo: { foreground_process_group_id: 5151 },
      tokens: {
        trellage_surface: "sandbox",
        trellage_agent: "claude",
        trellage_profile: "claude-research",
        trellage_invocation_id: "a".repeat(32),
        trellage_container_id: "b".repeat(64),
        trellage_pgrp: "5151",
      },
    },
    processInfo: { foreground_process_group_id: 5151 },
    structuredLookup: async () => {
      structuredCalled = true
      return undefined
    },
    sandboxLookup: async ({ cwd }) => {
      bridgeCwd = cwd
      return {
        text: "Exact Sandbox answer",
        source: "sandbox-transcript",
        sessionId: "22222222-2222-4222-8222-222222222222",
        identitySource: "trellage-sandbox-bridge",
        profile: "claude-research",
      }
    },
  })

  assert.equal(structuredCalled, false)
  assert.equal(bridgeCwd, "/repo")
  assert.deepEqual(result, {
    answer: "Exact Sandbox answer",
    source: "sandbox-transcript",
    confidence: "exact",
    agent: "claude",
    sessionId: "22222222-2222-4222-8222-222222222222",
    identitySource: "trellage-sandbox-bridge",
    profile: "claude-research",
  })
})

test("a resumed Sandbox session stays bound to the bridge and exact session", async () => {
  let structuredCalled = false
  let sandboxCalled = false
  const sessionId = "33333333-3333-4333-8333-333333333333"
  const result = await captureFinalAnswer({
    context: {
      paneId: "w1:p1",
      workspaceId: "w1",
      cwd: "/repo",
    },
    agentInfo: {
      pane_id: "w1:p1",
      workspace_id: "w1",
      cwd: "/repo",
      foreground_cwd: "/repo",
      agent: "claude",
      agent_status: "done",
      state_change_seq: 9,
      agent_session: {
        agent: "claude",
        kind: "id",
        value: sessionId,
      },
      tokens: {
        trellage_surface: "sandbox",
        trellage_agent: "claude",
        trellage_profile: "claude-research",
        trellage_invocation_id: "a".repeat(32),
        trellage_container_id: "b".repeat(64),
        trellage_pgrp: "5252",
      },
    },
    processInfo: { foreground_process_group_id: 5252 },
    structuredLookup: async () => {
      structuredCalled = true
      return undefined
    },
    sandboxLookup: async () => {
      sandboxCalled = true
      return {
        text: "Resumed Sandbox answer",
        source: "sandbox-transcript",
        sessionId,
        identitySource: "trellage-sandbox-bridge",
        profile: "claude-research",
      }
    },
  })

  assert.equal(structuredCalled, false)
  assert.equal(sandboxCalled, true)
  assert.equal(result.answer, "Resumed Sandbox answer")
  assert.equal(result.sessionId, sessionId)
})

test("a current direct harness session takes precedence over stale Trellage metadata", async () => {
  let receivedTokens
  const result = await captureFinalAnswer({
    context: {
      paneId: "w1:p1",
      workspaceId: "w1",
      cwd: "/repo",
    },
    agentInfo: {
      pane_id: "w1:p1",
      workspace_id: "w1",
      cwd: "/repo",
      foreground_cwd: "/repo",
      agent: "claude",
      agent_status: "done",
      state_change_seq: 9,
      agent_session: {
        agent: "claude",
        kind: "id",
        value: "33333333-3333-4333-8333-333333333333",
      },
      tokens: {
        trellage_surface: "sandbox",
        trellage_agent: "claude",
        trellage_profile: "claude-research",
        trellage_invocation_id: "a".repeat(32),
        trellage_container_id: "b".repeat(64),
      },
    },
    structuredLookup: async ({ tokens }) => {
      receivedTokens = tokens
      return {
        text: "Current direct answer",
        source: "transcript",
        sessionId: "33333333-3333-4333-8333-333333333333",
        identitySource: "herdr-session-id",
      }
    },
    sandboxLookup: async () => {
      throw new Error("stale Sandbox metadata was used")
    },
  })

  assert.deepEqual(receivedTokens, {})
  assert.equal(result.answer, "Current direct answer")
})
