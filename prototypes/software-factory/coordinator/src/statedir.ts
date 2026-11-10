// Where the factory keeps its state, and the one-time move out of $TMPDIR.
// The default was $TMPDIR/software-factory: shared by every git worktree, but macOS cleans $TMPDIR. The default is
// now $XDG_STATE_HOME/trellage/factory (~/.local/state/trellage/factory), beside ~/.config/trellage/factory.
// SF_STATE_DIR still overrides both.
// Run as a script (mise factory:up) before anything creates the new folder: `bun src/statedir.ts`.
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

type Env = Record<string, string | undefined>

export const legacyStateDir = (tmp = tmpdir()): string => path.join(tmp, "software-factory")

export const defaultStateDir = (env: Env = process.env, home = homedir()): string =>
  path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "trellage", "factory")

export const stateDir = (env: Env = process.env, home = homedir()): string => env.SF_STATE_DIR || defaultStateDir(env, home)

/** Worktree folders in the state (runs/<id>, worktrees/<repo>/<id>): each has a `.git` file that points at its repo. */
const gitWorktrees = (root: string): string[] =>
  ["runs", "worktrees"].flatMap((top) => {
    const walk = (dir: string, depth: number): string[] =>
      !existsSync(dir)
        ? []
        : readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
            if (!d.isDirectory()) return []
            const p = path.join(dir, d.name)
            return existsSync(path.join(p, ".git")) && lstatSync(path.join(p, ".git")).isFile() ? [p] : depth > 0 ? walk(p, depth - 1) : []
          })
    return walk(path.join(root, top), 1)
  })

/** Point the repo's worktree records at the moved folders. A repo that is gone is skipped. */
const repairWorktrees = (root: string): void => {
  for (const wt of gitWorktrees(root)) {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(path.join(wt, ".git"), "utf8"))?.[1]?.trim()
    const commonDir = gitdir && path.resolve(gitdir, "..", "..")
    if (!commonDir || !existsSync(commonDir)) continue
    try {
      execFileSync("git", ["--git-dir", commonDir, "worktree", "repair", wt], { stdio: "ignore" })
    } catch {
      // A broken record stays broken; the folder and its files are still there.
    }
  }
}

/** threads.json keeps absolute worktree paths; rewrite the ones inside the old folder. */
const rewriteThreads = (root: string, from: string[]): void => {
  const file = path.join(root, "threads.json")
  if (!existsSync(file)) return
  const text = readFileSync(file, "utf8")
  const next = from.reduce((t, old) => t.split(JSON.stringify(old).slice(1, -1)).join(JSON.stringify(root).slice(1, -1)), text)
  if (next !== text) writeFileSync(file, next)
}

/**
 * Move the old state folder to `target` once, and leave a symlink at the old path, so an older checkout that still
 * uses $TMPDIR finds the same data. Does nothing when `target` exists or the old folder is missing or already a link.
 * Returns true when it moved the folder.
 */
export const migrateLegacyState = (target: string, legacy = legacyStateDir()): boolean => {
  if (path.resolve(target) === path.resolve(legacy) || existsSync(target) || !existsSync(legacy) || lstatSync(legacy).isSymbolicLink()) return false
  mkdirSync(path.dirname(target), { recursive: true })
  try {
    renameSync(legacy, target)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e
    cpSync(legacy, target, { recursive: true, verbatimSymlinks: true })
    rmSync(legacy, { recursive: true, force: true })
  }
  symlinkSync(target, legacy)
  // macOS: $TMPDIR is /var/folders/…, and /var is a link to /private/var; old files hold either spelling.
  rewriteThreads(target, [legacy.replace(/\/$/, ""), path.join("/private", legacy).replace(/\/$/, "")])
  repairWorktrees(target)
  return true
}

if (import.meta.main) {
  if (process.env.SF_STATE_DIR) process.exit(0)
  const target = defaultStateDir()
  if (migrateLegacyState(target)) console.log(`software-factory state moved: ${legacyStateDir()} -> ${target} (old path is now a link)`)
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * One coordinator per state folder: two would write the same SQLite files and threads.json. Writes `coordinator.lock`
 * with this process id. Throws when another live process holds it; a lock left by a dead process is taken over.
 * `bun --watch` reloads in the same process, so a reload keeps its own lock.
 */
export const acquireStateLock = (root: string, pid = process.pid): void => {
  const file = path.join(root, "coordinator.lock")
  mkdirSync(root, { recursive: true })
  const holder = existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : NaN
  if (Number.isInteger(holder) && holder !== pid && isAlive(holder))
    throw new Error(`another coordinator (pid ${holder}) uses ${root}. Stop it first (mise run factory:down), or set SF_STATE_DIR to another folder.`)
  writeFileSync(file, String(pid))
}
