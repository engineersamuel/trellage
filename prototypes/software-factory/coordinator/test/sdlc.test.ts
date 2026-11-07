import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  addLessons,
  artifact,
  classify,
  criteriaMarkdown,
  decide,
  ensureFactoryDir,
  implementAddendum,
  newSdlc,
  parseCriteria,
  prBody,
  readLessons,
  repoChecks,
  settleGates,
  shipBlockers,
  testsCameFirst,
  unprovenCriteria,
  withGates,
  type Sdlc,
} from "../src/sdlc.ts"
import { parseReviewFindings, pickLenses, score } from "../src/review.ts"

const f = (p: string, added = 10, removed = 0) => ({ path: p, added, removed })

describe("risk tier", () => {
  test("T0 small docs, T1 normal code, T2 size, deps or sensitive paths", () => {
    expect(classify([f("README.md", 5)]).tier).toBe("T0")
    expect(classify([f("src/a.ts", 50)]).tier).toBe("T1")
    expect(classify([f("src/a.ts", 401)]).reasons).toEqual(["401 changed lines (> 400)"])
    expect(classify([f("Cargo.lock", 2)]).touchesDeps).toBe(true)
    expect(classify([f("src/auth/token.rs", 2)]).tier).toBe("T2")
    expect(classify([f("mise.toml", 2)]).tier).toBe("T2")
  })
})

describe("gate decisions", () => {
  test("Jev probability against thresholds; floors; no Jev runs every gate", () => {
    const t1 = classify([f("src/a.ts")])
    const d = decide("diff", { codeReview: 0.3, supplyChain: 0.9, docs: 0.1, postMerge: 0.5 }, t1)
    expect(d.map((g) => [g.id, g.chosen])).toEqual([["codeReview", false], ["supplyChain", true], ["docs", false], ["postMerge", true]])
    const t2 = classify([f("Cargo.lock")])
    const floored = decide("diff", { codeReview: 0.1, supplyChain: 0.1, docs: 0.1, postMerge: 0.1 }, t2)
    expect(floored.filter((g) => g.chosen).map((g) => g.id)).toEqual(["codeReview", "supplyChain"])
    expect(floored[0]!.reason).toStartWith("floor: tier T2")
    expect(decide("plan", null, null, "down").every((g) => g.chosen && g.reason.includes("Jev unavailable (down)"))).toBe(true)
  })
})

describe("criteria and evidence", () => {
  test("markdown round-trip and unproven list", () => {
    const md = criteriaMarkdown(["one", " two "])
    expect(parseCriteria(md)).toEqual(["one", "two"])
    expect(unprovenCriteria(["one", "two", "three"], "AC-1: PASS — x\\nAC-2: FAIL — y\\n".replace(/\\\\n/g, "\n"))).toEqual(["AC-2", "AC-3"])
    expect(unprovenCriteria(["one"], null)).toEqual(["AC-1"])
  })
})

describe("test-first", () => {
  test("a tests-only commit before the first code commit", () => {
    expect(testsCameFirst([{ files: ["tests/a.rs"] }, { files: ["src/a.rs", "tests/a.rs"] }])).toBe(true)
    expect(testsCameFirst([{ files: ["src/a.rs"] }, { files: ["tests/a.rs"] }])).toBe(false)
    expect(testsCameFirst([{ files: ["src/a.test.ts", "src/a.ts"] }])).toBe(false)
  })
})

