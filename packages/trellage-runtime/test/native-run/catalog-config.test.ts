import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadEffectiveRunConfig } from "../../src/native-run/catalog-config.ts"
import { enumerateNamedRunProfiles, resolveNamedRunProfile } from "../../src/native-run/selection.ts"
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(user?: string, explicit = false) {
  const home = await mkdtemp(path.join(os.tmpdir(), "run-catalog-config-"))
  roots.push(home)
  const shippedConfigPath = path.join(home, "shipped.toml")
  await writeFile(
    shippedConfigPath,
    `[native.profiles.base]\nalways = true\n[native.profiles.preset-codex-superpowers]\nharnesses = ["codex"]\n[native.profiles.preset-codex-superpowers.selection]\ndescription = "Shipped workflow"\nbest_for = ["Verified changes"]\n[native.profiles.firstmate]\nharnesses = ["pi", "claude"]\n`,
  )
  const userPath = path.join(home, ".config/trellage/config.toml")
  if (user !== undefined) {
    await mkdir(path.dirname(userPath), { recursive: true })
    await writeFile(userPath, user, { mode: 0o600 })
  }
  return {
    home,
    userPath,
    options: {
      home,
      cwd: home,
      shippedConfigPath,
      environment: { HOME: home, ...(explicit ? { TRELLAGE_CONFIG: userPath } : {}) },
    },
  }
}
test("read-only loading projects first-launch defaults without creating user configuration", async () => {
  const f = await fixture()
  const before = await readdir(f.home)
  const result = await loadEffectiveRunConfig(f.options)
  expect(result.catalog.profiles.base?.always).toBe(true)
  expect(await readdir(f.home)).toEqual(before)
})
test("explicit empty and intentionally empty native configuration remain authoritative", async () => {
  for (const [source, explicit] of [
    ["", true],
    ["[native]\n", false],
  ] as const) {
    const f = await fixture(source, explicit)
    expect((await loadEffectiveRunConfig(f.options)).catalog.profiles).toEqual({})
  }
})
test("omitting the environment option still respects an inherited explicit config", async () => {
  const f = await fixture("", true)
  const previous = process.env.TRELLAGE_CONFIG
  process.env.TRELLAGE_CONFIG = f.userPath
  try {
    const config = await loadEffectiveRunConfig({home:f.home,cwd:f.home,shippedConfigPath:f.options.shippedConfigPath})
    expect(config.catalog.profiles).toEqual({})
  } finally {
    if (previous === undefined) delete process.env.TRELLAGE_CONFIG
    else process.env.TRELLAGE_CONFIG = previous
  }
})

test("user overrides do not inherit descriptions from a shadowed preset", async () => {
  const f = await fixture('[native.profiles.superpowers]\nharnesses = ["codex"]\n')
  const config = await loadEffectiveRunConfig(f.options)
  const choice = resolveNamedRunProfile(config.catalog, config.shipped, "codex", "superpowers")
  expect(choice.definitionKey).toBe("superpowers")
  expect(choice.definition.selection).toBeUndefined()
  const choices = enumerateNamedRunProfiles(config)
  expect(choices.filter((x) => x.harness === "codex" && x.name === "superpowers")).toHaveLength(1)
  expect(choices.some((x) => x.harness === "pi" && x.name === "superpowers")).toBe(false)
})
test("enumeration respects shared and clean restrictions and does not advertise always-on entries", async () => {
  const f = await fixture()
  const config = await loadEffectiveRunConfig(f.options)
  const choices = enumerateNamedRunProfiles(config)
  expect(choices.some((x) => x.name === "base")).toBe(false)
  expect(
    choices
      .filter((x) => x.name === "firstmate")
      .map((x) => x.harness)
      .sort(),
  ).toEqual(["claude", "pi"])
  expect(
    choices
      .filter((x) => x.name === "clean")
      .map((x) => x.harness)
      .sort(),
  ).toEqual(["claude", "codex", "copilot", "pi"])
  expect(choices.find((x) => x.name === "clean")?.alwaysProfiles).toEqual([])
})
test("custom names beginning with preset remain discoverable unless they are shipped internal keys", async () => {
  const f = await fixture('[native.profiles.preset-my-review]\nharnesses=["pi"]\n')
  const config = await loadEffectiveRunConfig(f.options)
  expect(enumerateNamedRunProfiles(config).some((profile) => profile.ref === "native:pi/preset-my-review")).toBe(true)
})

test("source conflicts are visible on the affected preset before any launch", async () => {
  const f = await fixture('[native.sources.tools]\nrepository = "other/tools"\n')
  await writeFile(
    f.options.shippedConfigPath,
    '[native.sources.tools]\nrepository="expected/tools"\n[native.profiles.preset-codex-superpowers]\nharnesses=["codex"]\nskills=[{source="tools",names=["review"]}]\n',
  )
  const config = await loadEffectiveRunConfig(f.options)
  expect(
    enumerateNamedRunProfiles(config).find((p) => p.ref === "native:codex/superpowers")?.resolutionProblem,
  ).toContain("source tools conflicts")
})

test("unsafe selected config files remain rejected", async () => {
  const f = await fixture("[native]\n")
  await rm(f.userPath)
  await symlink(f.options.shippedConfigPath, f.userPath)
  await expect(loadEffectiveRunConfig(f.options)).rejects.toThrow()
})
