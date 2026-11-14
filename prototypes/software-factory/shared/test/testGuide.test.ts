import { expect, test } from "bun:test"
import { decodeGuide, guideMarkdown, setupScript } from "../testGuide.ts"

const reply = {
  setup: ["bun install", "PORT=7811 bun run dev"],
  steps: [
    { do: "Open the page", command: "open http://localhost:7811", expect: "the header shows How to test" },
    { do: "Click Rewrite", expect: "the pin says writing…" },
  ],
  cleanup: ["pkill -f 'bun run dev'"],
}

test("decodes a fenced JSON reply", () => {
  expect(decodeGuide("```json\n" + JSON.stringify(reply) + "\n```")).toEqual(reply)
})

test("a reply without steps or not JSON is an error that says why", () => {
  expect(() => decodeGuide(JSON.stringify({ ...reply, steps: [] }))).toThrow("wrong shape")
  expect(() => decodeGuide("Here is how to test it")).toThrow("not JSON")
})

test("markdown has the commit, setup block, numbered steps with expectations and cleanup", () => {
  const md = guideMarkdown({ ...reply, commit: "abcdef123456" })
  expect(md).toContain("`abcdef1`")
  expect(md).toContain("```sh\nbun install\nPORT=7811 bun run dev\n```")
  expect(md).toContain("1. Open the page\n   `open http://localhost:7811`\n   → the header shows How to test")
  expect(md).toContain("2. Click Rewrite\n   → the pin says writing…")
  expect(md).toContain("**Cleanup**")
})

test("setup script stops at the first failure and echoes each command", () => {
  expect(setupScript(["a", "b"])).toBe("#!/usr/bin/env bash\nset -ex\na\nb\n")
})
