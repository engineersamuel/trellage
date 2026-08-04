import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { Data, Effect } from "effect"

import { verifyInventory } from "./inventory.js"
import type { ArtifactLock } from "./lock.js"
import type { ClaudeMaterializeRequest } from "./materialize.js"

const execFilePromise = promisify(execFile)

export const claudeDefaultSettings = {
  permissions: {
    defaultMode: "bypassPermissions",
    deny: [
      "EnterPlanMode",
      "ExitPlanMode",
      "NotebookEdit",
      "SendMessage",
      "PushNotification",
      "RemoteTrigger",
      "ReportFindings",
      "ScheduleWakeup",
      "CronCreate",
      "CronDelete",
      "CronList",
    ],
  },
  skipDangerousModePermissionPrompt: true,
  disableRemoteControl: true,
  disableClaudeAiConnectors: true,
  disableArtifact: true,
} as const

export const claudeDefaultOnboarding = {
  hasCompletedOnboarding: true,
  lastOnboardingVersion: "2.1.218",
  theme: "dark",
  shiftEnterKeyBindingInstalled: true,
} as const

export class ClaudeMaterializeError extends Data.TaggedError("ClaudeMaterializeError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const attempt = <A>(message: string, operation: () => Promise<A>): Effect.Effect<A, ClaudeMaterializeError> =>
  Effect.tryPromise({ try: operation, catch: (cause) => new ClaudeMaterializeError({ message, cause }) })

const run = (
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
): Effect.Effect<string, ClaudeMaterializeError> =>
  attempt(`command failed: ${command}`, async () => {
    const result = await execFilePromise(command, [...args], {
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      ...(options?.env ? { env: options.env } : {}),
      maxBuffer: 32 * 1024 * 1024,
    })
    return result.stdout
  })

const artifact = (
  request: ClaudeMaterializeRequest,
  name: string,
): Effect.Effect<ArtifactLock, ClaudeMaterializeError> => {
  const found = request.lock.packages.artifacts?.find((candidate) => candidate.name === name)
  return found === undefined
    ? Effect.fail(new ClaudeMaterializeError({ message: `missing Claude artifact: ${name}` }))
    : Effect.succeed(found)
}

const digestFile = (candidate: string): Effect.Effect<string, ClaudeMaterializeError> =>
  attempt(
    `cannot hash ${candidate}`,
    async () =>
      `sha256:${createHash("sha256")
        .update(await readFile(candidate))
        .digest("hex")}`,
  )

const safeArchivePaths = (listing: string): boolean =>
  listing
    .split("\n")
    .filter(Boolean)
    .every((entry) => !path.posix.isAbsolute(entry) && !entry.split("/").some((segment) => segment === ".."))

const archiveEntries = (listing: string): ReadonlySet<string> =>
  new Set(
    listing
      .split("\n")
      .filter(Boolean)
      .map((entry) => entry.replace(/^\.\//, "")),
  )

const download = (locked: ArtifactLock, destination: string): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.gen(function* () {
    yield* run("curl", [
      "--fail",
      "--location",
      "--retry",
      "5",
      "--retry-all-errors",
      locked.url,
      "--output",
      destination,
    ])
    const actual = yield* digestFile(destination)
    if (actual !== locked.integrity) {
      return yield* Effect.fail(
        new ClaudeMaterializeError({
          message: `artifact integrity mismatch: ${locked.name}; expected ${locked.integrity}, actual ${actual}`,
        }),
      )
    }
  })

export const materializeChromiumArchives = (
  request: ClaudeMaterializeRequest,
  staging: string,
): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.gen(function* () {
    const archives = [
      {
        artifactName: "chromium",
        archiveName: "chromium.zip",
        destinationName: "chromium",
        executable: "chrome-linux/chrome",
      },
      {
        artifactName: "chromium-headless-shell",
        archiveName: "chromium-headless-shell.zip",
        destinationName: "chromium-headless-shell",
        executable: "chrome-linux/headless_shell",
      },
    ] as const

    for (const archive of archives) {
      const locked = yield* artifact(request, archive.artifactName)
      const archivePath = path.join(staging, archive.archiveName)
      yield* download(locked, archivePath)
      const listing = yield* run("unzip", ["-Z1", archivePath])
      if (!safeArchivePaths(listing)) {
        return yield* Effect.fail(
          new ClaudeMaterializeError({
            message: `${archive.artifactName} archive has unsafe paths`,
          }),
        )
      }
      if (!archiveEntries(listing).has(archive.executable)) {
        return yield* Effect.fail(
          new ClaudeMaterializeError({
            message: `${archive.artifactName} archive is missing ${archive.executable}`,
          }),
        )
      }
      const destination = path.join(request.context, `${archive.destinationName}-${locked.version}`)
      yield* attempt(`cannot create ${archive.artifactName} destination`, () => mkdir(destination, { recursive: true }))
      yield* run("unzip", ["-q", archivePath, "-d", destination])
      yield* attempt(`cannot mark ${archive.artifactName} executable`, () =>
        chmod(path.join(destination, archive.executable), 0o755),
      )
    }
  })

export const managedClaudeFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const found: Array<string> = []
  const visit = async (relative: string): Promise<void> => {
    const directory = path.join(root, relative)
    try {
      const entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" })
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
        const child = path.posix.join(relative, entry.name)
        if (entry.isSymbolicLink()) throw new Error(`managed Claude seed contains a symlink: ${child}`)
        if (entry.isDirectory()) await visit(child)
        else if (entry.isFile()) found.push(child)
        else throw new Error(`managed Claude seed contains an unsupported entry: ${child}`)
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return
      throw cause
    }
  }
  await visit("skills")
  await visit("agents")
  return found.sort()
}

export const normalizeHyperresearchSeed = (
  seed: string,
  generatedExecutable: string,
): Effect.Effect<void, ClaudeMaterializeError> =>
  attempt("cannot normalize Hyperresearch seed", async () => {
    const runtimeExecutable = "/usr/local/bin/hyperresearch"
    const generatedExecutables = new Set([generatedExecutable, await realpath(generatedExecutable)])
    for (const relative of await managedClaudeFiles(seed)) {
      const candidate = path.join(seed, relative)
      const source = await readFile(candidate, "utf8")
      let normalized = source
      for (const executable of generatedExecutables) {
        normalized = normalized.split(executable).join(runtimeExecutable)
      }
      if (normalized !== source) await writeFile(candidate, normalized)
    }
  })

const materializeClaudeMarketplaceAssets = (
  request: ClaudeMaterializeRequest,
): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.gen(function* () {
    if (request.sourceDirectories.length !== request.lock.sources.length || request.sourceDirectories.length === 0) {
      return yield* Effect.fail(new ClaudeMaterializeError({ message: "Claude marketplace sources do not match lock" }))
    }
    const marketplaces: Array<{
      readonly marketplace: string
      readonly source: string
      readonly commit: string
      readonly plugins: ReadonlyArray<{ readonly plugin: string; readonly version: string }>
    }> = []
    for (let index = 0; index < request.sourceDirectories.length; index += 1) {
      const sourceDirectory = request.sourceDirectories[index]!
      const source = request.lock.sources[index]
      if (
        source === undefined ||
        source.adapter !== "claude-marketplace" ||
        source.marketplace === undefined ||
        source.plugin_versions === undefined
      ) {
        return yield* Effect.fail(new ClaudeMaterializeError({ message: "Claude marketplace lock is invalid" }))
      }
      const marketplace = path.join(request.context, `claude-marketplace-${index}`)
      yield* attempt("cannot copy Claude marketplace source", () =>
        cp(sourceDirectory, marketplace, {
          recursive: true,
          errorOnExist: true,
          force: false,
          verbatimSymlinks: true,
        }),
      )
      yield* verifyInventory(marketplace, source.files).pipe(
        Effect.mapError(
          (cause) => new ClaudeMaterializeError({ message: "copied Claude marketplace inventory mismatch", cause }),
        ),
      )
      marketplaces.push({
        marketplace: source.marketplace,
        source: `/src/claude-marketplace-${index}`,
        commit: source.commit,
        plugins: source.select.map((plugin) => ({
          plugin,
          version: source.plugin_versions![plugin]!,
        })),
      })
    }
    const seed = path.join(request.context, "claude-seed")
    yield* attempt("cannot create Claude marketplace seed", async () => {
      await mkdir(seed, { recursive: true })
      await Promise.all([
        writeFile(path.join(seed, "default-settings.json"), `${JSON.stringify(claudeDefaultSettings, null, 2)}\n`, {
          mode: 0o644,
        }),
        writeFile(path.join(seed, "default-onboarding.json"), `${JSON.stringify(claudeDefaultOnboarding, null, 2)}\n`, {
          mode: 0o644,
        }),
        writeFile(
          path.join(request.context, "claude-marketplaces.json"),
          `${JSON.stringify({ marketplaces }, null, 2)}\n`,
          { mode: 0o644 },
        ),
      ])
    })
  })

const materializeHyperresearchAssets = (
  request: ClaudeMaterializeRequest,
): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.acquireUseRelease(
    attempt("cannot create Claude materialization staging", () => mkdtemp(path.join(os.tmpdir(), "trellage-claude-"))),
    (staging) =>
      Effect.gen(function* () {
        if (request.requirementsPath === undefined || request.browserAgentPath === undefined) {
          return yield* Effect.fail(new ClaudeMaterializeError({ message: "Hyperresearch runtime support is missing" }))
        }
        const requirementsPath = request.requirementsPath
        const browserAgentPath = request.browserAgentPath
        const expectedRequirements = request.lock.packages.python_lock_integrity
        const actualRequirements = yield* digestFile(requirementsPath)
        if (expectedRequirements === undefined || actualRequirements !== expectedRequirements) {
          return yield* Effect.fail(
            new ClaudeMaterializeError({
              message: `Python dependency lock integrity mismatch; expected ${expectedRequirements ?? "missing"}, actual ${actualRequirements}`,
            }),
          )
        }

        const pythonSite = path.join(request.context, "hyperresearch-site")
        yield* attempt("cannot create Hyperresearch target", () => mkdir(pythonSite, { recursive: true }))
        const uv = ["x", "uv@0.11.21", "--", "uv"]
        yield* run("mise", [
          ...uv,
          "pip",
          "install",
          "--target",
          pythonSite,
          "--python-version",
          "3.13",
          "--python-platform",
          "aarch64-manylinux_2_28",
          "--require-hashes",
          "--no-deps",
          "-r",
          requirementsPath,
        ])
        yield* run("mise", [
          ...uv,
          "pip",
          "install",
          "--target",
          pythonSite,
          "--python-version",
          "3.13",
          "--python-platform",
          "aarch64-manylinux_2_28",
          "--no-deps",
          request.sourceDirectories[0]!,
        ])

        const hostVenv = path.join(staging, "host-venv")
        yield* run("mise", [...uv, "venv", "--python", "3.13", hostVenv])
        const hostPython = path.join(hostVenv, "bin", "python")
        yield* run("mise", [
          ...uv,
          "pip",
          "install",
          "--python",
          hostPython,
          "--require-hashes",
          "-r",
          requirementsPath,
        ])
        yield* run("mise", [
          ...uv,
          "pip",
          "install",
          "--python",
          hostPython,
          "--no-deps",
          request.sourceDirectories[0]!,
        ])
        const installHome = path.join(staging, "seed-home")
        yield* attempt("cannot create Claude seed home", () => mkdir(installHome, { recursive: true }))
        yield* run(hostPython, ["-m", "hyperresearch", "install", "--global", "--profile", "full"], {
          env: { ...process.env, HOME: installHome, PYTHONDONTWRITEBYTECODE: "1" },
        })

        const seed = path.join(request.context, "claude-seed")
        yield* attempt("cannot create managed Claude seed", async () => {
          await mkdir(seed, { recursive: true })
          for (const category of ["skills", "agents"] as const) {
            const source = path.join(installHome, ".claude", category)
            try {
              await cp(source, path.join(seed, category), { recursive: true, errorOnExist: true, force: false })
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
            }
          }
          const browserAgent = path.join(seed, "agents", "hyperresearch-browser-fetcher.md")
          await cp(browserAgentPath, browserAgent, { force: true })
          await writeFile(
            path.join(seed, "default-settings.json"),
            `${JSON.stringify(claudeDefaultSettings, null, 2)}\n`,
            { mode: 0o644 },
          )
          await writeFile(
            path.join(seed, "default-onboarding.json"),
            `${JSON.stringify(claudeDefaultOnboarding, null, 2)}\n`,
            { mode: 0o644 },
          )
        })
        yield* normalizeHyperresearchSeed(seed, path.join(hostVenv, "bin", "hyperresearch"))
        yield* attempt("cannot write managed Claude seed manifest", async () => {
          const manifest = await managedClaudeFiles(seed)
          await writeFile(path.join(seed, "managed-paths.txt"), `${manifest.join("\n")}\n`, { mode: 0o644 })
        })

        yield* attempt("cannot write Hyperresearch wrapper", async () => {
          const wrapper = path.join(request.context, "hyperresearch-wrapper.sh")
          await writeFile(wrapper, '#!/bin/sh\nexec python -m hyperresearch "$@"\n', { mode: 0o755 })
        })

        yield* materializeChromiumArchives(request, staging)

        const obscura = yield* artifact(request, "obscura")
        const obscuraArchive = path.join(staging, "obscura.tar.gz")
        yield* download(obscura, obscuraArchive)
        const tarListing = yield* run("tar", ["-tzf", obscuraArchive])
        if (!safeArchivePaths(tarListing))
          return yield* Effect.fail(new ClaudeMaterializeError({ message: "Obscura archive has unsafe paths" }))
        const obscuraRoot = path.join(request.context, "obscura")
        yield* attempt("cannot create Obscura destination", () => mkdir(obscuraRoot, { recursive: true }))
        yield* run("tar", ["-xzf", obscuraArchive, "-C", obscuraRoot])
        yield* attempt("cannot mark Claude runtime assets executable", async () => {
          await Promise.all([
            chmod(path.join(obscuraRoot, "obscura"), 0o755),
            chmod(path.join(obscuraRoot, "obscura-worker"), 0o755),
          ])
        })
      }),
    (staging) =>
      attempt("cannot clean Claude materialization staging", () => rm(staging, { recursive: true, force: true })).pipe(
        Effect.orDie,
      ),
  )

export const materializeClaudeAssets = (
  request: ClaudeMaterializeRequest,
): Effect.Effect<void, ClaudeMaterializeError> =>
  request.adapter === "claude-marketplace"
    ? materializeClaudeMarketplaceAssets(request)
    : materializeHyperresearchAssets(request)
