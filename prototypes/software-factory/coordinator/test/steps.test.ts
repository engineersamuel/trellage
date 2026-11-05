import { expect, test } from "bun:test"
import { stepById, stepSetup } from "../src/steps.ts"

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

test("a step without skills, or no step, gets no setup", () => {
  const none = { skillDirectories: [], extraPath: [], prefix: "" }
  expect(stepSetup(stepById("verify"), "/s", "/t")).toEqual(none)
  expect(stepSetup(null, "/s", "/t")).toEqual(none)
})
