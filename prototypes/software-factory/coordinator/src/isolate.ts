// Agent runtimes run in their own process group (session), so a `kill 0` or `kill -- -$PGID` in a worker's tool
// tree (a test harness or a script cleaning up its background processes) cannot reach the coordinator.
import { spawn, type SpawnOptions as NodeSpawnOptions } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
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
export const spawnIsolated = (o: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }) =>
  spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, detached: true, stdio: ["pipe", "pipe", "pipe"] } satisfies NodeSpawnOptions)
