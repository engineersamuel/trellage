import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MAX_PATCH_BYTES, worktreeDiff } from "../src/worktreeDiff.ts"

test("lists committed, unstaged, deleted and untracked changes with patches, and does not touch the index", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sf-wtdiff-")))
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" })
  git("init", "-q")
  writeFileSync(path.join(dir, "keep.ts"), "a\nb\n")
  writeFileSync(path.join(dir, "gone.ts"), "x\n")
  writeFileSync(path.join(dir, ".gitignore"), "ignored.log\n")
  git("add", ".")
  git("commit", "-qm", "base")
  const base = git("rev-parse", "HEAD").trim()
  writeFileSync(path.join(dir, "committed.ts"), "new\n")
  git("add", "committed.ts")
  git("commit", "-qm", "work")
  writeFileSync(path.join(dir, "keep.ts"), "a\nB\n")
  rmSync(path.join(dir, "gone.ts"))
  writeFileSync(path.join(dir, "fresh.ts"), "one\ntwo\n")
  writeFileSync(path.join(dir, "big.txt"), "y\n".repeat(MAX_PATCH_BYTES))
  writeFileSync(path.join(dir, "ignored.log"), "z\n")
  const indexBefore = git("diff", "--cached", "--name-only")

  const d = worktreeDiff(dir, base)
  const by = Object.fromEntries(d.files.map((f) => [f.path, f]))
  expect(d.files.map((f) => f.path)).toEqual(["big.txt", "committed.ts", "fresh.ts", "gone.ts", "keep.ts"])
  expect(by["committed.ts"]).toMatchObject({ status: "A", added: 1, removed: 0 })
  expect(by["keep.ts"]).toMatchObject({ status: "M", added: 1, removed: 1 })
  expect(by["keep.ts"]!.patch).toContain("-b\n+B")
  expect(by["gone.ts"]).toMatchObject({ status: "D", removed: 1 })
  expect(by["fresh.ts"]).toMatchObject({ status: "?", added: 2 })
  expect(by["fresh.ts"]!.patch).toContain("+++ b/fresh.ts")
  expect(by["big.txt"]).toMatchObject({ status: "?", tooLarge: true, patch: "" })
  expect(git("diff", "--cached", "--name-only")).toBe(indexBefore)
})
