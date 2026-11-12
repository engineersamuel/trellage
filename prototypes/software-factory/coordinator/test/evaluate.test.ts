import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { factoryConfig } from "../src/config.ts"
import {
  agreeContract,
  contractMarkdown,
  contractProblems,
  evaluate,
  evaluationMarkdown,
  evaluatorPermissions,
  lockedCount,
  parseContract,
  parseVerdicts,
} from "../src/evaluate.ts"
import { Factory, type SpawnSpec } from "../src/factory.ts"
import { planApprovalCheck, planSdlc, startEvaluation } from "../src/gates.ts"
import {
  artifact,
  contractFor,
  criteriaWithChecks,
  ensureFactoryDir,
  newSdlc,
  prBody,
  type ContractItem,
  type Sdlc,
} from "../src/sdlc.ts"
import { defaultSettings } from "../src/settings.ts"
import { buildGrade } from "../../shared/goal.ts"

test("the contract keeps one item per criterion in order; junk and unknown ids are dropped", () => {
  const text = JSON.stringify([
    { id: "AC-2", problem: "two things", rewrite: "split" },
    { id: "AC-1", check: "curl -s :18080/health", expect: "200" },
    { id: "AC-9", check: "x" },
    { id: "nope", check: "x" },
    "junk",
  ])
  expect(parseContract(text, 3)).toEqual([
    { id: "AC-1", check: "curl -s :18080/health", expect: "200" },
    { id: "AC-2", problem: "two things", rewrite: "split" },
  ])
  expect(parseContract("not json", 2)).toEqual([])
})

test("a criterion with no valid verdict fails: the evaluator did not prove it", () => {
  const v = parseVerdicts(
    JSON.stringify([
      { id: "AC-1", verdict: "pass", command: "c", output: "o", note: "n" },
      { id: "AC-2", verdict: "maybe" },
    ]),
    2,
  )
  expect(v.map((x) => [x.id, x.verdict])).toEqual([
    ["AC-1", "pass"],
    ["AC-2", "fail"],
  ])
  expect(v[1]!.note).toBe("no verdict from the evaluator")
  expect(parseVerdicts("", 1)[0]!.verdict).toBe("fail")
})

test("locked goal criteria never go back to the sub-coordinator; others do", () => {
  const request = "…locked: use them as AC-1..AC-2 word for word in sdlc_plan…"
  expect(lockedCount(request)).toBe(2)
  expect(lockedCount("plain")).toBe(0)
  const items: ContractItem[] = [
    { id: "AC-1", problem: "vague", rewrite: "r1" },
    { id: "AC-3", problem: "vague", rewrite: "r3" },
  ]
  const p = contractProblems(items, 2)
  expect(p.open.map((x) => x.id)).toEqual(["AC-3"])
  expect(p.locked.map((x) => x.id)).toEqual(["AC-1"])
})

test("tasks and contract.md carry each criterion's agreed check", () => {
  const contract: ContractItem[] = [{ id: "AC-1", check: "cargo test x", expect: "ok" }]
  expect(criteriaWithChecks(["x works", "y works"], contract)).toBe(
    "AC-1: x works\n  check: cargo test x\n  expect: ok\nAC-2: y works",
  )
  expect(contractMarkdown(["x works", "y works"], contract)).toContain("## AC-2: y works\n- no check agreed")
})

test("the evaluator may write only under its output folder and never change git state", () => {
  const gate = evaluatorPermissions("/state/w-1/evaluate")
  const ask = (r: object) => gate(r as never, {} as never) as { kind: string }
  expect(ask({ kind: "write", fileName: "/state/w-1/evaluate/verdicts.json" }).kind).not.toBe("reject")
  expect(ask({ kind: "write", fileName: "/repo/src/main.rs" }).kind).toBe("reject")
  expect(ask({ kind: "write", fileName: "/state/w-1/evaluate/../../x" }).kind).toBe("reject")
  for (const cmd of ["git commit -am x", "git -C /r stash", "cd /r && git checkout .", "git push origin x"])
    expect(ask({ kind: "shell", fullCommandText: cmd }).kind).toBe("reject")
  for (const cmd of ["cargo build", "git diff main", "curl -s :18080/v1/models", "git log --oneline"])
    expect(ask({ kind: "shell", fullCommandText: cmd }).kind).not.toBe("reject")
})

// ---------- orchestration with a fake factory ----------

const repo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-eval-"))
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" })
  git("init", "-q", "-b", "factory/x")
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base")
  return dir
}

