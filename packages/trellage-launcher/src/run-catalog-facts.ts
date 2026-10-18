import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { canonicalNativeIdentity } from "@trellage/guide-core"
import { lifecycleRuntimes, type ResolvedNamedProfile } from "@trellage/runtime/native-run"
import { validateHeadlessCapabilitiesV1, type HeadlessCapabilitiesV1 } from "./guide-catalog.ts"

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

const profileEntries = (raw: unknown): ReadonlyArray<readonly [string, unknown]> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid catalog")
  const catalog = raw as { schemaVersion?: unknown; profiles?: unknown }
  if (catalog.schemaVersion !== 1 || catalog.profiles === null || typeof catalog.profiles !== "object")
    throw new Error("invalid profiles")
  const entries = Array.isArray(catalog.profiles)
    ? catalog.profiles.map((profile) => {
        if (profile === null || typeof profile !== "object" || typeof profile.name !== "string")
          throw new Error("invalid profile identity")
        return [profile.name, profile] as const
      })
    : Object.entries(catalog.profiles)
  const names = new Set<string>()
  for (const [name] of entries) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || names.has(name)) throw new Error("invalid profile identity")
    names.add(name)
  }
  return entries
}

const headlessEntries = (
  entries: ReadonlyArray<readonly [string, unknown]>,
  runtime: (typeof lifecycleRuntimes)[number],
): ReadonlyArray<readonly [string, HeadlessCapabilitiesV1]> =>
  entries.flatMap(([name, value]) => {
    const headless = (value as { headless?: unknown }).headless
    if (headless === null || headless === undefined) return []
    const identity = canonicalNativeIdentity(runtime.harness, name)
    return [[
      `native:${identity.launcher}/${identity.profile}`,
      validateHeadlessCapabilitiesV1(headless, `${runtime.harness}/${name}.headless`),
    ] as const]
  })

const loadLifecycleHeadless = async (
  runtime: (typeof lifecycleRuntimes)[number],
  shippedRoot: string,
  environment: NodeJS.ProcessEnv | undefined,
): Promise<ReadonlyArray<readonly [string, HeadlessCapabilitiesV1]>> => {
  const sourceFile = path.join(shippedRoot, "prototypes", runtime.packageDirectory, "catalog.json")
  const installedFile = environment?.HOME
      ? path.join(environment.HOME, ".local/share/trellage", runtime.runtimeName, "catalog.json")
      : undefined
  let raw: { schemaVersion?: unknown; profiles?: unknown } | undefined
  try {
    raw = (!environment?.TRELLAGE_TRX_NATIVE_SOURCE && installedFile ? await readJson(installedFile) : undefined) as typeof raw
    raw ??= (await readJson(sourceFile)) as typeof raw
    if (raw === undefined) return []
    return headlessEntries(profileEntries(raw), runtime)
  } catch {
    throw new Error(`invalid catalog from ${runtime.harness}`)
  }
}

const addSupplementalHeadless = async (headless: Map<string, HeadlessCapabilitiesV1>, shippedRoot: string): Promise<void> => {
  const supplemental = (await readJson(
    path.join(shippedRoot, "packages/trellage-runtime/src/native-run/headless-evidence.json"),
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
}

export const loadRunExecutionFacts = async (options: {
  readonly shippedRoot: string
  readonly environment?: NodeJS.ProcessEnv
}): Promise<RunExecutionFacts> => {
  const headless = new Map<string, HeadlessCapabilitiesV1>()
  for (const runtime of lifecycleRuntimes) {
    for (const [ref, evidence] of await loadLifecycleHeadless(runtime, options.shippedRoot, options.environment))
      headless.set(ref, evidence)
  }
  await addSupplementalHeadless(headless, options.shippedRoot)
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
