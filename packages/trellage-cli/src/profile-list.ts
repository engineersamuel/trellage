import type { ProfileChoice } from "./profile-discovery.js"
import type { HerdrCompatibilityEntry } from "./herdr-compatibility.js"

export interface SimplifiedProfileList {
  readonly schemaVersion: 1
  readonly profiles: ReadonlyArray<{
    readonly name: string
    readonly description: string
    // Trellage Sandbox profiles always execute inside a locked, built Docker
    // container, so every entry is implicitly sandboxed regardless of harness.
    readonly sandbox: true
  }>
}

export interface FullProfileListEntry {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly supportedPlatforms: ReadonlyArray<string>
  readonly harness: ProfileChoice["harness"]
  readonly skills: ProfileChoice["skills"]
  readonly plugins: ProfileChoice["plugins"]
  readonly mcps: ProfileChoice["mcps"]
  // Trellage Sandbox profiles always execute inside a locked, built Docker
  // container, so every entry is implicitly sandboxed regardless of harness.
  readonly sandbox: true
  // Whether this profile currently has a valid, up-to-date lock for a
  // production platform (i.e. `trellage build --locked` can reuse an image
  // instead of re-resolving sources). Computed from the profile document and
  // its adjacent lock file only; it does not check whether the image has
  // actually been built/pushed anywhere.
  readonly locked: boolean
  // Hand-maintained signal from docs/herdr-compatibility.json recording
  // whether this profile has been observed to work end-to-end when driven
  // as a Herdr agent. Curated, not live-probed: defaults to "untested" when
  // no verification run has been recorded for this profile.
  readonly herdrCompatibility: HerdrCompatibilityEntry
}

export interface FullProfileList {
  readonly schemaVersion: 1
  readonly profiles: ReadonlyArray<FullProfileListEntry>
}

const singleLine = (value: string): string =>
  value
    .replace(/[\t\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

export const toSimplifiedList = (choices: ReadonlyArray<ProfileChoice>): SimplifiedProfileList => ({
  schemaVersion: 1,
  profiles: choices.map(({ name, description }) => ({ name, description, sandbox: true as const })),
})

const untestedCompatibility: HerdrCompatibilityEntry = { status: "untested" }

export const toFullList = (
  choices: ReadonlyArray<ProfileChoice>,
  locked: ReadonlyArray<boolean> = [],
  herdrCompatibility: ReadonlyArray<HerdrCompatibilityEntry> = [],
): FullProfileList => ({
  schemaVersion: 1,
  profiles: choices.map((choice, index) => ({
    name: choice.name,
    description: choice.description,
    path: choice.value,
    supportedPlatforms: choice.supported_platforms,
    harness: choice.harness,
    skills: choice.skills,
    plugins: choice.plugins,
    mcps: choice.mcps,
    sandbox: true,
    locked: locked[index] ?? false,
    herdrCompatibility: herdrCompatibility[index] ?? untestedCompatibility,
  })),
})

export const formatProfileListHuman = (choices: ReadonlyArray<ProfileChoice>): string =>
  choices.map((choice) => `${choice.name}\t${singleLine(choice.description)}`).join("\n")
