import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { bunArguments, bunExecutable } from "@trellage/runtime"
import { runInteractiveTerminalCommand } from "../../src/guide-launch.ts"

const marker = process.argv[2]
if (marker === undefined) throw new Error("Missing terminal proof path")
if (process.argv[3] === "child") {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
    throw new Error("Interactive child did not receive terminal streams")
  }
  await writeFile(marker, "piped-parent-to-terminal-child")
} else {
  if (process.stdin.isTTY || process.stdout.isTTY)
    throw new Error("Transport fixture requires redirected parent streams")
  await runInteractiveTerminalCommand(
    {
      executable: bunExecutable(),
      args: bunArguments(fileURLToPath(import.meta.url), [marker, "child"]),
    },
    { cwd: path.dirname(marker), env: process.env },
  )
}
