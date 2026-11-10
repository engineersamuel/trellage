import { spawn } from "node:child_process"
import type { Stats } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import path from "node:path"
import { Data, Duration, Effect, Either, Schema } from "effect"
import { bunArguments, bunExecutable, sourceEnvironment, sourceWorkspaceRoot } from "./index.ts"
import { expandTrellagePath, type EnvironmentConfig } from "./native-config.ts"
import { dependencyDirectory } from "./workspace.ts"

export class CentralEnvironmentError extends Data.TaggedError("CentralEnvironmentError")<{
  readonly message: string
}> {}

const refuse = (message: string) => Effect.fail(new CentralEnvironmentError({ message }))

const schemaOnlyFiles = new Set([".env.schema", ".env.example", ".env.sample", ".env.template"])
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/
const maximumOutputBytes = 1024 * 1024
const defaultTimeout = Duration.seconds(20)

const isMissing = (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === "ENOENT"
const isEnvironmentFile = (name: string) => name === ".env" || name.startsWith(".env.")

const statEntry = (candidate: string) => Effect.tryPromise({ try: () => lstat(candidate), catch: (cause) => cause })

const assertSafe = (
  stats: Stats,
  candidate: string,
  label: string,
  strictPermissions: boolean,
  allowPublicRead: boolean,
) =>
  Effect.gen(function* () {
    if (stats.isSymbolicLink()) return yield* refuse(`${label} must not be a symbolic link: ${candidate}`)
    if (!stats.isFile() && !stats.isDirectory()) {
      return yield* refuse(`${label} is not a file or directory: ${candidate}`)
    }
    if ((stats.mode & 0o022) !== 0) {
      return yield* refuse(`${label} must not be writable by group or other users: ${candidate}`)
    }
    if (strictPermissions && !allowPublicRead && (stats.mode & 0o077) !== 0) {
      return yield* refuse(`${label} must not be accessible by group or other users: ${candidate}`)
    }
  })

type SourceKind = "file" | "directory"

/** Unsafe or unreadable sources fail with the reason; a missing source or one without .env files is undefined. */
const inspectEnvironmentSource = (candidate: string, required: boolean, strictPermissions: boolean) =>
  Effect.gen(function* () {
    const stats = yield* statEntry(candidate).pipe(
      Effect.catchAll((cause) =>
        isMissing(cause) ? Effect.succeed(undefined) : refuse(`cannot inspect Varlock environment path: ${candidate}`),
      ),
    )
    if (stats === undefined) {
      if (required) return yield* refuse(`required Varlock environment path does not exist: ${candidate}`)
      return undefined
    }
    if (stats.isFile()) {
      const label = "Varlock environment file"
      yield* assertSafe(stats, candidate, label, strictPermissions, schemaOnlyFiles.has(path.basename(candidate)))
      return "file" as const
    }
    yield* assertSafe(stats, candidate, "Varlock environment directory", strictPermissions, false)

    const entries = yield* Effect.tryPromise({
      try: () => readdir(candidate, { withFileTypes: true }),
      catch: () => new CentralEnvironmentError({ message: `cannot read Varlock environment directory: ${candidate}` }),
    })
    const environmentFiles = entries.filter((entry) => isEnvironmentFile(entry.name))
    if (environmentFiles.length === 0) {
      if (required) return yield* refuse(`required Varlock environment directory has no .env files: ${candidate}`)
      return undefined
    }
    for (const entry of environmentFiles) {
      const entryPath = path.join(candidate, entry.name)
      if (!entry.isFile()) return yield* refuse(`Varlock environment entry must be a regular file: ${entryPath}`)
      const entryStats = yield* statEntry(entryPath).pipe(
        Effect.catchAll(() => refuse(`cannot inspect Varlock environment path: ${entryPath}`)),
      )
      const label = "Varlock environment file"
      yield* assertSafe(entryStats, entryPath, label, strictPermissions, schemaOnlyFiles.has(entry.name))
    }
    return "directory" as const
  })

/** TRELLAGE_ENVIRONMENT=on|off overrides the configured switch for one invocation. */
const environmentEnabled = (configured: boolean, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const override = environment.TRELLAGE_ENVIRONMENT
    if (override !== undefined && override !== "on" && override !== "off") {
      return yield* refuse("TRELLAGE_ENVIRONMENT must be on or off")
    }
    return override === undefined ? configured : override === "on"
  })

interface EnvironmentLocation {
  readonly configPath: string
  readonly home: string
  readonly environment: NodeJS.ProcessEnv
}

/** Decide whether the central environment applies and what its source holds. */
const describeEnvironmentSource = (settings: EnvironmentConfig, location: EnvironmentLocation) =>
  Effect.gen(function* () {
    const enabled = yield* environmentEnabled(settings.enabled, location.environment)
    const base = path.dirname(location.configPath)
    const sourcePath = expandTrellagePath(settings.path ?? base, location.home, base)
    const kind = enabled
      ? yield* inspectEnvironmentSource(sourcePath, settings.required, settings.strict_permissions)
      : undefined
    return { enabled, path: sourcePath, kind }
  })

export interface CentralEnvironment {
  /** Resolved values for requested names only. Never print them. */
  readonly values: Readonly<Record<string, string>>
  readonly warnings: ReadonlyArray<string>
}

export interface CentralEnvironmentRequest extends EnvironmentLocation {
  readonly names: ReadonlyArray<string>
  readonly settings: EnvironmentConfig
  /** Workspace whose installed dependencies provide Varlock; defaults to this source tree. */
  readonly sourceRoot?: string
  readonly timeout?: Duration.DurationInput
}

