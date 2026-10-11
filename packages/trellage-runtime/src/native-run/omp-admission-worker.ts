import { spawn } from "node:child_process"
import { descendantsOf, signalIdentity } from "./process-tree.ts"

// This process is the private group leader. It stays alive after the manager
// exits, so the caller can identify orphaned admission workers before cleanup.
const cleanAfterDisconnect = async (): Promise<void> => {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const identity of descendantsOf(process.pid, true)) signalIdentity(identity, signal)
    const deadline = Date.now() + 1_000
    while (descendantsOf(process.pid, true).length > 0 && Date.now() < deadline) await Bun.sleep(10)
  }
  if (descendantsOf(process.pid, true).length === 0) process.exit(1)
}

let started = false
process.on("disconnect", () => {
  void cleanAfterDisconnect().catch((error) => console.error(`OMP admission cleanup failed: ${String(error)}`))
})
process.on("message", (message) => {
  if (message !== "start" || started) return
  started = true
  const [command, ...args] = process.argv.slice(2)
  if (!command) throw new Error("OMP admission command is missing")
  const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] })
  child.once("error", (error) => process.send?.({ error: error.message }))
  child.once("exit", (status, signal) => process.send?.({ status, signal }))
})
