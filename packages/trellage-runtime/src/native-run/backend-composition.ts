import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { ensureNativeConfig, withBuiltinPreset } from "./config-init.ts"
import { readTrellageConfig } from "../native-config.ts"
import { planComposition, publishGeneration } from "./compose.ts"
import { resolveNativeRunPaths } from "./paths.ts"
import { createSourceResolver, gitSourceTransport, type SourceTransport } from "./source.ts"
import { nativeHarness } from "./registry.ts"

export const prepareBackendComposition = async (
  harness: string,
  args: ReadonlyArray<string>,
  environment = process.env,
  transport: SourceTransport = gitSourceTransport(),
) => {
  const entry = nativeHarness(harness)!
  const profiles: string[] = []
  const forwarded: string[] = []
  let options = false
  let separator = false
  let noAlways = false
  let dryRun = false
  let interactive = false
  let nativeAuth = false
  for (const arg of args) {
    if (separator) {
      forwarded.push(arg)
      continue
    }
    if (arg === "--") {
      options = true
      separator = true
      continue
    }
    if (!options && arg === "--native-auth" && harness === "codex") {
      nativeAuth = true
      continue
    }
    if (!options && arg === "--interactive" && harness === "copilot") {
      interactive = true
      continue
    }
    if (arg === "--no-always") {
      noAlways = true
      continue
    }
    if (arg === "--require-proven-isolation")
      throw new Error(`${harness} configuration isolation is not proven; remove --require-proven-isolation to launch`)
    if (arg === "--allow-unproven-isolation" || arg === "--allow-unproven") continue
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }
    if (arg.startsWith("-")) options = true
    if (options) forwarded.push(arg)
    else profiles.push(arg)
  }
  const presets = profiles.filter((profile) => Object.hasOwn(entry.presets, profile))
  if (presets.length !== 1)
    throw new Error(`select exactly one ${harness} launch preset; received ${presets.join(", ") || "none"}`)
  const preset = presets[0]!
  const selected = profiles.map((profile) => (profile === preset ? `preset-${harness}-${profile}` : profile))
  await ensureNativeConfig({ environment, ...(environment.HOME ? { home: environment.HOME } : {}) })
  const loaded = await readTrellageConfig({ environment })
  const catalog = await withBuiltinPreset(loaded.config.native, `preset-${harness}-${preset}`)
  const instructionTexts: Record<string, string> = {}
  for (const [name, instruction] of Object.entries(catalog.instructions)) {
    instructionTexts[name] = await readFile(path.resolve(path.dirname(loaded.path), instruction.file), "utf8")
  }
  const paths = resolveNativeRunPaths({ environment, ...(environment.HOME ? { home: environment.HOME } : {}) })
  const resolver = createSourceResolver({ paths, transport })
  const plan = await planComposition(
    {
      harness,
      profiles: selected,
      catalog,
      instructionTexts,
      skipAlways: noAlways,
      adapterPolicy: "private-native-backend-v1",
      providerPolicy: `${harness}:${entry.presets[preset]}`,
    },
    { resolver },
  )
  const layout = await publishGeneration({
    paths,
    plan,
    skillsSubdirectory: "skills",
    instructionsFile: "instructions.md",
    writeAdapterFiles: async (stage) => {
      await mkdir(path.join(stage, "skills"), { recursive: true })
      await mkdir(path.join(stage, ".empty", "skills"), { recursive: true })
      await writeFile(path.join(stage, ".trellage-composition-snapshot"), "1\n")
      await writeFile(path.join(stage, ".empty", ".trellage-composition-snapshot"), "1\n")
      await writeFile(path.join(stage, ".empty", "managed-skills.txt"), "")
      await writeFile(path.join(stage, ".empty", "always-on.md"), "")
      await writeFile(path.join(stage, "managed-skills.txt"), plan.skills.map((skill) => skill.name).join("\n") + "\n")
      await writeFile(
        path.join(stage, "always-on.md"),
        [
          ...plan.instructions.map((instruction) => instruction.text),
          ...plan.skills
            .filter((skill) => skill.alwaysOn && !skill.manualOnly)
            .map((skill) => `Read and apply skills/${skill.name}/SKILL.md.`),
        ].join("\n\n"),
      )
    },
  })
  for (const source of plan.sources) await resolver.markGood(source)
  return { preset, profiles, forwarded, dryRun, interactive, nativeAuth, plan, layout, paths }
}
