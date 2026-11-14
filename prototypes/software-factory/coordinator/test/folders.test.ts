import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createWorktree,
  currentBase,
  discardWorktree,
  fullyMerged,
  removeWorktree,
  upstreamState,
  worktreeRoot,
} from "../src/folders.ts"
import { Threads } from "../src/threads.ts"

const repo = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sf-repo-")))
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" })
  git("init", "-q")
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
  mkdirSync(path.join(dir, "sub"))
  return dir
}

test("two conversations on the same repo pin to one folder, each with its own worktree", () => {
  const r = repo()
  const root = mkdtempSync(path.join(tmpdir(), "sf-state-"))
  const t = new Threads(root)
  const a = t.addFolder(r)
  const b = t.addFolder(path.join(r, "sub"))
  expect(b).toEqual(a)
  expect(t.folders().map((f) => f.id)).toEqual(["general", path.basename(r).toLowerCase()])
  const mk = (id: string) => createWorktree(r, path.join(root, "wt", id.slice(0, 8)), `factory/${id.slice(0, 8)}`)
  const c1 = t.create("one", a.id, mk)
  const c2 = t.create("two", a.id, mk)
  expect(c1.worktree).not.toBe(c2.worktree)
  expect(existsSync(path.join(c1.worktree!, ".git"))).toBe(true)
  // A worktree of the repo maps back to the same folder.
  expect(t.addFolder(c1.worktree!)).toEqual(a)
  // General conversations get no worktree; state survives a restart.
  expect(t.create("plain").worktree).toBeUndefined()
  expect(new Threads(root).get(c2.id)?.folderId).toBe(a.id)
})

test("adding a folder outside a git repo fails", () => {
  const t = new Threads(mkdtempSync(path.join(tmpdir(), "sf-state-")))
  expect(() => t.addFolder(mkdtempSync(path.join(tmpdir(), "sf-plain-")))).toThrow("not inside a git repository")
})

test("cleanup only for worktrees fully merged upstream", () => {
  const run = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
      stdio: "ignore",
    })
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sf-merge-")))
  const origin = path.join(tmp, "origin.git")
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin])
  const seed = path.join(tmp, "seed")
  execFileSync("git", ["clone", "-q", origin, seed], { stdio: "ignore" })
  run(seed, "commit", "-q", "--allow-empty", "-m", "init")
  run(seed, "push", "-q", "origin", "HEAD:main")
  const r = path.join(tmp, "repo")
  execFileSync("git", ["clone", "-q", origin, r], { stdio: "ignore" })
  const noPr = () => null
  const w = createWorktree(r, path.join(tmp, "wt"), "factory/x")
  expect(fullyMerged(r, w, noPr)).toBe(false) // no own commit yet
  writeFileSync(path.join(w.worktree, "a.txt"), "a")
  expect(fullyMerged(r, w, noPr)).toBe(false) // uncommitted change
  run(w.worktree, "add", ".")
  run(w.worktree, "commit", "-q", "-m", "a")
  expect(fullyMerged(r, w, noPr)).toBe(false) // committed, not merged
  const tip = execFileSync("git", ["-C", r, "rev-parse", "factory/x"], { encoding: "utf8" }).trim()
  expect(fullyMerged(r, w, () => tip)).toBe(true) // squash-merged PR with this head
  run(w.worktree, "push", "-q", "origin", "HEAD:main")
  expect(fullyMerged(r, w, noPr)).toBe(true) // in origin's default branch
  removeWorktree(r, w)
  expect(existsSync(w.worktree)).toBe(false)
})

test("default worktree root is ~/.trellage/worktrees", () => {
  expect(worktreeRoot({ HOME: "/h" } as NodeJS.ProcessEnv).endsWith(path.join(".trellage", "worktrees"))).toBe(true)
  expect(worktreeRoot({ SF_WORKTREES: "/x" } as NodeJS.ProcessEnv)).toBe("/x")
})

