import {
  loadProfileGuide,
  canonicalProfileRef,
  profileGuideIdentityKey,
  type LoadedProfileGuide,
  type ProfileGuideIdentity,
  type ProfileGuideV1,
} from "@trellage/guide-core"
import type { CombinedGuideCatalog, NativeGuideCatalogEntry } from "./guide-catalog.ts"

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

interface SelectedGuideSource {
  readonly identity: Extract<ProfileGuideIdentity, { readonly surface: "native" }>
  readonly guideRoot: string
  readonly projectedGuide: ProfileGuideV1
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
      }) === canonicalProfileRef(ref),
  )
  if (native !== undefined) return nativeSource(native, guideRoot)

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
