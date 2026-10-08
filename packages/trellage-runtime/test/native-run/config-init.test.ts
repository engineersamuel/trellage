import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ensureNativeConfig } from "../../src/native-run/config-init.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
test("initializes a missing config and preserves an existing environment config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "trellage-init-"))
  roots.push(home)
  const starter = path.join(home, "starter.toml")
  await writeFile(starter, "schema_version = 1\n[native.profiles.office]\nskills = []\n")
  const location = { home, environment: { HOME: home }, starter }
  const file = await ensureNativeConfig(location)
  expect(await readFile(file, "utf8")).toContain("native.profiles.office")
  const original = "# keep my comments\n[environment]\nenabled = false\n"
  await writeFile(file, original)
  await ensureNativeConfig(location)
  const migrated = await readFile(file, "utf8")
  expect(migrated.startsWith(original)).toBe(true)
  expect(migrated).toContain("native.profiles.office")
  await ensureNativeConfig(location)
  expect(await readFile(file, "utf8")).toBe(migrated)
})

test("explicit configuration is not overwritten or silently seeded", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "trellage-init-explicit-"))
  roots.push(home)
  const config = path.join(home, "custom.toml")
  await writeFile(config, "# custom\n[native.profiles.mine]\nskills = []\n", { mode: 0o600 })
  expect(await ensureNativeConfig({ home, environment: { HOME: home, TRELLAGE_CONFIG: config } })).toBe(config)
  expect(await readFile(config, "utf8")).toBe("# custom\n[native.profiles.mine]\nskills = []\n")
})

test("builtin dependency merge preserves pins and policy without adding starter defaults", async () => {
  const { withBuiltinPreset } = await import("../../src/native-run/config-init.ts")
  const source = {
    repository: "aqua-123/pstack-for-codex",
    commit: "a".repeat(40),
    allowExecutables: false,
    exclude: ["excluded"],
  }
  const original = { sources: { pstack: source }, instructions: {}, profiles: {} }
  const merged = await withBuiltinPreset(original, "preset-codex-pstack")
  expect(merged.sources.pstack).toBe(source)
  expect(Object.keys(merged.profiles)).toEqual(["preset-codex-pstack"])
  expect(original.profiles).toEqual({})
  const missing = await withBuiltinPreset({ sources: {}, instructions: {}, profiles: {} }, "preset-codex-pstack")
  expect(missing.sources.pstack?.repository).toBe(source.repository)
  expect(Object.keys(missing.sources)).toEqual(["pstack"])
  await expect(
    withBuiltinPreset({ ...original, sources: { pstack: { repository: "other/source" } } }, "preset-codex-pstack"),
  ).rejects.toThrow("rename your source or explicitly define")
})
