import { lstat, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Data, Effect } from "effect"
import { expandTrellagePath, loadTrellageConfig } from "@trellage/runtime/native-config"

export interface EnvironmentMetadata {
  readonly config_path: string
  readonly config_present: boolean
  readonly provider: "varlock"
  readonly enabled: boolean
  readonly path: string
  readonly source_present: boolean
  readonly required: boolean
  readonly strict_permissions: boolean
}

export class EnvironmentConfigError extends Data.TaggedError("EnvironmentConfigError")<{
  readonly message: string
}> {}

const fail = (message: string): Effect.Effect<never, EnvironmentConfigError> =>
  Effect.fail(new EnvironmentConfigError({ message }))

const isMissing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT"

const isEnvironmentFile = (name: string): boolean => name === ".env" || name.startsWith(".env.")

const isSchemaOnlyFile = (name: string): boolean =>
  [".env.schema", ".env.example", ".env.sample", ".env.template"].includes(name)

const assertSafePath = (
  candidate: string,
  label: string,
  strictPermissions: boolean,
  allowPublicRead: boolean,
): Effect.Effect<void, EnvironmentConfigError> =>
  Effect.tryPromise({
    try: async () => {
      const stats = await lstat(candidate)
      if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${candidate}`)
      if (!stats.isFile() && !stats.isDirectory()) throw new Error(`${label} is not a file or directory: ${candidate}`)
      if ((stats.mode & 0o022) !== 0) {
        throw new Error(`${label} must not be writable by group or other users: ${candidate}`)
      }
      if (strictPermissions && !allowPublicRead && (stats.mode & 0o077) !== 0) {
        throw new Error(`${label} must not be accessible by group or other users: ${candidate}`)
      }
    },
    catch: (cause) =>
      new EnvironmentConfigError({
        message: cause instanceof Error ? cause.message : `cannot inspect ${label}: ${candidate}`,
      }),
  })

const inspectEnvironmentSource = (
  candidate: string,
  required: boolean,
  strictPermissions: boolean,
): Effect.Effect<boolean, EnvironmentConfigError> =>
  Effect.gen(function* () {
    const stats = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await lstat(candidate)
        } catch (cause) {
          if (isMissing(cause)) return undefined
          throw cause
        }
      },
      catch: () => new EnvironmentConfigError({ message: `cannot inspect Varlock environment path: ${candidate}` }),
    })
    if (stats === undefined) {
      if (required) return yield* fail(`required Varlock environment path does not exist: ${candidate}`)
      return false
    }

    if (stats.isFile()) {
      yield* assertSafePath(
        candidate,
        "Varlock environment file",
        strictPermissions,
        isSchemaOnlyFile(path.basename(candidate)),
      )
      return true
    }
    yield* assertSafePath(candidate, "Varlock environment directory", strictPermissions, false)

    const entries = yield* Effect.tryPromise({
      try: () => readdir(candidate, { withFileTypes: true }),
      catch: () => new EnvironmentConfigError({ message: `cannot read Varlock environment directory: ${candidate}` }),
    })
    const environmentFiles = entries.filter((entry) => isEnvironmentFile(entry.name))
    if (environmentFiles.length === 0) {
      if (required) return yield* fail(`required Varlock environment directory has no .env files: ${candidate}`)
      return false
    }
    for (const entry of environmentFiles) {
      if (!entry.isFile())
        return yield* fail(`Varlock environment entry must be a regular file: ${path.join(candidate, entry.name)}`)
      yield* assertSafePath(
        path.join(candidate, entry.name),
        "Varlock environment file",
        strictPermissions,
        isSchemaOnlyFile(entry.name),
      )
    }
    return true
  })

export const environmentMetadata = (
  environment: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Effect.Effect<EnvironmentMetadata, EnvironmentConfigError> =>
  Effect.gen(function* () {
    const {
      path: configPath,
      present: configPresent,
      config,
    } = yield* loadTrellageConfig({ environment, home }).pipe(
      Effect.mapError((cause) => new EnvironmentConfigError({ message: cause.message })),
    )
    const decoded = config.environment

    const override = environment.TRELLAGE_ENVIRONMENT
    if (override !== undefined && override !== "on" && override !== "off") {
      return yield* fail("TRELLAGE_ENVIRONMENT must be on or off")
    }
    const enabled = override === undefined ? decoded.enabled : override === "on"
    const configuredPath = decoded.path ?? path.dirname(configPath)
    const environmentPath = expandTrellagePath(configuredPath, home, path.dirname(configPath))
    const sourcePresent = enabled
      ? yield* inspectEnvironmentSource(environmentPath, decoded.required, decoded.strict_permissions)
      : false

    return {
      config_path: configPath,
      config_present: configPresent,
      provider: decoded.provider,
      enabled,
      path: environmentPath,
      source_present: sourcePresent,
      required: decoded.required,
      strict_permissions: decoded.strict_permissions,
    }
  })
