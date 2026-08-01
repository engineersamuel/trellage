import { execFile, spawn } from "node:child_process"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { Cause, Data, Effect, Exit } from "effect"
import lockfile from "proper-lockfile"

import { resolveGitHubSource } from "./github-cache.js"
import { parseLock, renderLock } from "./lock-file.js"
import { compileLock, lockIsReady, profileHash, requireLocked, withFinalDigest, type ProfileLock } from "./lock.js"
import { createBuildContext, type PluginGenerator, type RuntimeSupport, type SkillGenerator } from "./materialize.js"
import { parseProfile, type ProfileDocument } from "./profile.js"
import { productionResolvers } from "./resolvers.js"
import { sourceIncludes, sourceInventoryPolicy } from "./source-policy.js"
import { createRuntimeSupportSnapshot, type RuntimeSupportSnapshot } from "./runtime-support.js"

const execFilePromise = promisify(execFile)
const builderImage = "docker.io/jdxcode/mise@sha256:b8f8c20fc3308f8b1d00ccca2bc968e4e208af1c5c1069e1ad9753baa099acff"
const skopeoImage = "quay.io/skopeo/stable@sha256:47853bb9fb24202af9110531ebd6e43c5f97701254ca290596640290d17942f4"
const compatibilityAdapter = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../prototypes/trellage/adapt-agent-kit.sh",
)
const skillsCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/skills/bin/cli.mjs")

export class ApplicationError extends Data.TaggedError("ApplicationError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const sanitizeNpmRegistry = (candidate: string): string | undefined => {
  try {
    const registry = new URL(candidate.trim())
    if (
      registry.protocol !== "https:" ||
      registry.username !== "" ||
      registry.password !== "" ||
      registry.search !== "" ||
      registry.hash !== ""
    )
      return undefined
    return registry.toString()
  } catch {
    return undefined
  }
}

export interface UpgradeServices {
  readonly buildCandidate: (
    document: ProfileDocument,
    lock: ProfileLock,
    image: string,
  ) => Effect.Effect<string, ApplicationError>
  readonly imageExists: (image: string) => Effect.Effect<boolean, ApplicationError>
  readonly tagImage: (source: string, destination: string) => Effect.Effect<void, ApplicationError>
  readonly removeImage: (image: string) => Effect.Effect<void, ApplicationError>
}

const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const safeLockedVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const impossibleBuilderInput = (message: string): never => {
  throw new ApplicationError({ message })
}

