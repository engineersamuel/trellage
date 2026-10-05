import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createNodeCommandRunner } from "../src/guide-launch.ts"
import { resolveGuideModelRouting } from "../src/guide-api.ts"
import {
  assertGuideOptimizeTargetCurrent,
  guideOptimizeTargetIdentity,
  inspectGuideOptimizeTarget,
  selectedGuideOptimizeChanges,
} from "../src/guide-optimize-target.ts"
import { optimizeReviewersFor } from "../src/guide-optimize-review.ts"
import { runGuideOptimizeReview } from "../src/guide-optimize.ts"

const runner = createNodeCommandRunner()
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const fixture = async (committed = true) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "guide-optimize-target-")))
  roots.push(root)
  const git = async (...args: string[]) => (await runner.run("git", args, { cwd: root })).stdout.trim()
  await git("init", "--quiet", "-b", "main")
  await git("config", "user.name", "Fixture")
  await git("config", "user.email", "fixture@example.invalid")
  await git("config", "commit.gpgsign", "false")
  await git("config", "core.hooksPath", "/dev/null")
  await mkdir(path.join(root, "src"))
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n")
  await writeFile(path.join(root, "src", "tracked.ts"), "export const value = 1\n")
  if (committed) {
    await git("add", ".")
    await git("commit", "--quiet", "-m", "Fixture baseline")
  }
  return { root, git }
}

