import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  addLessons,
  inHistory,
  rebaseChangedLines,
  artifact,
  classify,
  criteriaMarkdown,
  decide,
  ensureFactoryDir,
  implementAddendum,
  isTestPath,
  newSdlc,
  parseCriteria,
  factoryThreadUrl,
  prBody,
  readLessons,
  screenshotsMarkdown,
  repoChecks,
  settleGates,
  shipBlockers,
  unprovenCriteria,
  waiveGate,
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
    expect(d.map((g) => [g.id, g.chosen])).toEqual([
      ["codeReview", false],
      ["supplyChain", true],
      ["docs", false],
      ["postMerge", true],
    ])
    const t2 = classify([f("Cargo.lock")])
    const floored = decide("diff", { codeReview: 0.1, supplyChain: 0.1, docs: 0.1, postMerge: 0.1 }, t2)
    expect(floored.filter((g) => g.chosen).map((g) => g.id)).toEqual(["codeReview", "supplyChain"])
    expect(floored[0]!.reason).toStartWith("floor: tier T2")
    expect(
      decide("plan", null, null, "down").every((g) => g.chosen && g.reason.includes("Jev unavailable (down)")),
    ).toBe(true)
  })
})

describe("criteria and evidence", () => {
  test("markdown round-trip and unproven list", () => {
    const md = criteriaMarkdown(["one", " two "])
    expect(parseCriteria(md)).toEqual(["one", "two"])
    expect(
      unprovenCriteria(["one", "two", "three"], "AC-1: PASS — x\\nAC-2: FAIL — y\\n".replace(/\\\\n/g, "\n")),
    ).toEqual(["AC-2", "AC-3"])
    expect(unprovenCriteria(["one"], null)).toEqual(["AC-1"])
  })
})

describe("test paths", () => {
  test.each([
    "test.sh",
    "scripts/test.sh",
    "tests.sh",
    "test_api.py",
    "pkg/test_util.py",
    "cli_test.ts",
    "tests/a.rs",
    "src/a.test.ts",
    "a_test.go",
    "__tests__/x.js",
    "spec/x.rb",
  ])("isTestPath true for %s", (p) => expect(isTestPath(p)).toBe(true))

  test.each(["src/testing.ts", "src/latest.ts", "contest.py", "src/attest.rs", "README.md"])(
    "isTestPath false for %s",
    (p) => expect(isTestPath(p)).toBe(false),
  )
})