export const builderScript = (document: ProfileDocument, lock: ProfileLock): string => {
  const harness = lock.packages.harness
  if (document.profile.harness.kind !== harness.kind || !safeLockedVersionPattern.test(harness.version)) {
    return impossibleBuilderInput("profile and lock harness packages do not match")
  }
  const tool = `http:${harness.kind}@${harness.version}`
  const build = 'PATH=/src/build-support:$PATH mise oci build --locked --output "$OUTPUT_DIR" --tag "$IMAGE_REF"'
  if (harness.kind === "codex") {
    return `mise install --locked ${tool}; codex_dir=\"$(mise where ${tool})\"; rm -f \"$codex_dir/metadata.json\"; ${build}`
  }
  if (harness.kind === "claude") {
    return `mise install --locked; find /mise/installs -name metadata.json -type f -delete; ${build}`
  }

  const profilePlugin = document.profile.plugins[0]
  const source = lock.sources[0]
  const selected = profilePlugin?.select[0]
  const versions = source?.plugin_versions === undefined ? [] : Object.entries(source.plugin_versions)
  if (
    document.profile.plugins.length !== 1 ||
    lock.sources.length !== 1 ||
    profilePlugin === undefined ||
    !("marketplace" in profilePlugin) ||
    profilePlugin.select.length !== 1 ||
    selected === undefined ||
    source === undefined ||
    source.kind !== "plugin" ||
    source.adapter !== "copilot-marketplace" ||
    source.marketplace !== profilePlugin.marketplace ||
    source.repository !== profilePlugin.repository ||
    source.ref !== profilePlugin.ref ||
    source.select.length !== 1 ||
    source.select[0] !== selected ||
    versions.length !== 1 ||
    versions[0]?.[0] !== selected ||
    !exactVersionPattern.test(harness.version) ||
    !safeIdentifierPattern.test(profilePlugin.marketplace) ||
    !safeIdentifierPattern.test(selected) ||
    !exactVersionPattern.test(versions[0]?.[1] ?? "")
  ) {
    return impossibleBuilderInput("Copilot builder requires one exact locked marketplace plugin")
  }
  const marketplace = profilePlugin.marketplace
  const version = versions[0]![1]
  const plugin = `${selected}@${marketplace}`
  const nativeEnvironment = "COPILOT_HOME=/src/copilot-seed COPILOT_AUTO_UPDATE=false NO_COLOR=1 TERM=dumb"
  const expectedRow = `  • ${plugin} (v${version})`
  return [
    `mise install --locked ${tool}`,
    `copilot_dir="$(mise where ${tool})"`,
    'copilot_bin="$copilot_dir/copilot"',
    '[ -x "$copilot_bin" ]',
    'rm -f "$copilot_dir/metadata.json"',
    `${nativeEnvironment} "$copilot_bin" plugin marketplace add /src/hve-core`,
    `${nativeEnvironment} "$copilot_bin" plugin install ${plugin}`,
    "plugin_list_status=0",
    `plugin_list="$(${nativeEnvironment} "$copilot_bin" plugin list)" || plugin_list_status=$?`,
    '[ "$plugin_list_status" -eq 0 ]',
    `printf '%s\\n' "$plugin_list" | awk -v expected='${expectedRow}' '$0 == expected { count++ } END { exit count == 1 ? 0 : 1 }'`,
    "[ -x /mise/installs/node/24.18.0/bin/node ]",
    `/mise/installs/node/24.18.0/bin/node /src/finalize-copilot-seed.mjs /src/copilot-seed ${marketplace} ${selected} ${version}`,
    build,
  ].join("; ")
}

const io = <A>(message: string, operation: () => Promise<A>): Effect.Effect<A, ApplicationError> =>
  Effect.tryPromise({ try: operation, catch: (cause) => new ApplicationError({ message, cause }) })

export const adjacentLockPath = (profilePath: string): string => {
  const extension = path.extname(profilePath)
  return `${profilePath.slice(0, extension.length === 0 ? undefined : -extension.length)}.lock.toml`
}

export const loadProfile = (profilePath: string): Effect.Effect<ProfileDocument, ApplicationError> =>
  io(`cannot read profile: ${profilePath}`, () => readFile(profilePath, "utf8")).pipe(
    Effect.flatMap((source) => parseProfile(source, profilePath)),
    Effect.mapError(
      (cause) => new ApplicationError({ message: "message" in cause ? String(cause.message) : String(cause), cause }),
    ),
  )

export const loadLock = (profilePath: string): Effect.Effect<ProfileLock | undefined, ApplicationError> => {
  const lockPath = adjacentLockPath(profilePath)
  return Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(lockPath, "utf8")
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw cause
      }
    },
    catch: (cause) => new ApplicationError({ message: `cannot read lock: ${lockPath}`, cause }),
  }).pipe(
    Effect.flatMap((source) =>
      source === undefined
        ? Effect.succeed(undefined)
        : parseLock(source).pipe(Effect.map((lock) => lock as ProfileLock | undefined)),
    ),
    Effect.mapError(
      (cause) => new ApplicationError({ message: "message" in cause ? String(cause.message) : String(cause), cause }),
    ),
  )
}

