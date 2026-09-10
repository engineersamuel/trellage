import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"
import test from "node:test"

import { captureAgentContent } from "../lib/capture.ts"
import { parseConversationRecords } from "../lib/conversation-parser.ts"
import {
  captureSandboxFinalMessage,
  captureSandboxConversation,
  describeSandboxConversation,
  releaseSandboxConversation,
  runSandboxConversationProcess,
  sandboxBridgeMaximumOutputBytes,
  sandboxConversationMaximumOutputBytes,
} from "../lib/sandbox-bridge.ts"

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
  const result = await captureAgentContent({
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
  const result = await captureAgentContent({
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
  const result = await captureAgentContent({
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

const conversationSessionId = "11111111-1111-4111-8111-111111111111"
const conversationSnapshotId = "c".repeat(64)
const conversationMessages = [
  { id: "m-user-1", role: "user", text: "Explain the next change", recordIndex: 2 },
  { id: "m-assistant-1", role: "assistant", text: "This is reported progress.", recordIndex: 8 },
]
const conversationDigest = (messages) =>
  createHash("sha256").update(JSON.stringify(messages)).digest("hex")
const conversationIdentity = {
  agent: identity.agent,
  profile: identity.profile,
  containerId: identity.containerId,
  invocationId: identity.invocationId,
  sessionId: conversationSessionId,
}

const conversationPages = (chunks = [conversationMessages]) => {
  const messages = chunks.flat()
  const last = messages.at(-1)
  return chunks.map((chunk, index) => ({
    schemaVersion: 1,
    ...conversationIdentity,
    snapshotId: conversationSnapshotId,
    capturedAt: "2026-09-09T12:00:00.000Z",
    cutoff: { messageId: last.id, recordIndex: last.recordIndex },
    revision: conversationDigest(messages),
    activityRevision: conversationDigest(messages),
    coverage: { complete: true, notices: [] },
    messages: chunk,
    page: {
      index,
      total: chunks.length,
      nextCursor: index < chunks.length - 1
        ? conversationSnapshotId + (index + 1).toString(16).padStart(64, "0")
        : null,
    },
  }))
}

const conversationRunner = (pages, calls = [], binding = conversationIdentity) => async (request) => {
  calls.push(request)
  if (request.operation === "release-conversation") {
    return JSON.stringify({
      schemaVersion: 1,
      ...binding,
      snapshotId: request.snapshotId,
      released: true,
    })
  }
  const index = request.cursor === undefined ? 0 : Number.parseInt(request.cursor.slice(64), 16)
  return JSON.stringify(pages[index])
}

test("assembles bounded Sandbox conversation pages and releases the sealed snapshot", async () => {
  const calls = []
  const pages = conversationPages(conversationMessages.map((message) => [message]))
  const env = { PATH: "fixture" }
  const result = await captureSandboxConversation({
    identity, cwd: "/repo", env,
    bridgeRunner: conversationRunner(pages, calls),
  })
  assert.match(result.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  assert.notEqual(result.id, conversationSnapshotId)
  assert.deepEqual(result, {
    schemaVersion: 1,
    id: result.id,
    capturedAt: pages[0].capturedAt,
    cutoff: pages[0].cutoff,
    revision: pages[0].revision,
    activityRevision: pages[0].activityRevision,
    messages: conversationMessages,
    coverage: pages[0].coverage,
    agent: identity.agent,
    profile: identity.profile,
    sessionId: conversationSessionId,
  })
  assert.deepEqual(calls.map((call) => call.operation), [
    "export-conversation", "export-conversation", "release-conversation",
  ])
  assert.equal(calls[1].cursor, pages[0].page.nextCursor)
  assert.equal(calls[2].snapshotId, conversationSnapshotId)
  assert.equal(calls[2].identity.sessionId, conversationSessionId)
  assert.ok(calls.every((call) => call.cwd === "/repo" && call.env === env))
  assert.ok(Object.isFrozen(calls[0].identity))
})

test("preserves a Unicode conversation answer above the old 60000-character limit", async () => {
  const messages = [
    conversationMessages[0],
    { ...conversationMessages[1], text: "界🙂".repeat(60_001) },
  ]
  const pages = conversationPages([messages])
  assert.ok(Buffer.byteLength(JSON.stringify(pages[0])) < sandboxConversationMaximumOutputBytes)
  const result = await captureSandboxConversation({
    identity, bridgeRunner: conversationRunner(pages),
  })
  assert.equal(result.messages[1].text, messages[1].text)
})

test("rejects a final-message v1 response instead of falling back to older capture", async () => {
  await assert.rejects(captureSandboxConversation({
    identity,
    bridgeRunner: async () => JSON.stringify({
      version: 1, agent: identity.agent, profile: identity.profile,
      session_id: conversationSessionId, answer: "not a conversation",
    }),
  }), /does not support conversation export/u)
})

test("rejects different Sandbox source identities on any conversation page", async () => {
  for (const [field, value] of [
    ["agent", "codex"], ["profile", "other-profile"], ["containerId", "e".repeat(64)],
    ["invocationId", "e".repeat(32)], ["sessionId", "other-session"],
  ]) {
    const pages = conversationPages(conversationMessages.map((message) => [message]))
    pages[1][field] = value
    const calls = []
    await assert.rejects(captureSandboxConversation({
      identity, bridgeRunner: conversationRunner(pages, calls),
    }), /different source identity|changed identity/u, field)
    assert.equal(calls.at(-1).operation, "release-conversation")
  }
})

test("requires a known focused session to match the bridge session", async () => {
  await assert.rejects(captureSandboxConversation({
    identity: { ...identity, sessionId: "another-session" },
    bridgeRunner: conversationRunner(conversationPages()),
  }), /different source identity/u)
})

test("rejects changed page metadata and releases the original snapshot", async () => {
  const mutations = [
    (page) => { page.revision = "e".repeat(64) },
    (page) => { page.activityRevision = "e".repeat(64) },
    (page) => { page.snapshotId = "e".repeat(64) },
    (page) => { page.capturedAt = "2026-09-10T12:00:00.000Z" },
    (page) => { page.cutoff.recordIndex += 1 },
    (page) => { page.coverage = { complete: false, notices: ["compacted-history"] } },
    (page) => { page.page.index = 0 },
    (page) => { page.page.total = 3 },
  ]
  for (const mutate of mutations) {
    const pages = conversationPages(conversationMessages.map((message) => [message]))
    mutate(pages[1])
    const calls = []
    await assert.rejects(captureSandboxConversation({
      identity, bridgeRunner: conversationRunner(pages, calls),
    }), /conversation/u)
    assert.equal(calls.at(-1).snapshotId, conversationSnapshotId)
  }
})

test("rejects missing pages, unsafe cursors, unknown fields, and oversized responses", async () => {
  const mutations = [
    (page) => { page.page.total = 2 },
    (page) => { page.page.nextCursor = "../../outside" },
    (page) => { page.page.total = 513 },
    (page) => { page.private_transcript = "must not cross this boundary" },
    (page) => { page.messages[0].role = "system" },
    (page) => { page.messages[0].recordIndex = -1 },
    (page) => { page.coverage.notices = ["private transcript text"] },
    (page) => { page.messages[0].text = "x".repeat(sandboxConversationMaximumOutputBytes) },
  ]
  for (const mutate of mutations) {
    const page = structuredClone(conversationPages()[0])
    mutate(page)
    await assert.rejects(captureSandboxConversation({
      identity, bridgeRunner: conversationRunner([page]),
    }), /conversation/u)
  }
})

test("rejects duplicate evidence, out-of-order records, wrong digests, and incomplete cutoffs", async () => {
  const mutations = [
    (page) => { page.messages[1].id = page.messages[0].id },
    (page) => { page.messages[1].recordIndex = page.messages[0].recordIndex },
    (page) => { page.revision = "0".repeat(64) },
    (page) => { page.cutoff.messageId = "not-present" },
    (page) => { page.cutoff.recordIndex += 1 },
    (page) => { page.messages[1].role = "user" },
  ]
  for (const mutate of mutations) {
    const pages = structuredClone(conversationPages())
    mutate(pages[0])
    const calls = []
    await assert.rejects(captureSandboxConversation({
      identity, bridgeRunner: conversationRunner(pages, calls),
    }), /evidence|digest|cutoff/u)
    assert.equal(calls.at(-1).operation, "release-conversation")
  }
})

test("cancellation stops page requests and releases the known snapshot without the aborted signal", async () => {
  const controller = new AbortController()
  const pages = conversationPages(conversationMessages.map((message) => [message]))
  const calls = []
  const runner = conversationRunner(pages, calls)
  const error = new DOMException("capture cancelled", "AbortError")
  await assert.rejects(captureSandboxConversation({
    identity, signal: controller.signal,
    bridgeRunner: async (request) => {
      const response = await runner(request)
      if (request.operation === "export-conversation") controller.abort(error)
      return response
    },
  }), (actual) => {
    assert.equal(actual, error)
    assert.equal(actual.name, "AbortError")
    return true
  })
  assert.deepEqual(calls.map((call) => call.operation), ["export-conversation", "release-conversation"])
  assert.equal(calls[0].signal, controller.signal)
  assert.notEqual(calls[1].signal, controller.signal)
  assert.equal(calls[1].signal.aborted, false)
})

test("an already cancelled Sandbox capture makes no bridge call", async () => {
  const controller = new AbortController()
  controller.abort(new Error("cancelled before capture"))
  let called = false
  await assert.rejects(captureSandboxConversation({
    identity, signal: controller.signal, bridgeRunner: async () => {
      called = true
      return ""
    },
  }), /cancelled before capture/u)
  assert.equal(called, false)
})

test("a release failure prevents claiming successful capture", async () => {
  const runner = conversationRunner(conversationPages())
  await assert.rejects(captureSandboxConversation({
    identity, bridgeRunner: async (request) => {
      if (request.operation === "release-conversation") throw new Error("release failed")
      return runner(request)
    },
  }), /release failed/u)
})

test("a page error and release error are both preserved in an AggregateError", async () => {
  const pages = conversationPages(conversationMessages.map((message) => [message]))
  const calls = []
  const runner = conversationRunner(pages, calls)
  const captureError = new Error("source replaced")
  const releaseError = new Error("cleanup failure")
  let releaseAttempted = false
  await assert.rejects(captureSandboxConversation({
    identity, bridgeRunner: async (request) => {
      if (request.operation === "release-conversation") {
        releaseAttempted = true
        throw releaseError
      }
      if (request.cursor !== undefined) throw captureError
      return runner(request)
    },
  }), (actual) => {
    assert.ok(actual instanceof AggregateError)
    assert.deepEqual(actual.errors, [captureError, releaseError])
    assert.equal(actual.cause, captureError)
    assert.equal(actual.message, "The Sandbox conversation capture failed and snapshot release also failed.")
    return true
  })
  assert.equal(releaseAttempted, true)
})

test("an aborted capture and failed release are both surfaced in an AggregateError", async () => {
  const controller = new AbortController()
  const abortError = new DOMException("capture cancelled", "AbortError")
  const releaseError = new Error("snapshot release failed")
  const calls = []
  const runner = conversationRunner(conversationPages(conversationMessages.map((message) => [message])), calls)
  await assert.rejects(captureSandboxConversation({
    identity, signal: controller.signal,
    bridgeRunner: async (request) => {
      const response = await runner(request)
      if (request.operation === "release-conversation") throw releaseError
      controller.abort(abortError)
      return response
    },
  }), (actual) => {
    assert.ok(actual instanceof AggregateError)
    assert.deepEqual(actual.errors, [abortError, releaseError])
    assert.equal(actual.cause, abortError)
    assert.equal(actual.errors[0].name, "AbortError")
    return true
  })
  assert.deepEqual(calls.map((call) => call.operation), ["export-conversation", "release-conversation"])
  assert.notEqual(calls[1].signal, controller.signal)
  assert.equal(calls[1].signal.aborted, false)
})

test("snapshot release is bounded even when an injected runner ignores cancellation", async () => {
  let cleanupSignal
  const runner = conversationRunner(conversationPages())
  await assert.rejects(captureSandboxConversation({
    identity, cleanupTimeoutMs: 10,
    bridgeRunner: async (request) => {
      if (request.operation === "release-conversation") {
        cleanupSignal = request.signal
        return new Promise<string>(() => {})
      }
      return runner(request)
    },
  }), /snapshot release exceeded its time budget/u)
  assert.equal(cleanupSignal.aborted, true)
})

test("an invalid cleanup deadline cannot start a Sandbox export", async () => {
  let called = false
  await assert.rejects(captureSandboxConversation({
    identity, cleanupTimeoutMs: 60_000, bridgeRunner: async () => {
      called = true
      return ""
    },
  }), /time budget is invalid/u)
  assert.equal(called, false)
})

const processFixtureEnv = {
  PATH: process.env.PATH,
  NODE_DISABLE_COMPILE_CACHE: "1",
}

test("a bridge process is reaped before an abort rejects and cannot signal its caller", {
  skip: process.platform === "win32",
}, async () => {
  const controller = new AbortController()
  const callerPid = process.pid
  const reason = new Error("owned bridge cancelled")
  let child
  let closed = false
  let grandchildPid
  let output = ""
  const descendant = [
    "process.on('SIGTERM', () => {})",
    "process.stdout.write('ready:' + process.pid + '\\n')",
    "setInterval(() => {}, 1000)",
  ].join(";")
  const program = [
    "const { spawn } = require('node:child_process')",
    "process.on('SIGTERM', () => {})",
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] })`,
    "setInterval(() => {}, 1000)",
  ].join(";")
  const running = runSandboxConversationProcess({
    command: process.execPath, args: ["-e", program], env: processFixtureEnv,
    signal: controller.signal, timeoutMs: 5_000,
    spawnProcess: ((command, args, options) => {
      assert.equal(options.detached, true)
      child = spawn(command, args, options)
      child.once("close", () => { closed = true })
      child.stdout.on("data", (chunk) => {
        output += chunk.toString()
        const match = /ready:(\d+)\n/u.exec(output)
        if (match !== null) {
          grandchildPid = Number(match[1])
          controller.abort(reason)
        }
      })
      return child
    }) as typeof spawn,
  })
  try {
    await assert.rejects(running, /owned bridge cancelled/u)
    assert.equal(closed, true)
    assert.equal(child.signalCode, "SIGKILL")
    assert.ok(grandchildPid > 0)
    assert.equal(process.pid, callerPid)
    assert.doesNotThrow(() => process.kill(callerPid, 0))
    // The descendant keeps the inherited output pipe open until it exits.
    assert.equal(child.stdout.destroyed, true)
    let descendantState = ""
    try {
      descendantState = execFileSync("ps", ["-o", "stat=", "-p", String(grandchildPid)], { encoding: "utf8" }).trim()
    } catch (error) {
      assert.equal(error.status, 1)
    }
    assert.ok(descendantState === "" || descendantState.startsWith("Z"), "owned descendant is still running")
  } finally {
    controller.abort(reason)
    await running.catch(() => {})
  }
})

test("a bridge process deadline waits for owned child termination", async () => {
  let child
  let closed = false
  await assert.rejects(runSandboxConversationProcess({
    command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
    env: processFixtureEnv, timeoutMs: 25,
    spawnProcess: ((command, args, options) => {
      child = spawn(command, args, options)
      child.once("close", () => { closed = true })
      return child
    }) as typeof spawn,
  }), /exceeded its time budget/u)
  assert.equal(closed, true)
  assert.notEqual(child.signalCode, null)
})

test("bridge output overflow terminates and reaps its owned process", async () => {
  let closed = false
  await assert.rejects(runSandboxConversationProcess({
    command: process.execPath,
    args: ["-e", `process.stdout.write('x'.repeat(${sandboxConversationMaximumOutputBytes + 1})); setInterval(() => {}, 1000)`],
    env: processFixtureEnv,
    spawnProcess: ((command, args, options) => {
      const child = spawn(command, args, options)
      child.once("close", () => { closed = true })
      return child
    }) as typeof spawn,
  }), /exceeded its response budget/u)
  assert.equal(closed, true)
})

test("a cancelled bridge request does not spawn and failures do not expose private stderr", async () => {
  const controller = new AbortController()
  controller.abort(new Error("already cancelled"))
  let spawned = false
  await assert.rejects(runSandboxConversationProcess({
    command: process.execPath, args: [], signal: controller.signal,
    spawnProcess: (() => { spawned = true; throw new Error("must not spawn") }) as typeof spawn,
  }), /already cancelled/u)
  assert.equal(spawned, false)
  await assert.rejects(runSandboxConversationProcess({
    command: process.execPath,
    args: ["-e", "process.stderr.write('PRIVATE_TRANSCRIPT_SENTINEL'); process.exit(19)"],
    env: processFixtureEnv,
  }), (error) => {
    assert.match(error.message, /Sandbox conversation bridge failed/u)
    assert.doesNotMatch(error.message, /PRIVATE_TRANSCRIPT_SENTINEL/u)
    assert.equal(Object.hasOwn(error, "stderr"), false)
    return true
  })
})

test("describes current Sandbox activity after the transport snapshot has been released", async () => {
  const page = conversationPages()[0]
  const description = {
    schemaVersion: 1,
    ...conversationIdentity,
    cutoff: page.cutoff,
    revision: page.revision,
    activityRevision: "e".repeat(64),
    coverage: { complete: false, notices: ["pending-turn-excluded"] },
  }
  const result = await describeSandboxConversation({
    identity: { ...identity, sessionId: conversationSessionId },
    bridgeRunner: async (request) => {
      assert.equal(request.operation, "describe-conversation")
      assert.equal(request.snapshotId, undefined)
      return JSON.stringify(description)
    },
  })
  assert.deepEqual(result, description)
})

test("validates optional snapshot descriptions and exact release confirmations", async () => {
  const page = conversationPages()[0]
  await assert.rejects(describeSandboxConversation({
    identity, snapshotId: conversationSnapshotId,
    bridgeRunner: async () => JSON.stringify({
      schemaVersion: 1, ...conversationIdentity, cutoff: page.cutoff,
      revision: page.revision, activityRevision: page.activityRevision, coverage: page.coverage,
      snapshotId: "e".repeat(64), changed: false,
    }),
  }), /different snapshot description/u)
  await assert.rejects(releaseSandboxConversation({
    identity, snapshotId: conversationSnapshotId,
    bridgeRunner: async () => JSON.stringify({
      schemaVersion: 1, ...conversationIdentity, snapshotId: conversationSnapshotId, released: false,
    }),
  }), /did not confirm snapshot release/u)
})

test("Python and TypeScript independently normalize identical evidence IDs and completed messages", async () => {
  const script = path.resolve(import.meta.dirname, "../../../scripts/trellage-session-bridge.py")
  const fixtures = [
    { agent: "copilot", records: [
      { id: "u", type: "user.message", data: { content: "Why 界?" } },
      { id: "a", type: "assistant.message", data: { phase: "final_answer", content: "Answer 🙂" } },
    ] },
    { agent: "codex", records: [
      { type: "event_msg", payload: { type: "user_message", message: "Why 界?" } },
      { type: "response_item", payload: { type: "message", role: "assistant",
        phase: "final_answer", content: [{ type: "output_text", text: "Answer 🙂" }] } },
    ] },
    { agent: "claude", records: [
      { type: "user", uuid: "u", message: { role: "user", content: "Why 界?" } },
      { type: "assistant", uuid: "a", message: { id: "answer", role: "assistant",
        content: [{ type: "text", text: "Answer 🙂" }], stop_reason: "end_turn" } },
    ] },
    { agent: "copilot", records: [
      { type: "user.message", data: { messageId: "human-id", content: "Question" } },
      { type: "session.task_complete", data: { message_id: "summary-id", summary: "Summary presentation" } },
      { type: "assistant.message", id: "event-id",
        data: { messageId: "answer-id", phase: "final", content: "Complete answer" } },
    ] },
    { agent: "copilot", records: [
      { type: "user.message", eventId: "human-event", data: { content: "Question" } },
      { type: "user.message", eventId: "human-event", data: { content: "Question" } },
      { type: "assistant.message", data: { content: "Legacy answer" } },
      { type: "assistant.turn_end" },
    ] },
    { agent: "copilot", records: [
      { type: "user.message", data: { id: "human-id", content: "Question" } },
      { type: "assistant.message", data: { message_id: "pending-id", content: "Pending presentation" } },
      { type: "session.task_complete", id: "complete-event", data: { summary: "Completed summary" } },
    ] },
    { agent: "codex", records: [
      { type: "response_item", payload: { type: "message", role: "user", message_id: "human-id",
        internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text", "system.instructions"] },
        content: [{ type: "input_text", text: "Question" }, { type: "input_text", text: "Hidden instructions" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", id: "answer-id",
        content: [{ type: "output_text", text: "Legacy answer" }] } },
      { type: "event_msg", payload: { type: "agent_message", messageId: "answer-id", message: "Legacy answer" } },
      { type: "event_msg", payload: { type: "task_complete" } },
    ] },
    { agent: "codex", records: [
      { type: "event_msg", payload: { type: "user_message", messageId: "human-id", message: "Repeated question" } },
      { type: "response_item", payload: { type: "message", role: "user", messageId: "human-id",
        internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
        content: [{ type: "input_text", text: "Repeated question" }] } },
      { type: "event_msg", payload: { type: "user_message", messageId: "second-human-id", message: "Repeated question" } },
      { type: "response_item", payload: { type: "message", role: "assistant", id: "answer-id",
        phase: "final_answer", content: [{ type: "output_text", text: "Answer" }] } },
    ] },
    { agent: "claude", records: [
      { type: "user", id: "event-id", message: { id: "human-id", content: "Question" } },
      { type: "assistant", uuid: "fragment-1", message: { id: "answer-id",
        content: [{ type: "text", text: "Part one" }] } },
      { type: "assistant", uuid: "fragment-2", message: { id: "answer-id",
        content: [{ type: "text", text: "Part two" }], stop_reason: "end_turn" } },
    ] },
    { agent: "claude", records: [
      { type: "user", message: { content: "Question" } },
      { type: "assistant", uuid: "fragment-1", message: { id: "answer-id",
        content: [{ type: "text", id: "block-id", text: "Answer" }] } },
      { type: "assistant", uuid: "fragment-2", message: { id: "answer-id", stop_reason: "end_turn",
        content: [{ type: "text", id: "block-id", text: "Answer" }] } },
      { type: "assistant", message: { id: "tool-turn", stop_reason: "end_turn",
        content: [{ type: "text", text: "Hidden commentary" }, { type: "tool_use", id: "tool-id" }] } },
    ] },
    { agent: "copilot", records: [
      { type: "user.message", data: { source: "system", content: "Hidden instructions" } },
      { type: "user.message", id: "human-id", data: { content: "Question" } },
      { type: "assistant.message", id: "answer-id", data: { phase: "final_answer", content: "Answer" } },
      { type: "user.message", id: "next-human-id", data: { content: "Next question" } },
      { type: "assistant.message", data: { content: "Unmarked commentary" } },
      { type: "tool.execution_start" },
      { type: "session.idle" },
      { type: "assistant.message", subagentId: "child", data: { phase: "final_answer", content: "Child answer" } },
    ] },
  ]
  const python = [
    "import importlib.util,json,sys",
    "spec=importlib.util.spec_from_file_location('bridge',sys.argv[1])",
    "bridge=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(bridge)",
    "value=bridge.normalize_conversation({'agent':sys.argv[3],'session_id':sys.argv[2]},list(enumerate(json.load(sys.stdin))),False,bridge.conversation_policy())",
    "print(bridge.serialize_result(value))",
  ].join("\n")
  for (const fixture of fixtures) {
    const normalized = JSON.parse(execFileSync("python3", [
      "-c", python, script, conversationSessionId, fixture.agent,
    ], {
      encoding: "utf8", input: JSON.stringify(fixture.records),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    }))
    const native = parseConversationRecords(fixture.agent as Parameters<typeof parseConversationRecords>[0],
      fixture.records.map((value, recordIndex) => ({ value, recordIndex })), {
        sessionId: conversationSessionId, cwd: "/repo",
      })
    assert.deepEqual(normalized.messages, native.messages, fixture.agent)
    assert.deepEqual(normalized.cutoff, native.cutoff, fixture.agent)
    const binding = { ...conversationIdentity, agent: fixture.agent, profile: `${fixture.agent}-profile` }
    const wire = { ...conversationPages([normalized.messages])[0], ...normalized, ...binding }
    const result = await captureSandboxConversation({
      identity: { ...identity, ...binding }, bridgeRunner: conversationRunner([wire], [], binding),
    })
    assert.equal(result.revision, normalized.revision)
    assert.deepEqual(result.messages, normalized.messages)
  }
})
