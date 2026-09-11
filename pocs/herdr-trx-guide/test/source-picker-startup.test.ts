import assert from "node:assert/strict"
import test from "node:test"
import { PassThrough } from "node:stream"
import { main } from "../custom-popup.ts"
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const setup = () => {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} })
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 88, rows: 20 })
  let rendered = ""
  output.on("data", chunk => { rendered += chunk.toString() })
  const sources = Object.fromEntries(["queue", "clipboard", "capture", "rewrite"].map(name => [name, deferred()]))
  const started = []
  const read = name => () => { assert.match(rendered, /TRX actions/); assert.match(rendered, /loading/); started.push(name); return sources[name].promise }
  const run = main({ input, output, context: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", cwd: "/repo", agent: "copilot" }, env: { HERDR_PLUGIN_STATE_DIR: "/unused" }, queueReader: read("queue"), clipboardReader: read("clipboard"), captureInspector: read("capture"), contextMenuCapture: read("rewrite") })
  return { input, output, run, sources, started, screen: () => rendered.slice(rendered.lastIndexOf("\x1b[2J")), all: () => rendered }
}
test("paints before every read, shows incremental failures, and ignores completions after Escape", async () => {
  const ui = setup()
  assert.equal(ui.started.length, 4)
  ui.sources.clipboard.resolve({ ok: false, message: "CLIPBOARD_FAILED" })
  ui.sources.capture.resolve({ choices: [], notes: ["CAPTURE_FAILED"] })
  await tick()
  assert.match(ui.screen(), /CLIPBOARD_FAILED/)
  assert.match(ui.screen(), /CAPTURE_FAILED/)
  assert.match(ui.screen(), /rewrite: loading/)
  ui.input.emit("keypress", "", { name: "escape" })
  assert.equal(await ui.run, 0)
  const closed = ui.all()
  ui.sources.rewrite.resolve({ kind: "context-menu-error", error: { message: "late" } })
  ui.sources.queue.resolve({ schemaVersion: 1, entries: [] })
  await tick()
  assert.equal(ui.all(), closed)
})
test("keeps the selected identity as earlier choices arrive and avoids overlapping rows", async () => {
  const ui = setup()
  ui.sources.capture.resolve({ choices: Array.from({ length: 6 }, (_, i) => ({ kind: "terminal", paneId: String(i), label: `Choice ${i}`, detail: "detail", preview: "line1\nline2\nline3\nline4" })), notes: [] })
  await tick()
  ui.input.emit("keypress", "j", { name: "j" })
  ui.sources.clipboard.resolve({ ok: true, value: "clipboard" })
  await tick()
  assert.match(ui.screen(), /> Choice 1/)
  for (const rows of [18, 20]) {
    ui.output.rows = rows; ui.output.emit("resize")
    const positions = [...ui.screen().matchAll(/\x1b\[(\d+);3H/g)].map(match => Number(match[1]))
    assert.equal(new Set(positions).size, positions.length, `overlapping terminal rows at ${rows}`)
  }
  ui.input.emit("keypress", "", { name: "escape" })
  await ui.run
})

test("invokes the capture inspector for each fresh popup and exposes no analysis source", async () => {
  const first = setup()
  assert.equal(first.started.filter((name) => name === "capture").length, 1)
  first.sources.capture.resolve({ choices: [], notes: [] })
  first.sources.clipboard.resolve({ ok: false, message: "none" })
  first.sources.rewrite.resolve({ kind: "context-menu-error", error: { message: "none" } })
  first.sources.queue.resolve({ schemaVersion: 1, entries: [] })
  first.input.emit("keypress", "", { name: "escape" })
  await first.run

  const second = setup()
  assert.equal(second.started.filter((name) => name === "capture").length, 1)
  assert.doesNotMatch(second.screen(), /conversation|next-steps|analysis/iu)
  second.input.emit("keypress", "", { name: "escape" })
  await second.run
})