let atomicWriteSequence = 0
const writeLockBytes = (profilePath: string, contents: string): Effect.Effect<void, ApplicationError> => {
  const destination = adjacentLockPath(profilePath)
  const temporary = `${destination}.tmp-${process.pid}-${atomicWriteSequence++}`
  return io(`cannot write lock: ${destination}`, async () => {
    await writeFile(temporary, contents, { flag: "wx" })
    await rename(temporary, destination)
  }).pipe(Effect.ensuring(io("cannot clean temporary lock", () => rm(temporary, { force: true })).pipe(Effect.ignore)))
}

export const writeLock = (profilePath: string, lock: ProfileLock): Effect.Effect<void, ApplicationError> =>
  writeLockBytes(profilePath, renderLock(lock))

const readLockBytes = (profilePath: string): Effect.Effect<string | undefined, ApplicationError> => {
  const lockPath = adjacentLockPath(profilePath)
  return Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(lockPath, "utf8")
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw cause
      }
    },
    catch: (cause) => new ApplicationError({ message: `cannot read lock: ${lockPath}`, cause }),
  })
}

const upgradeFileServices = {
  readLockBytes,
  writeLockBytes,
  removeLock: (profilePath: string): Effect.Effect<void, ApplicationError> => {
    const lockPath = adjacentLockPath(profilePath)
    return io(`cannot remove lock: ${lockPath}`, () => rm(lockPath, { force: true }))
  },
}

export const compileProfileLock = (
  profilePath: string,
  update: boolean,
  xdgCacheHome: string,
): Effect.Effect<ProfileLock, ApplicationError> =>
  Effect.gen(function* () {
    const document = yield* loadProfile(profilePath)
    const current = yield* loadLock(profilePath)
    const lock = yield* compileLock(document, current, update, productionResolvers(xdgCacheHome)).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    )
    if (lock !== current) yield* writeLock(profilePath, lock)
    return lock
  })

interface CommandOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdio?: "inherit"
}

const run = (command: string, args: ReadonlyArray<string>, options?: CommandOptions) =>
  options?.stdio === "inherit"
    ? Effect.tryPromise({
        try: (signal) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(command, [...args], {
              ...(options.cwd ? { cwd: options.cwd } : {}),
              ...(options.env ? { env: options.env } : {}),
              stdio: "inherit",
            })
            const abort = () => child.kill("SIGTERM")
            signal.addEventListener("abort", abort, { once: true })
            child.once("error", reject)
            child.once("close", (code, childSignal) => {
              signal.removeEventListener("abort", abort)
              if (code === 0) resolve()
              else reject(new Error(`command exited with ${code ?? `signal ${childSignal ?? "unknown"}`}`))
            })
          }),
        catch: (cause) => new ApplicationError({ message: `command failed: ${command}`, cause }),
      })
    : Effect.tryPromise({
        try: async (signal) => {
          await execFilePromise(command, args, {
            ...(options?.cwd ? { cwd: options.cwd } : {}),
            ...(options?.env ? { env: options.env } : {}),
            maxBuffer: 32 * 1024 * 1024,
            signal,
          })
        },
        catch: (cause) => new ApplicationError({ message: `command failed: ${command}`, cause }),
      })

const pluginGenerator: PluginGenerator = (sourceDirectory, selections, destination) =>
  Effect.forEach(
    selections,
    (selection) =>
      run(
        "mise",
        [
          "x",
          "uv@0.11.21",
          "--",
          "uv",
          "run",
          "--locked",
          "--project",
          path.join(sourceDirectory, "plugins", "plugin-eval"),
          "python",
          path.join(sourceDirectory, "tools", "generate.py"),
          "--harness",
          "codex",
          "--plugin",
          selection,
          "--output-root",
          destination,
        ],
        {
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: "1",
            UV_PROJECT_ENVIRONMENT: path.join(destination, ".venv"),
          },
        },
      ),
    { concurrency: 1 },
  ).pipe(Effect.zipRight(run("bash", [compatibilityAdapter, destination])), Effect.asVoid)

