import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ensureClones, SELECTABLE_STEPS, SKILL_REPOS, stepById, stepSetup } from "../src/steps.ts"

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
  expect(stepById("rpi-research")).toMatchObject({ factoryOnly: true, skills: ["rpi-research"], gateTools: false })
  expect(stepById("rpi-research").harness).toBeUndefined()
  expect(SELECTABLE_STEPS.some((s) => s.id === "rpi-research")).toBe(false)
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
  expect(() => ensureClones(dir, { nope: path.join(dir, "missing-repo") })).toThrow(/clone nope failed: .*(does not exist|not a git repository|repository)/i)
})
