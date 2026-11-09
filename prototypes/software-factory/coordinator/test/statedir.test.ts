import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { acquireStateLock, defaultStateDir, migrateLegacyState, stateDir } from "../src/statedir.ts"

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()

test("the state lives outside $TMPDIR unless SF_STATE_DIR says otherwise", () => {
  expect(defaultStateDir({}, "/home/a")).toBe("/home/a/.local/state/trellage/factory")
  expect(defaultStateDir({ XDG_STATE_HOME: "/x" }, "/home/a")).toBe("/x/trellage/factory")
  expect(stateDir({ SF_STATE_DIR: "/s" }, "/home/a")).toBe("/s")
})

test("the old folder moves once, keeps a link, and its git worktrees and threads follow", () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "sf-statedir-")))
  const legacy = path.join(base, "tmp", "software-factory")
  const target = path.join(base, "state", "software-factory")
  const repo = path.join(base, "repo")
  mkdirSync(repo, { recursive: true })
  git(repo, "init", "-q")
  git(repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x")
  mkdirSync(path.join(legacy, "runs"), { recursive: true })
  git(repo, "worktree", "add", "-q", path.join(legacy, "runs", "run-1"))
  writeFileSync(path.join(legacy, "events.db"), "db")
  writeFileSync(path.join(legacy, "threads.json"), JSON.stringify({ threads: [{ id: "t", worktree: path.join(legacy, "worktrees", "r", "t") }] }))

  expect(migrateLegacyState(target, legacy)).toBe(true)
  expect(readFileSync(path.join(target, "events.db"), "utf8")).toBe("db")
  expect(lstatSync(legacy).isSymbolicLink()).toBe(true)
  expect(JSON.parse(readFileSync(path.join(target, "threads.json"), "utf8")).threads[0].worktree).toBe(path.join(target, "worktrees", "r", "t"))
  expect(git(repo, "worktree", "list")).toContain(path.join(target, "runs", "run-1"))
  expect(git(path.join(target, "runs", "run-1"), "rev-parse", "--is-inside-work-tree")).toBe("true")

  // Second start: nothing to do.
  expect(migrateLegacyState(target, legacy)).toBe(false)
  expect(existsSync(path.join(target, "events.db"))).toBe(true)
})

test("one coordinator per state folder; a dead holder's lock is taken over", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-lock-"))
  acquireStateLock(root, process.pid)
  acquireStateLock(root, process.pid)
  expect(() => acquireStateLock(root, 999_999_999)).toThrow(/another coordinator \(pid \d+\)/)
  writeFileSync(path.join(root, "coordinator.lock"), "999999998")
  acquireStateLock(root, process.pid)
  expect(readFileSync(path.join(root, "coordinator.lock"), "utf8")).toBe(String(process.pid))
})
