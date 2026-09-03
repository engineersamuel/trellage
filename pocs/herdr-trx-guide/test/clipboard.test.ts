import assert from "node:assert/strict"
import test from "node:test"

import { readClipboard } from "../lib/clipboard.ts"

test("reads the first available Linux clipboard adapter", () => {
  const calls = []
  const result = readClipboard({
    platform: "linux",
    run: (command, args) => {
      calls.push([command, args])
      if (command === "wl-paste") return { status: 1, stdout: "" }
      return { status: 0, stdout: "Highlighted text" }
    },
  })
  assert.deepEqual(result, { ok: true, value: "Highlighted text" })
  assert.deepEqual(calls, [
    ["wl-paste", ["--no-newline"]],
    ["xclip", ["-selection", "clipboard", "-out"]],
  ])
})

test("reports when no clipboard reader succeeds", () => {
  assert.deepEqual(
    readClipboard({
      platform: "darwin",
      run: () => ({ status: 1, stdout: "" }),
    }),
    { ok: false, message: "No supported clipboard reader is available" },
  )
})