const skillGenerator: SkillGenerator = (sourceDirectory, selections, destination) =>
  run(
    process.execPath,
    [skillsCli, "add", sourceDirectory, "--skill", ...selections, "--agent", "codex", "--copy", "--yes"],
    {
      cwd: destination,
      env: {
        ...process.env,
        CI: "1",
        DISABLE_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        npm_config_ignore_scripts: "true",
      },
    },
  )

type CommandRunner = typeof run

const buildOci = (
  context: string,
  imageTag: string,
  document: ProfileDocument,
  lock: ProfileLock,
  expectedDigest?: string,
  execute: CommandRunner = run,
  npmRegistry?: string,
): Effect.Effect<string, ApplicationError> =>
  Effect.gen(function* () {
    const output = path.join(context, "oci")
    yield* execute(
      "docker",
      [
        "run",
        "--rm",
        "--platform",
        document.profile.image.platform,
        "--user",
        "0:0",
        "--env",
        "MISE_EXPERIMENTAL=1",
        "--env",
        "MISE_GLOBAL_CONFIG_FILE=/dev/null",
        "--env",
        "MISE_CONFIG_DIR=/tmp/mise-config",
        "--env",
        "MISE_DATA_DIR=/tmp/mise-data",
        "--env",
        "MISE_CACHE_DIR=/tmp/mise-cache",
        "--env",
        "MISE_YES=1",
        ...(npmRegistry === undefined ? [] : ["--env", `npm_config_registry=${npmRegistry}`]),
        "--env",
        `SOURCE_DATE_EPOCH=${lock.source_date_epoch}`,
        "--env",
        "OUTPUT_DIR=/src/oci",
        "--env",
        `IMAGE_REF=${imageTag}`,
        "--mount",
        `type=bind,src=${context},dst=/src`,
        "--workdir",
        "/src",
        "--entrypoint",
        "sh",
        builderImage,
        "-ceu",
        builderScript(document, lock),
      ],
      { stdio: "inherit" },
    )
    const index = yield* io("cannot read built OCI index", () => readFile(path.join(output, "index.json"), "utf8"))
    const parsed = yield* Effect.try({
      try: () => JSON.parse(index) as { manifests?: Array<{ digest?: string }> },
      catch: (cause) => new ApplicationError({ message: "built OCI index is invalid", cause }),
    })
    const digest = parsed.manifests?.[0]?.digest
    if (!digest?.startsWith("sha256:"))
      return yield* Effect.fail(new ApplicationError({ message: "built OCI index has no manifest digest" }))
    if (expectedDigest !== undefined && digest !== expectedDigest) {
      return yield* Effect.fail(
        new ApplicationError({
          message: `locked OCI digest mismatch: expected ${expectedDigest}, actual ${digest}`,
        }),
      )
    }
    yield* execute(
      "docker",
      [
        "run",
        "--rm",
        "--platform",
        document.profile.image.platform,
        "--mount",
        `type=bind,src=${context},dst=/work,readonly`,
        "--mount",
        "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
        skopeoImage,
        "copy",
        "oci:/work/oci",
        `docker-daemon:${imageTag}`,
      ],
      { stdio: "inherit" },
    )
    return digest
  })

const buildCandidateImage = (
  document: ProfileDocument,
  lock: ProfileLock,
  image: string,
  xdgCacheHome: string,
  runtimeSupport: RuntimeSupportSnapshot,
): Effect.Effect<string, ApplicationError> =>
  Effect.gen(function* () {
    const directories = yield* Effect.forEach(
      lock.sources,
      (source) =>
        resolveGitHubSource(xdgCacheHome, {
          repository: source.repository,
          ref: source.ref,
          lockedCommit: source.commit,
          include: sourceIncludes(source),
          inventoryPolicy: sourceInventoryPolicy(source),
        }).pipe(
          Effect.map((resolved) => resolved.directory),
          Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
        ),
      { concurrency: 1 },
    )
    const temporaryParent = path.join(xdgCacheHome, "trellage", "build")
    yield* io("cannot create build cache", () => mkdir(temporaryParent, { recursive: true }))
    const context = yield* createBuildContext(
      document,
      lock,
      directories,
      runtimeSupport,
      temporaryParent,
      skillGenerator,
      pluginGenerator,
    ).pipe(Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })))
    return yield* buildOci(context, image, document, lock).pipe(
      Effect.ensuring(
        io("cannot clean build context", () => rm(context, { recursive: true, force: true })).pipe(Effect.ignore),
      ),
    )
  })

