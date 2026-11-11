// Agent runtimes run in their own process group (session), so a `kill 0` or `kill -- -$PGID` in a worker's tool
// tree (a test harness or a script cleaning up its background processes) cannot reach the coordinator.
import { spawn, type SpawnOptions as NodeSpawnOptions } from "node:child_process"
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * A launcher that starts `binary` in a new session (perl's POSIX::setsid, present on macOS and Linux) and replaces
 * itself with it, so stdio, exit codes and signals from the SDK reach the runtime unchanged.
 */
export const isolatedLauncher = (dir: string, binary: string): string => {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "isolated-runtime")
  const script = `#!/bin/sh\n# Start the runtime in its own process group (see coordinator/src/isolate.ts).\nexec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec: $!"' ${JSON.stringify(binary)} "$@"\n`
  if (!existsSync(file) || Bun.file(file).size !== script.length) writeFileSync(file, script)
  chmodSync(file, 0o755)
  return file
}

/** The Claude Agent SDK's spawn hook: the same process, detached into its own process group. */
export const spawnIsolated = (o: {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string | undefined>
  signal: AbortSignal
}) =>
  spawn(o.command, o.args, {
    cwd: o.cwd,
    env: o.env,
    signal: o.signal,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  } satisfies NodeSpawnOptions)

/** The runtimes this state folder started, one pid per line. Only these may be cleaned up at the next start. */
const pidFile = (root: string) => path.join(root, "runtime.pids")

/** Remember a runtime this coordinator started, so the next coordinator on the same state folder can stop it. */
export const recordRuntime = (root: string, pid: number): void => appendFileSync(pidFile(root), `${pid}\n`)

/**
 * Stop the runtimes a previous coordinator on this state folder left behind, and forget them. A pid is stopped only
 * when it still runs the Copilot runtime (pids are reused). Runtimes of other state folders are not touched.
 */
export const reapRuntimes = (root: string, command = (pid: number) => commandOf(pid)): number[] => {
  const file = pidFile(root)
  if (!existsSync(file)) return []
  const pids = [
    ...new Set(
      readFileSync(file, "utf8")
        .split("\n")
        .map(Number)
        .filter((n) => n > 0),
    ),
  ]
  const reaped = pids.filter((pid) => {
    if (!command(pid)?.includes("copilot-runtime")) return false
    try {
      process.kill(pid, "SIGTERM")
      return true
    } catch {
      return false
    }
  })
  writeFileSync(file, "")
  return reaped
}

/** The command line of a running pid, or null when it is gone. */
const commandOf = (pid: number): string | null => {
  const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)])
  return r.exitCode === 0 ? r.stdout.toString().trim() : null
}
