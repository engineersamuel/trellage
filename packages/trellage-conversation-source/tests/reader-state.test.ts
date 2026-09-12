import assert from "node:assert/strict"
import { appendFile, chmod, lstat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { captureFocusedConversation } from "../src/conversation-capture.ts"
import { conversationCapturePolicy } from "../src/conversation-policy.ts"
import { readStableConversationRecords } from "../src/conversation-reader.ts"
import { readConversationRequest, writeConversationRequest } from "../src/conversation-state.ts"
import { captureFixture, jsonl } from "./fixtures.ts"

test("Bun capture discloses partial trailing records and freezes append-only reads", async (t) => {
  const fixture = await captureFixture(t)
  await writeFile(fixture.transcriptPath, jsonl(fixture.records.slice(0, 3)) + '{"type":"user.message","data":')
  const read = await readStableConversationRecords(fixture.transcriptPath, [fixture.home], {
    afterPrefixRead: () => appendFile(fixture.transcriptPath, '{"content":"later"}}\n'),
  })
  assert.equal(read.records.length, 3)
  assert.deepEqual(read.notices, ["One incomplete trailing transcript record was excluded."])
})

test("malformed tails with the same Bun parse error as incomplete tails fail closed", async (t) => {
  const fixture = await captureFixture(t)
  for (const suffix of ['{"secret":1 MALFORMED_SYNTHETIC_TEXT', '{"secret":}', '{"secret":"\\x']) {
    await writeFile(fixture.transcriptPath, jsonl(fixture.records.slice(0, 3)) + suffix)
    await assert.rejects(readStableConversationRecords(fixture.transcriptPath, [fixture.home]), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /malformed/)
      assert.doesNotMatch(error.message, /MALFORMED_SYNTHETIC_TEXT|secret/)
      return true
    })
  }
})

test("module-relative policy remains unchanged and source budgets are enforced", async (t) => {
  const fixture = await captureFixture(t)
  assert.equal(conversationCapturePolicy.maximumTranscriptBytes, 67_108_864)
  assert.equal(conversationCapturePolicy.maximumRequestBytes, 67_108_864)
  assert.equal(Object.isFrozen(conversationCapturePolicy), true)
  await assert.rejects(readStableConversationRecords(fixture.transcriptPath, [fixture.home], {
    policy: { ...conversationCapturePolicy, maximumRecordBytes: 10 },
  }), /record byte limit/)
})

test("concurrent private requests retain exact snapshots with owned file modes", async (t) => {
  const fixture = await captureFixture(t)
  const snapshot = await captureFocusedConversation(fixture.context, fixture.dependencies)
  const paths = await Promise.all(Array.from({ length: 5 }, () => writeConversationRequest(fixture.root, snapshot)))
  assert.equal(new Set(paths).size, 5)
  for (const requestPath of paths) {
    assert.equal((await lstat(requestPath)).mode & 0o7777, 0o600)
    assert.equal((await lstat(path.dirname(requestPath))).mode & 0o7777, 0o700)
    assert.deepEqual(await readConversationRequest(fixture.root, requestPath), snapshot)
  }
})

test("unowned request locations, links, and public file modes are not repaired or followed", async (t) => {
  const fixture = await captureFixture(t)
  const snapshot = await captureFocusedConversation(fixture.context, fixture.dependencies)
  const requestPath = await writeConversationRequest(fixture.root, snapshot)
  await chmod(requestPath, 0o644)
  await assert.rejects(readConversationRequest(fixture.root, requestPath), /private owned/)
  assert.equal((await lstat(requestPath)).mode & 0o777, 0o644)
  const link = path.join(fixture.root, "linked.jsonl")
  await symlink(fixture.transcriptPath, link)
  await assert.rejects(readStableConversationRecords(link, [fixture.root]), /symbolic links/)
  await assert.rejects(readConversationRequest(fixture.root, fixture.transcriptPath), /outside/)
})
