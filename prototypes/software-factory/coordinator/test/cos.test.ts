import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Approval } from "../src/approvals.ts"
import {
  blockerKey,
  costAlert,
  OffTrack,
  r8Scores,
  isModelError,
  issueAction,
  prEvent,
  prState,
  Ledger,
  mainCheckout,
  mergeHold,
  mergePr,
  modelErrorWorkers,
  pullMain,
  r14Blocker,
  r1Pick,
  r25Action,
  r3aBlocker,
  r3Blockers,
  RepoGates,
  taskKey,
  type PrView,
} from "../src/cos.ts"
import type { Evaluation } from "../src/evaluate.ts"

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: "a1",
  kind: "approval",
  threadId: null,
  title: "Apply the review findings?",
  summary: "",
  options: ["Apply", "Skip"],
  optionDetails: [],
  allowText: false,
  context: "c",
  status: "pending",
  answer: null,
  note: null,
  createdAt: 0,
  answeredAt: null,
  answeredBy: null,
  topic: "findings",
  shadow: {
    pick: "Apply",
    confidence: 0.96,
    covered: 1,
    probabilities: { Apply: 0.96, Skip: 0.04 },
  } as Approval["shadow"],
  ...over,
})

test("R1 answers at or above the threshold and never for excluded decisions", () => {
  expect(r1Pick(approval(), 0.95, false)).toBe("Apply")
  expect(r1Pick(approval({ shadow: { ...approval().shadow!, confidence: 0.94 } }), 0.95, false)).toBeNull()
  for (const topic of ["ship", "budget", "goal"] as const) expect(r1Pick(approval({ topic }), 0.95, false)).toBeNull()
  expect(r1Pick(approval({ title: "Review and merge PR #325?" }), 0.95, false)).toBeNull()
  expect(r1Pick(approval({ options: ["Delete the branch", "Keep"] }), 0.95, false)).toBeNull()
  expect(r1Pick(approval(), 0.95, true)).toBeNull()
  expect(r1Pick(approval({ status: "answered" }), 0.95, false)).toBeNull()
  expect(r1Pick(approval({ shadow: null }), 0.95, false)).toBeNull()
})

const evaluation = (over: Partial<Evaluation> = {}): Evaluation => ({
  id: "e",
  scopeId: "s",
  threadId: null,
  workdir: "/w",
  status: "done",
  round: 1,
  model: "m",
  verdicts: [{ id: "AC-1", verdict: "pass", command: "", output: "", note: "" }],
  workerIds: [],
  notes: [],
  at: 0,
  ...over,
})

test("R14 grants only a finished evaluation that passed every criterion", () => {
  expect(r14Blocker(evaluation())).toBeNull()
  expect(r14Blocker(undefined)).toBe("no independent evaluation")
  expect(r14Blocker(evaluation({ status: "fixing" }))).toBe("independent evaluation is fixing")
  expect(r14Blocker(evaluation({ verdicts: [] }))).toBe("independent evaluation has no verdicts")
  const failed = evaluation({
    verdicts: [...evaluation().verdicts, { id: "AC-2", verdict: "fail", command: "", output: "", note: "" }],
  })
  expect(r14Blocker(failed)).toBe("acceptance criteria failed: AC-2")
})

const pr = (over: Partial<PrView> = {}): PrView => ({
  number: 7,
  url: "u",
  state: "OPEN",
  isDraft: false,
  headRefName: "factory/x",
  reviewDecision: null,
  mergeable: "MERGEABLE",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  ...over,
})

test("R3 merges only an open, green, non-draft PR of the branch", () => {
  expect(r3Blockers(pr(), "factory/x")).toEqual([])
  expect(r3Blockers(pr({ statusCheckRollup: [] }), "factory/x")).toEqual([])
  expect(r3Blockers(pr({ statusCheckRollup: [{ status: "IN_PROGRESS" }] }), "factory/x")).toEqual([
    "checks are PENDING",
  ])
  expect(r3Blockers(pr({ statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }), "factory/x")).toEqual([
    "checks are FAILURE",
  ])
  expect(r3Blockers(pr({ isDraft: true }), "factory/x")).toEqual(["PR is a draft"])
  expect(r3Blockers(pr({ reviewDecision: "CHANGES_REQUESTED" }), "factory/x")).toEqual(["a reviewer requested changes"])
  expect(r3Blockers(pr({ mergeable: "CONFLICTING" }), "factory/x")[0]).toStartWith("PR has merge conflicts (rule R22")
  expect(r3Blockers(pr({ state: "MERGED" }), "factory/x")).toEqual(["PR #7 is MERGED"])
  expect(r3Blockers(pr(), "factory/y")).toEqual(["PR #7 is for factory/x, not factory/y"])
})

