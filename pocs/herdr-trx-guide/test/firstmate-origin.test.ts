import assert from "node:assert/strict"
import { mkdir, rename, symlink } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { parseFirstmateInstanceControlContextV1 } from "@trellage/guide-core"
import { conversationGuideEnvironment } from "../conversation-popup.ts"
import { captureAgentContent } from "../lib/capture.ts"
import { bindFocusedConversationForGuide, captureFocusedConversation } from "../lib/conversation-capture.ts"
import { readFirstmateLaunchOrigin } from "../lib/firstmate-origin.ts"
import { HerdrRequestError } from "../lib/herdr.ts"
import { captureStructuredFinalMessage, findFocusedTranscript } from "../lib/transcripts.ts"
import { firstmateSessionReference, trellageSessionIdentity } from "../lib/trellage-session.ts"
import { captainHome, firstmateCaptureFixture, firstmateOrigin, firstmateTokens, legacyOrigin } from "./helpers/firstmate.ts"
import { historyRecords, sessionId, writeHarnessHistory } from "./helpers/conversation-fixtures.ts"

const metadata = () => ({
  agent: "claude", processInfo: { foreground_process_group_id: 12345 }, tokens: firstmateTokens(),
})

test("Firstmate metadata keeps fleet UUID, harness session and profile separate", () => {
  const identity = trellageSessionIdentity(metadata())
  assert.equal(identity.profile, "default")
  assert.equal(identity.sessionId, sessionId)
  assert.notEqual(identity.firstmateInstanceId, identity.sessionId)
  assert.deepEqual(identity.launchOrigin, firstmateOrigin)
  assert.deepEqual(firstmateSessionReference(identity), firstmateOrigin.reference)
  const withoutOrigin = metadata()
  delete withoutOrigin.tokens.trellage_firstmate_launch_origin
  assert.equal(trellageSessionIdentity(withoutOrigin).firstmateInstanceId, firstmateOrigin.reference.instanceId)
  assert.throws(() => firstmateSessionReference(trellageSessionIdentity(withoutOrigin)), /no instance root reference/u)
})

test("Firstmate metadata rejects conflicting, malformed and oversized private context", () => {
  const invalid = [
    { ...firstmateOrigin, schemaVersion: 2 },
    { ...firstmateOrigin, reference: { ...firstmateOrigin.reference, instanceId: "44444444-4444-4444-8444-444444444444" } },
    { ...firstmateOrigin, reference: { ...firstmateOrigin.reference, profile: "pstack-workers" } },
    { ...firstmateOrigin, launchCommand: "/bin/sh" },
  ]
  for (const origin of invalid) {
    const source = metadata()
    source.tokens.trellage_firstmate_launch_origin = JSON.stringify(origin)
    assert.throws(() => trellageSessionIdentity(source), /Firstmate launch origin/u)
  }
  const oversized = metadata()
  oversized.tokens.trellage_firstmate_launch_origin = "x".repeat(65_537)
  assert.throws(() => trellageSessionIdentity(oversized), /size limit/u)
  const wrongAgent = metadata()
  wrongAgent.agent = "codex"
  wrongAgent.tokens.trellage_agent = "codex"
  assert.throws(() => trellageSessionIdentity(wrongAgent), /Native Claude supervisor/u)
  const unbound = metadata()
  delete unbound.tokens.trellage_firstmate_instance_id
  assert.throws(() => trellageSessionIdentity(unbound), /instance UUID/u)
})

test("ordinary popup origin reads only the original pane and retains its configuration cwd", async () => {
  const source = { workspaceId: "workspace-1", paneId: "pane-1", cwd: "/private/fleet/runtime" }
  const calls = []
  const origin = await readFirstmateLaunchOrigin(source, {
    expectedSessionId: sessionId,
    getAgentForPane: async (paneId) => {
      calls.push(["agent", paneId])
      return { workspace_id: source.workspaceId, pane_id: source.paneId, cwd: source.cwd, agent: "claude", tokens: firstmateTokens() }
    },
    processReader: async (paneId) => {
      calls.push(["process", paneId])
      return { pane_id: source.paneId, foreground_process_group_id: 12345 }
    },
  })
  assert.deepEqual(origin, firstmateOrigin)
  assert.equal(source.cwd, "/private/fleet/runtime")
  assert.deepEqual(calls, [["agent", "pane-1"], ["process", "pane-1"]])
})

