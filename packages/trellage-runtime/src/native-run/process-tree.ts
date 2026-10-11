import { execFileSync } from "node:child_process"

export interface ProcessIdentity {
  pid: number
  started: string
}

const processEnvironment = () => ({ ...process.env, TZ: "UTC", LC_ALL: "C" })

export const processStart = (pid: number): string | null => {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", env: processEnvironment(),
    }).trim() || null
  } catch {
    return null
  }
}

export const descendantsOf = (root: number, ownedGroup = false): ProcessIdentity[] => {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8", env: processEnvironment(),
  }).split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), started: match[4]! }] : []
  })
  // A live, validated group leader keeps its group ID reserved even when an
  // admission worker exits and its children are reparented outside the tree.
  const members = ownedGroup ? rows.filter((row) => row.group === root && row.pid !== root) : []
  const parents = new Set([root, ...members.map(({ pid }) => pid)])
  const result: ProcessIdentity[] = members.map(({ pid, started }) => ({ pid, started }))
  for (;;) {
    const children = rows.filter((row) => parents.has(row.parent) && !parents.has(row.pid))
    if (children.length === 0) return result
    for (const row of children) {
      parents.add(row.pid)
      result.push({ pid: row.pid, started: row.started })
    }
  }
}

export const signalIdentity = (identity: ProcessIdentity, signal: NodeJS.Signals): void => {
  if (processStart(identity.pid) !== identity.started) return
  try {
    process.kill(identity.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}
