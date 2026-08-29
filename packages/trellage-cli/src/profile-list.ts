import type { ProfileChoice } from "./profile-discovery.js"
import type { ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import { resolveSandboxHeadlessCapabilities, type HeadlessCapabilitiesV1 } from "./headless-capabilities.js"
import type { HerdrCompatibilityEntry } from "./herdr-compatibility.js"
import type { ProfileReadiness } from "./profile-readiness.js"

export interface SimplifiedProfileList {
  readonly schemaVersion: 1
  readonly profiles: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly guide: ProfileGuideV1
    // Trellage Sandbox profiles always execute inside a locked, built Docker
    // container, so every entry is implicitly sandboxed regardless of harness.
    readonly sandbox: true
  }>
}

export interface FullProfileListEntry {
  readonly name: string
  readonly description: string
  readonly guide: ProfileGuideV1
  readonly path: string
  readonly supportedPlatforms: ReadonlyArray<string>
  readonly harness: ProfileChoice["harness"]
  readonly resolutionPolicy: "floating"
  readonly locallyResolved: boolean
  readonly releaseLockAvailable: boolean
  readonly skillBundles: ReadonlyArray<string>
  readonly skillsMode: "floating" | "locked"
  readonly finalDigestLocked: boolean
  readonly skills: ProfileChoice["skills"]
  readonly plugins: ProfileChoice["plugins"]
  readonly mcps: ProfileChoice["mcps"]
  // Trellage Sandbox profiles always execute inside a locked, built Docker
  // container, so every entry is implicitly sandboxed regardless of harness.
  readonly sandbox: true
  // Version-gated headless capability contract for the resolved container
  // runtime. Unknown or unverified harness versions fail closed.
  readonly headless: HeadlessCapabilitiesV1
  // Compatibility alias for locallyResolved.
  readonly locked: boolean
  // Hand-maintained signal from docs/herdr-compatibility.json recording
  // whether this profile has been observed to work end-to-end when driven
  // as a Herdr agent. Curated, not live-probed: defaults to "untested" when
  // no verification run has been recorded for this profile.
  readonly herdrCompatibility: HerdrCompatibilityEntry
}

export interface FullProfileList {
  readonly schemaVersion: 2
  readonly profiles: ReadonlyArray<FullProfileListEntry>
}

const singleLine = (value: string): string =>
  value
    .replace(/[\t\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const guideAt = (guides: ReadonlyArray<ProfileGuideV1>, index: number, name: string): ProfileGuideV1 => {
  const guide = guides[index]
  if (guide === undefined) throw new Error(`missing projected profile guide for ${name}`)
  return guide
}

export const toSimplifiedList = (
  choices: ReadonlyArray<ProfileChoice>,
  guides: ReadonlyArray<ProfileGuideV1>,
): SimplifiedProfileList => ({
  schemaVersion: 1,
  profiles: choices.map(({ name, description }, index) => ({
    name,
    description,
    guide: guideAt(guides, index, name),
    sandbox: true as const,
  })),
})

const untestedCompatibility: HerdrCompatibilityEntry = { status: "untested" }

export const toFullList = (
  choices: ReadonlyArray<ProfileChoice>,
  guides: ReadonlyArray<ProfileGuideV1>,
  readiness: ReadonlyArray<ProfileReadiness> = [],
  herdrCompatibility: ReadonlyArray<HerdrCompatibilityEntry> = [],
): FullProfileList => ({
  schemaVersion: 2,
  profiles: choices.map((choice, index) => {
    const entryReadiness = readiness[index] ?? {
      resolutionPolicy: "floating" as const,
      locallyResolved: false,
      releaseLockAvailable: false,
      locked: false,
      resolvedVersion: null,
    }
    return {
      name: choice.name,
      description: choice.description,
      guide: guideAt(guides, index, choice.name),
      path: choice.value,
      supportedPlatforms: choice.supported_platforms,
      harness: choice.harness,
      resolutionPolicy: choice.resolutionPolicy ?? "floating",
      locallyResolved: entryReadiness.locallyResolved,
      releaseLockAvailable: entryReadiness.releaseLockAvailable,
      skillBundles: choice.skillBundles ?? [],
      skillsMode: choice.skillsMode ?? ((choice.skillBundles?.length ?? 0) > 0 ? "floating" : "locked"),
      finalDigestLocked:
        (choice.skillsMode ?? ((choice.skillBundles?.length ?? 0) > 0 ? "floating" : "locked")) === "locked",
      skills: choice.skills,
      plugins: choice.plugins,
      mcps: choice.mcps,
      sandbox: true,
      headless: resolveSandboxHeadlessCapabilities(choice.headlessRuntime, entryReadiness.resolvedVersion),
      locked: entryReadiness.locallyResolved,
      herdrCompatibility: herdrCompatibility[index] ?? untestedCompatibility,
    }
  }),
})

export const formatProfileListHuman = (choices: ReadonlyArray<ProfileChoice>): string =>
  choices.map((choice) => `${choice.name}\t${singleLine(choice.description)}`).join("\n")