test("popup origin cannot follow changed pane, process, cwd or captured session evidence", async () => {
  const source = { workspaceId: "workspace-1", paneId: "pane-1", cwd: "/private/fleet/runtime" }
  const agent = { workspace_id: source.workspaceId, pane_id: source.paneId, cwd: source.cwd, agent: "claude", tokens: firstmateTokens() }
  const process = { pane_id: source.paneId, foreground_process_group_id: 12345 }
  const otherSessionId = "22222222-2222-4222-8222-222222222222"
  for (const changed of [
    { agent: { ...agent, workspace_id: "other" }, process },
    { agent: { ...agent, pane_id: "other" }, process },
    { agent: { ...agent, cwd: "/other" }, process },
    { agent, process: { ...process, pane_id: "other" } },
    { agent, process: { ...process, foreground_process_group_id: 99999 } },
    { agent: { ...agent, agent_session: { agent: "claude", kind: "id", value: otherSessionId } }, process },
    { agent, process: { ...process, foreground_processes: [
      { name: "claude", argv: ["claude", "--session-id", otherSessionId] },
    ] } },
  ]) {
    await assert.rejects(readFirstmateLaunchOrigin(source, {
      getAgentForPane: async () => changed.agent, processReader: async () => changed.process,
    }), /changed|another|focused process|session identities/u)
  }
  await assert.rejects(readFirstmateLaunchOrigin(source, {
    expectedSessionId: "another-session", getAgentForPane: async () => agent, processReader: async () => process,
  }), /captured Firstmate session changed/u)
  let processReads = 0
  assert.equal(await readFirstmateLaunchOrigin(source, {
    getAgentForPane: async () => ({ tokens: {} }),
    processReader: async () => { processReads += 1; throw new Error("No process lookup is needed") },
  }), undefined)
  assert.equal(processReads, 0)
  assert.equal(await readFirstmateLaunchOrigin(source, {
    getAgentForPane: async () => { throw new HerdrRequestError("agent.get", "agent_not_found", "No active agent") },
  }), undefined)
  await assert.rejects(readFirstmateLaunchOrigin(source, {
    getAgentForPane: async () => { throw new Error("Herdr connection failed") },
  }), /Herdr connection failed/u)
})

test("two default instances with the same harness session never share transcript roots", async (t) => {
  const fixture = await firstmateCaptureFixture(t)
  const otherOrigin = parseFirstmateInstanceControlContextV1({
    ...firstmateOrigin,
    reference: { ...firstmateOrigin.reference, instanceId: "44444444-4444-4444-8444-444444444444" },
    selection: "confirmed-join", entryWorktree: null, expectedBindingDigest: "d".repeat(64),
  })
  const otherHome = captainHome(fixture.root, otherOrigin)
  const otherRecords = historyRecords("claude", fixture.cwd)
  otherRecords[2].message.content[0].text = "Other fleet must not be captured"
  await writeHarnessHistory(otherHome, "claude", fixture.cwd, otherRecords)
  const options = {
    agent: "claude", cwd: fixture.cwd, agentSession: fixture.agentInfo.agent_session,
    processInfo: fixture.processInfo, tokens: fixture.agentInfo.tokens, env: fixture.env,
  }
  const transcript = await findFocusedTranscript(options)
  assert.equal(transcript.path, fixture.transcriptPath)
  assert.deepEqual(transcript.roots, [fixture.home])
  assert.equal((await captureStructuredFinalMessage(options)).text, "Completed visible answer")
  await rename(fixture.home, `${fixture.home}-unavailable`)
  await assert.rejects(findFocusedTranscript(options), /no supported session root/u)
  assert.equal(await captureStructuredFinalMessage(options), undefined)
})

