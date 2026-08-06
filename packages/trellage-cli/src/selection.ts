import path from "node:path"

import { Data, Effect } from "effect"

export class ProfileSelectionError extends Data.TaggedError("ProfileSelectionError")<{
  readonly message: string
}> {}

export interface ProfileSelection {
  readonly explicit?: string
  readonly environment?: string
  readonly cwd: string
  readonly worktree: string
  readonly home: string
  readonly bundled: string
  readonly profiles: string
  readonly exists: (candidate: string) => Effect.Effect<boolean, never>
}

const fromCwd = (cwd: string, candidate: string): string =>
  path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd, candidate)

const isProfileName = (candidate: string): boolean =>
  !path.isAbsolute(candidate) && !candidate.endsWith(".toml") && !candidate.includes("/") && !candidate.includes("\\")

const resolveRequestedProfile = (
  selection: ProfileSelection,
  requested: string,
): Effect.Effect<string, ProfileSelectionError> =>
  Effect.gen(function* () {
    if (/^https:\/\/github\.com\//.test(requested)) return requested
    if (!isProfileName(requested)) return fromCwd(selection.cwd, requested)
    const worktreeCandidate = path.join(selection.worktree, "profiles", requested, "profile.toml")
    if (yield* selection.exists(worktreeCandidate)) return worktreeCandidate
    const bundledCandidate = path.join(selection.profiles, requested, "profile.toml")
    if (bundledCandidate !== worktreeCandidate && (yield* selection.exists(bundledCandidate))) return bundledCandidate
    const searched =
      bundledCandidate === worktreeCandidate ? worktreeCandidate : `${worktreeCandidate}, ${bundledCandidate}`
    return yield* Effect.fail(
      new ProfileSelectionError({
        message: `profile "${requested}" not found; searched: ${searched}`,
      }),
    )
  })

export const selectProfilePath = (selection: ProfileSelection): Effect.Effect<string, ProfileSelectionError> =>
  Effect.gen(function* () {
    if (selection.explicit) return yield* resolveRequestedProfile(selection, selection.explicit)
    if (selection.environment) return yield* resolveRequestedProfile(selection, selection.environment)
    const worktreeProfile = path.join(selection.worktree, ".harness.toml")
    if (yield* selection.exists(worktreeProfile)) return worktreeProfile
    const userProfile = path.join(selection.home, ".config", "harness", "profile.toml")
    if (yield* selection.exists(userProfile)) return userProfile
    return path.resolve(selection.bundled)
  })
