import type { NativeCatalog, NativeProfile } from "../native-config.ts"
import { adapters } from "./adapters.ts"
import { nativePresetProfile, nativePresetProfiles, nativeSharedPresets } from "./presets.ts"
import { NativeRunError } from "./paths.ts"
import type { EffectiveRunConfig } from "./catalog-config.ts"
import { mergeBuiltinPreset } from "./config-init.ts"

export interface ResolvedNamedProfile {
  readonly harness: string
  readonly name: string
  readonly ref: string
  readonly definitionKey: string
  readonly definition: NativeProfile
  readonly catalog: NativeCatalog
  readonly resolutionProblem?: string
  readonly origin: "local" | "shipped" | "clean"
  readonly alwaysProfiles: ReadonlyArray<NativeProfile>
}

export const resolveProfileKey = (catalog: NativeCatalog, harness: string, name: string): string =>
  Object.hasOwn(catalog.profiles, name) ? name : (nativePresetProfile(harness, name) ?? name)

export const resolveNamedRunProfile = (
  catalog: NativeCatalog,
  shipped: NativeCatalog,
  harness: string,
  name: string,
  shippedRoot = ".",
): ResolvedNamedProfile => {
  const adapter = adapters[harness]
  if (!adapter) throw new NativeRunError("unsupported", `unknown harness: ${harness}`)
  const key = resolveProfileKey(catalog, harness, name)
  const clean = name === "clean"
  if (clean && !adapter.clean.supported) throw new NativeRunError("unsupported", `${harness} does not support clean`)
  const builtin = key.startsWith(`preset-${harness}-`) || nativeSharedPresets.includes(key)
  const definition = clean
    ? { always: false, instructions: [], skills: [], plugins: [], ...shipped.profiles[`preset-${harness}-clean`] }
    : (catalog.profiles[key] ?? (builtin ? shipped.profiles[key] : undefined))
  if (!definition) throw new NativeRunError("unknown-profile", `unknown profile: ${harness}/${name}`)
  if (definition.harnesses && !definition.harnesses.includes(harness))
    throw new NativeRunError("unsupported", `${name} does not support ${harness}`)
  let resolvedCatalog = catalog,
    resolutionProblem: string | undefined
  if (!clean && builtin && !catalog.profiles[key]) {
    try {
      resolvedCatalog = mergeBuiltinPreset(catalog, shipped, key, shippedRoot)
    } catch (error) {
      resolutionProblem = error instanceof Error ? error.message : "Could not resolve the preset"
    }
  }
  return {
    harness,
    name,
    ref: `native:${harness}/${name}`,
    definitionKey: key,
    definition,
    catalog: resolvedCatalog,
    ...(resolutionProblem === undefined ? {} : { resolutionProblem }),
    origin: clean ? "clean" : catalog.profiles[key] ? "local" : "shipped",
    alwaysProfiles: clean
      ? []
      : Object.values(catalog.profiles).filter(
          (profile) => profile.always && (!profile.harnesses || profile.harnesses.includes(harness)),
        ),
  }
}

export const enumerateNamedRunProfiles = (config: EffectiveRunConfig): ReadonlyArray<ResolvedNamedProfile> => {
  const result: ResolvedNamedProfile[] = []
  const privateKeys = new Set(
    Object.keys(adapters).flatMap((harness) =>
      [...nativePresetProfiles(harness), "clean"].map((name) => `preset-${harness}-${name}`),
    ),
  )
  for (const harness of Object.keys(adapters).sort()) {
    const names = new Set([
      ...nativePresetProfiles(harness),
      ...nativeSharedPresets,
      ...Object.entries(config.catalog.profiles)
        .filter(([id, profile]) => !profile.always && !privateKeys.has(id))
        .map(([id]) => id),
      ...(adapters[harness]!.clean.supported ? ["clean"] : []),
    ])
    for (const name of [...names].sort()) {
      try {
        const resolved = resolveNamedRunProfile(config.catalog, config.shipped, harness, name, config.shippedRoot)
        if (config.seeded && resolved.origin === "local") result.push({ ...resolved, origin: "shipped" })
        else result.push(resolved)
      } catch (error) {
        if (!(error instanceof NativeRunError) || !["unsupported", "unknown-profile"].includes(error.code)) throw error
      }
    }
  }
  return result
}
