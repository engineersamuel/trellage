import { afterEach, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { prepareBackendComposition } from "../../src/native-run/backend-composition.ts"
import { gitSourceTransport } from "../../src/native-run/source.ts"
import { cleanupFixtures, createSourceRepo, skillMarkdown, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)

test("private presets compose additive TOML skills and instructions with an immutable snapshot", async () => {
  const home = await tempRoot("backend-composition")
  const repo = await createSourceRepo(home, "selected")
  await repo.write({ "skills/chosen/SKILL.md": skillMarkdown("chosen") })
  const config = path.join(home, "config.toml")
  await writeFile(path.join(home, "instructions.md"), "Keep existing sessions.")
  await writeFile(
    config,
    `
[native.sources.selected]
repository = "example/selected"
[native.instructions.note]
file = "instructions.md"
[native.profiles.preset-omp-default]
harnesses = ["omp"]
[native.profiles.extra]
skills = [{ source = "selected", names = ["chosen"] }]
instructions = ["note"]
[native.profiles.base]
always = true
`,
    { mode: 0o600 },
  )
  const environment = { HOME: home, TRELLAGE_CONFIG: config, PATH: process.env.PATH }
  const prepared = await prepareBackendComposition(
    "omp",
    ["default", "extra", "--no-always", "--dry-run", "--", "--resume", "old-session"],
    environment,
    gitSourceTransport(() => repo.directory),
  )
  expect(prepared.preset).toBe("default")
  expect(prepared.plan.profiles).toEqual(["extra", "preset-omp-default"])
  expect(prepared.plan.alwaysProfiles).toEqual([])
  expect(prepared.forwarded).toEqual(["--resume", "old-session"])
  expect(await readFile(path.join(prepared.layout.generationPath, "skills/chosen/SKILL.md"), "utf8")).toContain(
    "chosen",
  )
  expect(await readFile(path.join(prepared.layout.generationPath, "always-on.md"), "utf8")).toContain(
    "Keep existing sessions.",
  )
  expect(await readFile(path.join(prepared.layout.generationPath, ".empty/managed-skills.txt"), "utf8")).toBe("")
  expect(await readFile(config, "utf8")).toContain("[native.profiles.extra]")
})

test("provider preset conflicts fail before reading config or touching homes", async () => {
  await expect(prepareBackendComposition("omp", ["default", "local"], { HOME: "/nonexistent" })).rejects.toThrow(
    "select exactly one",
  )
})

test("the argument separator preserves literal harness options", async () => {
  const home = await tempRoot("backend-forwarding")
  const config = path.join(home, "config.toml")
  await writeFile(config, "[native.profiles.preset-omp-default]\n", { mode: 0o600 })
  const prepared = await prepareBackendComposition(
    "omp",
    [
      "default",
      "--allow-unproven-isolation",
      "--allow-unproven",
      "--",
      "--no-always",
      "--dry-run",
      "--require-proven-isolation",
      "--allow-unproven",
      "--",
    ],
    { HOME: home, TRELLAGE_CONFIG: config },
  )
  expect(prepared.forwarded).toEqual([
    "--no-always",
    "--dry-run",
    "--require-proven-isolation",
    "--allow-unproven",
    "--",
  ])
  expect(prepared.dryRun).toBe(false)
})

test("existing explicit custom configs inherit missing launch presets without file changes", async () => {
  const home = await tempRoot("backend-builtin-default")
  const config = path.join(home, "config.toml")
  const original = "# User-owned config\n[native.profiles.extra]\n[native.profiles.base]\nalways = true\n"
  await writeFile(config, original, { mode: 0o600 })
  const prepared = await prepareBackendComposition("omp", ["default", "extra"], { HOME: home, TRELLAGE_CONFIG: config })
  expect(prepared.plan.profiles).toContain("preset-omp-default")
  expect(prepared.plan.alwaysProfiles).toEqual(["base"])
  expect(await readFile(config, "utf8")).toBe(original)
})

test("private backends fail closed when proven isolation is required", async () => {
  await expect(
    prepareBackendComposition("omp", ["default", "--require-proven-isolation"], { HOME: "/nonexistent" }),
  ).rejects.toThrow("isolation is not proven")
})