const isMissingImageError = (cause: unknown): boolean => {
  const candidate = cause as { readonly stderr?: unknown; readonly message?: unknown }
  const detail = `${String(candidate.stderr ?? "")}\n${String(candidate.message ?? "")}`
  return /No such image|No such object|does not exist/i.test(detail)
}

const liveImageExists = (image: string): Effect.Effect<boolean, ApplicationError> =>
  Effect.tryPromise({
    try: async (signal) => {
      try {
        await execFilePromise("docker", ["image", "inspect", image], { maxBuffer: 32 * 1024 * 1024, signal })
        return true
      } catch (cause) {
        if (isMissingImageError(cause)) return false
        throw cause
      }
    },
    catch: (cause) => new ApplicationError({ message: `cannot inspect owned image: ${image}`, cause }),
  })

const defaultRuntimeSupport: RuntimeSupport = {
  codexEntry: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prototypes/trellage/runtime-entry.sh",
  ),
  copilotEntry: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prototypes/trellage/runtime-copilot-entry.sh",
  ),
  finalizeCopilotSeed: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prototypes/trellage/finalize-copilot-seed.mjs",
  ),
  claudeEntry: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prototypes/trellage/runtime-claude-entry.sh",
  ),
  hyperresearchRequirements: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../assets/hyperresearch-requirements.lock",
  ),
  claudeBrowserAgent: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../assets/hyperresearch-browser-fetcher.md",
  ),
}

const defaultCacheHome = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")

export const LiveUpgradeServices: UpgradeServices = {
  buildCandidate: (document, lock, image) =>
    createRuntimeSupportSnapshot(document.profile.harness.kind, defaultRuntimeSupport).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
      Effect.flatMap((snapshot) => buildCandidateImage(document, lock, image, defaultCacheHome, snapshot)),
    ),
  imageExists: liveImageExists,
  tagImage: (source, destination) => run("docker", ["image", "tag", source, destination]),
  removeImage: (image) =>
    Effect.tryPromise({
      try: async (signal) => {
        try {
          await execFilePromise("docker", ["image", "rm", "--force", image], { maxBuffer: 32 * 1024 * 1024, signal })
        } catch (cause) {
          if (!isMissingImageError(cause)) throw cause
        }
      },
      catch: (cause) => new ApplicationError({ message: `cannot remove owned image: ${image}`, cause }),
    }),
}

const applicationError = (cause: unknown): ApplicationError =>
  cause instanceof ApplicationError
    ? cause
    : new ApplicationError({ message: String((cause as { readonly message?: unknown })?.message ?? cause), cause })

const collectCauses = (
  operations: ReadonlyArray<Effect.Effect<void, ApplicationError>>,
): Effect.Effect<ReadonlyArray<Cause.Cause<ApplicationError>>, never> =>
  Effect.forEach(operations, (operation) => Effect.exit(operation), { concurrency: 1 }).pipe(
    Effect.map((exits) => exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))),
  )

const sequentialCauses = (
  causes: ReadonlyArray<Cause.Cause<ApplicationError>>,
): Cause.Cause<ApplicationError> | undefined =>
  causes.reduce<Cause.Cause<ApplicationError> | undefined>(
    (combined, cause) => (combined === undefined ? cause : Cause.sequential(combined, cause)),
    undefined,
  )

