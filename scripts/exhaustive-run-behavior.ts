import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { readTrellageConfig } from "@trellage/runtime/native-config"
import { NativeRunError, parseRunArguments, runNative, type RunOptions } from "@trellage/runtime/native-run"
import { caseAt, loadCliDomains, productSize } from "./exhaustive-cli-domains.ts"
import { renderArgumentForm } from "./exhaustive-argument-syntax.ts"
import { expectedRun, expectedRunOutcome } from "./exhaustive-run-oracle.ts"
import { createRunWorld } from "./exhaustive-run-world.ts"
import { assertRunSelection } from "./exhaustive-run-selection.ts"
import { assertRunCommand } from "./exhaustive-run-command.ts"
import { assertRunLaunch } from "./exhaustive-run-launch.ts"

const root = fileURLToPath(new URL("../", import.meta.url))
export const loadRunBehaviorDomain = async () => {
  const { run, sourceHashes } = await loadCliDomains()
  const hash = async (name: string) => {
    sourceHashes[name] = createHash("sha256")
      .update(await readFile(path.join(root, name)))
      .digest("hex")
  }
  for (const name of [
    "scripts/exhaustive-run-behavior.ts",
    "scripts/verify-run-behavior.ts",
    "scripts/exhaustive-run-world.ts",
    "scripts/exhaustive-run-selection.ts",
    "scripts/exhaustive-run-launch.ts",
    "scripts/exhaustive-run-command.ts",
    "scripts/exhaustive-clean-run-world.ts",
    "scripts/exhaustive-admission-mocks.ts",
    "scripts/exhaustive-host-admission.ts",
    "scripts/exhaustive-runtime-admission.ts",
    "scripts/exhaustive-github-bridge.ts",
    "scripts/exhaustive-firstmate.ts",
    "scripts/trellage-statusline.sh",
    "tests/helpers/native-source-fixtures.ts",
  ])
    await hash(name)
  const tree = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) await tree(name)
      else if (entry.isFile()) await hash(name)
    }
  }
  await tree("packages/trellage-runtime/src/native-run")
  return {
    run,
    sourceHashes,
    domainHash: createHash("sha256").update(JSON.stringify({ run, sourceHashes })).digest("hex"),
  }
}

const readOptional = async (file: string) =>
  readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })

export const defaultRunBehaviorSamples = 4000
/** Evenly spaced ordinals; the last sampled case is always inside the product. */
export const runBehaviorStride = (total: bigint, samples: bigint): bigint => (total / samples > 0n ? total / samples : 1n)

