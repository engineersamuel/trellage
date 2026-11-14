import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, type SpawnSpec } from "../src/factory.ts"
import { guideOutdated, guideView, openInHerdr, TEST_GUIDE, writeGuide } from "../src/testGuide.ts"
import type { TestGuide } from "../../shared/testGuide.ts"

const repo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-tg-"))
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" })
  git("init", "-q")
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base")
  return { dir, git }
}

const REPLY = JSON.stringify({ setup: ["echo hi"], steps: [{ do: "look", expect: "hi" }], cleanup: [] })

/** A fake factory: spawned workers answer `reply`; publishes go to an in-memory store `latest` reads. */
const fakeFactory = (reply: string | null) => {
  const f = Object.create(Factory.prototype)
  const published: { type: string; data: unknown }[] = []
  Object.assign(f, {
    workers: new Map(),
    sdlc: new Map(),
    spawned: [] as SpawnSpec[],
    stopped: [] as string[],
    published,
    store: { latest: (type: string) => published.filter((p) => p.type === type).map((p) => p.data) },
  })
  f.publish = (_w: string, type: string, _a: null, _t: string, data: unknown) => published.push({ type, data })
  f.stop = async (id: string) => void f.stopped.push(id)
  f.spawn = async (spec: SpawnSpec) => {
    f.spawned.push(spec)
    return { id: "w-1", waitIdle: async () => reply !== null, lastMessage: reply }
  }
  return f as Factory & { spawned: SpawnSpec[]; stopped: string[]; published: typeof published }
}

test("writes a read-only guide for the worktree HEAD, then marks it stale after a new commit", async () => {
  const { dir, git } = repo()
  const f = fakeFactory(REPLY)
  const g = await writeGuide(f, { id: "sub-1", threadId: "t", workdir: dir }, "Adds X")
  expect(f.spawned[0]).toMatchObject({ name: "manual-test", owner: "sub-1", workdir: dir })
  expect(f.spawned[0]!.permissions).toBe(f.subPermissions)
  expect(f.spawned[0]!.task).toContain("Adds X")
  expect(f.stopped).toEqual(["w-1"])
  expect(g).toMatchObject({ status: "ready", setup: ["echo hi"], steps: [{ do: "look", expect: "hi" }] })
  expect(f.published.map((p) => (p.data as TestGuide).status)).toEqual(["writing", "ready"])
  expect(guideView(f, "sub-1")).toMatchObject({ status: "ready", stale: false })
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "next")
  expect(guideView(f, "sub-1")).toMatchObject({ stale: true })
  expect(guideView(f, "sub-2")).toBeNull()
})

test("a bad reply or a timeout ends as failed with the reason", async () => {
  const { dir } = repo()
  expect(await writeGuide(fakeFactory("no json"), { id: "s", threadId: null, workdir: dir }, "x")).toMatchObject({
    status: "failed",
    error: expect.stringContaining("not JSON"),
  })
  expect(await writeGuide(fakeFactory(null), { id: "s", threadId: null, workdir: dir }, "x")).toMatchObject({
    status: "failed",
    error: "the test guide writer timed out",
  })
  expect(TEST_GUIDE).toBe("factory.test_guide")
})

test("a guide left writing with no writer (a restart) reads as failed", () => {
  const f = fakeFactory(REPLY)
  f.publish("sub-1", TEST_GUIDE, null, "", { scopeId: "sub-1", status: "writing", workdir: "/x", commit: "c", at: 1 })
  expect(guideView(f, "sub-1")).toMatchObject({ status: "failed", error: "coordinator restarted" })
  f.workers.set("w-1", { owner: "sub-1", name: "manual-test" } as never)
  expect(guideView(f, "sub-1")).toMatchObject({ status: "writing" })
})

const guide = (workdir: string): TestGuide => ({
  id: "tg-1",
  scopeId: "sub-1",
  threadId: "t",
  workdir,
  status: "ready",
  commit: "abc1234",
  setup: ["echo a"],
  steps: [{ do: "look", expect: "a" }],
  cleanup: [],
  at: 0,
})

test("open in herdr: writes the files, makes a focused workspace in the worktree, runs them", () => {
  const { dir } = repo()
  const calls: string[][] = []
  const herdr = (args: string[]) => {
    calls.push(args)
    if (args[0] === "workspace" && args[1] === "list") return JSON.stringify({ result: { workspaces: [] } })
    return JSON.stringify({ result: { workspace: { workspace_id: "w5" }, root_pane: { pane_id: "w5:p1" } } })
  }
  expect(openInHerdr(guide(dir), "test: t", herdr)).toBe("w5:p1")
  expect(calls.slice(1)).toEqual([
    ["workspace", "create", "--cwd", dir, "--label", "test: t", "--focus"],
    ["pane", "run", "w5:p1", "cat .factory/manual-test.md; bash .factory/manual-test.sh"],
  ])
  expect(readFileSync(path.join(dir, ".factory/manual-test.sh"), "utf8")).toBe("#!/usr/bin/env bash\nset -ex\necho a\n")
  expect(statSync(path.join(dir, ".factory/manual-test.sh")).mode & 0o111).toBeTruthy()
  expect(readFileSync(path.join(dir, ".factory/manual-test.md"), "utf8")).toContain("1. look")
})

test("open in herdr: a workspace on the worktree, or one with the label, gets a new tab", () => {
  const { dir } = repo()
  for (const ws of [
    { workspace_id: "w7", label: "other", worktree: { checkout_path: dir } },
    { workspace_id: "w7", label: "test: t" },
  ]) {
    const calls: string[][] = []
    const herdr = (args: string[]) => {
      calls.push(args)
      if (args[1] === "list") return JSON.stringify({ result: { workspaces: [ws] } })
      return JSON.stringify({ result: { tab: { tab_id: "w7:t2" }, root_pane: { pane_id: "w7:p9" } } })
    }
    expect(openInHerdr(guide(dir), "test: t", herdr)).toBe("w7:p9")
    expect(calls[1]).toEqual(["tab", "create", "--workspace", "w7", "--cwd", dir, "--label", "How to test", "--focus"])
  }
})

test("outdated: only a finished guide whose commit is no longer HEAD", async () => {
  const { dir, git } = repo()
  const f = fakeFactory("no json")
  expect(guideOutdated(f, "sub-1")).toBe(false)
  await writeGuide(f, { id: "sub-1", threadId: "t", workdir: dir }, "x")
  // Failed on the same commit: no retry loop.
  expect(guideOutdated(f, "sub-1")).toBe(false)
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "more")
  expect(guideOutdated(f, "sub-1")).toBe(true)
  f.publish("sub-1", TEST_GUIDE, null, "", { scopeId: "sub-1", status: "writing", workdir: dir, commit: "c", at: 9e15 })
  expect(guideOutdated(f, "sub-1")).toBe(false)
})