const repo = () => {
  const r = mkdtempSync(path.join(tmpdir(), "sf-sdlc-"))
  const git = (...a: string[]) => execFileSync("git", ["-C", r, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("commit", "-q", "--allow-empty", "-m", "base")
  return { r, git, base: git("rev-parse", "HEAD") }
}

describe("worktree artifacts", () => {
  test(".factory is git-excluded; CI and AGENTS.md checks are read", () => {
    const { r, git } = repo()
    ensureFactoryDir(r)
    writeFileSync(artifact(r, "x.md"), "x")
    expect(git("status", "--porcelain")).toBe("")
    mkdirSync(path.join(r, ".github", "workflows"), { recursive: true })
    writeFileSync(path.join(r, ".github/workflows/ci.yml"), "jobs:\n  a:\n    steps:\n      - run: cargo fmt --check\n      - run: |\n          cargo clippy --all-targets -- -D warnings\n          echo done\n      - run: cargo test --locked\n")
    writeFileSync(path.join(r, "AGENTS.md"), "Run `npm run lint` and `cargo test --locked`.")
    expect(repoChecks(r)).toEqual(["cargo fmt --check", "cargo clippy --all-targets -- -D warnings", "cargo test --locked", "npm run lint"])
  })

  test("ship blockers: criteria, evidence, verify after implement, security, chosen gates", () => {
    const { r, git, base } = repo()
    ensureFactoryDir(r)
    expect(shipBlockers(undefined, r, base, true, true)).toEqual(["no SDLC plan: call sdlc_plan with the acceptance criteria first"])
    let s: Sdlc = { ...newSdlc("sub", "t"), criteria: ["works"], implementDoneAt: 2, verifyDoneAt: 1 }
    s = withGates(s, decide("plan", { design: 0.9, testFirst: 0.9 }, null))
    s = withGates(s, decide("diff", { codeReview: 0.9, supplyChain: 0.1, docs: 0.9, postMerge: 0.1 }, classify([f("src/a.ts")])))
    expect(shipBlockers(s, r, base, false, false)).toEqual([
      "no PASS evidence in .factory/evidence.md for AC-1",
      "no verify step after the last implement",
      "security review not done (it runs last, when everything else is ready)",
      "design gate: .factory/design.md missing",
      "test-first gate: no tests-only commit before the first code commit",
      "code review gate not done",
      "docs gate: the diff changes no README, docs or CHANGELOG",
    ])
    writeFileSync(artifact(r, "evidence.md"), "AC-1: PASS — cargo test — ok\n")
    writeFileSync(artifact(r, "design.md"), "# Design\n## Rollback\nRevert and restart.\n")
    mkdirSync(path.join(r, "tests"))
    writeFileSync(path.join(r, "tests/a.test.ts"), "t")
    git("add", "tests")
    git("commit", "-q", "-m", "test: a")
    writeFileSync(path.join(r, "a.ts"), "a")
    writeFileSync(path.join(r, "README.md"), "r")
    git("add", "a.ts", "README.md")
    git("commit", "-q", "-m", "feat: a")
    expect(shipBlockers({ ...s, verifyDoneAt: 3 }, r, base, true, true)).toEqual([])
    const body = prBody({ ...s, risk: classify([f("src/a.ts")]) }, r, "Adds a.")
    expect(body).toContain("- [x] AC-1: works")
    expect(body).toContain("Tier T1")
    expect(body).toContain("Revert and restart.")
  })

  test("implement rules follow the chosen gates", () => {
    const s = withGates({ ...newSdlc("sub", null), criteria: ["c"] }, decide("plan", { design: 0.1, testFirst: 0.9 }, null))
    const t = implementAddendum(s)
    expect(t).toContain("AC-1: c")
    expect(t).toContain("Tests first")
    expect(t).not.toContain("design note")
  })
})

describe("lessons", () => {
  test("deduplicated, newest 20", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-lessons-"))
    addLessons(root, "cpr", ["a", "b"])
    addLessons(root, "cpr", ["a", ...Array.from({ length: 21 }, (_, i) => `x${i}`)])
    const l = readLessons(root, "cpr")
    expect(l.length).toBe(20)
    expect(l.at(-1)).toBe("x20")
    expect(l.filter((x) => x === "a").length).toBeLessThanOrEqual(1)
    expect(readFileSync(path.join(root, "lessons", "cpr.md"), "utf8").startsWith("- ")).toBe(true)
  })
})

describe("code review", () => {
  test("lens pick: threshold, cap, at least one, default without Jev", () => {
    expect(pickLenses(null)).toEqual(["correctness", "tests"])
    expect(pickLenses({ correctness: 0.9, tests: 0.7, design: 0.65, performance: 0.8, operability: 0.1 })).toEqual(["correctness", "performance", "tests"])
    expect(pickLenses({ correctness: 0.1, tests: 0.2, design: 0.1, performance: 0.1, operability: 0.3 })).toEqual(["operability"])
  })
  test("findings parse and score", () => {
    const fs = parseReviewFindings(JSON.stringify([{ title: "t", problem: "p", severity: "high" }, { nope: 1 }]))
    expect(fs).toEqual([{ id: "cr1", title: "t", file: "unknown", severity: "high", problem: "p", fix: "", lenses: [] }])
    expect(parseReviewFindings("not json")).toEqual([])
    expect(score(fs[0]!, 0.8, 0.7).keep).toBe(true)
    expect(score(fs[0]!, 0.8, 0.5).keep).toBe(false)
    expect(score(fs[0]!, undefined, undefined).keep).toBe(true)
    expect(score({ ...fs[0]!, severity: "low" }, undefined, undefined).keep).toBe(false)
  })
})

describe("gate settling", () => {
  test("unblocked on-diff gates become done; postMerge waits for the merge; blocked ones stay", () => {
    const s = withGates(withGates(newSdlc("sub", null), decide("plan", { design: 0.9, testFirst: 0.9 }, null)), decide("diff", { codeReview: 0.1, supplyChain: 0.1, docs: 0.9, postMerge: 0.9 }, classify([f("src/a.ts")])))
    const settled = settleGates(s, ["test-first gate: no tests-only commit before the first code commit"])
    expect(Object.fromEntries(settled.gates.map((g) => [g.id, g.status]))).toEqual({ design: "done", testFirst: "pending", codeReview: "skipped", supplyChain: "skipped", docs: "done", postMerge: "pending" })
    expect(settled.gates.find((g) => g.id === "postMerge")?.detail).toBe("runs after the human merges")
  })
  test("implement rules carry the minimal-change rule and a scope warning", () => {
    const t = implementAddendum({ ...newSdlc("sub", null), criteria: ["c"], scopeWarning: "diff grew from 100 to 600 lines" })
    expect(t).toContain("smallest change")
    expect(t).toContain("Scope warning: diff grew from 100 to 600 lines")
  })
})
