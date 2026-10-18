import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readTrellageConfig } from "@trellage/runtime/native-config"
import {
  adapters,
  nativeHarnessPresets,
  nativeSharedPresets,
  NativeRunError,
  parseRunArguments,
  prepareRun,
} from "@trellage/runtime/native-run"
import { createCleanRunWorld } from "./exhaustive-clean-run-world.ts"

// Preparation is a separate scope: launch, discovery, updates, and model execution are forbidden.
const root = fileURLToPath(new URL("../", import.meta.url))
const configPath = path.join(root, "config.toml")
assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "use scripts/test-offline.sh --native-sources")
assert.ok(process.env.TRELLAGE_DEV_SOURCES, "local source mappings are required")
const {
  config: { native: catalog },
} = await readTrellageConfig({ environment: { TRELLAGE_CONFIG: configPath } })
const harnesses = Object.keys(adapters).sort()
const profileNames = [
  ...new Set([
    ...Object.keys(catalog.profiles),
    ...Object.values(nativeHarnessPresets).flat(),
    ...nativeSharedPresets,
    "fixture-unknown-profile",
  ]),
].sort()
const profiles: (string | null)[] = [null, ...profileNames]
const requested = process.argv.slice(2)
assert.ok(
  requested.length === 0 ||
    (requested.length === 2 && requested[0] === "--harness" && harnesses.includes(requested[1]!)),
  "usage: exhaustive-run-composition.ts [--harness NAME]",
)
const selectedHarnesses = requested.length ? [requested[1]!] : harnesses
const sources = new Map(
  process.env.TRELLAGE_DEV_SOURCES.split(/\s+/).map((mapping) => {
    const separator = mapping.indexOf("=")
    return [mapping.slice(0, separator), mapping.slice(separator + 1)]
  }),
)
const sourceHashes: Record<string, string> = {}
const hashFile = async (relative: string) => {
  sourceHashes[relative] = createHash("sha256")
    .update(await readFile(path.join(root, relative)))
    .digest("hex")
}
for (const relative of [
  "config.toml",
  "scripts/exhaustive-run-composition.ts",
  "scripts/exhaustive-clean-run-world.ts",
  "tests/helpers/native-source-fixtures.ts",
  "packages/trellage-runtime/src/native-config.ts",
])
  await hashFile(relative)
