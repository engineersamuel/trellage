import path from "node:path"
import {
  loadProfileGuide,
  profileGuideIdentityKey,
  type LoadedProfileGuide,
  type ProfileGuideIdentity,
  type ProfileGuideV1,
} from "../../trellage-guide-core/dist/index.js"
import type { CombinedGuideCatalog, NativeGuideCatalogEntry, SandboxGuideCatalogEntry } from "./guide-catalog.js"

const controls = /[\u0000-\u001f\u007f-\u009f]/u

export class SelectedGuideError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "SelectedGuideError"
  }
}

export interface SelectedGuideDocument {
  readonly ref: string
  readonly guide: ProfileGuideV1
  readonly body: string
}

type SelectedGuideSource =
  | {
      readonly identity: Extract<ProfileGuideIdentity, { readonly surface: "native" }>
      readonly guideRoot: string
      readonly projectedGuide: ProfileGuideV1
    }
  | {
      readonly identity: Extract<ProfileGuideIdentity, { readonly surface: "sandbox" }>
      readonly guideRoot: string
      readonly projectedGuide: ProfileGuideV1
    }

export const sandboxGuideRootFromProfilePath = (profilePath: string, profile: string): string => {
  if (!path.isAbsolute(profilePath) || controls.test(profilePath)) {
    throw new SelectedGuideError("Sandbox profile path must be an absolute path without control characters")
  }
  const profileDirectory = path.dirname(profilePath)
  const profilesDirectory = path.dirname(profileDirectory)
  if (
    path.basename(profilePath) !== "profile.toml" ||
    path.basename(profileDirectory) !== profile ||
    path.basename(profilesDirectory) !== "profiles"
  ) {
    throw new SelectedGuideError(`Sandbox profile path does not match profiles/${profile}/profile.toml`)
  }
  return path.join(path.dirname(profilesDirectory), "profile-guides")
}

const nativeSource = (entry: NativeGuideCatalogEntry, guideRoot: string): SelectedGuideSource => ({
  identity: {
    surface: "native",
    launcher: entry.launcher,
    profile: entry.name,
  },
  guideRoot,
  projectedGuide: entry.guide,
})

const sandboxSource = (entry: SandboxGuideCatalogEntry): SelectedGuideSource => ({
  identity: {
    surface: "sandbox",
    profile: entry.name,
  },
  guideRoot: sandboxGuideRootFromProfilePath(entry.path, entry.name),
  projectedGuide: entry.guide,
})

const findSelectedGuideSource = (
  catalog: CombinedGuideCatalog,
  guideRoot: string,
  ref: string,
): SelectedGuideSource => {
  const native = catalog.native.find(
    (entry) =>
      profileGuideIdentityKey({
        surface: "native",
        launcher: entry.launcher,
        profile: entry.name,
      }) === ref,
  )
  if (native !== undefined) return nativeSource(native, guideRoot)

  const sandbox = catalog.sandbox.find(
    (entry) => profileGuideIdentityKey({ surface: "sandbox", profile: entry.name }) === ref,
  )
  if (sandbox !== undefined) return sandboxSource(sandbox)
  throw new SelectedGuideError(`Unknown profile reference: ${ref}`)
}

const guidesMatch = (loaded: ProfileGuideV1, projected: ProfileGuideV1): boolean =>
  JSON.stringify(loaded) === JSON.stringify(projected)

const assertCurrentProjection = (loaded: LoadedProfileGuide, source: SelectedGuideSource): void => {
  if (!guidesMatch(loaded.guide, source.projectedGuide)) {
    throw new SelectedGuideError(
      `Profile guide changed after catalog collection: ${profileGuideIdentityKey(source.identity)}`,
    )
  }
}

export const loadSelectedGuide = async (
  catalog: CombinedGuideCatalog,
  guideRoot: string,
  ref: string,
): Promise<SelectedGuideDocument> => {
  const source = findSelectedGuideSource(catalog, guideRoot, ref)
  let loaded: LoadedProfileGuide
  try {
    loaded = await loadProfileGuide(source.guideRoot, source.identity)
  } catch (cause) {
    throw new SelectedGuideError(`Failed to load selected profile guide: ${ref}`, { cause })
  }
  assertCurrentProjection(loaded, source)
  return {
    ref,
    guide: loaded.guide,
    body: loaded.body,
  }
}
