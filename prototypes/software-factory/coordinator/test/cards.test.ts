import { describe, expect, test } from "bun:test"
import { cardOpenUi, plainLine, MAX_DIFF_FILES, parseNumstat, reportFindings } from "../src/cards.ts"
import { Translator } from "../src/agui.ts"
import { RunRecorder } from "../src/threads.ts"
import { CARDS_PROMPT } from "../src/prompts.ts"
import { coordinatorTools, ownDecisions } from "../src/tools.ts"

describe("cards", () => {
  test("numstat: counts, binary files, largest first", () => {
    const d = parseNumstat("3\t1\ta.ts\n-\t-\timg.png\n10\t0\tsrc/b.ts\n", "abc")
    expect(d.files.map((f) => f.path)).toEqual(["src/b.ts", "a.ts", "img.png"])
    expect([d.added, d.removed, d.truncated, d.files[2]!.binary]).toEqual([13, 1, false, true])
  })
  test("numstat: more files than shown keeps full totals", () => {
    const out = Array.from({ length: MAX_DIFF_FILES + 3 }, (_, i) => `1\t0\tf${i}`).join("\n")
    const d = parseNumstat(out, "b")
    expect([d.files.length, d.added, d.truncated]).toEqual([MAX_DIFF_FILES, MAX_DIFF_FILES + 3, true])
  })
  test("report findings: ranked headings only, fences ignored", () => {
    const md = "# T\n## 1. Fast path\nbody one\n```\n## 9. not a finding\n```\n## Notes\nx\n## 2) Second\nb2"
    expect(reportFindings(md).map((f) => [f.rank, f.title])).toEqual([[1, "Fast path"], [2, "Second"]])
  })
  test("every card the prompt names is a coordinator tool or a browser tool", () => {
    const backend = new Set(coordinatorTools({ summaries: () => [], securityReviews: new Map(), codeReviews: new Map(), sdlc: new Map(), decisions: [], run: null } as never).map((t) => t.name))
    const browser = new Set(["focus_agent", "open_report", "set_layout", "confirm_action"])
    for (const name of CARDS_PROMPT.match(/\b(show_[a-z_]+|render_ui|request_approval|ask_user|focus_agent|open_report|set_layout|confirm_action)\b/g)!)
      expect(backend.has(name) || browser.has(name)).toBe(true)
  })
  test("delivery decisions are scoped to their coordinator; untagged ones are the desk's", () => {
    const all = [{ step: "plan" }, { step: "implement", scopeId: "sub-1" }, { step: "verify", scopeId: "gen-2" }]
    expect(ownDecisions(all, "sub-1")).toEqual([{ step: "implement", scopeId: "sub-1" }])
    expect(ownDecisions(all, "coordinator")).toEqual([{ step: "plan" }])
    expect(ownDecisions(all, "gen-9")).toEqual([])
  })
  test("show_delivery_run in a General chat returns no foreign decisions", async () => {
    const f = { summaries: () => [], securityReviews: new Map(), codeReviews: new Map(), sdlc: new Map(), decisions: [{ step: "plan", moreWork: 0.9 }], run: null } as never
    const tool = coordinatorTools(f, { id: "gen-x", threadId: "t" }).find((t) => t.name === "show_delivery_run")!
    const r = JSON.parse(String(await (tool.handler as any)({}, {})))
    expect([r.decisions.length, typeof r.note]).toEqual([0, "string"])
  })
  test("the prompt asks for a plain sentence next to every card", () => {
    expect(CARDS_PROMPT).toContain("Foldkit")
    expect(CARDS_PROMPT).toContain("never show_delivery_run there")
  })
})

describe("cards as live OpenUI (Foldkit)", () => {
  const card = (name: string, result: string, args: Record<string, unknown>, prefix: string) => cardOpenUi(name, result, "sub-1", args, prefix)
  test("a card is a live Query for its scope, with the tool result as default", () => {
    const p = cardOpenUi("show_worker_board", JSON.stringify({ workers: [{ id: "a", name: 'He said "hi"', role: "worker", status: "idle", model: "m", rssKb: null }], at: 0 }), "sub-1", {}, "k0")!
    expect(p.startsWith("ROOT = Card([k0head")).toBe(true)
    expect(p).toMatch(/k0card = Query\("factory_card", \{"name":"show_worker_board","scope":"sub-1"\}, \{.*He said \\"hi\\".*\}, 60\)/)
    expect(cardOpenUi("bash", "{}")).toBeNull()
    expect(cardOpenUi("show_worker_board", "not json")).toBeNull()
  })
  test("report findings keep the path in the live query", () => {
    expect(cardOpenUi("show_report_findings", JSON.stringify({ path: "reports/s.md", findings: [] }), "sub-1", { path: "reports/s.md" })).toContain('"path":"reports/s.md"')
  })
  test("the translator sends the turn's cards, merged, as the last message", () => {
    const ev = (type: string, data: Record<string, unknown>) => ({ type, data }) as never
    const call = (id: string) => [
      ev("tool.execution_start", { toolCallId: id, toolName: "show_decisions", arguments: {} }),
      ev("tool.execution_complete", { toolCallId: id, success: true, result: { content: JSON.stringify({ pending: [] }) } }),
    ]
    const answer = ev("assistant.message", { messageId: "m1", content: 'root = Card([t])\nt = TextContent("x")' })
    const run = (opts: object) => { const t = new Translator("t", "r", opts); return [...call("c1"), ...call("c2"), answer, ev("session.idle", {})].flatMap((e) => t.translate(e)) as any[] }
    const out = run({ card })
    const texts = out.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)
    expect(texts.length).toBe(2)
    expect(texts[1].startsWith("root = Card([k0head")).toBe(true)
    expect(texts[1]).toContain("k1card = Query(")
    expect(out.findIndex((e) => e.type === "RUN_FINISHED")).toBeGreaterThan(out.findLastIndex((e) => e.type === "TEXT_MESSAGE_END"))
    expect(run({}).filter((e) => e.type === "TEXT_MESSAGE_CONTENT").length).toBe(1)
    const rec = new RunRecorder()
    for (const e of out) rec.add(e)
    expect(rec.messages().filter((m) => m.role === "assistant" && m.content).length).toBe(2)
  })
})

test("finding subtitle: first prose line without markdown", () => {
  expect(plainLine("**File:line:** `a.rs:3`\n**Problem:** the `x` is slow")).toBe("Problem: the x is slow")
  expect(plainLine("")).toBe("")
})