test("legacy Firstmate metadata uses its captain home, not the Claude profile home", async (t) => {
  const fixture = await firstmateCaptureFixture(t, legacyOrigin)
  const captured = await captureFocusedConversation(fixture.context, fixture.dependencies)
  assert.equal(captured.source.profile, "default")
  assert.equal(captured.source.cwd, fixture.cwd)
  const transcript = await findFocusedTranscript({
    agent: "claude", cwd: fixture.cwd, agentSession: fixture.agentInfo.agent_session,
    processInfo: fixture.processInfo, tokens: fixture.agentInfo.tokens, env: fixture.env,
  })
  assert.deepEqual(transcript.roots, [fixture.home])
})

test("named capture refuses a symlinked instance root instead of following another fleet", async (t) => {
  const fixture = await firstmateCaptureFixture(t)
  const root = path.resolve(fixture.home, "..", "..")
  const foreign = `${root}-foreign`
  await rename(root, foreign)
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 })
  await symlink(foreign, root)
  await assert.rejects(captureFocusedConversation(fixture.context, fixture.dependencies), /symlink|link/u)
})

test("conversation origin remains private and leaves saved source and messages unchanged", async (t) => {
  const fixture = await firstmateCaptureFixture(t)
  const snapshot = await captureFocusedConversation(fixture.context, fixture.dependencies)
  const before = JSON.stringify(snapshot)
  const bound = await bindFocusedConversationForGuide({
    ...fixture.context, expectedSource: snapshot.source,
  }, fixture.dependencies)
  assert.deepEqual(bound.launchOrigin, firstmateOrigin)
  assert.equal(Object.hasOwn(bound.binding, "launchOrigin"), false)
  const env = conversationGuideEnvironment(snapshot, "/private/request.json", {
    HERDR_PANE_ID: "popup-pane", HERDR_WORKSPACE_ID: "real-workspace",
    FMX_LAUNCH_PROVENANCE_JSON: "untrusted daemon hint",
  }, bound.launchOrigin)
  const context = JSON.parse(env.TRELLAGE_GUIDE_HERDR_CONTEXT_JSON)
  assert.deepEqual(context.launchOrigin, firstmateOrigin)
  assert.equal(context.cwd, snapshot.source.cwd)
  assert.equal(context.paneId, snapshot.source.paneId)
  assert.equal(env.HERDR_WORKSPACE_ID, "real-workspace")
  assert.equal(env.HERDR_PANE_ID, undefined)
  assert.equal(env.FMX_LAUNCH_PROVENANCE_JSON, undefined)
  assert.equal(JSON.stringify(snapshot), before)
  assert.equal(Object.hasOwn(snapshot.source, "launchOrigin"), false)
  assert.doesNotMatch(JSON.stringify(snapshot.messages), /33333333-3333/u)
})

test("ordinary conversation intent excludes Firstmate runtime paths and never guesses the task target", async (t) => {
  const fixture = await firstmateCaptureFixture(t)
  fixture.agentInfo.agent_status = "done"
  const captured = await captureAgentContent({
    context: fixture.context, agentInfo: fixture.agentInfo, processInfo: fixture.processInfo,
    env: fixture.env, mode: "conversation",
  })
  assert.match(captured.answer, /Original human goal/u)
  assert.match(captured.answer, /Repository target: select and confirm it in trx guide/u)
  assert.equal(captured.answer.includes(fixture.cwd), false)
  assert.equal(captured.answer.includes(firstmateOrigin.reference.instanceId), false)
  assert.equal(captured.answer.includes(firstmateOrigin.entryWorktree.locators.worktree), false)
  fixture.agentInfo.tokens.trellage_firstmate_launch_origin = '{"schemaVersion":2}'
  await assert.rejects(captureAgentContent({
    context: fixture.context, agentInfo: fixture.agentInfo, processInfo: fixture.processInfo,
    env: fixture.env, mode: "conversation", onDiagnostic: () => {},
  }), /Firstmate launch origin/u)
})
