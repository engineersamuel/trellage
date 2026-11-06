import { describe, expect, test } from "bun:test"
import { MAX_DIFF_FILES, parseNumstat, reportFindings } from "../src/cards.ts"
import { CARDS_PROMPT } from "../src/prompts.ts"
import { coordinatorTools } from "../src/tools.ts"

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
    const backend = new Set(coordinatorTools({ summaries: () => [], securityReviews: new Map(), decisions: [], run: null } as never).map((t) => t.name))
    const browser = new Set(["focus_agent", "open_report", "set_layout", "confirm_action"])
    for (const name of CARDS_PROMPT.match(/\b(show_[a-z_]+|render_ui|request_approval|ask_user|focus_agent|open_report|set_layout|confirm_action)\b/g)!)
      expect(backend.has(name) || browser.has(name)).toBe(true)
  })
})