const runAll = (
  operations: ReadonlyArray<Effect.Effect<void, ApplicationError>>,
): Effect.Effect<void, ApplicationError> =>
  collectCauses(operations).pipe(
    Effect.flatMap((causes) => {
      const combined = sequentialCauses(causes)
      return combined === undefined ? Effect.void : Effect.failCause(combined)
    }),
  )

interface UpgradeLease {
  readonly path: string
  readonly release: () => Promise<void>
  readonly compromised: Promise<never>
}

const acquireUpgradeLease = (
  xdgCacheHome: string,
  profileName: string,
): Effect.Effect<UpgradeLease, ApplicationError> => {
  const directory = path.join(xdgCacheHome, "trellage", "upgrade-locks")
  const leasePath = path.join(directory, profileName)
  return Effect.tryPromise({
    try: async () => {
      await mkdir(directory, { recursive: true })
      let compromise!: (cause: unknown) => void
      const compromised = new Promise<never>((_resolve, reject) => {
        compromise = reject
      })
      try {
        const release = await lockfile.lock(leasePath, {
          realpath: false,
          stale: 10_000,
          update: 5_000,
          retries: 0,
          onCompromised: compromise,
        })
        return { path: leasePath, release, compromised }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ELOCKED") {
          throw new ApplicationError({ message: `upgrade already active for profile: ${profileName}`, cause })
        }
        throw cause
      }
    },
    catch: applicationError,
  })
}

const releaseUpgradeLease = (lease: UpgradeLease): Effect.Effect<void, ApplicationError> =>
  io(`cannot release upgrade lock: ${lease.path}`, async () => {
    try {
      await lease.release()
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ERELEASED") throw cause
    }
  })

const awaitUpgradeLeaseCompromise = (lease: UpgradeLease): Effect.Effect<never, ApplicationError> =>
  Effect.tryPromise({
    try: () => lease.compromised,
    catch: (cause) => new ApplicationError({ message: `upgrade lock compromised: ${lease.path}`, cause }),
  })

