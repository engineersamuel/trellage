import assert from "node:assert/strict"
import test from "node:test"

import { readClipboard, readClipboardAsync } from "../lib/clipboard.ts"

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

test("reads clipboard asynchronously without blocking the event loop and tries adapters independently", async () => {
  const calls = []
  const result = await readClipboardAsync({
    platform: "linux",
    exec: (command, args, options, callback) => {
      calls.push(command)
      setImmediate(() => callback(command === "wl-paste" ? new Error("missing") : null, command === "xclip" ? "ready" : ""))
    },
  })
  assert.deepEqual(result, { ok: true, value: "ready" })
  assert.deepEqual(calls, ["wl-paste", "xclip"])
})

test("reports an asynchronous clipboard failure after every adapter fails", async () => {
  const result = await readClipboardAsync({
    platform: "darwin",
    exec: (_command, _args, _options, callback) => setImmediate(() => callback(new Error("unavailable"), "")),
  })
  assert.deepEqual(result, { ok: false, message: "No supported clipboard reader is available" })
})
