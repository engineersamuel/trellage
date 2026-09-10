import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import { parseConversationRecords } from "../lib/conversation-parser.ts"
import { readStableConversationRecords } from "../lib/conversation-reader.ts"
import { fixtureDirectory } from "./helpers/conversation-fixtures.ts"

const fixtures = JSON.parse(await readFile(new URL("./fixtures/conversation-evidence-ids.json", import.meta.url), "utf8"))

for (const fixture of fixtures.cases) {
  test(`canonical evidence IDs: ${fixture.name}`, async (t) => {
    const root = await fixtureDirectory(t)
    const sourcePath = path.join(root, "evidence.jsonl")
    const source = fixture.records.map((record) => record === null ? "" : JSON.stringify(record)).join("\n") +
      (fixture.trailingNewline ? "\n" : "")
    await writeFile(sourcePath, source, { mode: 0o600 })
    const read = await readStableConversationRecords(sourcePath, [root])
    const result = parseConversationRecords(fixture.agent, read.records, {
      sessionId: fixtures.sessionId, cwd: fixtures.cwd,
    })
    assert.deepEqual(result.messages, fixture.messages)
    const last = fixture.messages.at(-1)
    assert.deepEqual(result.cutoff, { messageId: last.id, recordIndex: last.recordIndex })
    assert.deepEqual(read.notices, [])
  })
}
