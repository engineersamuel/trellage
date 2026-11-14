import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Approval } from "../src/approvals.ts"
import {
  Ledger,
  mainCheckout,
  mergePr,
  pullMain,
  r14Blocker,
  r1Pick,
  r3aBlocker,
  r3Blockers,
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
  expect(r3Blockers(pr({ mergeable: "CONFLICTING" }), "factory/x")).toEqual(["PR has merge conflicts"])
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