export const upgradeProfile = (
  profilePath: string,
  xdgCacheHome: string,
  runtimeSupport: RuntimeSupport,
  services: UpgradeServices = LiveUpgradeServices,
): Effect.Effect<{ readonly image: string; readonly digest: string }, ApplicationError> =>
  Effect.gen(function* () {
    const document = yield* loadProfile(profilePath)
    const runtimeSnapshot = yield* createRuntimeSupportSnapshot(document.profile.harness.kind, runtimeSupport).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    )
    const canonical = `trellage-profile-${document.profile.name}:locked`
    const candidate = `trellage-profile-${document.profile.name}:candidate-${process.pid}`
    const backup = `trellage-profile-${document.profile.name}:backup-${process.pid}`
    const activeServices =
      services === LiveUpgradeServices
        ? {
            ...LiveUpgradeServices,
            buildCandidate: (profile: ProfileDocument, lock: ProfileLock, image: string) =>
              buildCandidateImage(profile, lock, image, xdgCacheHome, runtimeSnapshot),
          }
        : services

    return yield* Effect.acquireUseRelease(
      acquireUpgradeLease(xdgCacheHome, document.profile.name),
      (lease) =>
        Effect.raceFirst(
          Effect.gen(function* () {
            const originalLockBytes = yield* upgradeFileServices.readLockBytes(profilePath)
            const current = yield* originalLockBytes === undefined
              ? Effect.succeed(undefined)
              : parseLock(originalLockBytes).pipe(
                  Effect.map((lock) => lock as ProfileLock | undefined),
                  Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
                )
            const candidateLock = yield* compileLock(document, current, true, productionResolvers(xdgCacheHome)).pipe(
              Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
            )
            let candidateAttempted = false
            let backupAttempted = false
            let backupSucceeded = false
            let canonicalExisted = false
            let canonicalAttempted = false
            let lockWriteAttempted = false
            let committed = false

            const transaction = Effect.gen(function* () {
              candidateAttempted = true
              const digest = yield* activeServices.buildCandidate(document, candidateLock, candidate)
              const finalLock: ProfileLock = {
                ...candidateLock,
                image: { ...candidateLock.image, final_digest: digest },
              }
              canonicalExisted = yield* activeServices.imageExists(canonical)
              return yield* Effect.uninterruptibleMask(() =>
                Effect.gen(function* () {
                  if (canonicalExisted) {
                    backupAttempted = true
                    yield* activeServices.tagImage(canonical, backup)
                    backupSucceeded = true
                  }
                  canonicalAttempted = true
                  yield* activeServices.tagImage(candidate, canonical)
                  lockWriteAttempted = true
                  yield* upgradeFileServices.writeLockBytes(profilePath, renderLock(finalLock))
                  committed = true
                  return { image: canonical, digest }
                }).pipe(
                  Effect.catchAllCause((primaryCause) => {
                    if (!canonicalAttempted && !lockWriteAttempted) return Effect.failCause(primaryCause)
                    const compensation: Array<Effect.Effect<void, ApplicationError>> = []
                    if (lockWriteAttempted) {
                      compensation.push(
                        originalLockBytes === undefined
                          ? upgradeFileServices.removeLock(profilePath)
                          : upgradeFileServices.writeLockBytes(profilePath, originalLockBytes),
                      )
                    }
                    if (canonicalAttempted) {
                      compensation.push(
                        canonicalExisted && backupSucceeded
                          ? activeServices.tagImage(backup, canonical)
                          : activeServices.removeImage(canonical),
                      )
                    }
                    return collectCauses(compensation).pipe(
                      Effect.flatMap((compensationCauses) => {
                        const combinedCompensation = sequentialCauses(compensationCauses)
                        return Effect.failCause(
                          combinedCompensation === undefined
                            ? primaryCause
                            : Cause.sequential(primaryCause, combinedCompensation),
                        )
                      }),
                    )
                  }),
                ),
              )
            })

            const cleanup = () => {
              const operations: Array<Effect.Effect<void, ApplicationError>> = []
              if (candidateAttempted) operations.push(activeServices.removeImage(candidate))
              if (backupAttempted) operations.push(activeServices.removeImage(backup))
              return runAll(operations).pipe(
                Effect.catchAllCause((cause) =>
                  committed
                    ? Effect.fail(new ApplicationError({ message: "upgrade committed but cleanup failed", cause }))
                    : Effect.failCause(cause),
                ),
              )
            }

            return yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const transactionExit = yield* restore(Effect.exit(transaction))
                const cleanupExit = yield* Effect.exit(Effect.suspend(cleanup))
                if (Exit.isFailure(transactionExit)) {
                  return yield* Effect.failCause(
                    Exit.isFailure(cleanupExit)
                      ? Cause.sequential(transactionExit.cause, cleanupExit.cause)
                      : transactionExit.cause,
                  )
                }
                if (Exit.isFailure(cleanupExit)) return yield* Effect.failCause(cleanupExit.cause)
                return transactionExit.value
              }),
            )
          }),
          awaitUpgradeLeaseCompromise(lease),
        ),
      (lease) => releaseUpgradeLease(lease).pipe(Effect.orDie),
    )
  })