test("merge_pr refuses without a ship grant or off a factory branch, before calling gh", async () => {
  const m = { worktree: "/nowhere", repo: "/nowhere", branch: "factory/x", shipGranted: false }
  expect(await mergePr(m)).toEqual({ merged: false, reason: "no accepted ship approval for factory/x" })
  expect(await mergePr({ ...m, branch: "main", shipGranted: true })).toEqual({
    merged: false,
    reason: "only factory/* branches merge; on main",
  })
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: "pipe" })

/** origin (bare), a main checkout nested under projects/<subdir>/<repo>, and a factory worktree outside it. */
const repoFixture = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "cos-")))
  const origin = path.join(root, "origin.git")
  git(root, "init", "-q", "--bare", "-b", "main", origin)
  const checkout = path.join(root, "projects", "team", "app")
  mkdirSync(path.dirname(checkout), { recursive: true })
  git(root, "clone", "-q", origin, checkout)
  git(checkout, "checkout", "-q", "-b", "main")
  writeFileSync(path.join(checkout, "a.txt"), "1\n")
  git(checkout, "add", "a.txt")
  git(checkout, "commit", "-qm", "one")
  git(checkout, "push", "-q", "-u", "origin", "main")
  const worktree = path.join(root, "worktrees", "app-1")
  git(checkout, "worktree", "add", "-q", "-b", "factory/x", worktree)
  return { root, origin, checkout, worktree }
}

test("the main checkout is found from the worktree at a nested path and must be the registered folder", async () => {
  const { checkout, worktree, root } = repoFixture()
  expect(await mainCheckout(worktree, checkout)).toBe(checkout)
  expect(await mainCheckout(worktree, path.join(root, "projects", "other"))).toEqual({
    error: `main checkout ${checkout} is not the registered repo folder ${path.join(root, "projects", "other")}`,
  })
})

test("R3a: a dirty or non-main checkout is not pulled; a clean one pulls the merge", async () => {
  const { root, origin, checkout, worktree } = repoFixture()
  // Someone else lands a commit on origin/main (the squash merge).
  const other = path.join(root, "other")
  git(root, "clone", "-q", origin, other)
  writeFileSync(path.join(other, "b.txt"), "2\n")
  git(other, "add", "b.txt")
  git(other, "commit", "-qm", "two")
  git(other, "push", "-q", "origin", "main")

  writeFileSync(path.join(checkout, "a.txt"), "dirty\n")
  expect(await r3aBlocker(checkout)).toBe(`${checkout} has uncommitted changes`)
  expect(await pullMain(worktree, checkout)).toBe(`not pulled: ${checkout} has uncommitted changes`)
  git(checkout, "checkout", "-q", "a.txt")

  git(checkout, "checkout", "-q", "-b", "local")
  expect(await r3aBlocker(checkout)).toBe(`${checkout} is on local, not main`)
  git(checkout, "checkout", "-q", "main")

  expect(await pullMain(worktree, checkout)).toBe(`pulled ${checkout}`)
  expect(git(checkout, "log", "--format=%s", "-1").trim()).toBe("two")
})

test("the ledger keeps every action, newest first, filterable by conversation", () => {
  const l = new Ledger(mkdtempSync(path.join(tmpdir(), "ledger-")))
  l.add({ rule: "R1", threadId: "t1", action: "answer decision a", result: "done", detail: "x" })
  l.add({ rule: "R3", threadId: "t2", action: "merge factory/x", result: "refused", detail: "checks are PENDING" })
  expect(l.list().map((e) => e.rule)).toEqual(["R3", "R1"])
  expect(l.list(10, "t1").map((e) => e.action)).toEqual(["answer decision a"])
})

test("R1 never answers a decision a rule opened for the human", () => {
  expect(r1Pick(approval({ context: "Chief of Staff · R24" }), 0.95, false)).toBeNull()
})

test("R15/R17: a red main holds every merge but its fix; a fresh merge holds the next one; waiters are kept", () => {
  const g = new RepoGates()
  expect(mergeHold(g.get("/r"), "t1")).toBeNull()
  g.set("/r", { red: { fixThread: "fix", since: 1 } })
  expect(mergeHold(g.get("/r"), "t1")).toContain("rule R15")
  expect(mergeHold(g.get("/r"), "fix")).toBeNull()
  g.wait("/r", "t1")
  g.wait("/r", "t1")
  expect(g.get("/r").waiting).toEqual(["t1"])
  g.set("/r", { settling: { pr: "u/7", sha: "abc" } })
  expect(mergeHold(g.get("/r"), "fix")).toContain("rule R17")
  g.set("/r", {})
  expect(g.all()).toEqual([])
})

test("R24: the same blocker matches across commits, numbers and spacing; another does not", () => {
  const a = blockerKey(["Test foo fails at 3f2a9c1d", "lint:  12 errors"], "x")
  expect(blockerKey(["test foo fails at 9e8d7c6b", "lint: 7 errors"], "y")).toBe(a)
  expect(blockerKey(["build fails"], "x")).not.toBe(a)
  expect(blockerKey([], "Hook   failed")).toBe("hook failed")
})