describe("Optimize change targets", () => {
  it("captures staged, unstaged, deleted and untracked files without including ignored files", async () => {
    const { root, git } = await fixture()
    await writeFile(path.join(root, "src", "tracked.ts"), "export const value = 2\n")
    await git("add", "src/tracked.ts")
    await writeFile(path.join(root, "src", "tracked.ts"), "export const value = 3\n")
    await rm(path.join(root, ".gitignore"))
    await writeFile(path.join(root, "new file é.ts"), "export const fresh = true\n")
    const target = await inspectGuideOptimizeTarget(runner, path.join(root, "src"))
    expect(target.cwd).toBe(root)
    expect(target.changes).toEqual([
      expect.objectContaining({ path: ".gitignore", kind: "deleted", staged: false, unstaged: true }),
      expect.objectContaining({ path: "new file é.ts", kind: "file", untracked: true }),
      expect.objectContaining({ path: "src/tracked.ts", kind: "file", staged: true, unstaged: true }),
    ])
    const before = await git("status", "--porcelain")
    await assertGuideOptimizeTargetCurrent(runner, target)
    expect(await git("status", "--porcelain")).toBe(before)
  })

  it("does not select ignored files or invent a previous commit for a clean worktree", async () => {
    const { root } = await fixture()
    await writeFile(path.join(root, "ignored.txt"), "not part of this task\n")
    const target = await inspectGuideOptimizeTarget(runner, root)
    expect(target.changes).toEqual([])
    expect(target.base).toBeUndefined()
    expect(() => selectedGuideOptimizeChanges(target, [])).toThrow("Select at least one")
  })

  it("preserves spaces at the end of a worktree directory name", async () => {
    const { root } = await fixture()
    const directory = path.join(root, "checkout ")
    await mkdir(directory)
    await runner.run("git", ["init", "--quiet"], { cwd: directory })
    await writeFile(path.join(directory, "task.ts"), "new task\n")
    const target = await inspectGuideOptimizeTarget(runner, directory)
    expect(target.cwd).toBe(directory)
    expect(target.changes.map((entry) => entry.path)).toEqual(["task.ts"])
  })

  it("compares committed work against an explicit merge-base and includes current edits", async () => {
    const { root, git } = await fixture()
    const baseline = await git("rev-parse", "HEAD")
    await git("branch", "base")
    await writeFile(path.join(root, "src", "tracked.ts"), "export const value = 2\n")
    await git("add", ".")
    await git("commit", "--quiet", "-m", "Fixture change")
    expect(await git("status", "--porcelain")).toBe("")
    expect((await inspectGuideOptimizeTarget(runner, root)).changes).toEqual([])
    expect((await inspectGuideOptimizeTarget(runner, root, { kind: "branch", baseRef: "base" })).changes).toEqual([
      expect.objectContaining({ path: "src/tracked.ts", committed: true }),
    ])
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\nstaged.txt\n")
    await git("add", ".gitignore")
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\nstaged.txt\nunstaged.txt\n")
    await writeFile(path.join(root, "current.ts"), "export const current = true\n")
    const target = await inspectGuideOptimizeTarget(runner, root, { kind: "branch", baseRef: "base" })
    expect(target.base).toEqual({ ref: "base", commit: baseline, mergeBase: baseline })
    expect(target.changes).toEqual([
      expect.objectContaining({ path: ".gitignore", staged: true, unstaged: true }),
      expect.objectContaining({ path: "current.ts", untracked: true }),
      expect.objectContaining({ path: "src/tracked.ts", committed: true, staged: false, unstaged: false }),
    ])
    await git("branch", "--force", "base", "HEAD")
    await expect(assertGuideOptimizeTargetCurrent(runner, target)).rejects.toThrow("comparison base changed")
  })

  it("defaults to the current branch's changes against main, including committed and current edits", async () => {
    const { root, git } = await fixture()
    const baseline = await git("rev-parse", "HEAD")
    await git("switch", "--quiet", "-c", "task")
    await writeFile(path.join(root, "src", "tracked.ts"), "committed task\n")
    await git("commit", "--quiet", "-am", "Task work")
    await writeFile(path.join(root, "src", "tracked.ts"), "staged task\n")
    await git("add", "src/tracked.ts")
    await writeFile(path.join(root, "src", "tracked.ts"), "current task\n")
    const index = await git("diff", "--cached")
    const target = await inspectGuideOptimizeTarget(runner, path.join(root, "src"), { kind: "current-branch" })
    expect(target.cwd).toBe(root)
    expect(target.scope).toEqual({ kind: "branch", baseRef: "refs/heads/main" })
    expect(target.base).toEqual({ ref: "refs/heads/main", commit: baseline, mergeBase: baseline })
    expect(target.changes).toEqual([
      expect.objectContaining({ path: "src/tracked.ts", committed: true, staged: true, unstaged: true }),
    ])
    expect(await git("diff", "--cached")).toBe(index)
    await git("branch", "--force", "main", "HEAD")
    await expect(assertGuideOptimizeTargetCurrent(runner, target)).rejects.toThrow("comparison base changed")
  })

  it("uses the cached remote default without hiding work already pushed to the task branch", async () => {
    const { root, git } = await fixture()
    await git("update-ref", "refs/remotes/origin/main", "HEAD")
    await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    await git("switch", "--quiet", "-c", "task")
    await writeFile(path.join(root, "src", "tracked.ts"), "published task\n")
    await git("commit", "--quiet", "-am", "Task work")
    await git("update-ref", "refs/remotes/origin/task", "HEAD")
    await git("config", "branch.task.remote", "origin")
    await git("config", "branch.task.merge", "refs/heads/task")
    const target = await inspectGuideOptimizeTarget(runner, root, { kind: "current-branch" })
    expect(target.base?.ref).toBe("refs/remotes/origin/main")
    expect(target.changes).toEqual([
      expect.objectContaining({ path: "src/tracked.ts", committed: true, staged: false, unstaged: false }),
    ])
  })

  it("identifies the worktree holding a subdirectory and separates a linked worktree", async () => {
    const { root, git } = await fixture()
    const linked = path.join(root, "linked")
    await git("worktree", "add", "--quiet", "-b", "task", linked)
    const identity = await guideOptimizeTargetIdentity(runner, path.join(root, "src"))
    const inspected = await inspectGuideOptimizeTarget(runner, path.join(root, "src"))
    expect(identity).toEqual({ cwd: inspected.cwd, gitDirectory: inspected.gitDirectory })
    expect(identity.cwd).toBe(root)
    const other = await guideOptimizeTargetIdentity(runner, linked)
    expect(other.cwd).toBe(linked)
    expect(other.gitDirectory).not.toBe(identity.gitDirectory)
  })

  it("refuses to review a target that belongs to another worktree", async () => {
    const { root, git } = await fixture()
    const linked = path.join(root, "linked")
    await git("worktree", "add", "--quiet", "-b", "task", linked)
    await writeFile(path.join(linked, "src", "tracked.ts"), "linked task\n")
    const foreign = await inspectGuideOptimizeTarget(runner, linked)
    const routing = resolveGuideModelRouting({}, {})
    const progress: string[] = []
    await expect(
      runGuideOptimizeReview(
        { runner, cwd: root },
        routing,
        {
          target: foreign,
          paths: ["src/tracked.ts"],
          reviewerIds: optimizeReviewersFor(routing).map((entry) => entry.id),
        },
        new AbortController().signal,
        (message) => progress.push(message),
      ),
    ).rejects.toThrow("not this Guide worktree")
    expect(progress).toEqual([])
  })

  it("uses the primary worktree branch for a linked worktree with a custom base name", async () => {
    const { root, git } = await fixture()
    await git("branch", "-m", "trunk")
    const linked = path.join(root, "linked")
    await git("worktree", "add", "--quiet", "-b", "task", linked)
    await writeFile(path.join(linked, "src", "tracked.ts"), "linked task\n")
    await runner.run("git", ["commit", "--quiet", "-am", "Task work"], { cwd: linked })
    const target = await inspectGuideOptimizeTarget(runner, linked, { kind: "current-branch" })
    expect(target.cwd).toBe(linked)
    expect(target.base?.ref).toBe("refs/heads/trunk")
    expect(target.changes).toEqual([expect.objectContaining({ path: "src/tracked.ts", committed: true })])
  })

  it("includes unpushed commits on main instead of comparing the current branch with itself", async () => {
    const { root, git } = await fixture()
    await git("update-ref", "refs/remotes/origin/main", "HEAD")
    await writeFile(path.join(root, "src", "tracked.ts"), "unpushed task\n")
    await git("commit", "--quiet", "-am", "Task work")
    const target = await inspectGuideOptimizeTarget(runner, root, { kind: "current-branch" })
    expect(target.base?.ref).toBe("refs/remotes/origin/main")
    expect(target.changes).toEqual([expect.objectContaining({ path: "src/tracked.ts", committed: true })])
  })

  it("requests a base only when Git has no separate comparison branch", async () => {
    const { root } = await fixture()
    await expect(inspectGuideOptimizeTarget(runner, root, { kind: "current-branch" })).rejects.toThrow(
      "Cannot detect a comparison base",
    )
  })

  it("rejects changed file bytes, index contents and HEAD after target confirmation", async () => {
    const { root, git } = await fixture()
    const file = path.join(root, "src", "tracked.ts")
    await writeFile(file, "staged version\n")
    await git("add", ".")
    await writeFile(file, "working version\n")
    const target = await inspectGuideOptimizeTarget(runner, root)
    await writeFile(file, "changed working version\n")
    await expect(assertGuideOptimizeTargetCurrent(runner, target)).rejects.toThrow(
      "worktree or comparison base changed",
    )
    await writeFile(file, "different staged version\n")
    await git("add", ".")
    await writeFile(file, "working version\n")
    await expect(assertGuideOptimizeTargetCurrent(runner, target)).rejects.toThrow(
      "worktree or comparison base changed",
    )
    const beforeCommit = await inspectGuideOptimizeTarget(runner, root)
    await git("commit", "--quiet", "-m", "Fixture staged change")
    await expect(assertGuideOptimizeTargetCurrent(runner, beforeCommit)).rejects.toThrow(
      "worktree or comparison base changed",
    )
  })

  it("keeps both sides of a rename and permits only paths from the reviewed target", async () => {
    const { root, git } = await fixture()
    await rename(path.join(root, "src", "tracked.ts"), path.join(root, "renamed.ts"))
    await git("add", "--all")
    const target = await inspectGuideOptimizeTarget(runner, root)
    expect(target.changes.map((change) => [change.path, change.kind])).toEqual([
      ["renamed.ts", "file"],
      ["src/tracked.ts", "deleted"],
    ])
    expect(selectedGuideOptimizeChanges(target, ["renamed.ts"])).toHaveLength(1)
    expect(() => selectedGuideOptimizeChanges(target, ["../outside"])).toThrow("not part")
    expect(() => selectedGuideOptimizeChanges(target, ["renamed.ts", "renamed.ts"])).toThrow("duplicate")
  })

  it("never reads symlink targets and rejects links as optimization inputs", async () => {
    const { root } = await fixture()
    await symlink("/does/not/exist/outside", path.join(root, "outside-link"))
    const target = await inspectGuideOptimizeTarget(runner, root)
    expect(target.changes).toEqual([expect.objectContaining({ path: "outside-link", kind: "symlink" })])
    expect(() => selectedGuideOptimizeChanges(target, ["outside-link"])).toThrow("regular files only")
  })

  it("supports a first uncommitted task but requires a commit for branch comparison", async () => {
    const { root } = await fixture(false)
    const target = await inspectGuideOptimizeTarget(runner, root)
    expect(target.head).toBeNull()
    expect(target.changes.map((change) => change.path)).toEqual([".gitignore", "src/tracked.ts"])
    expect(await inspectGuideOptimizeTarget(runner, root, { kind: "current-branch" })).toEqual(target)
    await expect(inspectGuideOptimizeTarget(runner, root, { kind: "branch", baseRef: "main" })).rejects.toThrow(
      "existing commit",
    )
  })
})
