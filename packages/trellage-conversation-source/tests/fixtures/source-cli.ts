import { writeFile } from "node:fs/promises"
import path from "node:path"
import { runConversationSourceCli } from "../../src/cli.ts"
import { readConversationRequest } from "../../src/conversation-state.ts"

const [operation, requestPath, mode] = process.argv.slice(2)
const state = process.env.HERDR_PLUGIN_STATE_DIR
if (state === undefined || requestPath === undefined || operation === undefined) {
  throw new Error("Synthetic CLI arguments are missing.")
}
const original = await readConversationRequest(state, requestPath)

const waitForCancellation = async (signal: AbortSignal) => {
  let abort: () => void = () => {}
  const timer = setInterval(() => {}, 1_000)
  try {
    await new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      else process.send?.("capture-ready")
    })
  } finally {
    clearInterval(timer)
    signal.removeEventListener("abort", abort)
    await writeFile(path.join(state, "cleanup.receipt"), "clean", { mode: 0o600 })
  }
}

process.exitCode = await runConversationSourceCli([operation, requestPath], {
  capture: async (_context, { signal } = {}) => {
    if (mode === "failure") throw new Error("EXCLUDED_SYNTHETIC_MODEL_AND_INPUT")
    if (mode === "wait") {
      if (signal === undefined) throw new Error("Synthetic cancellation signal is missing.")
      await waitForCancellation(signal)
    }
    return original
  },
})
