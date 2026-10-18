import { expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readTrellageConfig } from "@trellage/runtime/native-config"
import { parseRunArguments, prepareRun } from "@trellage/runtime/native-run"
import { createRunWorld } from "./exhaustive-run-world.ts"
import { assertRunSelection } from "./exhaustive-run-selection.ts"

test("selection oracle rejects missing or substituted manifest selections", async () => {
  const world = await createRunWorld("codex")
  try {
    const {
      config: { native: catalog },
    } = await readTrellageConfig({
      environment: { TRELLAGE_CONFIG: fileURLToPath(new URL("../config.example.toml", import.meta.url)) },
    })
    const options = parseRunArguments(["codex", "base", "--dry-run", "--skill", "a/b:c"])
    const prepared = await prepareRun(options, world.dependencies)
    const file = path.join(prepared.layout.generationPath, "manifest.json")
    const original = JSON.parse(await readFile(file, "utf8"))
    const check = () =>
      assertRunSelection(
        options,
        catalog,
        prepared.layout.generationPath,
        world.dependencies.environment.TRELLAGE_DEV_SOURCES!,
        "mutation",
      )
    await check()
    const changes = [
      { harness: "pi" },
      { profiles: [] },
      { alwaysProfiles: [] },
      { skills: [] },
      { instructions: ["unexpected"] },
      { plugins: [{ name: "unexpected" }] },
      { skills: original.skills.map((skill: object) => ({ ...skill, sourceId: "unexpected" })) },
      { skills: original.skills.map((skill: object) => ({ ...skill, commit: "invalid" })) },
    ]
    for (const change of changes) {
      await writeFile(file, JSON.stringify({ ...original, ...change }))
      await expect(check()).rejects.toThrow()
    }
    await writeFile(file, JSON.stringify(original))
    await check()
    expect(world.launches).toEqual([])
    expect(world.unexpected).toEqual([])
  } finally {
    await world.close()
  }
}, 120000)
