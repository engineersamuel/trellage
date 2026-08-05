import { Data, Effect } from "effect"

export const platforms = ["linux/arm64", "linux/amd64"] as const
export type Platform = (typeof platforms)[number]

export class PlatformError extends Data.TaggedError("PlatformError")<{ readonly message: string }> {}

export const productionPlatforms = ["linux/arm64"] as const satisfies ReadonlyArray<Platform>

export const assertProductionPlatform = (platform: Platform): Effect.Effect<"linux/arm64", PlatformError> =>
  platform === "linux/arm64"
    ? Effect.succeed(platform)
    : Effect.fail(new PlatformError({ message: `production artifacts are unavailable for ${platform}` }))

export const parseDockerPlatform = (value: string): Effect.Effect<Platform, PlatformError> => {
  const normalized = value.trim().replace("linux/aarch64", "linux/arm64").replace("linux/x86_64", "linux/amd64")
  return normalized === "linux/arm64" || normalized === "linux/amd64"
    ? Effect.succeed(normalized)
    : Effect.fail(new PlatformError({ message: `unsupported Docker server platform: ${value.trim() || "unknown"}` }))
}

export const platformLockPath = (profilePath: string, platform: Platform): string => {
  const extension = profilePath.endsWith(".toml") ? ".toml" : ""
  const stem = extension === "" ? profilePath : profilePath.slice(0, -extension.length)
  return `${stem}.${platform.replace("/", "-")}.lock.toml`
}

export const platformIdentity = (platform: Platform): string => platform.replace("/", "-")
