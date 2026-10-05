import { fileURLToPath } from "node:url"
import { bunArguments, bunExecutable } from "@trellage/runtime"
import { createNodeCommandRunner, runInteractiveTerminalCommand } from "../../src/guide-launch.ts"

const entry = fileURLToPath(import.meta.url)
const mode = process.argv[2]

if (mode === "child") {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY)
    throw new Error("The interactive child requires three terminal streams.")
  process.stdin.setEncoding("utf8")
  process.stdin.setRawMode(true)
  try {
    await new Promise<void>((resolve, reject) => {
      let input = ""
      const receive = (chunk: string) => {
        input += chunk
        if (!input.includes("\r")) return
        process.stdin.off("data", receive)
        if (input !== "terminal-proof\r") reject(new Error(`Unexpected terminal input: ${JSON.stringify(input)}`))
        else resolve()
      }
      process.stdin.once("error", reject)
      process.stdin.on("data", receive)
      process.stdout.write("TERMINAL INPUT READY\n")
    })
    process.stdout.write("TERMINAL INPUT ACCEPTED\n")
  } finally {
    process.stdin.pause()
    process.stdin.setRawMode(false)
  }
} else if (mode === "redirected") {
  await createNodeCommandRunner().run(bunExecutable(), bunArguments(entry, ["piped-parent"]), {
    timeoutMs: 5000,
  })
} else if (mode === "inherited" || mode === "piped-parent") {
  if (mode === "piped-parent" && (process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY))
    throw new Error("The intermediate parent must have redirected streams.")
  await runInteractiveTerminalCommand({
    executable: bunExecutable(),
    args: bunArguments(entry, ["child"]),
  })
} else {
  throw new Error(`Unknown terminal fixture mode: ${mode}`)
}
