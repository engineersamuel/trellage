import { expect, test } from "bun:test"
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkStepSkills, prepareStepSkills, SkillPreflightError, skillProblem, stepById } from "../src/steps.ts"
import { spawnHealing } from "../src/tools.ts"

const skill = (root: string, name: string, extra = "") => {
  mkdirSync(path.join(root, name), { recursive: true })
  writeFileSync(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n${extra}---\n\nbody\n`)
}
const arch = stepById("optimize-improve-codebase-architecture")

test("preflight names the exact reason a skill is unusable", () => {
  const src = mkdtempSync(path.join(tmpdir(), "sf-skills-"))
  skill(src, "codebase-design")
  skill(src, "improve-codebase-architecture", "disable-model-invocation: true\n")
  expect(skillProblem(null)).toBe("SKILL.md not found")
  expect(skillProblem(path.join(src, "codebase-design"))).toBeNull()
  expect(skillProblem(path.join(src, "improve-codebase-architecture"))).toContain("disable-model-invocation")
  const err = (() => {
    try {
      prepareStepSkills([src], path.join(src, "healed"), path.join(src, "step"), arch)
    } catch (e) {
      return e
    }
  })()
  expect(err).toBeInstanceOf(SkillPreflightError)
  expect((err as SkillPreflightError).failures.map((f) => f.name)).toEqual(["improve-codebase-architecture"])
})

test("a healed copy wins, and the step folder links only the step's skills", () => {
  const src = mkdtempSync(path.join(tmpdir(), "sf-skills-"))
  const healed = path.join(src, "healed")
  for (const n of ["codebase-design", "tdd", "wizard"]) skill(src, n)
  skill(src, "improve-codebase-architecture", "disable-model-invocation: true\n")
  skill(healed, "improve-codebase-architecture")
  const checks = prepareStepSkills([src], healed, path.join(src, "step"), arch)
  expect(checks.map((c) => [c.name, c.healed, c.problem])).toEqual([
    ["improve-codebase-architecture", true, null],
    ["codebase-design", false, null],
  ])
  expect(readlinkSync(path.join(src, "step", "improve-codebase-architecture"))).toBe(path.join(healed, "improve-codebase-architecture"))
  expect(() => lstatSync(path.join(src, "step", "tdd"))).toThrow()
  expect(checkStepSkills([src], healed, stepById("optimize-first-principles"))).toEqual([])
})

const preflight = new SkillPreflightError("optimize-improve-codebase-architecture", [
  { name: "improve-codebase-architecture", dir: "/s/x", healed: false, problem: "model invocation is disabled" },
])
const healFactory = (failures: number) => {
  const spawned: any[] = []
  const published: string[] = []
  let left = failures
  const f: any = {
    healRoot: "/state/skills-healed",
    publish: (_w: string, type: string) => published.push(type),
    spawn: async (spec: any) => {
      spawned.push(spec)
      if (spec.step && left-- > 0) throw preflight
      return { id: `w-${spawned.length}`, lastMessage: "improve-codebase-architecture: healed", waitIdle: async () => true }
    },
  }
  return { f, spawned, published }
}
const scope = { id: "sub-o", threadId: "o", workdir: "/wt" }

test("a preflight failure spawns one skill-doctor, then retries the worker once", async () => {
  const { f, spawned, published } = healFactory(1)
  const w = await spawnHealing(f, scope, { name: "arch", role: "worker", step: arch.id, task: "t" })
  expect(w.id).toBe("w-3")
  expect(spawned.map((s) => s.name)).toEqual(["arch", "skill-doctor-improve-codebase-architecture", "arch"])
  expect(spawned[1].workdir).toBe("/state/skills-healed")
  expect(spawned[1].step).toBeUndefined()
  expect(spawned[1].task).toContain("model invocation is disabled")
  expect(published).toEqual(["factory.skill_preflight_failed", "factory.skill_healed"])
})

test("a second preflight failure fails with the doctor's verdict, without a loop", async () => {
  const { f, spawned } = healFactory(2)
  await expect(spawnHealing(f, scope, { name: "arch", role: "worker", step: arch.id, task: "t" })).rejects.toThrow("skill-doctor: improve-codebase-architecture: healed")
  expect(spawned).toHaveLength(3)
})

test("other spawn errors pass through without a doctor", async () => {
  const f: any = { publish: () => {}, spawn: async () => { throw new Error("boom") } }
  await expect(spawnHealing(f, scope, { name: "x", role: "worker" })).rejects.toThrow("boom")
})