const repo = () => {
  const r = mkdtempSync(path.join(tmpdir(), "sf-sdlc-"))
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", r, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
      encoding: "utf8",
    }).trim()
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
    writeFileSync(
      path.join(r, ".github/workflows/ci.yml"),
      "jobs:\n  a:\n    steps:\n      - run: cargo fmt --check\n      - run: |\n          cargo clippy --all-targets -- -D warnings\n          echo done\n      - run: cargo test --locked\n",
    )
    writeFileSync(path.join(r, "AGENTS.md"), "Run `npm run lint` and `cargo test --locked`.")
    expect(repoChecks(r)).toEqual([
      "cargo fmt --check",
      "cargo clippy --all-targets -- -D warnings",
      "cargo test --locked",
      "npm run lint",
    ])
  })

  test("ship blockers: criteria, evidence, verify after implement, security, chosen gates", () => {
    const { r, git, base } = repo()
    ensureFactoryDir(r)
    expect(shipBlockers(undefined, r, base, true, true)).toEqual([
      "no SDLC plan: call sdlc_plan with the acceptance criteria first",
    ])
    let s: Sdlc = {
      ...newSdlc("sub", "t"),
      criteria: ["works"],
      implementDoneAt: 2,
      verifyDoneAt: 1,
    }
    s = withGates(s, decide("plan", { design: 0.9 }, null))
    s = withGates(
      s,
      decide("diff", { codeReview: 0.9, supplyChain: 0.1, docs: 0.9, postMerge: 0.1 }, classify([f("src/a.ts")])),
    )
    expect(shipBlockers(s, r, base, false, false)).toEqual([
      "no PASS evidence in .factory/evidence.md for AC-1",
      "no verify step after the last implement",
      "security review not done (it runs last, when everything else is ready)",
      "design gate: .factory/design.md missing",
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
    expect(body).not.toContain("## Factory")
    const id = "11111111-2222-3333-4444-555555555555"
    const linked = prBody(s, r, "Adds a.", undefined, id)
    expect(linked).toContain(`## Factory\nthread=${id}\nhttp://localhost:5174/?thread=${id}`)
    expect(factoryThreadUrl(id, "http://factory.test:9000/ui")).toBe(`http://factory.test:9000/ui?thread=${id}`)
  })

  test("waiveGate marks only a chosen docs gate done and removes its blocker", () => {
    const { r, git, base } = repo()
    ensureFactoryDir(r)
    writeFileSync(path.join(r, "src.ts"), "base")
    git("add", "src.ts")
    git("commit", "-q", "-m", "base")
    writeFileSync(path.join(r, "src.ts"), "changed")
    writeFileSync(path.join(r, "src.test.ts"), "test")
    git("add", "src.ts", "src.test.ts")
    let s: Sdlc = {
      ...newSdlc("sub", null),
      request: "Keep the change minimal: the regex and its tests",
      criteria: ["works"],
      implementDoneAt: 2,
      verifyDoneAt: 3,
    }
    s = withGates(s, decide("diff", { docs: 0.9 }, null))
    writeFileSync(artifact(r, "evidence.md"), "AC-1: PASS — bun test — ok\n")
    const before = shipBlockers(s, r, base, true, true)
    expect(before.some((b) => b.startsWith("docs gate:"))).toBe(true)
    const result = waiveGate(s, "docs", "the regex and its tests")
    expect("error" in result).toBe(false)
    if ("error" in result) throw new Error(result.error)
    const docs = result.sdlc.gates.find((g) => g.id === "docs")!
    expect(docs.status).toBe("done")
    expect(docs.detail?.startsWith("waived:")).toBe(true)
    expect(shipBlockers(result.sdlc, r, base, true, true).some((b) => b.startsWith("docs gate:"))).toBe(false)
  })

  test("waiveGate rejects other gates and unquoted reasons without changing state", () => {
    const { r, base } = repo()
    ensureFactoryDir(r)
    writeFileSync(path.join(r, "src.ts"), "base")
    writeFileSync(path.join(r, "src.test.ts"), "test")
    let s: Sdlc = withGates(
      {
        ...newSdlc("sub", null),
        request: "Keep the change minimal: code and tests only",
        criteria: ["works"],
        implementDoneAt: 2,
        verifyDoneAt: 1,
      },
      decide("diff", { docs: 0.9, codeReview: 0.9, supplyChain: 0.9 }, null),
    )
    writeFileSync(artifact(r, "evidence.md"), "AC-1: PASS — bun test — ok\n")
    for (const id of ["design", "codeReview", "supplyChain", "postMerge", "security", "verify", "unknown"]) {
      const before = structuredClone(s)
      const blockersBefore = shipBlockers(s, r, base, false, false)
      expect(blockersBefore.some((b) => b.startsWith("docs gate:"))).toBe(true)
      expect(blockersBefore.some((b) => b.startsWith("security review not done"))).toBe(true)
      expect(blockersBefore).toContain("no verify step after the last implement")
      const result = waiveGate(s, id, "code and tests only")
      expect("error" in result).toBe(true)
      if (!("error" in result)) throw new Error("expected refusal")
      expect(result.error).toContain("only the docs gate")
      expect(result.error).toContain("floors")
      expect(result.error).toContain("never be waived")
      expect(s).toEqual(before)
      expect(shipBlockers(s, r, base, false, false)).toEqual(blockersBefore)
      expect(shipBlockers(s, r, base, false, false).some((b) => b.startsWith("docs gate:"))).toBe(true)
    }
    for (const reason of ["", " documentation updates "]) {
      const before = structuredClone(s)
      const blockersBefore = shipBlockers(s, r, base, false, false)
      expect(blockersBefore.some((b) => b.startsWith("docs gate:"))).toBe(true)
      const result = waiveGate(s, "docs", reason)
      expect("error" in result).toBe(true)
      expect(s).toEqual(before)
      if (!("error" in result)) throw new Error("expected refusal")
      expect(result.error).toMatch(/reason.*request|request.*reason|words of the request/i)
      expect(shipBlockers(s, r, base, false, false)).toEqual(blockersBefore)
      expect(shipBlockers(s, r, base, false, false).some((b) => b.startsWith("docs gate:"))).toBe(true)
    }
  })

  test("prBody includes the waived docs reason in the Gates section", () => {
    let s: Sdlc = withGates(
      { ...newSdlc("sub", null), request: "code and tests only", criteria: ["works"] },
      decide("diff", { docs: 0.9 }, null),
    )
    const waived = waiveGate(s, "docs", "code and tests only")
    if ("error" in waived) throw new Error(waived.error)
    s = waived.sdlc
    const body = prBody(s, tmpdir(), "Adds a.")
    expect(body).toContain("## Gates")
    expect(body).toMatch(/- docs: done \([^)]*\) — waived: code and tests only/)
  })

  test("implement rules follow the chosen gates", () => {
    const s = withGates({ ...newSdlc("sub", null), criteria: ["c"] }, decide("plan", { design: 0.1 }, null))
    const t = implementAddendum(s)
    expect(t).toContain("AC-1: c")
    expect(t).not.toContain("Tests first")
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
    expect(
      pickLenses({
        correctness: 0.9,
        tests: 0.7,
        design: 0.65,
        performance: 0.8,
        operability: 0.1,
      }),
    ).toEqual(["correctness", "performance", "tests"])
    expect(pickLenses({ correctness: 0.1, tests: 0.2, design: 0.1, performance: 0.1, operability: 0.3 })).toEqual([
      "operability",
    ])
    // T2 always gets at least 2 reviewers; the bar is 0.6.
    expect(pickLenses({ correctness: 0.7, tests: 0.2, design: 0.1, performance: 0.1, operability: 0.4 }, "T2")).toEqual(
      ["correctness", "operability"],
    )
    expect(
      pickLenses({ correctness: 0.7, tests: 0.55, design: 0.1, performance: 0.1, operability: 0.4 }, "T1"),
    ).toEqual(["correctness"])
  })
  test("findings parse and score", () => {
    const fs = parseReviewFindings(JSON.stringify([{ title: "t", problem: "p", severity: "high" }, { nope: 1 }]))
    expect(fs).toEqual([
      {
        id: "cr1",
        title: "t",
        file: "unknown",
        severity: "high",
        problem: "p",
        fix: "",
        lenses: [],
      },
    ])
    expect(parseReviewFindings("not json")).toEqual([])
    expect(score(fs[0]!, 0.8, 0.7).keep).toBe(true)
    expect(score(fs[0]!, 0.8, 0.65).keep).toBe(false)
    // Low severity is never fixed in the change, however Jev scores it.
    expect(score({ ...fs[0]!, severity: "low" }, 0.95, 0.95).keep).toBe(false)
    expect(score(fs[0]!, undefined, undefined).keep).toBe(true)
    expect(score({ ...fs[0]!, severity: "low" }, undefined, undefined).keep).toBe(false)
  })
})

