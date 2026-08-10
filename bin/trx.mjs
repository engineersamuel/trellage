#!/usr/bin/env node
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = path.join(repositoryRoot, "prototypes", "trellage-router")
const command = path.join(sourceRoot, "bin", "trx")
const child = spawn(command, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, TRELLAGE_TRX_SOURCE_ROOT: sourceRoot },
})

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal))
}

child.on("error", (error) => {
  process.stderr.write(`trx: ${error.message}\n`)
  process.exitCode = 1
})
child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
