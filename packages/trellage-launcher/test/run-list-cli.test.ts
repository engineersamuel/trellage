import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadRunCatalog } from "../src/run-catalog.ts"
import { buildRunList, formatRunList } from "../src/run-list-cli.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const loadFixtureCatalog = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trellage-run-list-"))
  temporaryDirectories.push(directory)
  const config = path.join(directory, "config.toml")
  await writeFile(config, `
[native.profiles.base]
label = "Shared defaults"
always = true

[native.profiles.claude-only]
label = "Claude tools"
harnesses = ["claude"]

[native.profiles.optional]
label = "Optional tools"
`, { mode: 0o600 })
  await chmod(config, 0o600)
  return loadRunCatalog({ environment: { ...process.env, TRELLAGE_CONFIG: config }, home: directory, cwd: directory, includeModels: false })
}

describe("run list", () => {
  it("resolves presets, harness-limited profiles, always profiles, shared profiles, and clean", async () => {
    const document = buildRunList(await loadFixtureCatalog())
    const claude = document.harnesses.find((entry) => entry.harness === "claude")
    const grok = document.harnesses.find((entry) => entry.harness === "grok")
    const fx = document.harnesses.find((entry) => entry.harness === "fx")

    expect(document.schemaVersion).toBe(2)
    expect(claude?.presets).toContain("social-media")
    expect(claude?.profiles).toEqual(expect.arrayContaining(["base", "claude-only", "optional", "firstmate", "clean", "default"]))
    expect(grok?.profiles).toEqual(expect.arrayContaining(["base", "optional"]))
    expect(grok?.profiles).not.toEqual(expect.arrayContaining(["claude-only", "firstmate", "clean"]))
    expect(fx).toMatchObject({ canonical: false, presets: ["default"] })
    expect(document.profiles).toEqual(expect.arrayContaining([
      { name: "base", label: "Shared defaults", kind: "config", always: true, harnesses: null },
      { name: "claude-only", label: "Claude tools", kind: "config", always: false, harnesses: ["claude"] },
      { name: "firstmate", label: expect.any(String), kind: "shared", always: false, harnesses: ["claude", "pi"] },
    ]))
    expect(document.profiles.find((entry) => entry.name === "clean")).toMatchObject({
      label: "Clean",
      kind: "special",
      always: false,
      harnesses: expect.arrayContaining(["claude", "copilot", "codex", "pi"]),
    })
  })

  it("formats compact aligned tables", async () => {
    const output = formatRunList(buildRunList(await loadFixtureCatalog()))
    expect(output).toContain("HARNESS")
    expect(output).toContain("BUILT-IN PRESETS")
    expect(output).toContain("PROFILE")
    expect(output).toContain("APPLIES TO")
    expect(output).toContain("base")
    expect(output).toContain("always")
    expect(output).toContain("claude-only")
    expect(output).toContain("claude")
  })
})