test("R26: task keys ignore case and spacing", () => {
  expect(taskKey("[from the global coordinator] Fix  the\nLogin bug")).toContain(taskKey("fix the login BUG"))
})

test("R28: auth and rate-limit errors count once per worker inside the window", () => {
  expect(isModelError("HTTP 429 Too Many Requests")).toBe(true)
  expect(isModelError("401 Unauthorized")).toBe(true)
  expect(isModelError("rate limit exceeded")).toBe(true)
  expect(isModelError("ENOENT: no such file")).toBe(false)
  const errs = [
    { worker: "a", at: 0 },
    { worker: "a", at: 100 },
    { worker: "b", at: 200 },
    { worker: "c", at: 1000 },
  ]
  expect(modelErrorWorkers(errs, 1000, 900)).toEqual(["a", "b", "c"])
  expect(modelErrorWorkers(errs, 1000, 850)).toEqual(["b", "c"])
})

test("R25: idle and done archives; idle, not done and not reported reports; busy or recent does nothing", () => {
  const q = 15 * 60_000
  const base = { idle: true, quietMs: q, done: false, reported: false }
  expect(r25Action({ ...base, done: true }, q)).toBe("archive")
  expect(r25Action(base, q)).toBe("report")
  expect(r25Action({ ...base, reported: true }, q)).toBeNull()
  expect(r25Action({ ...base, idle: false }, q)).toBeNull()
  expect(r25Action({ ...base, quietMs: q - 1 }, q)).toBeNull()
})

test("merge holds survive a restart (saved in cos.db)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "gates-"))
  const a = new RepoGates(root)
  a.set("/r", { red: { fixThread: "fix", since: 1 } })
  a.wait("/r", "t1")
  expect(new RepoGates(root).get("/r")).toEqual({ red: { fixThread: "fix", since: 1 }, waiting: ["t1"] })
  a.set("/r", {})
  expect(new RepoGates(root).all()).toEqual([])
})

test("R6/R7/R8: first stall nudges, second stops; tool failures go to the owner, then the human; off-track warns the owner", () => {
  const on = () => true
  expect(issueAction("stalled", 0, on)).toBe("nudge")
  expect(issueAction("stalled", 1, on)).toBe("stop")
  expect(issueAction("failing-tools", 0, on)).toBe("to-owner")
  expect(issueAction("failing-tools", 3, on)).toBe("to-human")
  expect(issueAction("off-track", 0, on)).toBe("warn-owner")
  expect(issueAction("uncollected", 0, on)).toBeNull()
  expect(issueAction("stalled", 0, () => false)).toBeNull()
})

test("R12: one alert between 80% and the limit", () => {
  expect(costAlert(80, 100, 0.8, false)).toBe(true)
  expect(costAlert(79, 100, 0.8, false)).toBe(false)
  expect(costAlert(90, 100, 0.8, true)).toBe(false)
  expect(costAlert(100, 100, 0.8, false)).toBe(false)
})

test("typed PR events fire on a change of state only", () => {
  expect(prState("OPEN", "SUCCESS")).toBe("green")
  expect(prState("OPEN", "NONE")).toBe("green")
  expect(prState("OPEN", "FAILURE")).toBe("red")
  expect(prState("OPEN", "PENDING")).toBe("pending")
  expect(prState("MERGED", "SUCCESS")).toBe("merged")
  expect(prEvent(undefined, "green")).toBe("pr-green")
  expect(prEvent("green", "green")).toBeNull()
  expect(prEvent("pending", "red")).toBe("pr-red")
  expect(prEvent("green", "merged")).toBe("merged")
  expect(prEvent("red", "pending")).toBeNull()
})

test("R8 scores only non-gate, non-check workers between tool calls", () => {
  expect(r8Scores({ step: "implement", toolsInFlight: 0 }, false)).toBe(true)
  expect(r8Scores({ step: null, toolsInFlight: 0 }, false)).toBe(true)
  expect(r8Scores({ step: "implement", toolsInFlight: 1 }, false)).toBe(false)
  expect(r8Scores({ step: "implement", toolsInFlight: 0 }, true)).toBe(false)
  for (const step of ["verify", "evaluate", "security", "review"])
    expect(r8Scores({ step, toolsInFlight: 0 }, false)).toBe(false)
})

test("R8 acts on the second low score in a row, once per streak", () => {
  const o = new OffTrack()
  expect(o.score("w", 0.1)).toBe(false)
  expect(o.score("w", 0.2)).toBe(true)
  expect(o.score("w", 0.1)).toBe(false)
  expect(o.score("w", 0.9)).toBe(false)
  expect(o.score("w", 0.1)).toBe(false)
  expect(o.score("w", 0.1)).toBe(true)
  expect(o.score("x", 0.1)).toBe(false)
  expect(o.score("x", 0.5)).toBe(false)
  expect(o.score("x", 0.1)).toBe(false)
})