const varlockCommand = (sourceRoot: string) =>
  Effect.gen(function* () {
    const cli = yield* Effect.try({
      try: () => path.join(dependencyDirectory(path.resolve(sourceRoot), "varlock"), "bin", "cli.js"),
      catch: (cause) =>
        new CentralEnvironmentError({ message: cause instanceof Error ? cause.message : "Varlock is not installed" }),
    })
    const stats = yield* statEntry(cli).pipe(Effect.catchAll(() => refuse(`Varlock CLI is missing: ${cli}`)))
    if (!stats.isFile()) return yield* refuse(`Varlock CLI must be a regular file: ${cli}`)
    const executable = yield* Effect.try({
      try: () => bunExecutable(),
      catch: (cause) =>
        new CentralEnvironmentError({ message: cause instanceof Error ? cause.message : "Bun is not available" }),
    })
    return { executable, cli }
  })

interface ChildResult {
  readonly status: number | null
  readonly stdout: string
}

/** The child gets no input. Its error output is dropped because it can quote configuration values. */
const execute = (command: string, args: ReadonlyArray<string>, environment: NodeJS.ProcessEnv, cwd: string) =>
  Effect.async<ChildResult, CentralEnvironmentError>((resume) => {
    const child = spawn(command, [...args], { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    let size = 0
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > maximumOutputBytes) child.kill("SIGKILL")
      else chunks.push(chunk)
    })
    child.stderr.resume()
    child.once("error", () => resume(refuse("Varlock could not start")))
    child.once("close", (status) => {
      if (size > maximumOutputBytes) resume(refuse("Varlock output is too large"))
      else resume(Effect.succeed({ status, stdout: Buffer.concat(chunks).toString("utf8") }))
    })
    return Effect.sync(() => {
      child.kill("SIGKILL")
    })
  })

const VarlockValues = Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown }))

const usableValue = (value: unknown): string | undefined => {
  const text =
    typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : ""
  return text.length > 0 && !text.includes("\0") ? text : undefined
}

/** Keep only requested names with usable values. */
const requestedValues = (stdout: string, names: ReadonlyArray<string>) =>
  Schema.decodeUnknown(VarlockValues)(stdout).pipe(
    Effect.mapError(() => new CentralEnvironmentError({ message: "Varlock returned unreadable output" })),
    Effect.map((parsed) =>
      Object.fromEntries(
        names.flatMap((name) => {
          const value = Object.hasOwn(parsed, name) ? usableValue(parsed[name]) : undefined
          return value === undefined ? [] : [[name, value] as const]
        }),
      ),
    ),
  )

/**
 * Varlock only resolves; it never wraps the harness. Requested names are removed from the child
 * environment so an empty ambient value cannot override the file, and telemetry stays off.
 */
const resolveValues = (
  names: ReadonlyArray<string>,
  source: { readonly path: string; readonly kind: SourceKind },
  request: CentralEnvironmentRequest,
) =>
  Effect.gen(function* () {
    const { executable, cli } = yield* varlockCommand(request.sourceRoot ?? sourceWorkspaceRoot())
    const childEnvironment = sourceEnvironment(request.environment)
    for (const name of names) delete childEnvironment[name]
    childEnvironment.VARLOCK_TELEMETRY_DISABLED = "1"
    const result = yield* execute(
      executable,
      bunArguments(cli, ["load", "--path", source.path, "--format", "json", "--filter", names.join(",")]),
      childEnvironment,
      source.kind === "directory" ? source.path : path.dirname(source.path),
    ).pipe(
      Effect.timeoutFail({
        duration: request.timeout ?? defaultTimeout,
        onTimeout: () => new CentralEnvironmentError({ message: "Varlock did not finish in time" }),
      }),
    )
    if (result.status !== 0) {
      return yield* refuse(`Varlock could not load the environment (run varlock load --path ${source.path} to see why)`)
    }
    return yield* requestedValues(result.stdout, names)
  })

const settle = async <A>(effect: Effect.Effect<A, CentralEnvironmentError>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect))
  if (Either.isLeft(result)) throw result.left
  return result.right
}

/** The configured source path and whether it holds environment files, as the shell launchers need it. */
export const readEnvironmentSource = (settings: EnvironmentConfig, location: EnvironmentLocation) =>
  settle(describeEnvironmentSource(settings, location))

/**
 * Resolve the requested variable names from the central environment source. Fails only when the
 * source is required; otherwise a problem becomes a warning and the launch continues without it.
 */
export const readCentralEnvironment = (request: CentralEnvironmentRequest): Promise<CentralEnvironment> => {
  const names = [...new Set(request.names)].filter((name) => environmentName.test(name)).sort()
  const required = request.settings.required
  const resolution = Effect.gen(function* () {
    const source = yield* describeEnvironmentSource(request.settings, request)
    if (!source.enabled || source.kind === undefined || names.length === 0) {
      return { values: {}, warnings: [] } satisfies CentralEnvironment
    }
    const values = yield* resolveValues(names, { path: source.path, kind: source.kind }, request)
    return { values, warnings: [] } satisfies CentralEnvironment
  }).pipe(
    Effect.catchAll((error) =>
      required
        ? Effect.fail(error)
        : Effect.succeed({
            values: {},
            warnings: [`Central environment unavailable: ${error.message}; launching without it`],
          } satisfies CentralEnvironment),
    ),
  )
  return names.length === 0 && !required ? Promise.resolve({ values: {}, warnings: [] }) : settle(resolution)
}