/** A fake factory whose evaluate workers write the verdicts `rounds[i]` gives (AC id → pass/fail). */
const fakeFactory = (rounds: Record<string, "pass" | "fail">[], contract?: unknown[]) => {
  const f = Object.create(Factory.prototype)
  const root = mkdtempSync(path.join(tmpdir(), "sf-eval-state-"))
  let evals = 0
  Object.assign(f, {
    root,
    workers: new Map(),
    securityReviews: new Map(),
    codeReviews: new Map(),
    evaluations: new Map(),
    sdlc: new Map(),
    stored: defaultSettings(),
    spawned: [] as SpawnSpec[],
    stopped: [] as string[],
    published: [] as { type: string; data: unknown }[],
  })
  f.publish = (_w: string, type: string, _a: null, _t: string, data: unknown) => f.published.push({ type, data })
  f.stop = async (id: string) => void f.stopped.push(id)
  f.spawn = async (spec: SpawnSpec) => {
    f.spawned.push(spec)
    const out = spec.id ? path.join(root, spec.id, "evaluate") : null
    if (spec.name === "evaluate" && out) {
      const r = rounds[evals++] ?? {}
      writeFileSync(
        path.join(out, "verdicts.json"),
        JSON.stringify(
          Object.entries(r).map(([id, verdict]) => ({
            id,
            verdict,
            command: "c",
            output: "o",
            note: `${verdict} note`,
          })),
        ),
      )
    }
    if (spec.name === "evaluate-contract" && out)
      writeFileSync(path.join(out, "contract.json"), JSON.stringify(contract ?? []))
    const id = spec.id ?? `w-${f.spawned.length}`
    return { id, status: "idle", lastError: null, waitIdle: async () => true }
  }
  return f as Factory & { spawned: SpawnSpec[]; stopped: string[]; published: { type: string; data: unknown }[] }
}

const sdlc = (over: Partial<Sdlc> = {}): Sdlc => ({
  ...newSdlc("sub-1", "t"),
  criteria: ["a works", "b works"],
  implementDoneAt: 1,
  verifyDoneAt: 2,
  implementerModel: "claude-sonnet-5.5",
  ...over,
})

test("a failed criterion gets one fix and verify round, then a new evaluation; a later fail ends it without blocking", async () => {
  const workdir = repo()
  const f = fakeFactory([
    { "AC-1": "pass", "AC-2": "fail" },
    { "AC-1": "pass", "AC-2": "pass" },
  ])
  const e = await evaluate(f, { id: "sub-1", threadId: "t", workdir }, sdlc(), factoryConfig())
  expect(f.spawned.map((s) => [s.name, s.step])).toEqual([
    ["evaluate", "evaluate"],
    ["evaluate-fix", "implement"],
    ["evaluate-verify", "verify"],
    ["evaluate", "evaluate"],
  ])
  // The evaluator is from another family than the implementer (claude), and gated; the fixer is not.
  expect(f.spawned[0]!.model).not.toMatch(/^claude/)
  expect(f.spawned[0]!.permissions).toBeDefined()
  expect(f.spawned[1]!.permissions).toBeUndefined()
  expect(f.spawned[1]!.task).toContain("AC-2: fail note")
  expect(e).toMatchObject({ status: "done", round: 2 })
  expect(e.verdicts.map((v) => v.verdict)).toEqual(["pass", "pass"])
  expect(readFileSync(e.file!.path, "utf8")).toContain("AC-2")

  const g = fakeFactory([{ "AC-1": "fail" }, { "AC-1": "fail" }])
  const still = await evaluate(g, { id: "sub-1", threadId: "t", workdir }, sdlc(), factoryConfig())
  expect(g.spawned.filter((s) => s.name === "evaluate")).toHaveLength(2)
  expect(still).toMatchObject({ status: "done", round: 2 })
  expect(still.verdicts.map((v) => v.verdict)).toEqual(["fail", "fail"])
  expect(evaluationMarkdown(still)).toContain("- [ ] AC-1: FAIL")
})

test("a ship request starts the evaluation once per implement, before the final security review", () => {
  const workdir = repo()
  ensureFactoryDir(workdir)
  writeFileSync(artifact(workdir, "evidence.md"), "AC-1: PASS\nAC-2: PASS\n")
  const f = fakeFactory([{ "AC-1": "pass", "AC-2": "pass" }])
  f.sdlc.set("sub-1", sdlc())
  const scope = { id: "sub-1", threadId: "t", workdir }
  expect(startEvaluation(f, scope)).toContain("independent evaluator started")
  expect(startEvaluation(f, scope)).toContain("is evaluating")
  const ev = [...f.evaluations.values()][0]!
  f.evaluations.set(ev.id, { ...ev, status: "done", at: 5 })
  expect(startEvaluation(f, scope)).toBeNull()
  // A later implement needs a new evaluation; one a restart stopped runs again.
  f.sdlc.set("sub-1", sdlc({ implementDoneAt: 9, verifyDoneAt: 10 }))
  expect(startEvaluation(f, scope)).toContain("independent evaluator started")
  for (const e of f.evaluations.values())
    f.evaluations.set(e.id, { ...e, status: "failed", error: "coordinator restarted", at: 20 })
  expect(startEvaluation(f, scope)).toContain("independent evaluator started")
  // Not before the floors: no verify after the last implement.
  const g = fakeFactory([])
  g.sdlc.set("sub-1", sdlc({ verifyDoneAt: 0 }))
  expect(startEvaluation(g, scope)).toBeNull()
})

