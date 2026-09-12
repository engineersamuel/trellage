import assert from "node:assert/strict"
import { chmod, link, lstat, mkdir, readFile, symlink, truncate, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import test from "node:test"
import * as Core from "@trellage/guide-core/conversation"

import { bindFocusedConversation, captureFocusedConversation } from "../lib/conversation-capture.ts"
import { ConversationAgent, ConversationRole, ConversationSurface } from "../lib/conversation-contract.ts"
import { conversationCapturePolicy } from "../lib/conversation-policy.ts"
import {
  consumeConversationChoice, readConversationRequest, writeConversationChoice, writeConversationRequest,
} from "../lib/conversation-state.ts"
import { parseConversationSnapshot } from "../lib/conversation-validation.ts"
import { captureFixture } from "./helpers/conversation-fixtures.ts"

const snapshotFixture = async (t) => {
  const fixture = await captureFixture(t)
  const snapshot = await captureFocusedConversation(fixture.context, fixture.dependencies)
  return { ...fixture, snapshot }
}

test("conversation runtime enums are the shared source exports, not local copies", () => {
  assert.equal(ConversationAgent, Core.ConversationAgent)
  assert.equal(ConversationRole, Core.ConversationRole)
  assert.equal(ConversationSurface, Core.ConversationSurface)
})

test("request snapshots are private, owned, immutable transport outside the capture queue", async (t) => {
  const fixture = await snapshotFixture(t)
  const queuePath = path.join(fixture.root, "capture-queue.json")
  const queue = '{"schemaVersion":1,"entries":[{"id":"keep","answer":"Keep this capture"}]}\n'
  await writeFile(queuePath, queue, { mode: 0o600 })
  const requestPath = await writeConversationRequest(fixture.root, fixture.snapshot)
  assert.match(path.basename(requestPath), /^[a-f0-9-]{36}\.json$/u)
  assert.equal(path.dirname(requestPath), path.join(fixture.root, "continuations", "requests"))
  assert.equal((await lstat(requestPath)).mode & 0o7777, 0o600)
  assert.equal((await lstat(path.dirname(requestPath))).mode & 0o7777, 0o700)
  assert.equal((await lstat(path.dirname(path.dirname(requestPath)))).mode & 0o7777, 0o700)
  assert.equal((await lstat(requestPath)).nlink, 1)
  assert.deepEqual(await readConversationRequest(fixture.root, requestPath), fixture.snapshot)
  assert.deepEqual(await readConversationRequest(fixture.root, requestPath), fixture.snapshot)
  assert.equal(await readFile(queuePath, "utf8"), queue)
})

test("concurrent immutable request writes remain separate and fully readable", async (t) => {
  const fixture = await snapshotFixture(t)
  const requests = await Promise.all(Array.from({ length: 5 }, () =>
    writeConversationRequest(fixture.root, fixture.snapshot)))
  assert.equal(new Set(requests).size, 5)
  for (const request of requests) {
    assert.deepEqual(await readConversationRequest(fixture.root, request), fixture.snapshot)
  }
})

test("request persistence supports filtered snapshots above the old state file and intent limits", async (t) => {
  const fixture = await snapshotFixture(t)
  const large = {
    ...fixture.snapshot,
    messages: fixture.snapshot.messages.map((message, index) =>
      index === 1 ? { ...message, text: "界".repeat(400_000) } : message),
  }
  const target = await writeConversationRequest(fixture.root, large)
  assert.ok((await lstat(target)).size > 512 * 1024)
  assert.equal((await readConversationRequest(fixture.root, target)).messages[1].text, large.messages[1].text)
})

test("standalone saved snapshots are not request transports and remain untouched", async (t) => {
  const fixture = await snapshotFixture(t)
  await writeConversationRequest(fixture.root, fixture.snapshot)
  const snapshots = path.join(fixture.root, "continuations", "snapshots")
  const nested = path.join(snapshots, randomUUID())
  await mkdir(nested, { recursive: true, mode: 0o700 })
  for (const target of [path.join(snapshots, `${randomUUID()}.json`), path.join(nested, "snapshot.json")]) {
    await writeFile(target, JSON.stringify(fixture.snapshot), { mode: 0o600 })
    await assert.rejects(readConversationRequest(fixture.root, target), /outside the owned continuation store/u)
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), fixture.snapshot)
    assert.ok((await lstat(target)).isFile())
  }
})

