// The coordinator builds OpenUI programs for UIs that draw only OpenUI (Foldkit); this parses them with the same library.
import { test, expect } from "bun:test"
import { createParser } from "@openuidev/lang-core"
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib"
import { cardOpenUi } from "../../coordinator/src/cards.ts"
const parser = createParser(openuiChatLibrary.toJSONSchema(), "Card")
const W = { id: "w1", name: "Alpha \"x\"", status: "running", model: "m", rssKb: 51200, contextTokens: 10, contextLimit: 100 }
const cases: [string, unknown][] = [
  ["show_worker_board", { workers: [W, { ...W, id: "c", name: "Desk", status: "idle", rssKb: null, contextLimit: null }], at: 0 }],
  ["show_worker_board", { workers: [], at: 0 }],
  ["show_delivery_run", { branch: "b", decisions: [{ step: "plan", confidence: 0.9, moreWork: 0.6, request: "Do X" }] }],
  ["show_delivery_run", { branch: null, decisions: [], note: "none" }],
  ["show_security_review", { reviewId: "sr", status: "done", model: "m", findings: [{ title: "XSS", severity: "high", file: "a.ts", verdict: "keep", reason: "real" }] }],
  ["show_security_review", { reviewId: null, note: "No security review yet." }],
  ["show_diff_summary", { base: "abcdef123", files: [{ path: "a.ts", added: 3, removed: 1, binary: false }], added: 3, removed: 1, truncated: false }],
  ["show_diff_summary", { error: "No worktree" }],
  ["show_report_findings", { path: "reports/s.md", findings: [{ rank: 1, title: "Fast", body: "line\nmore" }] }],
  ["show_decisions", { pending: [{ id: "d1", title: "Ship?", kind: "approval", context: "repo", options: ["Yes", "No"] }] }],
  ["show_decisions", { pending: [] }],
]
test("every card program parses with no errors or dropped statements", () => {
  for (const [name, data] of cases) {
    const prog = cardOpenUi(name, JSON.stringify(data))!
    const r = parser.parse(prog)
    const errs = (r.meta as any).errors ?? (r.meta as any).validationErrors ?? []
    if (!r.root || r.meta.orphaned.length || r.meta.unresolved.length || errs.length) console.log(name, JSON.stringify(r.meta).slice(0, 600), "\n", prog)
    expect(r.root).not.toBeNull()
    expect([r.meta.orphaned, r.meta.unresolved, errs.length]).toEqual([[], [], 0])
  }
})

test("two cards merged into one program still parse", async () => {
  const { mergeCards } = await import("../../coordinator/src/cards.ts")
  const progs = cases.slice(0, 4).map(([n, d]) => cardOpenUi(n, JSON.stringify(d))!)
  const r = parser.parse(mergeCards(progs))
  expect(r.root).not.toBeNull()
  expect([r.meta.orphaned, r.meta.unresolved]).toEqual([[], []])
})
