import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { loadCompositionCatalog } from "../../packages/trellage-launcher/src/composition-catalog.ts"
import { nativeMatrixWorld } from "./native-world.ts"

/** Read the actual router's catalog with a private HOME and no provider credentials. */
export async function guideWorld(repositoryRoot: string) {
  if (process.env.TRELLAGE_TEST_OFFLINE !== "1") throw new Error("Guide fixtures require enforced offline execution")
  const world = await nativeMatrixWorld(repositoryRoot)
  const environment = {
    ...world.dependencies.environment,
    TRELLAGE_TEST_BUN: process.env.TRELLAGE_TEST_BUN,
    TRELLAGE_TEST_BIN: process.env.TRELLAGE_TEST_BIN,
    TRELLAGE_TRX_COMMAND_PATH: path.join(repositoryRoot, "bin/trx"),
  }
  try {
    const child = Bun.spawn(
      ["bash", path.join(repositoryRoot, "prototypes/trellage-router/bin/trx"), "list", "--json"],
      {
        cwd: repositoryRoot,
        env: {
          ...environment,
          TRELLAGE_TRX_SOURCE_ROOT: path.join(repositoryRoot, "prototypes/trellage-router"),
          TRELLAGE_TRX_NATIVE_SOURCE: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    assert.equal(status, 0, stderr)
    const listing: { profiles: object[] } = JSON.parse(stdout)
    assert.ok(listing.profiles.length > 0)
    const guideRoot = path.join(repositoryRoot, "profile-guides")
    const catalogSource = `
      import { loadCompositionCatalog } from ${JSON.stringify(path.join(repositoryRoot, "packages/trellage-launcher/src/composition-catalog.ts"))}
      const catalog = await loadCompositionCatalog({
        guideRoot: ${JSON.stringify(guideRoot)},
        commandPath: ${JSON.stringify(path.join(repositoryRoot, "bin/trx"))},
      })
      await Bun.write(Bun.stdout, JSON.stringify(catalog))
    `
    const catalogProcess = Bun.spawn([process.execPath, "-e", catalogSource], {
      cwd: repositoryRoot,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [catalogOutput, catalogError, catalogStatus] = await Promise.all([
      new Response(catalogProcess.stdout).text(),
      new Response(catalogProcess.stderr).text(),
      catalogProcess.exited,
    ])
    assert.equal(catalogStatus, 0, catalogError)
    const catalog = JSON.parse(catalogOutput)
    assert.ok(catalog.entries.length > 0)
    const catalogWithGuides = {
      ...catalog,
      native: catalog.entries.flatMap((entry: (typeof catalog.entries)[number]) => {
        const name = entry.profiles[0]
        return entry.guide === null || name === undefined
          ? []
          : [{ launcher: entry.harness, name, guide: entry.guide, headless: entry.headless }]
      }),
    }
    assert.ok(catalogWithGuides.native.length > 0)
    const catalogFile = path.join(world.root, "guide-catalog.json")
    await writeFile(catalogFile, JSON.stringify(catalogWithGuides), { mode: 0o600 })
    const promptMasterSkillDirectory = path.join(world.root, "prompt-master")
    await mkdir(promptMasterSkillDirectory)
    await writeFile(
      path.join(promptMasterSkillDirectory, "SKILL.md"),
      "# Prompt Master\nDeterministic model fixture.\n",
    )
    return {
      root: world.root,
      environment,
      catalog: catalogWithGuides,
      catalogFile,
      guideRoot,
      promptMasterSkillDirectory,
      async withCase<T>(ordinal: bigint, use: (cwd: string) => Promise<T>): Promise<T> {
        const cwd = path.join(world.root, `case-${ordinal}`)
        await mkdir(cwd)
        try {
          return await use(cwd)
        } finally {
          await rm(cwd, { recursive: true, force: true })
        }
      },
      dispose: world.dispose,
    }
  } catch (error) {
    await world.dispose()
    throw error
  }
}
