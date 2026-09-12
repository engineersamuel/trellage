import { closeSync, openSync } from "node:fs"
import { spawnSync } from "node:child_process"

const [entry, stdoutPath, stderrPath, ...extra] = process.argv.slice(2)
if (entry === undefined || stdoutPath === undefined || stderrPath === undefined || extra.length !== 0) {
  throw new Error("expected entrypoint, stdout path and stderr path")
}
const stdout = openSync(stdoutPath, "w")
const stderr = openSync(stderrPath, "w")
try {
  const result = spawnSync(entry, ["new", "claude", "--print", "hello"], {
    env: process.env,
    stdio: ["ignore", stdout, stderr],
  })
  if (result.error !== undefined) throw result.error
  process.exitCode = result.signal === "SIGKILL" ? 1 : (result.status ?? 1)
} finally {
  closeSync(stdout)
  closeSync(stderr)
}