export const buildProfile = (
  profilePath: string,
  locked: boolean,
  xdgCacheHome: string,
  runtimeSupport: RuntimeSupport,
  execute: CommandRunner = run,
  npmRegistry?: string,
): Effect.Effect<{ readonly image: string; readonly digest: string }, ApplicationError> =>
  Effect.gen(function* () {
    const document = yield* loadProfile(profilePath)
    const runtimeSnapshot = yield* createRuntimeSupportSnapshot(document.profile.harness.kind, runtimeSupport).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    )
    const current = yield* loadLock(profilePath)
    let lock: ProfileLock
    if (locked) {
      lock = yield* requireLocked(document, current).pipe(
        Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
      )
    } else {
      lock = yield* compileLock(document, current, false, productionResolvers(xdgCacheHome)).pipe(
        Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
      )
    }
    if (!locked && lock !== current) yield* writeLock(profilePath, lock)
    const directories = yield* Effect.forEach(
      lock.sources,
      (source) =>
        resolveGitHubSource(xdgCacheHome, {
          repository: source.repository,
          ref: source.ref,
          lockedCommit: source.commit,
          include: sourceIncludes(source),
          inventoryPolicy: sourceInventoryPolicy(source),
        }).pipe(
          Effect.map((resolved) => resolved.directory),
          Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
        ),
      { concurrency: 1 },
    )
    const temporaryParent = path.join(xdgCacheHome, "trellage", "build")
    yield* io("cannot create build cache", () => mkdir(temporaryParent, { recursive: true }))
    const context = yield* createBuildContext(
      document,
      lock,
      directories,
      runtimeSnapshot,
      temporaryParent,
      skillGenerator,
      pluginGenerator,
    ).pipe(Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })))
    const image = `trellage-profile-${document.profile.name}:locked`
    const digest = yield* buildOci(
      context,
      image,
      document,
      lock,
      locked ? lock.image.final_digest : undefined,
      execute,
      npmRegistry,
    ).pipe(
      Effect.ensuring(
        io("cannot clean build context", () => rm(context, { recursive: true, force: true })).pipe(Effect.ignore),
      ),
    )
    if (!locked && digest !== lock.image.final_digest) {
      yield* writeLock(profilePath, withFinalDigest(lock, digest))
    }
    return { image, digest }
  })

export const profileMetadata = (
  profilePath: string,
): Effect.Effect<Readonly<Record<string, unknown>>, ApplicationError> =>
  Effect.gen(function* () {
    const document = yield* loadProfile(profilePath)
    const lock = yield* loadLock(profilePath)
    const hash = profileHash(document)
    const ready = lockIsReady(document, lock)
    const harnessKind = document.profile.harness.kind
    const runtimeSnapshot = yield* createRuntimeSupportSnapshot(harnessKind, defaultRuntimeSupport).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    )
    const isCopilot = harnessKind === "copilot"
    const isClaude = harnessKind === "claude"
    const secretEnvironment: Record<string, string> = Object.fromEntries(
      document.profile.secrets.required.map((name) => [name, name]),
    )
    for (const mcp of document.profile.mcps) {
      if (mcp.transport !== "stdio") continue
      Object.assign(secretEnvironment, mcp.env_from_secret ?? {})
    }
    return {
      profile_path: document.path,
      profile_name: document.profile.name,
      profile_hash: hash,
      runtime_hash: runtimeSnapshot.hash,
      image: `trellage-profile-${document.profile.name}:locked`,
      locked: ready,
      build_command: `trellage build --locked ${document.path}`,
      harness_args: document.profile.harness.args ?? [],
      secrets_provider: document.profile.secrets.provider,
      required_secrets: document.profile.secrets.required,
      secret_environment: secretEnvironment,
      resolved_varlock_path: document.resolvedVarlockPath ?? null,
      has_initial_prompt: document.resolvedInitialPrompt !== undefined,
      harness_kind: harnessKind,
      harness_executable: harnessKind,
      runtime_entry: isCopilot ? "trellage-copilot-entry" : isClaude ? "trellage-claude-entry" : "trellage-codex-entry",
      default_network: isCopilot ? "bridge" : "copilot-proxy-rs_default",
      auth_policy: isCopilot ? document.profile.harness.copilot.auth : isClaude ? "claude-explicit" : "profile-secrets",
      resolved_version: ready && lock?.packages.harness.kind === harnessKind ? lock.packages.harness.version : null,
    }
  })