test("the contract runs in the background; the plan approval waits for it and gets the open problems back", async () => {
  const workdir = repo()
  const contract = [
    { id: "AC-1", check: "cargo test a", expect: "ok" },
    { id: "AC-2", problem: "not observable", rewrite: "b returns 200" },
  ]
  let release = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const slow: typeof agreeContract = async (...a) => (await gate, agreeContract(...a))
  const f = fakeFactory([], contract)
  const scope = { id: "sub-1", threadId: "t", workdir }
  const first = await planSdlc(f, scope, "req", ["a works", "b is nice"], "plan", slow)
  // sdlc_plan returned while the contract still runs; the plan approval must wait.
  expect(first.contractState).toMatchObject({ status: "running", round: 1, final: false })
  expect(planApprovalCheck(f, "sub-1").wait).toContain("still agreeing")
  release()
  await first.job
  expect(f.sdlc.get("sub-1")!.contractState).toMatchObject({ status: "done", round: 1 })
  expect(planApprovalCheck(f, "sub-1").wait).toContain("AC-2: not observable Suggested: b returns 200")
  expect(readFileSync(artifact(workdir, "contract.md"), "utf8")).toContain("check: `cargo test a`")
  // Round 2 is the last: open problems no longer block; they become notes for the approval summary.
  await (
    await planSdlc(f, scope, "req", ["a works", "b is nice"], "plan")
  ).job
  expect(planApprovalCheck(f, "sub-1")).toEqual({
    wait: null,
    notes: ["AC-2: not observable Suggested: b returns 200"],
  })
  const third = await planSdlc(f, scope, "req", ["a works", "b is nice"], "plan")
  expect(third.job).toBeUndefined()
  expect(f.spawned.filter((s) => s.name === "evaluate-contract")).toHaveLength(2)
  expect(contractFor(f.sdlc.get("sub-1")!)).toEqual(contract as ContractItem[])
})

test("changed criteria drop the old contract, so an old check never tests a new AC", async () => {
  const workdir = repo()
  const f = fakeFactory([], [{ id: "AC-1", check: "old check", expect: "ok" }])
  const scope = { id: "sub-1", threadId: "t", workdir }
  for (let i = 0; i < 2; i++) await (await planSdlc(f, scope, "req", ["old"], "plan")).job
  expect(contractFor(f.sdlc.get("sub-1")!)).toHaveLength(1)
  // The round limit is used up; new criteria get no contract rather than the old one.
  const changed = await planSdlc(f, scope, "req", ["new"], "plan")
  expect(changed.job).toBeUndefined()
  expect(contractFor(changed)).toBeUndefined()
  expect(changed.contract).toBeUndefined()
  expect(existsSync(artifact(workdir, "contract.md"))).toBe(false)
  expect(criteriaWithChecks(changed.criteria, contractFor(changed))).toBe("AC-1: new")
  expect(planApprovalCheck(f, "sub-1")).toEqual({ wait: null, notes: [] })
})

test("a contract the sub-coordinator replaced with new criteria never lands", async () => {
  const workdir = repo()
  let release = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const f = fakeFactory([], [{ id: "AC-1", check: "stale", expect: "ok" }])
  const slow: typeof agreeContract = async (...a) => (await gate, agreeContract(...a))
  const scope = { id: "sub-1", threadId: "t", workdir }
  const first = await planSdlc(f, scope, "req", ["one"], "plan", slow)
  await planSdlc(f, scope, "req", ["two"], "plan", async () => null)
  release()
  await first.job
  expect(f.sdlc.get("sub-1")!.contract).toBeUndefined()
  expect(f.sdlc.get("sub-1")!.contractState?.criteria).toEqual(["two"])
})

test("the PR body shows the evaluator's verdicts; a g2 grade uses them and counts disagreements", () => {
  const workdir = repo()
  ensureFactoryDir(workdir)
  writeFileSync(artifact(workdir, "evidence.md"), "AC-1: PASS\n")
  const body = prBody(
    sdlc({ criteria: ["a works"] }),
    workdir,
    "sum",
    "Independent evaluator (m), 1 round.\n- [ ] AC-1: FAIL — stub",
  )
  expect(body).toContain("## Independent evaluation\nIndependent evaluator (m)")

  const base = {
    at: 1,
    factoryCommit: "c",
    subject: { kind: "goal" as const, id: "g" },
    report: { status: "done", commit: "x" },
    benchmarks: null,
    evidence: [],
    quality: [],
    errors: [],
  }
  const run = { threadId: "t", pr: null }
  const g2 = buildGrade(run, {
    ...base,
    criteria: { "AC-1": "fail", "AC-2": "pass" },
    selfCriteria: { "AC-1": "pass", "AC-2": "pass" },
  })
  expect(g2).toMatchObject({ gradingVersion: "g2", status: "fail", disagreements: ["AC-1"] })
  expect(g2.key.endsWith("|g2")).toBe(true)
  const g1 = buildGrade(run, { ...base, criteria: { "AC-1": "pass" } })
  expect(g1.gradingVersion).toBe("g1")
  expect("disagreements" in g1).toBe(false)
})
