import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, it, vi } from "vitest"
import { createReviewUiProps, reviewChoices, reviewFailureMessage } from "../src/review-entry.ts"
import { selectReviews } from "../src/review-catalog.ts"
import { captureReviewSnapshot } from "../src/review-run.ts"

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

it("shows the actual failure alongside the retained report directory", () => {
  expect(reviewFailureMessage(new Error("Invalid master synthesis."), "/tmp/review"))
    .toContain("Review stopped: Invalid master synthesis. Inspect retained partial reports in /tmp/review.")
})

it("offers the installed Matt Pocock skill as a two-axis review", () => {
  expect(reviewChoices.find((choice) => choice.id === "matt-code-review")).toMatchObject({
    label: "Matt Pocock Code Review", workers: 1, purpose: "Standards review; no verified spec source",
  })
  expect(selectReviews(["matt-code-review"])).toEqual([{
    id: "matt-code-review", skill: "code-review", model: "gpt-6-sol", kind: "two-axis",
  }])
})

it("uses the local tracking ref even when remote main moves and rechecks before model work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-review-entry-"))
  const repository = path.join(root, "repo")
  const origin = path.join(root, "origin.git")
  const second = path.join(root, "second")
  try {
    await mkdir(repository)
    git(root, "init", "--bare", origin)
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.name", "Fixture")
    git(repository, "config", "user.email", "fixture@example.invalid")
    await writeFile(path.join(repository, "review.js"), "export const allowed = true\n")
    git(repository, "add", "review.js")
    git(repository, "commit", "-qm", "base")
    git(repository, "remote", "add", "origin", origin)
    git(repository, "push", "-q", "-u", "origin", "main")
    git(repository, "checkout", "-qb", "review")
    await writeFile(path.join(repository, "review.js"), "export const allowed = false\n")
    git(repository, "commit", "-qam", "change")
    await writeFile(path.join(repository, "local.txt"), "excluded\n")
    vi.stubEnv("TRELLAGE_GUIDE_SKILLS_MANAGER", path.join(root, "manager"))
    vi.stubEnv("TRELLAGE_GUIDE_SKILLS_CATALOG", path.join(root, "catalog"))
    vi.stubEnv("TRELLAGE_GUIDE_NATIVE_SKILLS_CACHE", path.join(root, "cache"))
    const props = createReviewUiProps(repository)
    const target = await props.prepare(new AbortController().signal)
    expect(target.branch).toBe("review")
    expect(target.baseRef).toBe("refs/remotes/origin/main")
    expect(target.changedFiles).toEqual(["review.js", "local.txt"])
    expect(target.workingTreeFiles).toEqual(["local.txt"])
    expect(target.diffBytes).toBe(Buffer.byteLength(
      (await captureReviewSnapshot(await realpath(repository), "refs/remotes/origin/main")).diff, "utf8",
    ))
    expect(target.baseSha).toBe(git(repository, "rev-parse", "origin/main"))
    expect(target.headSha).toBe(git(repository, "rev-parse", "HEAD"))
    await expect(props.run(["ponytail"], { ...target, diffBytes: 0 },
      new AbortController().signal, () => {}, () => {})).rejects.toThrow("confirmed review target has changed")

    git(root, "clone", "-q", "-b", "main", origin, second)
    git(second, "config", "user.name", "Fixture")
    git(second, "config", "user.email", "fixture@example.invalid")
    await writeFile(path.join(second, "other.txt"), "new main\n")
    git(second, "add", "other.txt")
    git(second, "commit", "-qm", "advance remote main")
    git(second, "push", "-q", "origin", "main")
    const unchanged = await props.prepare(new AbortController().signal)
    expect(unchanged).toEqual(target)
    await expect(props.run(["ponytail"], target, new AbortController().signal, () => {}, () => {}))
      .rejects.toThrow("ENOENT")
    git(repository, "fetch", "-q", "origin", "main")
    await expect(props.run(["ponytail"], target, new AbortController().signal, () => {}, () => {}))
      .rejects.toThrow("confirmed review snapshot changed")
    const refreshed = await props.prepare(new AbortController().signal)
    expect(refreshed.baseRefSha).toBe(git(repository, "rev-parse", "origin/main"))
    expect(refreshed.baseSha).toBe(target.baseSha)
    expect(refreshed.changedFiles).toEqual(["review.js", "local.txt"])
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

it("prepares a detached target using its captured HEAD and preserves both confirmation gates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-review-detached-"))
  try {
    git(root, "init", "-b", "main")
    git(root, "config", "user.name", "Fixture")
    git(root, "config", "user.email", "fixture@example.invalid")
    await writeFile(path.join(root, "review.js"), "export const allowed = true\n")
    git(root, "add", "review.js")
    git(root, "commit", "-qm", "base")
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(root, "checkout", "-q", "--detach")
    await writeFile(path.join(root, "review.js"), "export const allowed = false\n")
    vi.stubEnv("TRELLAGE_GUIDE_SKILLS_MANAGER", path.join(root, "missing-manager"))
    vi.stubEnv("TRELLAGE_GUIDE_SKILLS_CATALOG", path.join(root, "catalog"))
    vi.stubEnv("TRELLAGE_GUIDE_NATIVE_SKILLS_CACHE", path.join(root, "cache"))
    const props = createReviewUiProps(root)
    const signal = new AbortController().signal
    const target = await props.prepare(signal)
    expect(target.branch).toBe(`(detached at ${target.headSha.slice(0, 12)})`)
    expect(target.headSha).toBe(git(root, "rev-parse", "HEAD"))
    expect(target.changedFiles).toEqual(["review.js"])
    expect(target.workingTreeFiles).toEqual(["review.js"])
    await expect(props.run(["ponytail"], { ...target, headSha: "0".repeat(40) }, signal, () => {}, () => {}))
      .rejects.toThrow("confirmed review target has changed")
    await expect(props.run(["ponytail"], target, signal, () => {}, () => {})).rejects.toThrow("ENOENT")
    await writeFile(path.join(root, "review.js"), "export const allowed = null\n")
    await expect(props.run(["ponytail"], target, signal, () => {}, () => {}))
      .rejects.toThrow("confirmed review snapshot changed")
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})

