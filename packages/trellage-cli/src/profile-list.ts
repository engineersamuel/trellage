import type { ProfileChoice } from "./profile-discovery.js"

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

export const toFullList = (choices: ReadonlyArray<ProfileChoice>): FullProfileList => ({
  schemaVersion: 1,
  profiles: choices.map((choice) => ({
    name: choice.name,
    description: choice.description,
    path: choice.value,
    supportedPlatforms: choice.supported_platforms,
    harness: choice.harness,
    skills: choice.skills,
    plugins: choice.plugins,
    mcps: choice.mcps,
    sandbox: true,
  })),
})

export const formatProfileListHuman = (choices: ReadonlyArray<ProfileChoice>): string =>
  choices.map((choice) => `${choice.name}\t${singleLine(choice.description)}`).join("\n")
