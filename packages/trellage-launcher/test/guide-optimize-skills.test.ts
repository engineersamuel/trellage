import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { CommandRunner } from "../src/guide-launch.ts"
import { ensureOptimizeSkills } from "../src/guide-optimize-skills.ts"
import { buildGuideOptimizePrompt, selectGuideOptimizeSkills } from "../src/guide-optimize.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async (writeSkills = true) => {
  const root = await mkdtemp(path.join(tmpdir(), "optimize-skills-"))
  roots.push(root)
  const calls: ReadonlyArray<string>[] = []
  const runner: CommandRunner = {
    run: async (_executable, args) => {
      calls.push(args)
      const target = args[args.indexOf("--target") + 1]!
      for (const name of writeSkills ? ["improve-codebase-architecture", "codebase-design"] : []) {
        await mkdir(path.join(target, name), { recursive: true })
        await writeFile(path.join(target, name, "SKILL.md"), `---\nname: ${name}\n---\n`)
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    },
  }
  const env = {
    TRELLAGE_GUIDE_SKILLS_MANAGER: path.join(root, "manager.ts"),
    TRELLAGE_GUIDE_SKILLS_CATALOG: path.join(root, "config.toml"),
    TRELLAGE_GUIDE_OPTIMIZE_SKILLS_CACHE: path.join(root, "cache"),
  }
  return { root, calls, runner, env }
}

describe("Optimize managed skills", () => {
  it("downloads the architecture bundle only when that skill is selected", async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    expect(await ensureOptimizeSkills(f.runner, ["first-principles", "ui-css"], signal, f.env)).toBeUndefined()
    expect(f.calls).toEqual([])
    const directory = await ensureOptimizeSkills(f.runner, ["improve-codebase-architecture"], signal, f.env)
    expect(directory).toBe(path.join(f.root, "cache", "run"))
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toEqual(expect.arrayContaining(["ensure", "--bundle", "guide-optimize-architecture"]))
  })

  it("fails when the bundle does not contain the expected skills", async () => {
    const f = await fixture(false)
    await expect(ensureOptimizeSkills(f.runner, ["improve-codebase-architecture"], new AbortController().signal, f.env))
      .rejects.toThrow()
  })

  it("fails clearly when runtime paths are missing", async () => {
    const f = await fixture()
    await expect(ensureOptimizeSkills(f.runner, ["improve-codebase-architecture"], new AbortController().signal, {}))
      .rejects.toThrow("runtime paths are missing")
  })

  it("names the skill directory in the prompt", () => {
    const prompt = buildGuideOptimizePrompt(selectGuideOptimizeSkills(["improve-codebase-architecture"]), "/skills")
    expect(prompt).toContain('Managed skills are in "/skills"')
    expect(prompt).toContain("## Improve codebase architecture")
  })
})
