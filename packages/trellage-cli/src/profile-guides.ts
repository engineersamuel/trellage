import path from "node:path"

import { Effect } from "effect"

import { loadProfileGuide, type ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import type { ProfileChoice } from "./profile-discovery.js"

export class ProfileGuideError extends Error {
  readonly cause: unknown

  constructor(message: string, cause: unknown) {
    super(message)
    this.name = "ProfileGuideError"
    this.cause = cause
  }
}

export const loadSandboxProfileGuides = (
  repositoryRoot: string,
  choices: ReadonlyArray<ProfileChoice>,
): Effect.Effect<ReadonlyArray<ProfileGuideV1>, ProfileGuideError> =>
  Effect.tryPromise({
    try: async () => {
      const bundledProfiles = path.join(repositoryRoot, "profiles")
      return Promise.all(
        choices.map(async (choice) => {
          const relativeToBundled = path.relative(bundledProfiles, choice.value)
          const bundled =
            relativeToBundled !== "" &&
            relativeToBundled !== ".." &&
            !relativeToBundled.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relativeToBundled)
          const profileRoot = path.dirname(path.dirname(choice.value))
          const owningRoot = bundled ? repositoryRoot : path.dirname(profileRoot)
          try {
            const loaded = await loadProfileGuide(path.join(owningRoot, "profile-guides"), {
              surface: "sandbox",
              profile: choice.name,
            })
            return loaded.guide
          } catch (cause) {
            throw new Error(`sandbox:${choice.name}: ${cause instanceof Error ? cause.message : String(cause)}`, {
              cause,
            })
          }
        }),
      )
    },
    catch: (cause) =>
      new ProfileGuideError(
        `could not load Sandbox profile guides: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      ),
  })
