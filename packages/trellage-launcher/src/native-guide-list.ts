import { lstat } from "node:fs/promises"
import path from "node:path"
import {
  loadProfileGuideRegistry,
  profileGuideIdentityKey,
  profileGuideRelativePath,
  type ProfileGuideIdentity,
} from "../../trellage-guide-core/dist/index.js"

interface NativeProfileIdentity {
  readonly launcher: string
  readonly name: string
}

interface NativeProfileList {
  readonly schemaVersion: 1
  readonly profiles: ReadonlyArray<NativeProfileIdentity & Record<string, unknown>>
}

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

const identifier = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new Error(`${name} must be a lowercase kebab-case identifier`)
  }
  return value
}

const parseNativeProfileList = (source: string): NativeProfileList => {
  let payload: unknown
  try {
    payload = JSON.parse(source)
  } catch {
    throw new Error("native profile list must be valid JSON")
  }
  const root = record(payload, "native profile list")
  if (root.schemaVersion !== 1) throw new Error("native profile list schemaVersion must equal 1")
  if (!Array.isArray(root.profiles) || root.profiles.length === 0) {
    throw new Error("native profile list must contain profiles")
  }
  const profiles = root.profiles.map((value, index) => {
    const profile = record(value, `native profile ${index}`)
    return {
      ...profile,
      launcher: identifier(profile.launcher, `native profile ${index} launcher`),
      name: identifier(profile.name, `native profile ${index} name`),
    }
  })
  const keys = profiles.map(({ launcher, name }) => `${launcher}/${name}`)
  if (new Set(keys).size !== keys.length) throw new Error("native profile identities must be unique")
  return { schemaVersion: 1, profiles }
}

/**
 * Whether a guide file is present. The profile catalogs are installed for the
 * whole machine, but guides live in one checkout, so a profile added in another
 * checkout has no guide here. Absence must not stop the other profiles;
 * everything else about the file stays fatal in `loadProfileGuideRegistry`.
 */
const guidePresent = async (guideRoot: string, identity: ProfileGuideIdentity): Promise<boolean> => {
  try {
    await lstat(path.join(guideRoot, profileGuideRelativePath(identity)))
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
    return false
  }
}

export const enrichNativeProfileList = async (source: string, guideRoot: string): Promise<string> => {
  const parsed = parseNativeProfileList(source)
  const candidates = parsed.profiles.map((profile) => ({
    profile,
    identity: { surface: "native", launcher: profile.launcher, profile: profile.name } as const,
  }))
  const kept: Array<(typeof candidates)[number]> = []
  for (const candidate of candidates) {
    if (await guidePresent(guideRoot, candidate.identity)) kept.push(candidate)
    else {
      process.stderr.write(
        `trellage-launcher: warning: skipping ${profileGuideIdentityKey(candidate.identity)}: no guide at ` +
          `${profileGuideRelativePath(candidate.identity)} in ${guideRoot}\n`,
      )
    }
  }
  const registry = await loadProfileGuideRegistry(
    guideRoot,
    kept.map((candidate) => candidate.identity),
  )
  return JSON.stringify({
    ...parsed,
    profiles: kept.map(({ profile, identity }) => {
      const loaded = registry.get(profileGuideIdentityKey(identity))
      if (loaded === undefined) throw new Error(`profile guide registry omitted ${profileGuideIdentityKey(identity)}`)
      return { ...profile, guide: loaded.guide }
    }),
  })
}
