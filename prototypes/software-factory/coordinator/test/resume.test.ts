import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Duration, Effect } from "effect"
import { retryTransient } from "../goal-cli.ts"
import { Factory } from "../src/factory.ts"
import { rerunInterruptedReview } from "../src/gates.ts"
import { interruptedScopes, resumePrompt, type Shutdown } from "../src/resume.ts"
import { newSdlc, type Gate, type Sdlc } from "../src/sdlc.ts"

const agent = (id: string, owner: string | null, step: string | null = null) => ({
  id,
  name: `n-${id}`,
  owner,
  step,
  task: `task of ${id}`,
})

test("a shutdown's running agents group by sub-coordinator; desk, chats and a resumed shutdown are skipped", () => {
  const shutdown: Shutdown = {
    at: 5,
    running: [
      agent("coordinator", null),
      agent("gen-aaaa", "coordinator"),
      agent("sub-1111", "gen-aaaa"),
      agent("w-1", "sub-1111", "implement"),
      agent("w-2", "sub-2222", "verify"),
      agent("w-3", "gen-aaaa"),
    ],
  }
  const got = interruptedScopes(shutdown, undefined)
  expect([...got.keys()]).toEqual(["sub-1111", "sub-2222"])
  expect(got.get("sub-1111")!.map((w) => w.id)).toEqual(["w-1"])
  expect(got.get("sub-2222")!.map((w) => w.id)).toEqual(["w-2"])
  expect(interruptedScopes(shutdown, { shutdownAt: 5, scopes: [] }).size).toBe(0)
  expect(interruptedScopes(shutdown, { shutdownAt: 4, scopes: [] }).size).toBe(2)
  expect(interruptedScopes(undefined, undefined).size).toBe(0)
})

const repo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-resume-"))
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim()
  git("init", "-q", "-b", "main")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  writeFileSync(path.join(dir, "a.txt"), "a\n")
  git("add", ".")
  git("commit", "-qm", "base")
  const base = git("rev-parse", "HEAD")
  writeFileSync(path.join(dir, "b.txt"), "b\n")
  git("add", ".")
  git("commit", "-qm", "feat: b")
  writeFileSync(path.join(dir, "c.txt"), "half done\n")
  return { dir, base }
}

const gate = (id: Gate["id"], status: Gate["status"], detail?: string): Gate => ({
  id,
  chosen: true,
  status,
  probability: 1,
  threshold: 0.5,
  reason: "",
  ...(detail ? { detail } : {}),
})

test("the resume turn names the stopped workers, the branch commits, uncommitted files, criteria and gates", () => {
  const { dir, base } = repo()
  const sdlc: Sdlc = {
    ...newSdlc("sub-1", "t"),
    criteria: ["route works", "tests pass"],
    gates: [gate("codeReview", "failed", "coordinator restarted"), { ...gate("docs", "pending"), chosen: false }],
  }
  const text = resumePrompt({
    at: Date.UTC(2026, 0, 1, 22, 28),
    lost: [agent("w-1", "sub-1", "implement")],
    workdir: dir,
    base,
    sdlc,
  })
  expect(text).toContain("[factory restarted]")
  expect(text).toContain("22:28 UTC")
  expect(text).toContain("n-w-1 (step implement): task of w-1")
  expect(text).toContain("feat: b")
  expect(text).not.toContain("base")
  expect(text).toContain("?? c.txt")
  expect(text).toContain("AC-1: route works")
  expect(text).toContain("- codeReview: failed (coordinator restarted)")
  expect(text).not.toContain("docs")
})

test("the resume turn says so when nothing was planned or committed", () => {
  const { dir } = repo()
  const text = resumePrompt({ at: 0, lost: [], workdir: dir, base: undefined, sdlc: undefined })
  expect(text).toContain("none (only your own turn was cut off)")
  expect(text).toContain("sdlc_plan not called")
  expect(text).toContain("- none chosen yet")
})

const fakeFactory = (s: Sdlc) => {
  const f = Object.create(Factory.prototype)
  Object.assign(f, {
    workers: new Map(),
    codeReviews: new Map(),
    securityReviews: new Map(),
    sdlc: new Map([[s.scopeId, s]]),
  })
  f.publish = () => ({})
  return f as Factory
}

test("only a code review the restart stopped runs again, and its stopped round is not counted", () => {
  const stopped = {
    ...newSdlc("sub-1", "t"),
    implementDoneAt: 10,
    reviewRounds: 1,
    gates: [gate("codeReview", "failed", "coordinator restarted")],
  }
  const f = fakeFactory(stopped)
  expect(rerunInterruptedReview(f, { id: "sub-1", threadId: "t" })).toBe(true)
  expect(f.sdlc.get("sub-1")!.reviewRounds).toBe(0)
  expect(f.sdlc.get("sub-1")!.implementDoneAt).toBe(10)

  for (const s of [
    { ...stopped, gates: [gate("codeReview", "failed", "reviewer error")] },
    { ...stopped, gates: [gate("codeReview", "done")] },
    { ...stopped, implementDoneAt: null },
  ])
    expect(rerunInterruptedReview(fakeFactory(s), { id: "sub-1", threadId: "t" })).toBe(false)
})

test("the goal runner polls through a coordinator restart, but not past a 4xx or the deadline", async () => {
  let calls = 0
  const flaky = Effect.suspend(() =>
    ++calls < 3
      ? Effect.fail(new Error("Unable to connect. Is the computer able to access the url?"))
      : Effect.succeed("ok"),
  )
  expect(await Effect.runPromise(retryTransient(flaky, Date.now() + 60_000, Duration.millis(1)))).toBe("ok")
  expect(calls).toBe(3)

  const notFound = Effect.fail(new Error("404 no thread"))
  await expect(Effect.runPromise(retryTransient(notFound, Date.now() + 60_000, Duration.millis(1)))).rejects.toThrow(
    "404",
  )
  const down = Effect.fail(new Error("502 bad gateway"))
  await expect(Effect.runPromise(retryTransient(down, Date.now() - 1, Duration.millis(1)))).rejects.toThrow("502")
})