test("private request reads reject links, unsafe modes, and outside paths without repair", async (t) => {
  const fixture = await snapshotFixture(t)
  const target = await writeConversationRequest(fixture.root, fixture.snapshot)
  await chmod(target, 0o644)
  await assert.rejects(readConversationRequest(fixture.root, target), /private owned/u)
  assert.equal((await lstat(target)).mode & 0o777, 0o644)
  await chmod(target, 0o600)
  const linkPath = path.join(path.dirname(target), `${randomUUID()}.json`)
  await symlink(target, linkPath)
  await assert.rejects(readConversationRequest(fixture.root, linkPath), /symbolic links/u)
  const hardPath = path.join(path.dirname(target), `${randomUUID()}.json`)
  await link(target, hardPath)
  await assert.rejects(readConversationRequest(fixture.root, hardPath), /one link/u)
  const outside = path.join(fixture.root, `${randomUUID()}.json`)
  await writeFile(outside, JSON.stringify(fixture.snapshot), { mode: 0o600 })
  await assert.rejects(readConversationRequest(fixture.root, outside), /outside/u)
  assert.ok((await lstat(outside)).isFile())
})

test("unsafe or linked state directories are not repaired or followed", async (t) => {
  const fixture = await snapshotFixture(t)
  await chmod(fixture.root, 0o755)
  await assert.rejects(writeConversationRequest(fixture.root, fixture.snapshot), /directory is not private/u)
  assert.equal((await lstat(fixture.root)).mode & 0o777, 0o755)
  await chmod(fixture.root, 0o700)
  const other = path.join(fixture.root, "other")
  await mkdir(other, { mode: 0o700 })
  await symlink(other, path.join(fixture.root, "continuations"))
  await assert.rejects(writeConversationRequest(fixture.root, fixture.snapshot), /not private/u)
})

test("private state below a writable ancestor is rejected without changing its permissions", async (t) => {
  const fixture = await snapshotFixture(t)
  const parent = path.join(fixture.root, "writable")
  const state = path.join(parent, "state")
  await mkdir(state, { recursive: true, mode: 0o700 })
  await chmod(parent, 0o777)
  await assert.rejects(writeConversationRequest(state, fixture.snapshot), /unsafe ancestor/u)
  assert.equal((await lstat(parent)).mode & 0o777, 0o777)
})

test("oversized and malformed private records fail with content-free diagnostics", async (t) => {
  const fixture = await snapshotFixture(t)
  const target = await writeConversationRequest(fixture.root, fixture.snapshot)
  await writeFile(target, '{"PRIVATE CONTENT":bad}')
  await assert.rejects(readConversationRequest(fixture.root, target), (error) => {
    assert.doesNotMatch(error.message, /PRIVATE CONTENT/u)
    return /valid JSON/u.test(error.message)
  })
  await truncate(target, conversationCapturePolicy.maximumRequestBytes + 1)
  await assert.rejects(readConversationRequest(fixture.root, target), /bounded/u)
})

test("snapshot schema rejects unknown fields, invalid cutoffs, duplicate evidence IDs, and crossed source identity", async (t) => {
  const fixture = await snapshotFixture(t)
  const value = fixture.snapshot
  for (const invalid of [
    { ...value, command: "do-not-run" },
    { ...value, cutoff: { messageId: value.messages[0].id, recordIndex: value.messages[0].recordIndex } },
    { ...value, messages: [value.messages[0], { ...value.messages[1], id: value.messages[0].id }] },
    { ...value, source: { ...value.source, surface: "host", containerId: "a".repeat(64) } },
    { ...value, source: { ...value.source, transcriptPath: "/outside" } },
  ]) assert.throws(() => parseConversationSnapshot(invalid), /private conversation record/u)
})

test("source choice tokens carry only frozen identity and are consumed once", async (t) => {
  const fixture = await snapshotFixture(t)
  const binding = await bindFocusedConversation(fixture.context, fixture.dependencies)
  const token = await writeConversationChoice(fixture.root, binding)
  assert.match(token, /^trellage-guide-conversation-choice:v1:[a-f0-9-]{36}$/u)
  assert.doesNotMatch(token, /Original human|Pending/u)
  assert.deepEqual(await consumeConversationChoice(fixture.root, token), binding)
  await assert.rejects(consumeConversationChoice(fixture.root, token), /ENOENT/u)
})
