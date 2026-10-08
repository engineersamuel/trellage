import { expect, test } from "bun:test"
import { Effect } from "effect"
import { parseTrellageConfig } from "../src/native-config.ts"

test("shared skill sources supply native selections without a second source definition", async () => {
  const config = await Effect.runPromise(
    parseTrellageConfig(`
[skills.sources.office]
repository = "https://github.com/example/office.git"
select = ["powerpoint"]
commit = "${"a".repeat(40)}"
[skills.bundles]
native-common = ["office"]
[native.profiles.office]
skills = [{ source = "office", names = ["powerpoint"] }]
`),
  )
  expect(config.native.sources.office?.commit).toBe("a".repeat(40))
  expect(config.native.sources.office?.repository).toBe("example/office")
})

test("duplicate shared and native source IDs fail instead of silently overriding policy", async () => {
  await expect(
    Effect.runPromise(
      parseTrellageConfig(`
[skills.sources.office]
repository = "https://github.com/example/office.git"
select = ["powerpoint"]
[skills.bundles]
native-common = ["office"]
[native.sources.office]
repository = "other/office"
`),
    ),
  ).rejects.toThrow(/duplicate.*office/)
})

test("shared wildcard permissions and exclusions survive the native catalog bridge", async () => {
  const config = await Effect.runPromise(
    parseTrellageConfig(`
[skills.sources.office]
repository = "https://github.com/example/office.git"
select = ["*"]
allowWildcard = true
exclude = ["private"]
required = ["powerpoint"]
allowExecutables = true
[skills.bundles]
native-common = ["office"]
[native.profiles.office]
skills = [{ source = "office", names = ["*"] }]
`),
  )
  expect(config.native.sources.office?.exclude).toEqual(["private"])
  expect(config.native.sources.office?.required).toEqual(["powerpoint"])
})

test("environment-only default config inherits starter skills without writing the user file", async () => {
  const { readEffectiveSkillCatalog } = await import("../src/skill-config.ts")
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises")
  const os = await import("node:os")
  const path = await import("node:path")
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-effective-skills-"))
  try {
    const configPath = path.join(root, "config.toml")
    const starterPath = path.join(root, "starter.toml")
    const original = "# my settings\n[environment]\nenabled = false\n"
    await writeFile(configPath, original)
    await writeFile(
      starterPath,
      '[skills.sources.office]\nrepository = "https://github.com/example/office.git"\nselect = ["powerpoint"]\n[skills.bundles]\nnative-common = ["office"]\n',
    )
    const catalog = await readEffectiveSkillCatalog({ configPath, starterPath })
    expect(catalog.sources.office?.select).toEqual(["powerpoint"])
    expect(await readFile(configPath, "utf8")).toBe(original)
    await expect(readEffectiveSkillCatalog({ configPath, starterPath, explicit: true })).rejects.toThrow(/skills/)
    await expect(
      readEffectiveSkillCatalog({ configPath: path.join(root, "missing.toml"), starterPath, explicit: true }),
    ).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
