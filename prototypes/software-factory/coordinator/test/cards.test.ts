import { describe, expect, test } from "bun:test"
import { cardOpenUi, plainLine, MAX_DIFF_FILES, parseNumstat, reportFindings } from "../src/cards.ts"
import { Translator } from "../src/agui.ts"
import { RunRecorder } from "../src/threads.ts"
import { cardsPrompt } from "../src/prompts.ts"
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
    expect(reportFindings(md).map((f) => [f.rank, f.title])).toEqual([
      [1, "Fast path"],
      [2, "Second"],
    ])
  })
  test("every tool the prompt names is a coordinator tool (no tool lives only in one UI)", () => {
    const backend = new Set(
      coordinatorTools({
        summaries: () => [],
        securityReviews: new Map(),
        codeReviews: new Map(),
        sdlc: new Map(),
        decisions: [],
        run: null,
      } as never).map((t) => t.name),
    )
    for (const name of cardsPrompt().match(
      /\b(show_[a-z_]+|render_ui|request_approval|ask_user|focus_agent|open_report|confirm_action)\b/g,
    )!)
      expect(backend.has(name)).toBe(true)
  })
  test("delivery decisions are scoped to their coordinator; untagged ones are the desk's", () => {
    const all = [{ step: "plan" }, { step: "implement", scopeId: "sub-1" }, { step: "verify", scopeId: "gen-2" }]
    expect(ownDecisions(all, "sub-1")).toEqual([{ step: "implement", scopeId: "sub-1" }])
    expect(ownDecisions(all, "coordinator")).toEqual([{ step: "plan" }])
    expect(ownDecisions(all, "gen-9")).toEqual([])
  })
  test("show_delivery_run in a General chat returns no foreign decisions", async () => {
    const f = {
      summaries: () => [],
      securityReviews: new Map(),
      codeReviews: new Map(),
      sdlc: new Map(),
      decisions: [{ step: "plan", moreWork: 0.9 }],
      run: null,
    } as never
    const tool = coordinatorTools(f, { id: "gen-x", threadId: "t" }).find((t) => t.name === "show_delivery_run")!
    const r = JSON.parse(String(await (tool.handler as (args: object, invocation: object) => unknown)({}, {})))
    expect([r.decisions.length, typeof r.note]).toEqual([0, "string"])
  })
  describe("show_evaluation", () => {
    const ev = (id: string, scopeId: string, at: number, extra: object = {}) => ({
      id,
      scopeId,
      threadId: "t",
      workdir: "/wt",
      status: "done",
      round: 2,
      model: `model-${id}`,
      verdicts: [
        { id: "AC-1", verdict: "pass", command: "bun test a", output: "ok", note: "a passes" },
        { id: "AC-2", verdict: "fail", command: "bun test b", output: "no", note: "b fails" },
      ],
      workerIds: [],
      notes: [`note-${id}`],
      at,
      ...extra,
    })
    const evaluation = async (evaluations: [string, unknown][]) => {
      const f = {
        summaries: () => [],
        securityReviews: new Map(),
        codeReviews: new Map(),
        evaluations: new Map(evaluations),
        sdlc: new Map(),
        decisions: [],
        run: null,
      } as never
      const tools = coordinatorTools(f, { id: "sub-1", threadId: "t", workdir: "/wt" })
      const tool = tools.find((t) => t.name === "show_evaluation")
      expect(tool).toBeDefined()
      return JSON.parse(String(await (tool!.handler as (args: object, invocation: object) => unknown)({}, {})))
    }
    test("returns the scope's newest evaluation, not insertion order or another scope's", async () => {
      const r = await evaluation([
        ["e-new", ev("e-new", "sub-1", 20, { status: "fixing", round: 3 })],
        ["e-old", ev("e-old", "sub-1", 10)],
        ["e-foreign", ev("e-foreign", "sub-2", 99)],
      ])
      expect(r).toEqual({
        evaluationId: "e-new",
        status: "fixing",
        round: 3,
        model: "model-e-new",
        verdicts: [
          { id: "AC-1", verdict: "pass", command: "bun test a", note: "a passes" },
          { id: "AC-2", verdict: "fail", command: "bun test b", note: "b fails" },
        ],
        notes: ["note-e-new"],
      })
    })
    test("keeps the evaluation error", async () => {
      const r = await evaluation([["e", ev("e", "sub-1", 1, { status: "failed", error: "boom" })]])
      expect([r.status, r.error]).toEqual(["failed", "boom"])
    })
    test("no evaluation in the scope: a note and no status", async () => {
      for (const evaluations of [[], [["e", ev("e", "sub-2", 1)]]] as [string, unknown][][]) {
        const r = await evaluation(evaluations)
        expect(typeof r.note).toBe("string")
        expect(r.note.length).toBeGreaterThan(0)
        expect("status" in r).toBe(false)
      }
    })
  })
  test("the prompt asks for a plain sentence next to every card", () => {
    expect(cardsPrompt()).toContain("Foldkit")
    expect(cardsPrompt()).toContain("never show_delivery_run there")
  })
})

describe("cards as live OpenUI (Foldkit)", () => {
  const card = (name: string, result: string, args: Record<string, unknown>, prefix: string) =>
    cardOpenUi(name, result, "sub-1", args, prefix)
  test("a card is a live Query for its scope, with the tool result as default", () => {
    const p = cardOpenUi(
      "show_worker_board",
      JSON.stringify({
        workers: [{ id: "a", name: 'He said "hi"', role: "worker", status: "idle", model: "m", rssKb: null }],
        at: 0,
      }),
      "sub-1",
      {},
      "k0",
    )!
    expect(p.startsWith("ROOT = Card([k0head")).toBe(true)
    expect(p).toMatch(
      /k0card = Query\("factory_card", \{"name":"show_worker_board","scope":"sub-1"\}, \{.*He said \\"hi\\".*\}, 60\)/,
    )
    expect(cardOpenUi("bash", "{}")).toBeNull()
    expect(cardOpenUi("show_worker_board", "not json")).toBeNull()
  })
  test("report findings keep the path in the live query", () => {
    expect(
      cardOpenUi("show_report_findings", JSON.stringify({ path: "reports/s.md", findings: [] }), "sub-1", {
        path: "reports/s.md",
      }),
    ).toContain('"path":"reports/s.md"')
  })
  test("the translator sends the turn's cards, merged, as the last message", () => {
    const ev = (type: string, data: Record<string, unknown>) => ({ type, data }) as never
    const call = (id: string) => [
      ev("tool.execution_start", { toolCallId: id, toolName: "show_decisions", arguments: {} }),
      ev("tool.execution_complete", {
        toolCallId: id,
        success: true,
        result: { content: JSON.stringify({ pending: [] }) },
      }),
    ]
    const answer = ev("assistant.message", { messageId: "m1", content: 'root = Card([t])\nt = TextContent("x")' })
    const run = (opts: object) => {
      const t = new Translator("t", "r", opts)
      return [...call("c1"), ...call("c2"), answer, ev("session.idle", {})].flatMap((e) => t.translate(e)) as {
        type: string
        delta: string
      }[]
    }
    const out = run({ card })
    const texts = out.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)
    expect(texts.length).toBe(2)
    expect(texts[1]!.startsWith("root = Card([k0head")).toBe(true)
    expect(texts[1]).toContain("k1card = Query(")
    expect(out.findIndex((e) => e.type === "RUN_FINISHED")).toBeGreaterThan(
      out.findLastIndex((e) => e.type === "TEXT_MESSAGE_END"),
    )
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
