import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse, stringify } from "smol-toml"
import { readTrellageConfig, type NativeCatalog, type TrellageConfigLocation } from "../native-config.ts"

const starterPath = fileURLToPath(new URL("../../../../config.toml", import.meta.url))

/** Add only the selected missing preset; existing user policy and pins remain authoritative. */
export const withBuiltinPreset = async (catalog: NativeCatalog, preset: string): Promise<NativeCatalog> => {
  if (Object.hasOwn(catalog.profiles, preset)) return catalog
  const starter = await readTrellageConfig({ environment: { TRELLAGE_CONFIG: starterPath } })
  const builtin = starter.config.native
  const profile = builtin.profiles[preset]
  if (!profile) throw new Error(`missing shipped launch preset: ${preset}`)
  const sources = { ...catalog.sources }
  for (const { source } of [...profile.skills, ...profile.plugins]) {
    const shipped = builtin.sources[source]!
    const existing = sources[source]
    if (existing && existing.repository !== shipped.repository)
      throw new Error(
        `source ${source} conflicts with shipped preset ${preset}: expected ${shipped.repository}, found ${existing.repository}; rename your source or explicitly define native.profiles.${preset}`,
      )
    sources[source] = existing ?? shipped
  }
  const instructions = { ...catalog.instructions }
  for (const name of profile.instructions) {
    if (instructions[name])
      throw new Error(
        `instruction ${name} conflicts with shipped preset ${preset}; rename it or explicitly define native.profiles.${preset}`,
      )
    instructions[name] = { file: path.resolve(path.dirname(starterPath), builtin.instructions[name]!.file) }
  }
  return { sources, instructions, profiles: { ...catalog.profiles, [preset]: profile } }
}

/** Seed defaults once; explicitly selected files always remain entirely user managed. */
export const ensureNativeConfig = async (
  location: TrellageConfigLocation & { readonly starter?: string } = {},
): Promise<string> => {
  const environment = location.environment ?? process.env
  const home = location.home ?? environment.HOME ?? os.homedir()
  const loaded = await readTrellageConfig({ ...location, environment, home })
  if (environment.TRELLAGE_CONFIG) return loaded.path
  if (loaded.present && Object.keys(loaded.config.native.profiles).length > 0) return loaded.path
  const starter = await readFile(location.starter ?? starterPath, "utf8")
  await mkdir(path.dirname(loaded.path), { recursive: true, mode: 0o700 })
  const lock = `${loaded.path}.initialize-lock`
  try {
    await mkdir(lock, { mode: 0o700 })
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(`configuration initialization is already running: ${loaded.path}`)
    throw error
  }
  const temporary = `${loaded.path}.initialize-${process.pid}`
  try {
    const current = await readFile(loaded.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (current === undefined) {
      await writeFile(loaded.path, starter, { flag: "wx", mode: 0o600 })
      return loaded.path
    }
    const parsed = parse(current)
    // Existing custom native settings are authoritative, including intentionally empty profiles.
    if (parsed.native !== undefined) return loaded.path
    const defaults = parse(starter)
    const additions: Record<string, unknown> = { native: defaults.native }
    if (parsed.skills === undefined && defaults.skills !== undefined) additions.skills = defaults.skills
    const text = `${current}\n# Native profile defaults added by trx.\n${stringify(additions)}`
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 })
    await readTrellageConfig({ environment: { ...environment, TRELLAGE_CONFIG: temporary }, home })
    if ((await readFile(loaded.path, "utf8")) !== current)
      throw new Error("configuration changed during initialization; retry")
    await rename(temporary, loaded.path)
    return loaded.path
  } finally {
    await rm(temporary, { force: true })
    await rm(lock, { recursive: true })
  }
}