describe("gate settling", () => {
  test("unblocked on-diff gates become done; postMerge waits for the merge; blocked ones stay", () => {
    const s = withGates(
      withGates(newSdlc("sub", null), decide("plan", { design: 0.9 }, null)),
      decide("diff", { codeReview: 0.1, supplyChain: 0.1, docs: 0.9, postMerge: 0.9 }, classify([f("src/a.ts")])),
    )
    const settled = settleGates(s, ["docs gate: the diff changes no README, docs or CHANGELOG"])
    expect(Object.fromEntries(settled.gates.map((g) => [g.id, g.status]))).toEqual({
      design: "done",
      codeReview: "skipped",
      supplyChain: "skipped",
      docs: "pending",
      postMerge: "pending",
    })
    expect(settled.gates.find((g) => g.id === "postMerge")?.detail).toBe("runs after the human merges")
  })
  test("implement rules carry the minimal-change rule and a scope warning", () => {
    const t = implementAddendum({
      ...newSdlc("sub", null),
      criteria: ["c"],
      scopeWarning: "diff grew from 100 to 600 lines",
    })
    expect(t).toContain("smallest change")
    expect(t).toContain("Scope warning: diff grew from 100 to 600 lines")
  })
})

describe("reviewer model", () => {
  test("the other family than the implementer; an env pin wins", async () => {
    const { reviewModelFor, lensModel, reviewModels, geminiReachable } = await import("../src/review.ts")
    // Three frontier families; reviewers come from the two the implementer is not in.
    expect(reviewModels("claude-opus-5.5")).toEqual(["gpt-6-astra", "gemini-4-argon"])
    expect(reviewModels("gpt-6-astra")).toEqual(["claude-opus-5.5", "gemini-4-argon"])
    expect(reviewModels("gemini-4-argon")).toEqual(["gpt-6-astra", "claude-opus-5.5"])
    expect(reviewModels("claude-opus-5.5", false)).toEqual(["gpt-6-astra"])
    // Two lenses read with two different models; a third wraps around.
    expect([0, 1, 2].map((i) => lensModel("claude-opus-5.5", i, true, ""))).toEqual([
      "gpt-6-astra",
      "gemini-4-argon",
      "gpt-6-astra",
    ])
    expect(
      geminiReachable("auto") && geminiReachable("claude") && geminiReachable("copilot") && geminiReachable("pi"),
    ).toBe(true)
    const { reviewerRoute } = await import("../src/review.ts")
    expect(reviewerRoute("gemini-4-argon", "copilot")).toEqual({ auth: "proxy" })
    expect(reviewerRoute("gemini-4-argon", "auto")).toEqual({ auth: "proxy" })
    expect(reviewerRoute("gemini-4-argon", "claude")).toEqual({
      harness: { kind: "claude", profiles: ["default"] },
    })
    expect(reviewerRoute("gpt-6-astra", "copilot")).toEqual({})
    expect(reviewerRoute("gemini-4-argon", "pi")).toEqual({})
    expect(reviewModelFor("gpt-6-astra", "")).toBe("claude-opus-5.5")
    expect(reviewModelFor("gpt-6.1-sol", undefined)).toBe("claude-opus-5.5")
    expect(reviewModelFor("claude-opus-5.5", undefined)).toBe("gpt-6-astra")
    expect(reviewModelFor(null, undefined)).toBe("gpt-6-astra")
    expect(reviewModelFor("gpt-6-astra", "claude-sonnet-5.5")).toBe("claude-sonnet-5.5")
  })
})