test("a conversation worktree can branch from a named base", () => {
  const r = repo()
  execFileSync("git", [
    "-C",
    r,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "two",
  ])
  execFileSync("git", ["-C", r, "branch", "feature", "HEAD~1"])
  const want = execFileSync("git", ["-C", r, "rev-parse", "feature"], { encoding: "utf8" }).trim()
  const tmp = mkdtempSync(path.join(tmpdir(), "sf-wt-"))
  const a = createWorktree(r, path.join(tmp, "a"), "factory/a", "feature")
  expect(a.base).toBe(want)
  expect(a.prBase).toBe("feature")
  expect(createWorktree(r, path.join(tmp, "c"), "factory/c", want).prBase).toBeUndefined()
  expect(createWorktree(r, path.join(tmp, "d"), "factory/d").prBase).toBeUndefined()
  expect(() => createWorktree(r, path.join(tmp, "b"), "factory/b", "nope")).toThrow("base 'nope'")
})

test("discardWorktree removes a dirty, unmerged worktree and its branch", () => {
  const r = repo()
  const root = mkdtempSync(path.join(tmpdir(), "sf-state-"))
  const w = createWorktree(r, path.join(root, "wt"), "factory/discard")
  writeFileSync(path.join(w.worktree, "x.txt"), "dirty")
  discardWorktree(r, w)
  expect(existsSync(w.worktree)).toBe(false)
  expect(execFileSync("git", ["-C", r, "branch", "--list", "factory/discard"], { encoding: "utf8" })).toBe("")
  discardWorktree(r, w) // already gone: no throw
})

test("currentBase follows a rebase; upstreamState counts upstream commits and predicts conflicts", () => {
  const run = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
      stdio: "ignore",
    })
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sf-base-")))
  const origin = path.join(tmp, "origin.git")
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin])
  const seed = path.join(tmp, "seed")
  execFileSync("git", ["clone", "-q", origin, seed], { stdio: "ignore" })
  writeFileSync(path.join(seed, "f.txt"), "one\n")
  run(seed, "add", ".")
  run(seed, "commit", "-q", "-m", "init")
  run(seed, "push", "-q", "origin", "HEAD:main")
  const r = path.join(tmp, "repo")
  execFileSync("git", ["clone", "-q", origin, r], { stdio: "ignore" })
  const w = createWorktree(r, path.join(tmp, "wt"), "factory/x")
  writeFileSync(path.join(w.worktree, "a.txt"), "a")
  run(w.worktree, "add", ".")
  run(w.worktree, "commit", "-q", "-m", "a")
  expect(currentBase(w.worktree, w.base)).toBe(w.base)
  expect(upstreamState(w.worktree, w.base)).toMatchObject({ behind: 0, conflicts: false })

  // main moves without overlap: behind 1, no conflict; the base stays until the branch rebases.
  writeFileSync(path.join(seed, "b.txt"), "b")
  run(seed, "add", ".")
  run(seed, "commit", "-q", "-m", "b")
  run(seed, "push", "-q", "origin", "HEAD:main")
  run(w.worktree, "fetch", "-q", "origin")
  expect(upstreamState(w.worktree, w.base)).toMatchObject({ behind: 1, conflicts: false })
  expect(currentBase(w.worktree, w.base)).toBe(w.base)

  // After the rebase the base is the new main.
  run(w.worktree, "rebase", "-q", "origin/main")
  const main = execFileSync("git", ["-C", w.worktree, "rev-parse", "origin/main"], {
    encoding: "utf8",
  }).trim()
  expect(currentBase(w.worktree, w.base)).toBe(main)
  expect(upstreamState(w.worktree, main)).toMatchObject({ behind: 0 })

  // main changes the same line as the branch: a conflict is predicted.
  writeFileSync(path.join(w.worktree, "f.txt"), "branch\n")
  run(w.worktree, "commit", "-q", "-am", "f")
  writeFileSync(path.join(seed, "f.txt"), "main\n")
  run(seed, "commit", "-q", "-am", "f2")
  run(seed, "push", "-q", "origin", "HEAD:main")
  run(w.worktree, "fetch", "-q", "origin")
  expect(upstreamState(w.worktree, main)).toMatchObject({ behind: 1, conflicts: true })
})
