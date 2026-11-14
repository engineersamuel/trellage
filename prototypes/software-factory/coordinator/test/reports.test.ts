import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { findingTask, findReport } from "../src/reports.ts"

const wt = (name: string) => {
  const d = mkdtempSync(path.join(tmpdir(), `sf-${name}-`))
  mkdirSync(path.join(d, "reports"))
  return d
}

test("reports resolve inside a conversation worktree only", () => {
  const a = wt("a"),
    b = wt("b"),
    outside = wt("out")
  writeFileSync(path.join(a, "reports", "synthesis.md"), "old")
  writeFileSync(path.join(b, "reports", "synthesis.md"), "new")
  writeFileSync(path.join(outside, "secret.md"), "x")
  symlinkSync(path.join(outside, "secret.md"), path.join(b, "reports", "link.md"))
  const threads = [
    { id: "ta", title: "A", createdAt: 1, folderId: "r", worktree: a },
    { id: "tb", title: "B", createdAt: 2, folderId: "r", worktree: b },
    { id: "tc", title: "C", createdAt: 3, folderId: "r", worktree: wt("c"), cleanedAt: 5 },
  ]
  expect(findReport(threads, "reports/synthesis.md")?.content).toBe("new")
  expect(findReport(threads, "reports/synthesis.md", "ta")?.content).toBe("old")
  expect(findReport(threads, path.join(a, "reports", "synthesis.md"))).toMatchObject({
    threadId: "ta",
    path: "reports/synthesis.md",
  })
  expect(findReport(threads, "../../etc/passwd.md")).toBeNull()
  expect(findReport(threads, path.join(outside, "secret.md"))).toBeNull()
  expect(findReport(threads, "reports/link.md")).toBeNull()
  expect(findReport(threads, "src/main.rs")).toBeNull()
})

test("a finding becomes a self-contained delivery task", () => {
  const t = findingTask(
    { path: "reports/synthesis.md", file: "/wt/reports/synthesis.md", title: "Look for optimizations" },
    { title: "1. Byte-safe SSE framing", body: "Use bytes.\n" },
  )
  expect(t).toContain("/wt/reports/synthesis.md")
  expect(t).toContain("## 1. Byte-safe SSE framing\n\nUse bytes.")
  expect(t).toContain("request_approval for the plan")
  expect(t).not.toContain("Do not push")
  expect(t).toContain("request_approval ship=true")
  expect(t).toContain("Never merge")
})

test("the brief must have the synthesis's ranked headings, each with a TL;DR", () => {
  const { briefProblem } = require("../src/reports.ts")
  const d = wt("brief")
  const full =
    "# S\n\n## 1. Fix SSE\n\nlong\n\n```\n## 9. not a heading\n```\n\n## 2. Route chat\n\nlong\n\n## Evidence limits\n"
  writeFileSync(path.join(d, "reports", "synthesis.md"), full)
  expect(briefProblem(d)).toBe("reports/synthesis.brief.md is missing")
  writeFileSync(
    path.join(d, "reports", "synthesis.brief.md"),
    "**TL;DR:** x\n\n## 1. Fix SSE\n**TL;DR:** a\n\n## 2. Route it\n**TL;DR:** b\n",
  )
  expect(briefProblem(d)).toContain("headings differ")
  writeFileSync(
    path.join(d, "reports", "synthesis.brief.md"),
    "**TL;DR:** x\n\n## 1. Fix SSE\n**TL;DR:** a\n\n## 2. Route chat\n- ✅ x\n",
  )
  expect(briefProblem(d)).toContain("lacks a **TL;DR:** line under: 2. Route chat")
  writeFileSync(
    path.join(d, "reports", "synthesis.brief.md"),
    "**TL;DR:** x\n\n## 1. Fix SSE\n**TL;DR:** a\n\n## 2. Route chat\n**TL;DR:** b\n",
  )
  expect(briefProblem(d)).toBeNull()
  const research = wt("research")
  writeFileSync(path.join(research, "reports", "synthesis.md"), "# R\n\n## Recommendation\n")
  expect(briefProblem(research)).toBeNull()
})
