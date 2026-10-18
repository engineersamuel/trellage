import {
  loadProfileGuide,
  type LoadedProfileGuide,
  type ProfileGuideIdentity,
  type ProfileGuideV1,
} from "@trellage/guide-core"
import type { CompositionCatalog, CompositionCatalogEntry } from "./composition-catalog.ts"

import { parseCompositionRef } from "./composition-catalog.ts"
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

const nativeSource = (entry: CompositionCatalogEntry, guideRoot: string): SelectedGuideSource => {
  const profile = entry.profiles[0]
  if (entry.profiles.length !== 1 || profile === undefined || entry.guide === null) {
    throw new SelectedGuideError(`Composition does not have an authored single-profile guide: ${entry.ref}`)
  }
  return {
    identity: { surface: "native", harness: entry.harness, profile },
    guideRoot,
    projectedGuide: entry.guide,
  }
}

const findSelectedGuideSource = (
  catalog: CompositionCatalog,
  guideRoot: string,
  ref: string,
): SelectedGuideSource => {
  const parsed = parseCompositionRef(ref)
  if (parsed.profiles.includes("clean") && parsed.profiles.length !== 1) {
    throw new SelectedGuideError("clean cannot be combined with other profiles")
  }
  const components = parsed.profiles.map((profile) =>
    catalog.entries.find((entry) => entry.harness === parsed.harness && entry.profiles.length === 1 && entry.profiles[0] === profile))
  if (components.some((entry) => entry === undefined)) throw new SelectedGuideError(`Unknown composition reference: ${ref}`)
  const base = components[0]
  if (base === undefined || base.guide === null || components.slice(1).some((entry) => entry?.kind !== "config")) {
    throw new SelectedGuideError(`Composition requires an authored base profile followed by config profiles: ${ref}`)
  }
  return nativeSource(base, guideRoot)
}

const guidesMatch = (loaded: ProfileGuideV1, projected: ProfileGuideV1): boolean =>
  JSON.stringify(loaded) === JSON.stringify(projected)

const assertCurrentProjection = (loaded: LoadedProfileGuide, source: SelectedGuideSource): void => {
  if (!guidesMatch(loaded.guide, source.projectedGuide)) {
    throw new SelectedGuideError(
      `Profile guide changed after catalog collection: native:${source.identity.harness}/${source.identity.profile}`,
    )
  }
}

export const loadSelectedGuide = async (
  catalog: CompositionCatalog,
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