it("propagates symbolic-ref errors and cancellation, missing refs, and Git spawn failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-review-errors-"))
  const repository = path.join(root, "repo")
  try {
    await mkdir(repository)
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.name", "Fixture")
    git(repository, "config", "user.email", "fixture@example.invalid")
    await writeFile(path.join(repository, "review.js"), "base\n")
    git(repository, "add", "review.js")
    git(repository, "commit", "-qm", "base")
    git(repository, "update-ref", "refs/remotes/origin/main", "HEAD")
    await writeFile(path.join(repository, "review.js"), "changed\n")
    vi.stubEnv("TRELLAGE_GUIDE_SKILLS_MANAGER", path.join(root, "manager"))
    vi.stubEnv("TRELLAGE_GUIDE_SKILLS_CATALOG", path.join(root, "catalog"))
    vi.stubEnv("TRELLAGE_GUIDE_NATIVE_SKILLS_CACHE", path.join(root, "cache"))
    const props = createReviewUiProps(repository)
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
    const originalPath = process.env.PATH!
    const marker = path.join(root, "symbolic-ref-started")
    await writeFile(path.join(root, "git"), `#!/bin/sh
if [ "$1" = symbolic-ref ]; then
  if [ "$REVIEW_TEST_ABORT" = 1 ]; then
    printf started > '${marker}'
    exec /bin/sleep 15
  fi
  echo 'symbolic-ref fixture failure' >&2
  exit 128
fi
exec '${realGit}' "$@"
`, { mode: 0o700 })
    vi.stubEnv("PATH", `${root}${path.delimiter}${originalPath}`)
    await expect(props.prepare(new AbortController().signal))
      .rejects.toMatchObject({ code: 128, stderr: "symbolic-ref fixture failure\n" })
    vi.stubEnv("REVIEW_TEST_ABORT", "1")
    const controller = new AbortController()
    const preparing = props.prepare(controller.signal)
    const cancelled = expect(preparing).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("started"))
    controller.abort()
    await cancelled
    vi.stubEnv("PATH", originalPath)
    git(repository, "update-ref", "-d", "refs/remotes/origin/main")
    await expect(props.prepare(new AbortController().signal)).rejects.toThrow()
    vi.stubEnv("PATH", path.join(root, "missing-bin"))
    await expect(props.prepare(new AbortController().signal)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
