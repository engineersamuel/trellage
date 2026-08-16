import { execFile } from "node:child_process"
import { mkdir, rm, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { captureGitEvidenceSnapshot, compareGitEvidenceSnapshots } from "../src/git-evidence.js"

const execFilePromise = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const scratchRoots = new Set<string>()
let fixtureIndex = 0

afterEach(async () => {
  const roots = [...scratchRoots]
  scratchRoots.clear()
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

const fixtureRoot = async (label: string): Promise<string> => {
  fixtureIndex += 1
  const root = path.join(packageRoot, `.git-evidence-${label}-${process.pid}-${fixtureIndex}`)
  scratchRoots.add(root)
  await mkdir(root)
  return root
}

const git = async (root: string, ...arguments_: ReadonlyArray<string>): Promise<void> => {
  await execFilePromise("git", ["-C", root, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  })
}

const initializeRepository = async (root: string): Promise<void> => {
  await git(root, "init", "--quiet")
  await git(root, "config", "user.name", "Trellage Test")
  await git(root, "config", "user.email", "trellage-test@example.invalid")
}

describe("Git changed-file evidence", () => {
  it("reports only final changes caused after the initial snapshot", async () => {
    const root = await fixtureRoot("changes")
    await initializeRepository(root)
    const baseline = [
      "tracked.txt",
      "staged.txt",
      "deleted.txt",
      "rename-old.txt",
      "preexisting-dirty.txt",
      "preexisting-dirty-changing.txt",
      "preexisting-dirty-restored.txt",
      "preexisting-staged.txt",
    ]
    await Promise.all(baseline.map((file) => writeFile(path.join(root, file), `baseline ${file}\n`)))
    await git(root, "add", "--", ".")
    await git(root, "commit", "--quiet", "-m", "baseline")

    await Promise.all([
      writeFile(path.join(root, "preexisting-dirty.txt"), "dirty before snapshot\n"),
      writeFile(path.join(root, "preexisting-dirty-changing.txt"), "dirty version one\n"),
      writeFile(path.join(root, "preexisting-dirty-restored.txt"), "dirty before snapshot\n"),
      writeFile(path.join(root, "preexisting-untracked.txt"), "untracked before snapshot\n"),
      writeFile(path.join(root, "preexisting-untracked-changing.txt"), "untracked version one\n"),
      writeFile(path.join(root, "preexisting-untracked-deleted.txt"), "untracked before snapshot\n"),
      writeFile(path.join(root, "preexisting-staged.txt"), "staged before snapshot\n"),
    ])
    await git(root, "add", "--", "preexisting-staged.txt")
    const before = await captureGitEvidenceSnapshot(root)

    await Promise.all([
      writeFile(path.join(root, "tracked.txt"), "tracked changed during run\n"),
      writeFile(path.join(root, "staged.txt"), "staged changed during run\n"),
      writeFile(path.join(root, "new-untracked.txt"), "new during run\n"),
      writeFile(path.join(root, "preexisting-dirty-changing.txt"), "dirty version two\n"),
      writeFile(path.join(root, "preexisting-dirty-restored.txt"), "baseline preexisting-dirty-restored.txt\n"),
      writeFile(path.join(root, "preexisting-untracked-changing.txt"), "untracked version two\n"),
      unlink(path.join(root, "deleted.txt")),
      unlink(path.join(root, "preexisting-untracked-deleted.txt")),
    ])
    await git(root, "add", "--", "staged.txt")
    await git(root, "mv", "--", "rename-old.txt", "rename-new.txt")
    const after = await captureGitEvidenceSnapshot(root)

    await expect(compareGitEvidenceSnapshots(before, after)).resolves.toEqual({
      changedFiles: [
        "deleted.txt",
        "new-untracked.txt",
        "preexisting-dirty-changing.txt",
        "preexisting-dirty-restored.txt",
        "preexisting-untracked-changing.txt",
        "preexisting-untracked-deleted.txt",
        "rename-new.txt",
        "rename-old.txt",
        "staged.txt",
        "tracked.txt",
      ],
      changedFilesSource: "git-diff",
    })
    await expect(compareGitEvidenceSnapshots(after, await captureGitEvidenceSnapshot(root))).resolves.toEqual({
      changedFiles: [],
      changedFilesSource: "git-diff",
    })
  })

  it("reports paths changed by commits created during the run", async () => {
    const root = await fixtureRoot("commits")
    await initializeRepository(root)
    await Promise.all([
      writeFile(path.join(root, "committed.txt"), "baseline committed\n"),
      writeFile(path.join(root, "deleted-in-commit.txt"), "baseline deleted\n"),
      writeFile(path.join(root, "rename-commit-old.txt"), "baseline renamed\n"),
    ])
    await git(root, "add", "--", ".")
    await git(root, "commit", "--quiet", "-m", "baseline")
    const before = await captureGitEvidenceSnapshot(root)

    await Promise.all([
      writeFile(path.join(root, "committed.txt"), "changed and committed\n"),
      writeFile(path.join(root, "new-in-commit.txt"), "new and committed\n"),
      unlink(path.join(root, "deleted-in-commit.txt")),
    ])
    await git(root, "mv", "--", "rename-commit-old.txt", "rename-commit-new.txt")
    await git(root, "add", "--all")
    await git(root, "commit", "--quiet", "-m", "agent changes")
    await writeFile(path.join(root, "after-commit-untracked.txt"), "working tree change\n")
    const after = await captureGitEvidenceSnapshot(root)

    await expect(compareGitEvidenceSnapshots(before, after)).resolves.toEqual({
      changedFiles: [
        "after-commit-untracked.txt",
        "committed.txt",
        "deleted-in-commit.txt",
        "new-in-commit.txt",
        "rename-commit-new.txt",
        "rename-commit-old.txt",
      ],
      changedFilesSource: "git-diff",
    })
  })

  it("returns empty evidence for an unchanged repository and null evidence when Git is unavailable", async () => {
    const repository = await fixtureRoot("unchanged")
    await initializeRepository(repository)
    await writeFile(path.join(repository, "tracked.txt"), "tracked\n")
    await git(repository, "add", "--", "tracked.txt")
    await git(repository, "commit", "--quiet", "-m", "baseline")

    const before = await captureGitEvidenceSnapshot(repository)
    const after = await captureGitEvidenceSnapshot(repository)
    await expect(compareGitEvidenceSnapshots(before, after)).resolves.toEqual({
      changedFiles: [],
      changedFilesSource: "git-diff",
    })

    const nonGit = await fixtureRoot("non-git")
    await writeFile(path.join(nonGit, ".git"), "gitdir: missing\n")
    const unavailable = await captureGitEvidenceSnapshot(nonGit)
    expect(unavailable).toBeNull()
    await expect(compareGitEvidenceSnapshots(before, unavailable)).resolves.toEqual({
      changedFiles: null,
      changedFilesSource: null,
    })
  })
})