const hashTree = async (relative: string): Promise<void> => {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name)
    if (entry.isDirectory()) await hashTree(child)
    else if (entry.isFile()) await hashFile(child)
  }
}
await hashTree("packages/trellage-runtime/src/native-run")
const results: { id: string; outcome: string }[] = []
for (const harness of selectedHarnesses) {
  // Source snapshots and generated files persist across cases, as on repeated developer runs.
  const world = await createCleanRunWorld()
  const environment = {
    ...world.dependencies.environment,
    TRELLAGE_CONFIG: configPath,
    TRELLAGE_DEV_SOURCES: process.env.TRELLAGE_DEV_SOURCES,
  }
  try {
    for (const profile of profiles)
      for (const noAlways of [false, true])
        for (const plan of [false, true]) {
          const id = JSON.stringify([harness, profile, noAlways, plan])
          const alias = profile === null ? undefined : `preset-${harness}-${profile}`
          const resolved =
            profile === null
              ? []
              : [
                  Object.hasOwn(catalog.profiles, profile)
                    ? profile
                    : Object.hasOwn(catalog.profiles, alias!)
                      ? alias!
                      : profile,
                ]
          const declaration = resolved.length ? catalog.profiles[resolved[0]!] : undefined
          const rejection =
            profile !== null && !declaration
              ? "unknown-profile"
              : declaration?.harnesses && !declaration.harnesses.includes(harness)
                ? "unsupported"
                : undefined
          const options = parseRunArguments([
            harness,
            ...(profile === null ? [] : [profile]),
            "--dry-run",
            ...(noAlways ? ["--no-always"] : []),
            ...(plan ? ["--plan"] : []),
          ])
          let prepared
          try {
            prepared = await prepareRun(options, { ...world.dependencies, environment })
          } catch (error) {
            assert.ok(error instanceof NativeRunError, `${id}: ${String(error)}`)
            assert.equal(error.code, rejection, `${id}: ${error.message}`)
            results.push({ id, outcome: error.code })
            continue
          }
          assert.equal(rejection, undefined, `${id}: unexpectedly accepted`)
          const always = noAlways
            ? []
            : Object.entries(catalog.profiles)
                .filter(([, value]) => value.always && (!value.harnesses || value.harnesses.includes(harness)))
                .map(([name]) => name)
                .sort()
          const effective = [...new Set([...resolved, ...always])].sort()
          const skills = new Set<string>()
          const plugins = new Set<string>()
          const instructions = new Set<string>()
          for (const name of effective) {
            const value = catalog.profiles[name]!
            for (const instruction of value.instructions) instructions.add(instruction)
            for (const selection of value.skills) {
              const source = catalog.sources[selection.source]!
              const names = selection.names.includes("*")
                ? (
                    await readdir(path.join(sources.get(`https://github.com/${source.repository}.git`)!, "skills"))
                  ).filter((name) => !source.exclude?.includes(name))
                : selection.names
              for (const name of names) {
                skills.add(name)
                if (source.alwaysOn && name !== "i-have-adhd") instructions.add(`skill-${name}`)
              }
            }
            for (const selection of value.plugins)
              if (selection.harness === harness)
                plugins.add(
                  selection.name ??
                    path.basename(selection.path === "." ? selection.source : selection.path).toLowerCase(),
                )
          }
          assert.deepEqual(prepared.plan.profiles, resolved, id)
          assert.deepEqual(prepared.plan.alwaysProfiles, always, id)
          assert.deepEqual(prepared.plan.skills.map((skill) => skill.name).sort(), [...skills].sort(), id)
          assert.deepEqual(prepared.plan.plugins.map((plugin) => plugin.name).sort(), [...plugins].sort(), id)
          assert.deepEqual(
            prepared.plan.instructions.map((instruction) => instruction.id).sort(),
            [...instructions].sort(),
            id,
          )
          const manifest = JSON.parse(
            await readFile(path.join(prepared.layout.generationPath, "manifest.json"), "utf8"),
          )
          assert.equal(manifest.harness, harness, id)
          assert.deepEqual(manifest.profiles, resolved, id)
          assert.deepEqual(manifest.alwaysProfiles, always, id)
          assert.deepEqual(manifest.skills.map((skill: { name: string }) => skill.name).sort(), [...skills].sort(), id)
          for (const skill of prepared.plan.skills)
            if (skill.name === "i-have-adhd") {
              assert.equal(skill.manualOnly, true, id)
              assert.notEqual(skill.alwaysOn, true, id)
            }
          results.push({ id, outcome: "prepared" })
        }
    assert.deepEqual(world.unexpected, [])
    assert.deepEqual(world.launches, [])
    assert.deepEqual(await world.discoveries(), [])
    process.stderr.write(`Verified preparation: ${harness}\n`)
  } finally {
    await world.close()
  }
}
const expected = selectedHarnesses.length * profiles.length * 2 * 2
assert.equal(results.length, expected)
assert.equal(new Set(results.map((result) => result.id)).size, expected)
console.log(
  JSON.stringify(
    {
      schema: 1,
      scope: "run-composition-preparation",
      domains: { harnesses, profiles, noAlways: [false, true], plan: [false, true] },
      selectedHarnesses,
      expected,
      executed: results.length,
      fullProduct: harnesses.length * profiles.length * 4,
      limitations: [
        "Single selected profile or omission; no profile stacks",
        "dryRun only; remaining options and launch behavior are outside this scope",
      ],
      sourceHashes,
      results,
    },
    null,
    2,
  ),
)
