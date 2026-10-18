import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadRunListCatalog } from "../src/run-list-catalog.ts"
import { formatRunList, parseRunListArguments } from "../src/run-list.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const loadFixtureCatalog = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trellage-run-list-"))
  temporaryDirectories.push(directory)
  await mkdir(path.join(directory, "bin"))
  await symlink(process.execPath, path.join(directory, "bin/pi"))
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
[native.profiles.optional.selection]
description = "Optional tools"
best_for = ["Useful optional work"]
`, { mode: 0o600 })
  await chmod(config, 0o600)
  return loadRunListCatalog({
    environment: { HOME: directory, PATH: path.join(directory, "bin"), TRELLAGE_CONFIG: config },
    home: directory,
    cwd: directory,
  })
}

describe("run list", () => {
  it("lists ready harnesses and groups profiles by their definition", async () => {
    const document = await loadFixtureCatalog()
    expect(document.schemaVersion).toBe(2)
    expect(document.harnesses.map((entry) => entry.id)).toEqual(["pi"])
    expect(document.harnesses[0]).not.toHaveProperty("profiles")
    expect(document.profiles.find((entry) => entry.id === "optional")).toMatchObject({
      argument: "optional",
      readyHarnesses: ["pi"],
      metadataStatus: "complete",
      guideEligibility: { eligible: true },
    })
    expect(document.profiles.find((entry) => entry.id === "optional")?.harnesses).toContain("pi")
    expect(document.unavailable.profiles.find((entry) => entry.id === "claude-only")?.harnesses).toEqual(["claude"])
    expect(document.profiles.some((entry) => entry.id === "base")).toBe(false)
  })

  it("formats readiness and validates its arguments", async () => {
    const output = formatRunList(await loadFixtureCatalog())
    expect(output).toContain("Harnesses")
    expect(output).toContain("Unavailable")
    expect(output).toContain("optional")
    expect(parseRunListArguments(["--json"])).toEqual({ format: "json", help: false })
    expect(parseRunListArguments(["--help"])).toEqual({ format: "text", help: true })
    expect(() => parseRunListArguments(["--json", "--json"])).toThrow("Usage: trx run list")
  })
})
