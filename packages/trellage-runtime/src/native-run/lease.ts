import { execFile } from "node:child_process"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { NativeRunPaths } from "./paths.ts"

const execFilePromise = promisify(execFile)

const processStart = async (pid: number): Promise<string | null> => {
  try {
    return (await execFilePromise("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" })).stdout.trim() || null
  } catch {
    return null
  }
}

const leaseDirectory = (paths: NativeRunPaths, generationId: string): string =>
  path.join(paths.state, "leases", generationId)

export interface Lease {
  readonly release: () => Promise<void>
}

/** Record that this process uses a generation. Liveness is checked by pid plus process start time. */
export const acquireLease = async (paths: NativeRunPaths, generationId: string, pid = process.pid): Promise<Lease> => {
  const directory = leaseDirectory(paths, generationId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, `${pid}.json`)
  await writeFile(file, JSON.stringify({ pid, started: await processStart(pid) }), { mode: 0o600 })
  return { release: () => rm(file, { force: true }) }
}

export const hasLiveLease = async (paths: NativeRunPaths, generationId: string): Promise<boolean> => {
  const directory = leaseDirectory(paths, generationId)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return false
  }
  let live = false
  for (const name of names) {
    const file = path.join(directory, name)
    try {
      const lease = JSON.parse(await readFile(file, "utf8")) as { pid: number; started: string | null }
      if ((await processStart(lease.pid)) !== null && (await processStart(lease.pid)) === lease.started) live = true
      else await rm(file, { force: true })
    } catch {
      await rm(file, { force: true })
    }
  }
  return live
}

/** Keep the newest generations of a composition and never collect one with a live lease. */
export const pruneGenerations = async (
  paths: NativeRunPaths,
  ownerHome: string,
  keep: number,
  protectedGeneration: string,
): Promise<string[]> => {
  const root = path.join(ownerHome, "generations")
  let names: string[]
  try {
    names = (await readdir(root)).filter((name) => !name.startsWith("."))
  } catch {
    return []
  }
  const dated = await Promise.all(names.map(async (name) => ({ name, time: (await stat(path.join(root, name))).mtimeMs })))
  dated.sort((a, b) => b.time - a.time)
  const removed: string[] = []
  for (const { name } of dated.slice(keep)) {
    if (name === protectedGeneration || (await hasLiveLease(paths, name))) continue
    await rm(path.join(root, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}
