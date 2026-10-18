import { fstatSync } from "node:fs"
import assert from "node:assert/strict"
import { openControllingTerminalInput } from "../../packages/trellage-launcher/src/controlling-terminal-input.ts"
for await (const chunk of process.stdin) {
}
const input = openControllingTerminalInput()
assert.ok("fd" in input && typeof input.fd === "number")
const descriptor = input.fd
input.setEncoding("utf8")
input.setRawMode(true)
let received = ""
input.on("readable", () => {
  let chunk: string | null
  while ((chunk = input.read()) !== null) {
    received += chunk
    if (received.endsWith("\n")) {
      input.setRawMode(false)
      input.destroy()
      break
    }
  }
})
input.once("close", () => {
  let closed = false
  try {
    fstatSync(descriptor)
  } catch (error) {
    closed = (error as NodeJS.ErrnoException).code === "EBADF"
  }
  process.stdout.write(JSON.stringify({ received, closed }) + "\n")
})
process.stdout.write("READY\n")
