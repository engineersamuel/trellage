import { afterEach, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { updateSkills } from "../src/skill-update.ts"
import { cleanupFixtures, createSourceRepo, fixturePaths, skillMarkdown, tempRoot } from "./native-run/fixtures.ts"
import { gitSourceTransport } from "../src/native-run/source.ts"
afterEach(cleanupFixtures)
const setup = async () => {
  const root = await tempRoot("skill-update")
  const repo = await createSourceRepo(root, "office")
  const first = await repo.write({ "skills/powerpoint/SKILL.md": skillMarkdown("powerpoint", "v1") })
  const second = await repo.write({ "skills/powerpoint/SKILL.md": skillMarkdown("powerpoint", "v2") })
  const file = path.join(root, "config.toml")
  const original = `# keep this comment\n[environment]\nenabled = false\n[native.sources.office]\nrepository = "example/office"\ncommit = "${first}" # pin\n[native.profiles.office]\nskills = [{ source = "office", names = ["powerpoint"] }]\n`
  await writeFile(file, original, { mode: 0o600 })
  return {
    root,
    repo,
    first,
    second,
    file,
    original,
    paths: await fixturePaths(root),
    transport: gitSourceTransport(() => repo.directory),
  }
}
test("maintenance keeps commit pins until deliberate upgrade and preserves TOML comments", async () => {
  const fixture = await setup()
  const checked = await updateSkills({ ...fixture, configPath: fixture.file, check: true })
  expect(checked[0]?.candidateCommit).toBe(fixture.second)
  expect(await readFile(fixture.file, "utf8")).toBe(fixture.original)
  const warmed = await updateSkills({ ...fixture, configPath: fixture.file })
  expect(warmed[0]?.commit).toBe(fixture.first)
  const upgraded = await updateSkills({ ...fixture, configPath: fixture.file, upgradePins: true })
  expect(upgraded[0]?.commit).toBe(fixture.second)
  expect(await readFile(fixture.file, "utf8")).toBe(fixture.original.replace(fixture.first, fixture.second))
})
test("failed replacement validation leaves configured pins unchanged", async () => {
  const fixture = await setup()
  await expect(
    updateSkills({
      ...fixture,
      configPath: fixture.file,
      upgradePins: true,
      validate: async () => {
        throw new Error("invalid content")
      },
    }),
  ).rejects.toThrow("invalid content")
  expect(await readFile(fixture.file, "utf8")).toBe(fixture.original)
})
test("concurrent config editing aborts pin persistence", async () => {
  const fixture = await setup()
  const edited = `${fixture.original}\n# user edit\n`
  await expect(
    updateSkills({
      ...fixture,
      configPath: fixture.file,
      upgradePins: true,
      validate: async () => {
        await writeFile(fixture.file, edited)
      },
    }),
  ).rejects.toThrow(/changed/)
  expect(await readFile(fixture.file, "utf8")).toBe(edited)
})

test("ambiguous stable tag upgrades leave pins unchanged", async () => {
  const fixture = await setup()
  const original = fixture.original.replace(`commit = "${fixture.first}"`, 'tag = "v1.0.0"')
  await writeFile(fixture.file, original)
  await expect(
    updateSkills({
      ...fixture,
      configPath: fixture.file,
      upgradePins: true,
      transport: { ...fixture.transport, listTags: async () => ["v2.0.0", "2.0.0"] },
    }),
  ).rejects.toThrow(/ambiguous/)
  expect(await readFile(fixture.file, "utf8")).toBe(original)
})

test("shared source replacement validates its selected skills even without native references", async () => {
  const fixture = await setup()
  const original = `[skills.sources.office]\nrepository = "https://github.com/example/office.git"\ncommit = "${fixture.first}"\nselect = ["missing"]\n[skills.bundles]\nsandbox-common = ["office"]\n`
  await writeFile(fixture.file, original)
  await expect(updateSkills({ ...fixture, configPath: fixture.file, upgradePins: true })).rejects.toThrow(/missing/)
  expect(await readFile(fixture.file, "utf8")).toBe(original)
})

test("tag upgrades select a stable newer tag and preserve the tag selector", async () => {
  const fixture = await setup()
  const { git } = await import("./native-run/fixtures.ts")
  await git(fixture.repo.directory, "tag", "v1.0.0", fixture.first)
  await git(fixture.repo.directory, "tag", "v2.0.0", fixture.second)
  await git(fixture.repo.directory, "tag", "v3.0.0-beta", fixture.second)
  const original = fixture.original.replace(`commit = "${fixture.first}"`, 'tag = "v1.0.0"')
  await writeFile(fixture.file, original)
  const results = await updateSkills({ ...fixture, configPath: fixture.file, upgradePins: true })
  expect(results[0]?.newSelector).toBe("v2.0.0")
  expect(results[0]?.commit).toBe(fixture.second)
  expect(await readFile(fixture.file, "utf8")).toBe(original.replace('"v1.0.0"', '"v2.0.0"'))
})
