import path from "node:path"
import assert from "node:assert/strict"
import { readdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createCleanRunWorld } from "./exhaustive-clean-run-world.ts"
import { createAdmissionMocks } from "./exhaustive-admission-mocks.ts"
import { createHostAdmission } from "./exhaustive-host-admission.ts"
import { createRuntimeAdmission } from "./exhaustive-runtime-admission.ts"
import { createGithubBridge } from "./exhaustive-github-bridge.ts"
import { createFirstmateFixture } from "./exhaustive-firstmate.ts"

/** One isolated harness world, retaining real composition and metadata admission. */
export const createRunWorld = async (harness: string) => {
  const world = await createCleanRunWorld()
  try {
    const inert = world.dependencies.environment!.TRELLAGE_CODEX_BIN!
    const admission = await createAdmissionMocks(world.root, inert)
    const host = await createHostAdmission(world.root)
    const runtime = await createRuntimeAdmission(world.root, world.home, inert)
    const github = await createGithubBridge(world.root, world.home, path.join(world.root, "bin"))
    const environment: NodeJS.ProcessEnv = {
      ...runtime.environment,
      ...host.environment,
      ...admission.environment,
      ...world.dependencies.environment,
      TRELLAGE_CONFIG: fileURLToPath(new URL("../config.toml", import.meta.url)),
      TRELLAGE_DEV_SOURCES: process.env.TRELLAGE_DEV_SOURCES,
    }
    if (harness === "jcode") delete environment.TRELLAGE_JCODE_BIN
    const firstmate = await createFirstmateFixture(world.root, environment)
    const refreshes: string[] = []
    return {
      ...world,
      admission,
      host,
      runtime,
      github,
      firstmate,
      refreshes,
      resetEvidence: async () => {
        world.launches.length = 0
        world.lines.length = 0
        refreshes.length = 0
        firstmate.calls.length = 0
        for (const relative of [
          "discovery.jsonl",
          "github-bridge.jsonl",
          "admission-mocks/calls.jsonl",
          "host-admission/calls.jsonl",
          "runtime-admission/calls.jsonl",
        ])
          await writeFile(path.join(world.root, relative), "")
      },
      dependencies: {
        ...world.dependencies,
        environment,
        syncRepository: firstmate.syncRepository,
        spawner: async (...args: Parameters<NonNullable<typeof world.dependencies.spawner>>) => {
          const leases = path.join(world.paths.state, "leases")
          const entries = await readdir(leases)
          let active = 0
          const generations = world.lines
            .filter((line) => line.startsWith("Generation  "))
            .map((line) => line.slice("Generation  ".length))
          assert.equal(generations.length, 1, "launch must identify one generation")
          for (const entry of entries) {
            const count = (await readdir(path.join(leases, entry))).length
            active += count
            if (count) assert.equal(entry, path.basename(generations[0]!), "active lease must match launch generation")
          }
          assert.equal(active, 1, "launch must hold exactly one active lease")
          return world.dependencies.spawner!(...args)
        },
        refreshHarness: async (requested: string) => {
          refreshes.push(requested)
          return undefined
        },
      },
    }
  } catch (error) {
    await world.close()
    throw error
  }
}
