import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { canonicalNativeIdentity } from "@trellage/guide-core"
import { lifecycleRuntimes, type ResolvedNamedProfile } from "@trellage/runtime/native-run"
import {
  validateHeadlessCapabilitiesV1,
  type HeadlessCapabilitiesV1,
} from "./guide-catalog.ts"

export interface RunExecutionFacts {
  readonly headless: ReadonlyMap<string, HeadlessCapabilitiesV1>
}
const readJson = async (file: string): Promise<unknown | undefined> => {
  const info = await lstat(file).catch((error) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!info) return undefined
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error(`Unsafe catalog data: ${file}`)
  return JSON.parse(await readFile(file, "utf8"))
}
export const loadRunExecutionFacts = async (options: {
  shippedRoot: string
  environment?: NodeJS.ProcessEnv
}): Promise<RunExecutionFacts> => {
  const headless = new Map<string, HeadlessCapabilitiesV1>()
  for (const runtime of lifecycleRuntimes) {
    const sourceFile = path.join(options.shippedRoot, "prototypes", runtime.packageDirectory, "catalog.json")
    const installedFile = options.environment?.HOME
      ? path.join(options.environment.HOME, ".local/share/trellage", runtime.runtimeName, "catalog.json")
      : undefined
    let raw: { schemaVersion?: unknown; profiles?: unknown } | undefined
    try {
      raw = (
        !options.environment?.TRELLAGE_TRX_NATIVE_SOURCE && installedFile ? await readJson(installedFile) : undefined
      ) as typeof raw
      raw ??= (await readJson(sourceFile)) as typeof raw
      if (raw === undefined) continue
      if (raw.schemaVersion !== 1 || !raw.profiles || typeof raw.profiles !== "object")
        throw new Error("invalid profiles")
      const entries = Array.isArray(raw.profiles)
        ? raw.profiles.map((profile) => [profile.name, profile] as const)
        : Object.entries(raw.profiles)
      const names = new Set<string>()
      for (const [name, profile] of entries) {
        if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || names.has(name))
          throw new Error("invalid profile identity")
        names.add(name)
        if (profile.headless !== null && profile.headless !== undefined) {
          const identity = canonicalNativeIdentity(runtime.harness, name)
          headless.set(
            `native:${identity.launcher}/${identity.profile}`,
            validateHeadlessCapabilitiesV1(profile.headless, `${runtime.harness}/${name}.headless`),
          )
        }
      }
    } catch {
      throw new Error(`invalid catalog from ${runtime.harness}`)
    }
  }
  const supplemental = (await readJson(
    path.join(options.shippedRoot, "packages/trellage-runtime/src/native-run/headless-evidence.json"),
  )) as { schemaVersion?: unknown; profiles?: unknown } | undefined
  if (supplemental !== undefined) {
    if (
      supplemental.schemaVersion !== 1 ||
      !supplemental.profiles ||
      typeof supplemental.profiles !== "object" ||
      Array.isArray(supplemental.profiles)
    )
      throw new Error("Invalid supplemental headless evidence")
    for (const [ref, evidence] of Object.entries(supplemental.profiles))
      headless.set(ref, validateHeadlessCapabilitiesV1(evidence, `${ref}.headless`))
  }
  return { headless }
}
export const profileExecutionFacts = (profile: ResolvedNamedProfile, facts: RunExecutionFacts) => {
  const verifiedDefinition =
    profile.origin === "shipped" &&
    (profile.definitionKey === `preset-${profile.harness}-${profile.name}` || profile.definitionKey === "firstmate")
  return {
    headless: verifiedDefinition ? (facts.headless.get(profile.ref) ?? null) : null,
    herdrCompatibility: { status: "untested" as const },
  }
}