if (import.meta.main) {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "use scripts/test-offline.sh --native-sources")
  assert.ok(process.env.TRELLAGE_DEV_SOURCES, "explicit local source mappings required")
  const { values } = parseArgs({
    options: {
      start: { type: "string", default: "0" },
      count: { type: "string" },
      output: { type: "string" },
      // Default: a fixed stride sample across the whole product (it has ~76 billion cases).
      samples: { type: "string", default: String(defaultRunBehaviorSamples) },
    },
  })
  const { run, sourceHashes, domainHash } = await loadRunBehaviorDomain()
  const total = productSize(run)
  const sampled = values.count === undefined && values.start === "0"
  const sampleCount = BigInt(values.samples!)
  const stride = runBehaviorStride(total, sampleCount)
  const start = BigInt(values.start!),
    count = sampled ? sampleCount : values.count === undefined ? total - start : BigInt(values.count),
    end = sampled ? total : start + count
  assert(start >= 0n && count > 0n && end <= total, "range outside declared full product")
  const {
    config: { native: catalog },
  } = await readTrellageConfig({ environment: { TRELLAGE_CONFIG: path.join(root, "config.example.toml") } })
  const worlds = new Map<string, Awaited<ReturnType<typeof createRunWorld>>>()
  const outcomes: Record<string, number> = {},
    digest = createHash("sha256")
  try {
    for (let step = 0n; step < count; step++) {
      const index = sampled ? step * stride : start + step
      const selected = caseAt(run, index),
        expectedOptions = expectedRun(selected)
      const expected = expectedRunOutcome(expectedOptions, catalog),
        id = `${domainHash}:${index}`
      let parsed: RunOptions | undefined, failure: unknown
      try {
        parsed = parseRunArguments(renderArgumentForm("run", selected))
      } catch (error) {
        failure = error
      }
      if (!expectedOptions) {
        assert(failure instanceof NativeRunError, id)
        assert.equal(failure.code, "usage", id)
      } else {
        assert.equal(failure, undefined, id)
        assert.deepEqual(parsed, expectedOptions, id)
        let world = worlds.get(parsed!.harness)
        if (!world) {
          world = await createRunWorld(parsed!.harness)
          worlds.set(parsed!.harness, world)
        }
        const history = path.join(world.paths.state, "selections.json"),
          beforeHistory = await readOptional(history)
        await world.resetEvidence()
        let result: number | undefined
        try {
          result = await runNative(parsed!, world.dependencies)
        } catch (error) {
          failure = error
        }
        const launched = expected === "launched"
        if (launched || expected === "dry-run" || expected === "no-session") {
          assert.equal(failure, undefined, `${id}: ${String(failure)}`)
          assert.equal(result, launched ? 23 : 0, id)
        } else {
          assert(failure instanceof NativeRunError, `${id}: ${String(failure)}`)
          assert.equal(failure.code, expected, id)
        }
        assert.equal(world.launches.length, launched ? 1 : 0, id)
        if (launched || expected === "dry-run" || expected === "no-session" || expected === "isolation") {
          assertRunCommand(parsed!, world.lines, id)
          const generations = world.lines
            .filter((line) => line.startsWith("Generation  "))
            .map((line) => line.slice("Generation  ".length))
          assert.equal(generations.length, 1, id)
          assert(generations[0]!.startsWith(path.join(world.paths.data, "compositions") + path.sep), id)
          const manifest = await assertRunSelection(
            parsed!,
            catalog,
            generations[0]!,
            world.dependencies.environment.TRELLAGE_DEV_SOURCES!,
            id,
          )
          if (launched) await assertRunLaunch(parsed!, world, generations[0]!, manifest, id)
        }
        if (launched) {
          const stored = JSON.parse((await readOptional(history))!)
          assert.deepEqual(
            stored.global,
            {
              harness: parsed!.harness,
              profiles: parsed!.profiles,
              ...(parsed!.model === undefined ? {} : { model: parsed!.model }),
              ...(parsed!.effort === undefined ? {} : { effort: parsed!.effort }),
            },
            id,
          )
          const firstmate = parsed!.profiles.includes("firstmate")
          assert.equal(world.launches[0]!.cwd, firstmate ? world.firstmate.directory : world.work, id)
          const leases = path.join(world.paths.state, "leases")
          for (const generation of await readdir(leases))
            assert.deepEqual(await readdir(path.join(leases, generation)), [], id)
        } else assert.equal(await readOptional(history), beforeHistory, id)
        assert.deepEqual(world.unexpected, [], id)
      }
      outcomes[expected] = (outcomes[expected] ?? 0) + 1
      digest.update(`${index}\n`)
      if ((step + 1n) % 1000n === 0n)
        console.error(JSON.stringify({ executed: (step + 1n).toString(), total: sampled ? sampleCount.toString() : total.toString() }))
    }
  } finally {
    for (const world of worlds.values()) await world.close()
  }
  assert.deepEqual((await loadRunBehaviorDomain()).sourceHashes, sourceHashes, "source changed during execution")
  const report = {
    scope: "run-full-domain-lifecycle",
    complete: !sampled && start === 0n && end === total,
    ...(sampled ? { sample: { count: sampleCount.toString(), stride: stride.toString() } } : {}),
    domainHash,
    sourceHashes,
    totalCases: total.toString(),
    start: start.toString(),
    endExclusive: sampled ? total.toString() : end.toString(),
    executedCases: count.toString(),
    distinctTupleIds: count.toString(),
    idSequenceSha256: digest.digest("hex"),
    outcomes,
    limitations: [
      "Full-domain execution does not itself prove all launch argument values; adapter-specific argument assertions remain in separate scopes",
      "Process-sensitive wrapper behavior remains in separate scopes",
    ],
  }
  if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
  console.log(JSON.stringify(report, null, 2))
}
