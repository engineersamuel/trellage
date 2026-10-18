import assert from "node:assert/strict"
import path from "node:path"
import { spawnSourcePty, type SourcePtyExit } from "../../packages/trellage-launcher/test/helpers/source-pty.ts"
const root = path.resolve(import.meta.dir, "../..")
const text = "x".repeat(4095) + "界" + "y".repeat(5000) + "\n"
const child = spawnSourcePty(
  "/bin/bash",
  [
    "-c",
    'exec "$@" </dev/null',
    "input-probe",
    process.execPath,
    path.join(import.meta.dir, "controlling-input-child.ts"),
  ],
  {
    name: "xterm",
    cols: 80,
    rows: 25,
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TRELLAGE_TEST_OFFLINE: process.env.TRELLAGE_TEST_OFFLINE },
  },
)
let output = "",
  exit: SourcePtyExit | undefined,
  sent = false
child.onExit((value) => {
  exit = value
})
child.onData((value) => {
  output += value
  if (output.includes("READY") && !sent) {
    sent = true
    child.write(text)
  }
})
const deadline = Date.now() + 5000
try {
  while (!exit && Date.now() < deadline) await Bun.sleep(20)
  assert.deepEqual(exit, { exitCode: 0, signal: 0 }, output.slice(-2000))
  const result = JSON.parse(output.split("\n").find((line) => line.startsWith("{"))!)
  assert.equal(result.received, text)
  assert.equal(result.closed, true)
  console.log(
    "Controlling terminal input PASS: 9097 characters, Unicode preserved, descriptor closed, process exits",
  )
} finally {
  if (!exit) {
    child.kill()
    while (!exit) await Bun.sleep(20)
  }
}
