import { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { lifecycleRuntime } from "./lifecycle-runtime.ts"
import { nativePresetProfiles } from "./presets.ts"

interface Owner {
  scope: string
  operation: string
  pid: number
  started: string
  child_pid: number | null
  child_started: string | null
  descendants: string
}

interface ProcessIdentity {
  pid: number
  started: string
}
const processEnvironment = () => ({ ...process.env, TZ: "UTC", LC_ALL: "C" })

const processStart = (pid: number): string | null => {
  try {
    return (
      execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: processEnvironment(),
      }).trim() || null
    )
  } catch {
    return null
  }
}

const descendantsOf = (root: number): ProcessIdentity[] => {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,lstart="], { encoding: "utf8", env: processEnvironment() })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), started: match[3]! }] : []
    })
  const parents = new Set([root])
  const result: ProcessIdentity[] = []
  for (;;) {
    const children = rows.filter((row) => parents.has(row.parent) && !parents.has(row.pid))
    if (children.length === 0) return result
    for (const row of children) {
      parents.add(row.pid)
      result.push({ pid: row.pid, started: row.started })
    }
  }
}

const signalIdentity = (identity: ProcessIdentity, signal: NodeJS.Signals) => {
  if (processStart(identity.pid) !== identity.started) return
  try {
    process.kill(identity.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

const descendantsLive = (owner: Owner): boolean =>
  (JSON.parse(owner.descendants) as ProcessIdentity[]).some(({ pid, started }) => live(pid, started))

const live = (pid: number, started: string): boolean => {
  if (pid === 0) return false
  // A negative child ID records a detached maintenance process group. Its workers
  // can outlive the group leader, so retain ownership until the entire group exits.
  if (pid < 0) {
    const leader = processStart(-pid)
    if (leader !== null && leader !== started) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH"
    }
  }
  const current = processStart(pid)
  if (current !== null) return current === started
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

export const profileGuardProfiles = (operation: string, harness: string, args: readonly string[]): string[] => {
  const runtime = lifecycleRuntime(harness)
  if (!runtime) throw new Error(`unknown managed profile harness: ${harness}`)
  const profiles = nativePresetProfiles(harness)
  // Firstmate's per-instance mutation gate and fleet session lock already protect
  // publication, including workers that outlive their captain. Shared writers use
  // its registry-wide maintenance lease; a preset guard would conflate UUID homes.
  if (harness === "firstmate") return []
  if (operation === "upgrade" && args.includes("--check")) return []
  if (
    ![
      "run",
      "setup",
      "repair",
      "doctor",
      "skills-update",
      "upgrade",
      "harness-update",
      "prepare",
      "submit",
      "skill",
    ].includes(operation)
  )
    return []
  const selected = args.find((arg) => profiles.includes(arg as never))
  // Harness upgrades replace shared executables even when a profile argument is present.
  if (
    args.includes("--all") ||
    args.includes("all") ||
    !selected ||
    operation === "harness-update" ||
    (operation === "upgrade" && !args.includes("--skills-only"))
  )
    return [...profiles].sort()
  return [selected]
}

export interface ProfileGuard {
  readonly attachChild: (pid: number, processGroup?: boolean) => void
  readonly signalTree: (pid: number, signal: NodeJS.Signals) => void
  readonly release: () => void
}

/** Lifecycle managers publish into persistent homes, so mutations hold exclusive ownership. */
export const acquireProfileGuard = (
  harness: string,
  presets: readonly string[],
  operation: string,
  home = process.env.HOME ?? os.homedir(),
): ProfileGuard => {
  if (presets.length === 0)
    return {
      attachChild: () => {},
      signalTree: (pid, signal) => {
        try {
          process.kill(pid, signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      },
      release: () => {},
    }
  const runtime = lifecycleRuntime(harness)
  const profiles = nativePresetProfiles(harness)
  if (!runtime || presets.some((preset) => !profiles.includes(preset as never)))
    throw new Error("invalid profile guard scope")
  let directory = realpathSync(home)
  for (const component of [".local", "share", "trellage", "profile-guards"]) {
    directory = path.join(directory, component)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const status = lstatSync(directory)
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      status.uid !== process.getuid?.() ||
      (status.mode & 0o022) !== 0
    )
      throw new Error(`unsafe profile guard directory: ${directory}`)
  }
  const file = path.join(directory, "profiles.sqlite")
  if (existsSync(file)) {
    const status = lstatSync(file)
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      status.uid !== process.getuid?.() ||
      (status.mode & 0o022) !== 0
    )
      throw new Error(`unsafe profile guard database: ${file}`)
  }
  const db = new Database(file, { create: true })
  db.exec("PRAGMA busy_timeout = 5000")
  chmodSync(file, 0o600)
  const token = randomUUID()
  const started = processStart(process.pid)
  try {
    if (started === null) throw new Error("cannot determine profile guard process identity")
    db.exec(
      "CREATE TABLE IF NOT EXISTS owners (scope TEXT PRIMARY KEY, operation TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL, child_pid INTEGER, child_started TEXT, token TEXT NOT NULL, descendants TEXT NOT NULL DEFAULT '[]')",
    )
    db.exec("BEGIN IMMEDIATE")
    try {
      if (
        !db
          .query<{ name: string }, []>("PRAGMA table_info(owners)")
          .all()
          .some((column) => column.name === "descendants")
      )
        db.exec("ALTER TABLE owners ADD COLUMN descendants TEXT NOT NULL DEFAULT '[]'")
      for (const preset of [...new Set(presets)].sort()) {
        const scope = `${harness}/${runtime.profileName(preset)}`
        const owner = db.query<Owner, [string]>("SELECT * FROM owners WHERE scope = ?").get(scope)
        if (
          owner &&
          (live(owner.pid, owner.started) ||
            (owner.child_pid !== null && owner.child_started !== null && live(owner.child_pid, owner.child_started)) ||
            descendantsLive(owner))
        )
          throw new Error(
            `profile busy: ${harness} ${preset} is owned by ${owner.operation} (pid ${Math.abs(owner.child_pid ?? owner.pid)}); finish that operation or shut down its session, then retry`,
          )
        db.query("INSERT OR REPLACE INTO owners (scope, operation, pid, started, token) VALUES (?, ?, ?, ?, ?)").run(
          scope,
          operation,
          process.pid,
          started,
          token,
        )
      }
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  } catch (error) {
    db.close()
    throw error
  }
  let released = false
  return {
    signalTree: (pid, signal) => {
      const started = processStart(pid)
      if (started === null) return
      const stopped = new Map<number, ProcessIdentity>([[pid, { pid, started }]])
      try {
        signalIdentity({ pid, started }, "SIGSTOP")
        for (;;) {
          const children = descendantsOf(pid).filter((identity) => !stopped.has(identity.pid))
          if (children.length === 0) break
          for (const identity of children) {
            stopped.set(identity.pid, identity)
            signalIdentity(identity, "SIGSTOP")
          }
        }
        const owner = db.query<Owner, [string]>("SELECT * FROM owners WHERE token = ? LIMIT 1").get(token)
        const previous = owner ? (JSON.parse(owner.descendants) as ProcessIdentity[]) : []
        const identities = [...previous, ...stopped.values()]
        db.query("UPDATE owners SET descendants = ? WHERE token = ?").run(JSON.stringify(identities), token)
        for (const identity of [...stopped.values()].reverse()) signalIdentity(identity, signal)
      } finally {
        for (const identity of stopped.values()) signalIdentity(identity, "SIGCONT")
      }
    },
    attachChild: (pid, processGroup = false) => {
      const childStarted = processStart(pid)
      if (childStarted !== null || processGroup)
        db.query("UPDATE owners SET child_pid = ?, child_started = ? WHERE token = ?").run(
          processGroup ? -pid : pid,
          childStarted ?? "exited group leader",
          token,
        )
    },
    release: () => {
      if (released) return
      released = true
      try {
        const owner = db.query<Owner, [string]>("SELECT * FROM owners WHERE token = ? LIMIT 1").get(token)
        if (
          owner &&
          (descendantsLive(owner) ||
            (owner?.child_pid !== null &&
              owner?.child_pid !== undefined &&
              owner.child_pid < 0 &&
              owner.child_started !== null &&
              live(owner.child_pid, owner.child_started)))
        )
          db.query("UPDATE owners SET pid = 0, started = '' WHERE token = ?").run(token)
        else db.query("DELETE FROM owners WHERE token = ?").run(token)
      } finally {
        db.close()
      }
    },
  }
}
