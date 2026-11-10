import { expect, test } from "bun:test"
import { readFile, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import { generateRunCatalogContent } from "../scripts/generate-run-catalog-content.ts"
import path from "node:path"
import { readTrellageConfig } from "@trellage/runtime/native-config"
import { adapters, enumerateNamedRunProfiles, loadEffectiveRunConfig } from "@trellage/runtime/native-run"
import { parseSelectionMetadata, selectionMetadataStatus } from "@trellage/guide-core"
const root = path.resolve(import.meta.dir, "..")
test("shipped harnesses and effective named choices all carry minimum selection guidance", async () => {
  const config = await loadEffectiveRunConfig({
    shippedConfigPath: path.join(root, "config.example.toml"),
    environment: { HOME: "/nonexistent-trx-catalog-home" },
    home: "/nonexistent-trx-catalog-home",
  })
  for (const id of Object.keys(adapters))
    expect(
      selectionMetadataStatus(parseSelectionMetadata(config.shipped.harnesses?.[id]?.selection ?? {}, id)),
      id,
    ).toBe("complete")
  const choices = enumerateNamedRunProfiles(config)
  expect(choices.some((profile) => profile.ref === "native:headlong/default")).toBe(true)
  for (const profile of choices)
    expect(
      selectionMetadataStatus(parseSelectionMetadata(profile.definition.selection ?? {}, profile.ref)),
      profile.ref,
    ).toBe("complete")
})
test("generation uses the shipped example without requiring a user config file", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "trx-catalog-content-"))
  try {
    await writeFile(path.join(fixture, "config.example.toml"), "schema_version = 1\n", {mode:0o600})
    await mkdir(path.join(fixture, "prototypes"))
    await generateRunCatalogContent({root:fixture,check:false})
    expect((await readdir(fixture)).sort()).toEqual(["config.example.toml", "prototypes"])
  } finally {
    await rm(fixture,{recursive:true,force:true})
  }
})

test("copyable example contains valid shipped defaults", async () => {
  const example = await readFile(path.join(root, "config.example.toml"), "utf8")
  expect(example).toContain("Copy this file to ~/.config/trellage/config.toml")
  const decoded = await readTrellageConfig({ environment: { TRELLAGE_CONFIG: path.join(root, "config.example.toml") } })
  expect(Object.keys(decoded.config.native.profiles).length).toBeGreaterThan(0)
})
