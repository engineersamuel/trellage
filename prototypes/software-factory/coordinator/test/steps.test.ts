import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  DEBUG_ONLY,
  ensureClones,
  harnessPrefix,
  selectableSteps,
  SKILL_REPOS,
  stepById,
  stepSetup,
} from "../src/steps.ts"

test("implement loads the whole skills root, the gate tools on PATH, and says so", () => {
  const s = stepSetup(stepById("implement"), "/s", "/t")
  expect(s.skillDirectories).toEqual(["/s"])
  expect(s.extraPath).toEqual(["/t/crapper", "/t/dryer", "/t/mutator"])
  expect(s.prefix).toBe("Use the ub-mode skill. The quality-gate tools crapper, dryer, mutator are on PATH.")
})

test("security loads only the security-audit skills, no gate tools, no PATH sentence", () => {
  const s = stepSetup(stepById("security"), "/s", "/t")
  expect(s.skillDirectories).toEqual(["/s/security-audit-skill/skills"])
  expect(s.extraPath).toEqual([])
  expect(s.prefix).toBe("Use the security-audit skill.")
})

test("rpi-research is factory-only and loads only hve-core's RPI skills folder", () => {
  expect(stepById("rpi-research")).toMatchObject({
    factoryOnly: true,
    skills: ["rpi-research"],
    gateTools: false,
  })
  expect(stepById("rpi-research").harness).toBeUndefined()
  expect(selectableSteps().some((s) => s.id === "rpi-research")).toBe(false)
  expect(SKILL_REPOS["hve-core"]).toBe("https://github.com/microsoft/hve-core.git")
  expect(stepSetup(stepById("rpi-research"), "/s", "/t")).toEqual({
    skillDirectories: ["/s/hve-core/.github/skills/rpi"],
    extraPath: [],
    prefix: "Use the rpi-research skill.",
  })
})

test("a step without skills, or no step, gets no setup", () => {
  const none = { skillDirectories: [], extraPath: [], prefix: "" }
  expect(stepSetup(stepById("verify"), "/s", "/t")).toEqual(none)
  expect(stepSetup(null, "/s", "/t")).toEqual(none)
})

test("a failed clone reports git's own error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-clone-"))
  expect(() => ensureClones(dir, { nope: path.join(dir, "missing-repo") })).toThrow(
    /clone nope failed: .*(does not exist|not a git repository|repository)/i,
  )
})

test("debug is selectable and loads only aitmpl's systematic-debugging skill", () => {
  expect(selectableSteps().some((s) => s.id === "debug")).toBe(true)
  expect(SKILL_REPOS["claude-code-templates"]).toEqual({
    url: "https://github.com/davila7/claude-code-templates.git",
    sparse: ["cli-tool/components/skills/development/systematic-debugging"],
  })
  expect(stepSetup(stepById("debug"), "/s", "/t")).toEqual({
    skillDirectories: ["/s/claude-code-templates/cli-tool/components/skills/development"],
    extraPath: [],
    prefix: `Use the systematic-debugging skill. ${DEBUG_ONLY()}`,
  })
})

test("debug finds the cause only: no Phase 4, no lasting code change, a report for the coordinator", () => {
  expect(DEBUG_ONLY()).toMatch(/Stop after Phase 3/)
  expect(DEBUG_ONLY()).toMatch(/Do not fix/)
  expect(stepById("debug").description).toMatch(/does not fix/)
})

test("a sparse repo checks out only its named folders", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-sparse-"))
  const src = path.join(dir, "src")
  for (const f of ["keep/a.md", "drop/b.md"]) {
    mkdirSync(path.join(src, path.dirname(f)), { recursive: true })
    writeFileSync(path.join(src, f), f)
  }
  const git = (...a: string[]) => execFileSync("git", ["-C", src, ...a], { stdio: "ignore" })
  git("init", "-q")
  git("add", ".")
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
  ensureClones(path.join(dir, "out"), { r: { url: `file://${src}`, sparse: ["keep"] } })
  expect(existsSync(path.join(dir, "out/r/keep/a.md"))).toBe(true)
  expect(existsSync(path.join(dir, "out/r/drop"))).toBe(false)
})

test("five-whys is a selectable Claude step that loads only intercom's five-whys skill", () => {
  const s = stepById("five-whys")
  expect(selectableSteps().some((x) => x.id === "five-whys")).toBe(true)
  expect(SKILL_REPOS["2x-skills"]).toEqual({
    url: "https://github.com/intercom/2x-skills.git",
    sparse: ["plugins/incident-tools/skills/five-whys"],
  })
  expect(s.harness).toEqual({ kind: "claude", profiles: ["default"] })
  expect(s.skillDirs).toEqual(["2x-skills/plugins/incident-tools/skills"])
  expect(s.instructions).toMatch(/do not fix/i)
})

test("debug and five-whys point at each other, so Jev can tell them apart", () => {
  expect(stepById("debug").avoidFor.join(" ")).toMatch(/five-whys/)
  expect(stepById("five-whys").avoidFor.join(" ")).toMatch(/use debug first/)
})

test("a Claude or Pi step's task prefix keeps the step's instructions", () => {
  expect(harnessPrefix(["five-whys"], stepById("five-whys"))).toBe(
    `Use the five-whys skill.\n${stepById("five-whys").instructions}`,
  )
  expect(harnessPrefix([], stepById("council"))).toBe("")
})

test("five-whys routes its subagents on a short low-cost text", () => {
  expect(stepById("five-whys").subagentRoute).toMatch(/^Low-cost/)
  expect(stepById("debug").subagentRoute).toBeUndefined()
})
