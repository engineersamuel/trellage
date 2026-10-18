import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { adapters, parseRunArguments, prepareRun } from "@trellage/runtime/native-run"
import { loadCliDomains } from "./exhaustive-cli-domains.ts"
import { createCleanRunWorld } from "./exhaustive-clean-run-world.ts"

const { run } = await loadCliDomains()
const selectors = run.find((domain) => domain.name === "--skill")!.values
const expectedSkills: Record<string, string[] | null> = {
  omitted: [],
  minimum: ["c"],
  ordinary: ["skill-name"],
  duplicate: ["c"],
  multiple: ["c", "d"],
  invalid: null,
}
expect(selectors.map((value) => value.id).sort()).toEqual(Object.keys(expectedSkills).sort())
const config = fileURLToPath(new URL("../config.toml", import.meta.url))

for (const harness of Object.keys(adapters).sort()) {
  test(`${harness}: declared ad hoc selectors prepare from owned local repositories`, async () => {
    const world = await createCleanRunWorld()
    try {
      for (const selector of selectors) {
        const argv = [harness, "--dry-run", "--no-always", ...selector.argv]
        const expected = expectedSkills[selector.id]!
        if (expected === null) {
          expect(() => parseRunArguments(argv)).toThrow()
          continue
        }
        const prepared = await prepareRun(parseRunArguments(argv), {
          ...world.dependencies,
          environment: {
            ...world.dependencies.environment,
            TRELLAGE_CONFIG: config,
            TRELLAGE_DEV_SOURCES: process.env.TRELLAGE_DEV_SOURCES,
          },
        })
        expect(prepared.plan.skills.map((skill) => skill.name)).toEqual(expected)
        expect(prepared.plan.alwaysProfiles).toEqual([])
        expect(prepared.plan.profiles.length).toBe(expected!.length ? 1 : 0)
        const manifest = JSON.parse(await readFile(path.join(prepared.layout.generationPath, "manifest.json"), "utf8"))
        expect(manifest.skills.map((skill: { name: string }) => skill.name)).toEqual(expected)
        for (const skill of prepared.plan.skills) {
          expect(skill.sourceId).toBe(selector.id === "ordinary" ? "adhoc-owner-repository" : "adhoc-a-b")
          const content = await readFile(
            path.join(prepared.layout.generationPath, "skills", skill.name, "SKILL.md"),
            "utf8",
          )
          expect(content).toContain(`Deterministic test fixture for ${skill.name}.`)
        }
      }
      expect(world.unexpected).toEqual([])
      expect(world.launches).toEqual([])
      expect(await world.discoveries()).toEqual([])
    } finally {
      await world.close()
    }
  }, 120000)
}

test("undeclared ad hoc repositories fail at the explicit transport boundary", async () => {
  const world = await createCleanRunWorld()
  try {
    await expect(
      prepareRun(parseRunArguments(["codex", "--dry-run", "--no-always", "--skill", "unmapped/repository:skill"]), {
        ...world.dependencies,
        environment: {
          ...world.dependencies.environment,
          TRELLAGE_CONFIG: config,
          TRELLAGE_DEV_SOURCES: process.env.TRELLAGE_DEV_SOURCES,
        },
      }),
    ).rejects.toThrow()
    expect(world.unexpected).toEqual(["source resolution"])
    expect(world.launches).toEqual([])
    expect(await world.discoveries()).toEqual([])
  } finally {
    await world.close()
  }
}, 120000)
