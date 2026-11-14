import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  isTestPath,
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

describe("test-first", () => {
  test("a tests-only commit before the first code commit", () => {
    expect(testsCameFirst([{ files: ["tests/a.rs"] }, { files: ["src/a.rs", "tests/a.rs"] }])).toBe(true)
    expect(testsCameFirst([{ files: ["src/a.rs"] }, { files: ["tests/a.rs"] }])).toBe(false)
    expect(testsCameFirst([{ files: ["src/a.test.ts", "src/a.ts"] }])).toBe(false)
    expect(testsCameFirst([{ files: ["test.sh"] }, { files: ["hello.txt"] }])).toBe(true)
    expect(testsCameFirst([{ files: ["tests/a.rs", "README.md"] }])).toBe(false)
  })

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

const repositories: string[] = []
afterAll(() => {
  for (const directory of repositories) rmSync(directory, { recursive: true, force: true })
})

const repo = () => {
  const r = mkdtempSync(path.join(tmpdir(), "sf-sdlc-"))
  repositories.push(r)
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", r, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
      encoding: "utf8",
    }).trim()
  git("init", "-q")
  git("commit", "-q", "--allow-empty", "-m", "base")
  return { r, git, base: git("rev-parse", "HEAD") }
}

const rustPlan = (): Sdlc =>
  withGates(
    { ...newSdlc("sub", "t"), criteria: ["works"], implementDoneAt: 1, verifyDoneAt: 2 },
    decide("plan", { design: 0.1, testFirst: 0.9 }, null),
  )

