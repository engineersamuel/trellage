import { describe, expect, test } from "bun:test"
import { partialArgs, toTranscript } from "../transcript"
import { hasUnified, lineDiff, parsePatch, parseUnified, toolDiffs, wordRanges } from "../diff.ts"

// Copied from a Copilot SDK `edit` result (`result.detailedContent`).
const COPILOT = `
diff --git a/Users/x/env.js b/Users/x/env.js
index 0000000..0000000 100644
--- a/Users/x/env.js
+++ b/Users/x/env.js
@@ -1,4 +1,5 @@
-const ENV = {
+// shim
+window.ENV = {
   API_BASE_URL: "/api",
   DEFAULT_AI_PROVIDER: "openai",
 };
`

describe("parseUnified", () => {
  test("Copilot edit diff: path, numbers, counts", () => {
    const [f] = parseUnified(COPILOT)
    expect(f!.path).toBe("Users/x/env.js")
    expect(f!.op).toBe("edited")
    expect([f!.added, f!.removed]).toEqual([2, 1])
    expect(f!.lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ["del", 1, undefined], ["add", undefined, 1], ["add", undefined, 2], ["ctx", 2, 3], ["ctx", 3, 4], ["ctx", 4, 5],
    ])
  })
  test("new file and a removed line that starts with --", () => {
    const d = parseUnified("diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,1 @@\n+x\ndiff --git a/o.sql b/o.sql\n--- a/o.sql\n+++ b/o.sql\n@@ -1,2 +1,1 @@\n--- comment\n keep\n")
    expect(d.map((f) => [f.path, f.op, f.added, f.removed])).toEqual([["n.ts", "created", 1, 0], ["o.sql", "edited", 0, 1]])
    expect(d[1]!.lines[0]!.text).toBe("-- comment")
  })
  test("git diff inside bash output; plain text has none", () => {
    expect(hasUnified(`$ git diff\n${COPILOT}`)).toBe(true)
    expect(hasUnified("--- a heading\nno diff")).toBe(false)
  })
})

test("parsePatch: Codex apply_patch", () => {
  const d = parsePatch("*** Begin Patch\n*** Add File: a.ts\n+one\n*** Update File: b.ts\n@@ fn\n-x\n+y\n ctx\n*** Delete File: c.ts\n*** End Patch\n")
  expect(d.map((f) => [f.path, f.op, f.added, f.removed])).toEqual([["a.ts", "created", 1, 0], ["b.ts", "edited", 1, 1], ["c.ts", "deleted", 0, 0]])
})

test("lineDiff: removed before added in a block", () => {
  expect(lineDiff("a\nb\nc\n", "a\nB\nc\n").map((l) => `${l.kind}:${l.text}`)).toEqual(["ctx:a", "del:b", "add:B", "ctx:c"])
})

describe("toolDiffs", () => {
  test("result diff wins over args", () => {
    expect(toolDiffs("edit", { path: "p", old_str: "q", new_str: "r" }, COPILOT)[0]!.path).toBe("Users/x/env.js")
  })
  test("edit args when there is no result diff (Copilot old_str, Claude old_string)", () => {
    expect(toolDiffs("edit", { path: "p", old_str: "a", new_str: "b" }, "ok")[0]).toMatchObject({ path: "p", added: 1, removed: 1 })
    expect(toolDiffs("Edit", { file_path: "p", old_string: "a", new_string: "b" }, undefined)[0]).toMatchObject({ path: "p", added: 1, removed: 1 })
  })
  test("Pi multi-edit, create/write, apply_patch string args", () => {
    expect(toolDiffs("edit", { path: "p", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }, undefined)[0]!.lines.map((l) => l.kind)).toEqual(["del", "add", "gap", "del", "add"])
    expect(toolDiffs("create", { path: "n", file_text: "1\n2\n" }, undefined)[0]).toMatchObject({ op: "created", added: 2 })
    expect(toolDiffs("write", { path: "n", content: "1" }, undefined)[0]).toMatchObject({ op: "created", added: 1 })
    expect(toolDiffs("apply_patch", "*** Begin Patch\n*** Add File: z\n+1\n*** End Patch", undefined)[0]!.path).toBe("z")
  })
  test("read-only tools show nothing", () => {
    expect(toolDiffs("view", { path: "p" }, "1. text")).toEqual([])
  })
})

test("a read tool's context-only diff is no file change", () => {
  const read = "\ndiff --git a/src/main.rs b/src/main.rs\nindex 0000000..0000000 100644\n--- a/src/main.rs\n+++ b/src/main.rs\n@@ -21,2 +21,2 @@\n #[tokio::main]\n async fn main() {\n"
  expect(toolDiffs("view", { path: "/src/main.rs" }, read)).toEqual([])
})

test("wordRanges marks only the changed word", () => {
  expect(wordRanges("const ENV = {", "window.ENV = {")).toEqual({ del: [[0, 6]], add: [[0, 7]] })
})


describe("streaming tool calls", () => {
  test("partialArgs: raw custom input, complete JSON, unfinished JSON strings", () => {
    expect(partialArgs("*** Begin Patch\n*** Add File: a.txt\n+hi")).toEqual({ input: "*** Begin Patch\n*** Add File: a.txt\n+hi" })
    expect(partialArgs('{"path":"a.ts","file_text":"x"}')).toEqual({ path: "a.ts", file_text: "x" })
    expect(partialArgs('{"path":"a.ts","file_text":"line1\\nline2')).toEqual({ path: "a.ts", file_text: "line1\nline2" })
  })
  test("deltas build one tool item that execution_start completes", () => {
    const ev = (seq: number, type: string, data: any) => ({ seq, workerId: "w", type, agentId: null, timestamp: "2026-01-01T00:00:00Z", data })
    const partial = toTranscript([
      ev(1, "assistant.tool_call_delta", { toolCallId: "c1", toolName: "apply_patch", inputDelta: "*** Begin Patch\n*** Add File: a.txt\n" }),
      ev(2, "assistant.tool_call_delta", { toolCallId: "c1", inputDelta: "+one\n+two\n" }),
    ])
    expect(partial).toHaveLength(1)
    expect((partial[0] as any).args.input).toContain("+two")
    expect((partial[0] as any).done).toBe(false)
    const full = toTranscript([
      ev(1, "assistant.tool_call_delta", { toolCallId: "c1", toolName: "apply_patch", inputDelta: "*** Begin" }),
      ev(3, "tool.execution_start", { toolCallId: "c1", toolName: "apply_patch", arguments: { input: "final" } }),
      ev(4, "tool.execution_complete", { toolCallId: "c1", success: true, result: { content: "ok" } }),
    ])
    expect(full).toHaveLength(1)
    expect(full[0]).toMatchObject({ args: { input: "final" }, done: true })
  })
})

import { imagePaths } from "../toolcard"

describe("tool call images", () => {
  test("absolute image paths from args and result, once each", () => {
    expect(imagePaths({ command: "python3 save.py > /tmp/sf-artifacts/demo.png" }, "Saved /tmp/sf-artifacts/demo.png (708227 bytes)\nalso /a/b/c.JPG and rel.png")).toEqual(["/tmp/sf-artifacts/demo.png", "/a/b/c.JPG"])
    expect(imagePaths({}, "no images")).toEqual([])
  })
})
