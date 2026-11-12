// The coordinator builds OpenUI programs for the Foldkit UI. Parse them with the catalog that UI draws (openuiChat).
// shared/openui-chat-library.json is agent-interface's schema; web-foldkit/src/openUiCatalog.test.ts keeps it in sync.
import { describe, expect, test } from "bun:test"
import { createParser } from "@openuidev/lang-core"
import schema from "../../shared/openui-chat-library.json"
import { CARD_TOOLS, cardOpenUi, mergeCards } from "../src/cards.ts"
import { cardView } from "../../shared/cardviews.ts"
const parser = createParser(schema, "Card")
const W = {
  id: "w1",
  name: 'Alpha "x"',
  status: "running",
  model: "m",
  rssKb: 51200,
  contextTokens: 10,
  contextLimit: 100,
}
const EVAL = {
  evaluationId: "ev-1",
  status: "done",
  round: 2,
  model: "gpt-x",
  verdicts: [
    { id: "AC-1", verdict: "pass", command: "bun test a", note: "a ok" },
    { id: "AC-2", verdict: "pass", command: "bun test b", note: "b ok" },
    { id: "AC-3", verdict: "fail", command: "bun test c", note: "c broke" },
  ],
  notes: ["changed a file", "AC-4 had no verdict"],
}
const cases: [string, unknown][] = [
  [
    "show_worker_board",
    { workers: [W, { ...W, id: "c", name: "Desk", status: "idle", rssKb: null, contextLimit: null }], at: 0 },
  ],
  ["show_worker_board", { workers: [], at: 0 }],
  [
    "show_delivery_run",
    { branch: "b", decisions: [{ step: "plan", confidence: 0.9, moreWork: 0.6, request: "Do X" }] },
  ],
  ["show_delivery_run", { branch: null, decisions: [], note: "none" }],
  [
    "show_security_review",
    {
      reviewId: "sr",
      status: "done",
      model: "m",
      findings: [{ title: "XSS", severity: "high", file: "a.ts", verdict: "keep", reason: "real" }],
    },
  ],
  ["show_security_review", { reviewId: null, note: "No security review yet." }],
  ["show_evaluation", EVAL],
  ["show_evaluation", { note: "No acceptance evaluation yet." }],
  [
    "show_diff_summary",
    {
      base: "abcdef123",
      files: [{ path: "a.ts", added: 3, removed: 1, binary: false }],
      added: 3,
      removed: 1,
      truncated: false,
    },
  ],
  ["show_diff_summary", { error: "No worktree" }],
  ["show_report_findings", { path: "reports/s.md", findings: [{ rank: 1, title: "Fast", body: "line\nmore" }] }],
  [
    "show_decisions",
    { pending: [{ id: "d1", title: "Ship?", kind: "approval", context: "repo", options: ["Yes", "No"] }] },
  ],
  ["show_decisions", { pending: [] }],
]
test("every card program parses with no errors or dropped statements", () => {
  for (const [name, data] of cases) {
    const prog = mergeCards([cardOpenUi(name, JSON.stringify(data), "sub-1", {}, "k0")!])
    const r = parser.parse(prog)
    const meta = r.meta as { errors?: unknown[]; validationErrors?: unknown[] }
    const errs = meta.errors ?? meta.validationErrors ?? []
    if (!r.root || r.meta.orphaned.length || r.meta.unresolved.length || errs.length)
      console.log(name, JSON.stringify(r.meta).slice(0, 600), "\n", prog)
    expect(r.root).not.toBeNull()
    expect([r.meta.orphaned, r.meta.unresolved, errs.length, r.queryStatements.length]).toEqual([[], [], 0, 1])
  }
})

test("two cards merged into one program still parse", () => {
  const progs = cases.slice(0, 4).map(([n, d], i) => cardOpenUi(n, JSON.stringify(d), "sub-1", {}, `k${i}`)!)
  const r = parser.parse(mergeCards(progs))
  expect(r.root).not.toBeNull()
  expect([r.meta.orphaned, r.meta.unresolved]).toEqual([[], []])
})

test("show_evaluation: a live card with one table row per verdict", () => {
  expect(CARD_TOOLS.has("show_evaluation")).toBe(true)
  const prog = cardOpenUi("show_evaluation", JSON.stringify(EVAL), "sub-1", {}, "k0")!
  expect(prog).not.toBeNull()
  expect(prog).toMatch(/Query\("factory_card", \{"name":"show_evaluation","scope":"sub-1"\}/)
  expect(prog).toContain('@Each(k0card.rows, "r", Text("text", r.id, r.note))')
  expect(prog).toContain('@Each(k0card.rows, "r", Tag(r.verdict, null, "sm", r.variant))')
  expect(prog).toContain("k0card.rows.command")
  const r = parser.parse(mergeCards([prog]))
  expect(r.root).not.toBeNull()
  expect([r.meta.orphaned, r.meta.unresolved, r.queryStatements.length]).toEqual([[], [], 1])
})

describe("show_evaluation view", () => {
  test("mixed verdicts: counts, rows, notes, warning", () => {
    const v = cardView("show_evaluation", EVAL)
    expect(v.title).toBe("Acceptance evaluation")
    for (const part of ["done", "round 2", "gpt-x"]) expect(v.subtitle).toContain(part)
    expect(v.metrics).toEqual([
      { value: "2", label: "pass" },
      { value: "1", label: "fail" },
    ])
    expect(v.rows).toEqual([
      { id: "AC-1", verdict: "pass", variant: "success", command: "bun test a", note: "a ok" },
      { id: "AC-2", verdict: "pass", variant: "success", command: "bun test b", note: "b ok" },
      { id: "AC-3", verdict: "fail", variant: "danger", command: "bun test c", note: "c broke" },
    ])
    expect(v.note).toContain("changed a file")
    expect(v.note).toContain("AC-4 had no verdict")
    expect(v.noteVariant).toBe("warning")
  })
  test("all pass: N/0, not a warning", () => {
    const v = cardView("show_evaluation", { ...EVAL, verdicts: EVAL.verdicts.slice(0, 2) })
    expect(v.metrics.map((m) => m.value)).toEqual(["2", "0"])
    expect(v.noteVariant).not.toBe("warning")
  })
  test("zero verdicts: 0/0 and no rows", () => {
    const v = cardView("show_evaluation", { ...EVAL, verdicts: [], notes: [] })
    expect([v.metrics.map((m) => m.value), v.rows.length]).toEqual([["0", "0"], 0])
    expect(v.note).toBeTruthy()
  })
  test("an error shows as the error", () => {
    const v = cardView("show_evaluation", { ...EVAL, status: "failed", error: "evaluator crashed" })
    expect([v.note, v.noteVariant]).toEqual(["evaluator crashed", "error"])
  })
  test("no evaluation: a short note, no rows", () => {
    const v = cardView("show_evaluation", { note: "No acceptance evaluation yet." })
    expect([v.title, v.note, v.rows.length]).toEqual(["Acceptance evaluation", "No acceptance evaluation yet.", 0])
  })
})