describe("test-first rust", () => {
  test("AC-1: inline-test-only commit on src/lib.rs then production commit passes test-first gate", () => {
    const { r, git } = repo()
    ensureFactoryDir(r)
    writeFileSync(artifact(r, "evidence.md"), "AC-1: PASS — cargo test — ok\n")
    mkdirSync(path.join(r, "src"), { recursive: true })
    writeFileSync(path.join(r, "src/lib.rs"), "pub fn add(a: i32, b: i32) -> i32 {\n  a\n}\n")
    git("add", "src/lib.rs")
    git("commit", "-q", "-m", "chore: scaffold")
    const base = git("rev-parse", "HEAD")

    writeFileSync(
      path.join(r, "src/lib.rs"),
      [
        "pub fn add(a: i32, b: i32) -> i32 {",
        "  a",
        "}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "  use super::*;",
        "",
        "  #[test]",
        "  fn adds_numbers() {",
        "    assert_eq!(add(2, 3), 5);",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    git("add", "src/lib.rs")
    git("commit", "-q", "-m", "test: inline add test")

    writeFileSync(
      path.join(r, "src/lib.rs"),
      [
        "pub fn add(a: i32, b: i32) -> i32 {",
        "  a + b",
        "}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "  use super::*;",
        "",
        "  #[test]",
        "  fn adds_numbers() {",
        "    assert_eq!(add(2, 3), 5);",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    git("add", "src/lib.rs")
    git("commit", "-q", "-m", "feat: implement add")

    const blockers = shipBlockers(rustPlan(), r, base, true, true)
    expect(blockers.some((b) => b.startsWith("test-first gate"))).toBe(false)
  })

  test.each([
    [
      "stub fn",
      [
        "pub enum Kind {",
        "  One,",
        "}",
        "",
        "fn helper() -> i32 {",
        "  1",
        "}",
        "",
        "pub fn stub() -> i32 {",
        "  0",
        "}",
      ],
      "src/lib.rs:9",
    ],
    [
      "use line",
      ["use std::fmt;", "", "pub enum Kind {", "  One,", "}", "", "fn helper() -> i32 {", "  1", "}"],
      "src/lib.rs:1",
    ],
    [
      "enum variant",
      ["pub enum Kind {", "  One,", "  Two,", "}", "", "fn helper() -> i32 {", "  1", "}"],
      "src/lib.rs:3",
    ],
    [
      "pub(crate) visibility change",
      ["pub enum Kind {", "  One,", "}", "", "pub(crate) fn helper() -> i32 {", "  1", "}"],
      "src/lib.rs:5",
    ],
  ])("AC-2: inline test plus %s outside test module fails with short sha and file:line", (_label, prodLines, loc) => {
    const { r, git } = repo()
    ensureFactoryDir(r)
    writeFileSync(artifact(r, "evidence.md"), "AC-1: PASS — cargo test — ok\n")
    mkdirSync(path.join(r, "src"), { recursive: true })
    writeFileSync(
      path.join(r, "src/lib.rs"),
      ["pub enum Kind {", "  One,", "}", "", "fn helper() -> i32 {", "  1", "}", ""].join("\n"),
    )
    git("add", "src/lib.rs")
    git("commit", "-q", "-m", "chore: base scaffold")
    const base = git("rev-parse", "HEAD")

    writeFileSync(
      path.join(r, "src/lib.rs"),
      [...prodLines, "", "#[cfg(test)]", "mod tests {", "  #[test]", "  fn it_works() {}", "}", ""].join("\n"),
    )
    git("add", "src/lib.rs")
    git("commit", "-q", "-m", "test: mixed commit")
    const shortSha = git("rev-parse", "--short", "HEAD")

    const blockers = shipBlockers(rustPlan(), r, base, true, true)
    const gate = blockers.find((b) => b.startsWith("test-first gate:"))
    expect(gate).toBeDefined()
    expect(gate).toContain(shortSha)
    expect(gate).toContain(loc)
  })

  test("AC-3: production .rs commit followed by inline-test-only commit still fails", () => {
    const { r, git } = repo()
    ensureFactoryDir(r)
    writeFileSync(artifact(r, "evidence.md"), "AC-1: PASS — cargo test — ok\n")
    mkdirSync(path.join(r, "src"), { recursive: true })
    writeFileSync(path.join(r, "src/lib.rs"), "pub fn run() -> i32 {\n  1\n}\n")
    git("add", "src/lib.rs")
    git("commit", "-q", "-m", "chore: base")
    const base = git("rev-parse", "HEAD")

    writeFileSync(path.join(r, "src/lib.rs"), "pub fn run() -> i32 {\n  2\n}\n")
    git("add", "src/lib.rs")
    git("commit", "-q", "-m", "feat: prod first")
    const firstSha = git("rev-parse", "--short", "HEAD")

    writeFileSync(
      path.join(r, "src/lib.rs"),
      [
        "pub fn run() -> i32 {",
        "  2",
        "}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "  #[test]",
        "  fn checks_run() {}",
        "}",
        "",
      ].join("\n"),
    )
    git("add", "src/lib.rs")
    git("commit", "-q", "-m", "test: inline second")

    const blockers = shipBlockers(rustPlan(), r, base, true, true)
    const gate = blockers.find((b) => b.startsWith("test-first gate:"))
    expect(gate).toBeDefined()
    expect(gate).toContain(firstSha)
    expect(gate).toContain("src/lib.rs:2")
  })

  test.each([
    [
      "no column-0 closing brace",
      ["pub fn f() {}", "", "#[cfg(test)]", "mod tests {", "  #[test]", "  fn t() {}", "  }", ""].join("\n"),
      "src/lib.rs:3: test module has no column-0 closing brace",
    ],
    [
      "non-blank column-0 interior line",
      ["pub fn f() {}", "", "#[cfg(test)]", "mod tests {", "  #[test]", "  fn t() {}", "fn sneaky() {}", "}", ""].join(
        "\n",
      ),
      "src/lib.rs:7: non-indented test module interior",
    ],
    [
      "missing module declaration",
      "pub fn f() {}\n\n#[cfg(test)]\n",
      "src/lib.rs:3: expected a column-0 inline test module",
    ],
    [
      "module text inside a multiline string",
      'pub fn f() {}\nconst TEXT: &str = "\n#[cfg(test)]\nmod tests {\n  fn fake() {}\n}\n";\n',
      "src/lib.rs:2: unsupported multiline comment or string",
    ],
  ])("AC-4: malformed test module (%s) fails closed as could not be classified", (_label, content, explanation) => {
    const { r, git } = repo()
    ensureFactoryDir(r)
    writeFileSync(artifact(r, "evidence.md"), "AC-1: PASS — cargo test — ok\n")
    mkdirSync(path.join(r, "src"), { recursive: true })
    writeFileSync(path.join(r, "src/lib.rs"), "pub fn f() {}\n")
    git("add", "src/lib.rs")
    git("commit", "-q", "-m", "chore: base")
    const base = git("rev-parse", "HEAD")

    writeFileSync(path.join(r, "src/lib.rs"), content)
    git("add", "src/lib.rs")
    git("commit", "-q", "-m", "test: malformed")

    const blockers = shipBlockers(rustPlan(), r, base, true, true)
    const gate = blockers.find((b) => b.startsWith("test-first gate:"))
    expect(gate).toBeDefined()
    expect(gate).toContain(explanation)
    expect(gate).toContain(git("rev-parse", "--short", "HEAD"))
    expect(gate).toContain("could not be classified")
  })

  test.each([
    ["production removal", "fn obsolete() {}\n", "", "src/lib.rs:1"],
    [
      "production removal preserving tests",
      "fn obsolete() {}\n#[cfg(test)]\nmod tests {\n  fn t() {}\n}\n",
      "#[cfg(test)]\nmod tests {\n  fn t() {}\n}\n",
      "src/lib.rs:1",
    ],
    ["blank-only edit", "fn f() {}\n", "fn f() {}\n\n", undefined],
    ["comment-only module", "", "// No tests here.\n", "src/lib.rs:1"],
  ])("%s does not establish a tests-only commit", (_label, before, after, location) => {
    const { r, git } = repo()
    mkdirSync(path.join(r, "src"))
    if (before) writeFileSync(path.join(r, "src/lib.rs"), before)
    git("add", "src")
    git("commit", "-q", "--allow-empty", "-m", "chore: base")
    const base = git("rev-parse", "HEAD")
    writeFileSync(path.join(r, "src/lib.rs"), after)
    git("add", "src/lib.rs")
    git("commit", "-q", "-m", "test: candidate")
    const sha = git("rev-parse", "--short", "HEAD")
    const gate = shipBlockers(rustPlan(), r, base, true, true).find((b) => b.startsWith("test-first gate:"))
    expect(gate).toBeDefined()
    if (location) {
      expect(gate).toContain(sha)
      expect(gate).toContain(location)
    }
  })

  test("removing a complete inline-test-only file counts as tests-only", () => {
    const { r, git } = repo()
    mkdirSync(path.join(r, "src"))
    writeFileSync(path.join(r, "src/lib.rs"), "#[cfg(test)]\nmod tests {\n  fn t() {}\n}\n")
    git("add", "src")
    git("commit", "-q", "-m", "chore: base")
    const base = git("rev-parse", "HEAD")
    git("rm", "src/lib.rs")
    git("commit", "-q", "-m", "test: remove obsolete tests")
    expect(shipBlockers(rustPlan(), r, base, true, true).some((b) => b.startsWith("test-first gate:"))).toBe(false)
  })

  test("unreadable history fails closed with a classification explanation", () => {
    const { r } = repo()
    const gate = shipBlockers(rustPlan(), r, "missing-base", true, true).find((b) => b.startsWith("test-first gate:"))
    expect(gate).toContain("commit history could not be classified")
    expect(gate).toContain("missing-base")
  })

  test("AC-5: commit removing non-blank lines inside an existing Rust test module counts as tests-only", () => {
    const { r, git } = repo()
    ensureFactoryDir(r)
    writeFileSync(artifact(r, "evidence.md"), "AC-1: PASS — cargo test — ok\n")
    mkdirSync(path.join(r, "src"), { recursive: true })
    writeFileSync(
      path.join(r, "src/lib.rs"),
      [
        "pub fn val() -> i32 {",
        "  1",
        "}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "  #[test]",
        "  fn old_test() {",
        "    assert_eq!(1, 1);",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    git("add", "src/lib.rs")
    git("commit", "-q", "-m", "chore: base with test")
    const base = git("rev-parse", "HEAD")

    writeFileSync(
      path.join(r, "src/lib.rs"),
      [
        "pub fn val() -> i32 {",
        "  1",
        "}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "  #[test]",
        "  fn old_test() {",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    git("add", "src/lib.rs")
    git("commit", "-q", "-m", "test: trim assertion")

    writeFileSync(
      path.join(r, "src/lib.rs"),
      [
        "pub fn val() -> i32 {",
        "  2",
        "}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "  #[test]",
        "  fn old_test() {",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    git("add", "src/lib.rs")
    git("commit", "-q", "-m", "feat: update val")

    const blockers = shipBlockers(rustPlan(), r, base, true, true)
    expect(blockers.some((b) => b.startsWith("test-first gate"))).toBe(false)
  })

  test.each([
    ["src/main.rs", "src/history.rs"],
    ["src/feature.rs", "src/feature/history.rs"],
  ])("AC-6: plain mod history; in %s with new test-only %s passes test-first gate", (parent, module) => {
    const { r, git } = repo()
    ensureFactoryDir(r)
    writeFileSync(artifact(r, "evidence.md"), "AC-1: PASS — cargo test — ok\n")
    mkdirSync(path.join(r, "src"), { recursive: true })
    writeFileSync(path.join(r, parent), "fn main() {}\n")
    git("add", parent)
    git("commit", "-q", "-m", "chore: base")
    const base = git("rev-parse", "HEAD")

    writeFileSync(path.join(r, parent), "mod history;\nfn main() {}\n")
    mkdirSync(path.dirname(path.join(r, module)), { recursive: true })
    writeFileSync(
      path.join(r, module),
      [
        "//! History module tests.",
        "// Plain comment.",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "  #[test]",
        "  fn records_entry() {",
        "    assert!(true);",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    git("add", parent, module)
    git("commit", "-q", "-m", "test: add history test module")

    writeFileSync(
      path.join(r, module),
      [
        "//! History module tests.",
        "pub fn entries() -> usize {",
        "  0",
        "}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "  #[test]",
        "  fn records_entry() {",
        "    assert!(true);",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    git("add", module)
    git("commit", "-q", "-m", "feat: implement entries")

    const blockers = shipBlockers(rustPlan(), r, base, true, true)
    expect(blockers.some((b) => b.startsWith("test-first gate"))).toBe(false)
  })

  test("AC-6: new module file containing a production fn fails test-first gate", () => {
    const { r, git } = repo()
    ensureFactoryDir(r)
    writeFileSync(artifact(r, "evidence.md"), "AC-1: PASS — cargo test — ok\n")
    mkdirSync(path.join(r, "src"), { recursive: true })
    writeFileSync(path.join(r, "src/main.rs"), "fn main() {}\n")
    git("add", "src/main.rs")
    git("commit", "-q", "-m", "chore: base")
    const base = git("rev-parse", "HEAD")

    writeFileSync(path.join(r, "src/main.rs"), "mod history;\nfn main() {}\n")
    writeFileSync(
      path.join(r, "src/history.rs"),
      [
        "//! History module.",
        "pub fn prod() {}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "  #[test]",
        "  fn t() {}",
        "}",
        "",
      ].join("\n"),
    )
    git("add", "src/main.rs", "src/history.rs")
    git("commit", "-q", "-m", "test: history with prod fn")
    const shortSha = git("rev-parse", "--short", "HEAD")

    const blockers = shipBlockers(rustPlan(), r, base, true, true)
    const gate = blockers.find((b) => b.startsWith("test-first gate:"))
    expect(gate).toBeDefined()
    expect(gate).toContain(shortSha)
  })

  test("AC-6: plain mod line naming an omitted module file fails test-first gate", () => {
    const { r, git } = repo()
    ensureFactoryDir(r)
    writeFileSync(artifact(r, "evidence.md"), "AC-1: PASS — cargo test — ok\n")
    mkdirSync(path.join(r, "src"), { recursive: true })
    writeFileSync(
      path.join(r, "src/main.rs"),
      ["fn main() {}", "", "#[cfg(test)]", "mod tests {", "  #[test]", "  fn a() {}", "}", ""].join("\n"),
    )
    git("add", "src/main.rs")
    git("commit", "-q", "-m", "chore: base")
    const base = git("rev-parse", "HEAD")

    writeFileSync(
      path.join(r, "src/main.rs"),
      [
        "mod other;",
        "fn main() {}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "  #[test]",
        "  fn a() {",
        "    assert!(true);",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    git("add", "src/main.rs")
    git("commit", "-q", "-m", "test: missing other.rs")
    const shortSha = git("rev-parse", "--short", "HEAD")

    const blockers = shipBlockers(rustPlan(), r, base, true, true)
    const gate = blockers.find((b) => b.startsWith("test-first gate:"))
    expect(gate).toBeDefined()
    expect(gate).toContain(shortSha)
    expect(gate).toContain("src/main.rs:1")
  })

  test("AC-6: plain mod line referencing a pre-existing test-only file in base fails test-first gate", () => {
    const { r, git } = repo()
    ensureFactoryDir(r)
    writeFileSync(artifact(r, "evidence.md"), "AC-1: PASS — cargo test — ok\n")
    mkdirSync(path.join(r, "src"), { recursive: true })
    writeFileSync(path.join(r, "src/main.rs"), "fn main() {}\n")
    writeFileSync(
      path.join(r, "src/other.rs"),
      ["#[cfg(test)]", "mod tests {", "  #[test]", "  fn existing() {}", "}", ""].join("\n"),
    )
    git("add", "src/main.rs", "src/other.rs")
    git("commit", "-q", "-m", "chore: base with pre-existing other.rs")
    const base = git("rev-parse", "HEAD")

    writeFileSync(path.join(r, "src/main.rs"), "mod other;\nfn main() {}\n")
    git("add", "src/main.rs")
    git("commit", "-q", "-m", "test: wire pre-existing other.rs")
    const shortSha = git("rev-parse", "--short", "HEAD")

    const blockers = shipBlockers(rustPlan(), r, base, true, true)
    const gate = blockers.find((b) => b.startsWith("test-first gate:"))
    expect(gate).toBeDefined()
    expect(gate).toContain(shortSha)
    expect(gate).toContain("src/main.rs:1")
  })

  test("AC-7: production multiline backslash string, raw string, and char literals before test module pass test-first gate", () => {
    const { r, git } = repo()
    ensureFactoryDir(r)
    writeFileSync(artifact(r, "evidence.md"), "AC-1: PASS — cargo test — ok\n")
    mkdirSync(path.join(r, "src"), { recursive: true })
    const prodPrefix = [
      'const JS: &str = "(e=>e&&\\',
      '    e.x)";',
      'const RAW: &str = r#"line one',
      'line "two" still raw"#;',
      "const QUOTE: char = '\"';",
      "const ESCAPED: char = '\\'';",
      "pub fn check<'a>(s: &'a str) -> &'a str {",
      "  s",
      "}",
      "",
    ]
    writeFileSync(
      path.join(r, "src/app.rs"),
      [...prodPrefix, "#[cfg(test)]", "mod tests {", "  #[test]", "  fn initial() {}", "}", ""].join("\n"),
    )
    git("add", "src/app.rs")
    git("commit", "-q", "-m", "chore: base app.rs")
    const base = git("rev-parse", "HEAD")

    writeFileSync(
      path.join(r, "src/app.rs"),
      [
        ...prodPrefix,
        "#[cfg(test)]",
        "mod tests {",
        "  #[test]",
        "  fn initial() {",
        '    let msg = "line 1\nunindented inside test string";',
        "    assert_eq!(super::check(msg), msg);",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    git("add", "src/app.rs")
    git("commit", "-q", "-m", "test: update inline test in app.rs")

    writeFileSync(
      path.join(r, "src/app.rs"),
      [
        ...prodPrefix.slice(0, 7),
        "  s.trim()",
        "}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "  #[test]",
        "  fn initial() {",
        '    let msg = "line 1\nunindented inside test string";',
        "    assert_eq!(super::check(msg), msg);",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    git("add", "src/app.rs")
    git("commit", "-q", "-m", "feat: trim in check")

    const blockers = shipBlockers(rustPlan(), r, base, true, true)
    expect(blockers.some((b) => b.startsWith("test-first gate"))).toBe(false)
  })

  test.each([
    [
      "marker look-alike inside multiline string",
      'pub fn f() {}\nconst FAKE: &str = "\n#[cfg(test)]\nmod tests {\n  #[test]\n  fn fake() {}\n}\n";\n',
      'pub fn f() {}\nconst FAKE: &str = "\n#[cfg(test)]\nmod tests {\n  #[test]\n  fn fake() { assert!(true); }\n}\n";\n',
    ],
    [
      "marker look-alike inside block comment",
      "pub fn f() {}\n/*\n#[cfg(test)]\nmod tests {\n  #[test]\n  fn fake() {}\n}\n*/\n",
      "pub fn f() {}\n/*\n#[cfg(test)]\nmod tests {\n  #[test]\n  fn fake() { assert!(true); }\n}\n*/\n",
    ],
    [
      "file ending inside unterminated string",
      'pub fn f() {}\n#[cfg(test)]\nmod tests {\n  #[test]\n  fn t() {}\n}\nconst BROKEN: &str = "unterminated\n',
      'pub fn f() {}\n#[cfg(test)]\nmod tests {\n  #[test]\n  fn t() { assert!(true); }\n}\nconst BROKEN: &str = "unterminated\n',
    ],
  ])("AC-7: %s fails closed as could not be classified", (_label, baseContent, nextContent) => {
    const { r, git } = repo()
    ensureFactoryDir(r)
    writeFileSync(artifact(r, "evidence.md"), "AC-1: PASS — cargo test — ok\n")
    mkdirSync(path.join(r, "src"), { recursive: true })
    writeFileSync(path.join(r, "src/app.rs"), baseContent)
    git("add", "src/app.rs")
    git("commit", "-q", "-m", "chore: base")
    const base = git("rev-parse", "HEAD")

    writeFileSync(path.join(r, "src/app.rs"), nextContent)
    git("add", "src/app.rs")
    git("commit", "-q", "-m", "test: attempt")
    const shortSha = git("rev-parse", "--short", "HEAD")

    const blockers = shipBlockers(rustPlan(), r, base, true, true)
    const gate = blockers.find((b) => b.startsWith("test-first gate:"))
    expect(gate).toBeDefined()
    expect(gate).toContain(shortSha)
    expect(gate).toContain("src/app.rs: could not be classified")
  })
})

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
    s = withGates(s, decide("plan", { design: 0.9, testFirst: 0.9 }, null))
    s = withGates(
      s,
      decide("diff", { codeReview: 0.9, supplyChain: 0.1, docs: 0.9, postMerge: 0.1 }, classify([f("src/a.ts")])),
    )
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
    const s = withGates(
      { ...newSdlc("sub", null), criteria: ["c"] },
      decide("plan", { design: 0.1, testFirst: 0.9 }, null),
    )
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
      withGates(newSdlc("sub", null), decide("plan", { design: 0.9, testFirst: 0.9 }, null)),
      decide("diff", { codeReview: 0.1, supplyChain: 0.1, docs: 0.9, postMerge: 0.9 }, classify([f("src/a.ts")])),
    )
    const settled = settleGates(s, ["test-first gate: no tests-only commit before the first code commit"])
    expect(Object.fromEntries(settled.gates.map((g) => [g.id, g.status]))).toEqual({
      design: "done",
      testFirst: "pending",
      codeReview: "skipped",
      supplyChain: "skipped",
      docs: "done",
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
