import { beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigStore, setConfigStore } from "../src/config.ts"
import { loadPrompt, promptErrors, render } from "../src/prompt.ts"
import * as P from "../src/prompts.ts"
import { findingTask } from "../src/reports.ts"
import { lenses, lensTask, synthesisTask } from "../src/review.ts"
import { implementAddendum, newSdlc, verifyAddendum, withGates, type GateId } from "../src/sdlc.ts"
import { OPTIMIZE_SKILLS, optimizeTask, researchTask } from "../src/workflows.ts"

let home = ""
const user = () => path.join(home, "config.toml")
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "sf-prompts-"))
  process.env.SF_CONFIG = user()
  setConfigStore(new ConfigStore(user()))
})

const golden: Record<string, string> = JSON.parse(
  readFileSync(path.join(import.meta.dir, "fixtures", "prompts.golden.json"), "utf8"),
)
const g = (id: GateId) => ({ id, chosen: true, probability: 1, threshold: 0.5, reason: "", status: "pending" as const })

test("rendered prompts equal the text that was in the code (re-review drift fixed: 100+ lines)", () => {
  const now: Record<string, string> = {
    coordinator: P.coordinatorPrompt(),
    global: P.globalPrompt(),
    research: P.researchPrompt(),
    desk: P.deskPrompt(),
    cards: P.cardsPrompt(),
    sub_full: P.subPrompt("app", "/r/app", "/w/app-1", "sf/x", "main", ["l1", "l2"]),
    sub_min: P.subPrompt("app", "/r/app", "/w/app-1", "sf/x"),
    lens_ac: lensTask(lenses()[0]!, "abc123", ["a", "b"], "/o/f.json"),
    lens_noac: lensTask(lenses()[2]!, "abc123", [], "/o/f.json"),
    synthesis: synthesisTask(["/a.json", "/b.json"], "/o/s.json"),
    research_task: researchTask("council", "REQ"),
    research_task_named: researchTask("council", "REQ", "draft-council"),
    optimize_task: optimizeTask(OPTIMIZE_SKILLS[0]!.id, "REQ"),
    impl_all: implementAddendum(
      withGates({ ...newSdlc("s", null), criteria: ["c1", "c2"], scopeWarning: "grew" }, [
        g("design"),
        g("testFirst"),
        g("docs"),
      ]),
    ),
    impl_none: implementAddendum({ ...newSdlc("s", null), criteria: ["c1"] }),
    finding: findingTask(
      { path: "reports/s.md", file: "/w/reports/s.md", title: "T" },
      { title: "1. X", body: " body \n" },
    ),
    verify_checks: verifyAddendum({ ...newSdlc("s", null), criteria: ["c1", "c2"], checks: ["bun test", "tsc"] }),
    verify_none: verifyAddendum({ ...newSdlc("s", null), criteria: ["c1"] }),
  }
  for (const [k, v] of Object.entries(golden)) expect({ k, v: now[k] }).toEqual({ k, v })
})

test("render: placeholders, sections, inverted sections, strict names, no re-scan", () => {
  expect(render("a {{x}} b", { x: 1 })).toBe("a 1 b")
  expect(render("{{#on}}yes{{/on}}{{^on}}no{{/on}}", { on: true })).toBe("yes")
  expect(render("{{#on}}yes{{/on}}{{^on}}no{{/on}}", { on: "" })).toBe("no")
  expect(render("{{x}}", { x: "{{y}}" })).toBe("{{y}}")
  expect(() => render("{{nope}}", {})).toThrow("unknown placeholder {{nope}}")
  expect(() => render("{{#nope}}x{{/nope}}", {})).toThrow("unknown section")
})

test("prompts read config values, and a config edit applies to the next render", () => {
  expect(P.coordinatorPrompt()).toContain("moreWork < 0.3")
  writeFileSync(user(), "[sdlc]\ndone_below = 0.2\nmax_fix_rounds = 3\n[review]\nrereview_lines = 40\n")
  setConfigStore(new ConfigStore(user()))
  expect(P.coordinatorPrompt()).toContain("moreWork < 0.2")
  const sub = P.subPrompt("a", "/r", "/w", "b")
  expect(sub).toContain("add 40+ lines")
  expect(sub).toContain("at most 3 fix rounds")
  writeFileSync(user(), "")
  setConfigStore(new ConfigStore(user()))
})

test("a user prompt file overrides one prompt; a broken one falls back to the default", () => {
  const dir = path.join(home, "prompts")
  mkdirSync(path.join(dir, "jev"), { recursive: true })
  writeFileSync(path.join(dir, "desk.md"), "Custom desk, stop below {{sdlc.done_below}}.\n")
  expect(P.deskPrompt()).toBe("Custom desk, stop below 0.3.")
  expect(P.cardsPrompt()).toBe(golden.cards!)
  writeFileSync(path.join(dir, "desk.md"), "Broken {{typo}}")
  expect(P.deskPrompt()).toBe(golden.desk!)
  expect(promptErrors.get("desk")).toContain("unknown placeholder {{typo}}")
  writeFileSync(path.join(dir, "jev", "growth.md"), "Needed?")
  expect(loadPrompt("jev/growth")).toBe("Needed?")
})

test("no source calls the browser's global prompt(); templates load with loadPrompt()", () => {
  const dir = path.join(import.meta.dir, "..", "src")
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => /(^|[^\w.])prompt\(/m.test(readFileSync(path.join(dir, f), "utf8")))
  expect(offenders).toEqual([])
})

test("both ui-format prompts render", () => {
  expect(loadPrompt("ui-format-openui")).toStartWith("<ui-format>This UI renders your final message as OpenUI Lang")
  expect(loadPrompt("ui-format-markdown")).toStartWith("<ui-format>This UI renders your final message as markdown")
})