test("osv flags: advisories and license violations per package", () => {
  const { osvFlagsFrom } = require("../src/sdlc.ts")
  const report = {
    results: [
      {
        packages: [
          {
            package: { name: "tokio", version: "1.0.0" },
            vulnerabilities: [{ id: "RUSTSEC-1" }],
            license_violations: [],
          },
          {
            package: { name: "subtle", version: "2.6.1" },
            vulnerabilities: [],
            license_violations: ["BSD-3-Clause"],
          },
          { package: { name: "toml", version: "1.2.1" } },
        ],
      },
    ],
  }
  expect([...osvFlagsFrom(report)]).toEqual(["tokio@1.0.0: RUSTSEC-1", "subtle@2.6.1: license BSD-3-Clause"])
})

test("rebaseChangedLines: 0 for a clean rebase, conflict resolutions count", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sf-rebase-")))
  const g = (...a: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
      encoding: "utf8",
    }).trim()
  g("init", "-q", "-b", "main")
  writeFileSync(path.join(dir, "f.txt"), "1\n2\n3\n")
  g("add", ".")
  g("commit", "-q", "-m", "init")
  g("checkout", "-q", "-b", "feat")
  writeFileSync(path.join(dir, "f.txt"), "1\n2\n3\nfeat\n")
  g("commit", "-q", "-am", "feat")
  const reviewed = g("rev-parse", "HEAD")
  g("checkout", "-q", "main")
  writeFileSync(path.join(dir, "m.txt"), "main\n")
  g("add", ".")
  g("commit", "-q", "-m", "main")
  const main1 = g("rev-parse", "HEAD")
  g("checkout", "-q", "feat")
  g("rebase", "-q", "main")
  expect(inHistory(dir, reviewed)).toBe(false)
  expect(rebaseChangedLines(dir, reviewed, main1)).toBe(0)

  // A conflict: main edits the same spot; the resolution rewrites the branch line.
  const reviewed2 = g("rev-parse", "HEAD")
  g("checkout", "-q", "main")
  writeFileSync(path.join(dir, "f.txt"), "1\n2\n3\nmain\n")
  g("commit", "-q", "-am", "main2")
  const main2 = g("rev-parse", "HEAD")
  g("checkout", "-q", "feat")
  g("checkout", "-q", "-b", "tmp", main2)
  writeFileSync(path.join(dir, "f.txt"), "1\n2\n3\nmain feat\n")
  g("commit", "-q", "-am", "feat resolved")
  expect(rebaseChangedLines(dir, reviewed2, main2)).toBeGreaterThan(0)
  expect(inHistory(dir, main2)).toBe(true)
})

test("screenshotsMarkdown lists the newest 4 UI screenshots, or nothing", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "sf-shots-"))
  expect(screenshotsMarkdown(wt)).toBe("")
  mkdirSync(artifact(wt, "screenshots"), { recursive: true })
  for (const n of ["1.png", "2.png", "3.jpg", "4.png", "5.png", "notes.txt"])
    writeFileSync(artifact(wt, `screenshots/${n}`), "")
  const md = screenshotsMarkdown(wt)
  expect(md.match(/!\[[^\]]+\]/g)).toEqual(["![2.png]", "![3.jpg]", "![4.png]", "![5.png]"])
})
