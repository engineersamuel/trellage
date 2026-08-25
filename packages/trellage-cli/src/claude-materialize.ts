import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
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

export const claudeDefaultOnboarding = (version: string) => ({
  hasCompletedOnboarding: true,
  lastOnboardingVersion: version,
  theme: "dark",
  shiftEnterKeyBindingInstalled: true,
})

export class ClaudeMaterializeError extends Data.TaggedError("ClaudeMaterializeError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const exactPluginVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * After inventory verification, stamp locked plugin versions into the build-context
 * marketplace copy so `claude plugin install` registers the same version finalize expects.
 * Upstream may omit versions (e.g. caveman); the lock holds the ref-derived fallback.
 * Must run only after verifyInventory against the pristine locked tree.
 */
export const stampClaudeMarketplaceVersions = async (
  marketplaceRoot: string,
  pluginVersions: Readonly<Record<string, string>>,
): Promise<void> => {
  const marketplacePath = path.join(marketplaceRoot, ".claude-plugin", "marketplace.json")
  const marketplaceSource = await readFile(marketplacePath, "utf8")
  const marketplace = JSON.parse(marketplaceSource) as {
    plugins?: Array<{ name?: string; version?: string; [key: string]: unknown }>
    [key: string]: unknown
  }
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error("Claude marketplace metadata plugins array is missing")
  }
  const remaining = new Set(Object.keys(pluginVersions))
  for (const plugin of marketplace.plugins) {
    if (typeof plugin.name !== "string" || !remaining.has(plugin.name)) continue
    const locked = pluginVersions[plugin.name]!
    if (!exactPluginVersion.test(locked)) {
      throw new Error(`Claude plugin locked version is not exact: ${plugin.name}`)
    }
    const existing = plugin.version
    if (existing !== undefined && existing !== locked) {
      throw new Error(
        `Claude plugin version conflict for ${plugin.name}: marketplace has ${existing}, lock has ${locked}`,
      )
    }
    plugin.version = locked
    remaining.delete(plugin.name)
  }
  if (remaining.size > 0) {
    throw new Error(`Claude plugin versions missing from marketplace metadata: ${[...remaining].sort().join(", ")}`)
  }
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, { mode: 0o644 })

  const pluginManifestPath = path.join(marketplaceRoot, ".claude-plugin", "plugin.json")
  try {
    const pluginSource = await readFile(pluginManifestPath, "utf8")
    const pluginManifest = JSON.parse(pluginSource) as { name?: string; version?: string; [key: string]: unknown }
    if (typeof pluginManifest.name === "string" && Object.hasOwn(pluginVersions, pluginManifest.name)) {
      const locked = pluginVersions[pluginManifest.name]!
      const existing = pluginManifest.version
      if (existing !== undefined && existing !== locked) {
        throw new Error(
          `Claude plugin.json version conflict for ${pluginManifest.name}: has ${existing}, lock has ${locked}`,
        )
      }
      pluginManifest.version = locked
      await writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`, { mode: 0o644 })
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
  }
}

const attempt = <A>(message: string, operation: () => Promise<A>): Effect.Effect<A, ClaudeMaterializeError> =>
  Effect.tryPromise({ try: operation, catch: (cause) => new ClaudeMaterializeError({ message, cause }) })

export const normalizeHyperresearchSitePermissions = (
  sitePackages: string,
): Effect.Effect<void, ClaudeMaterializeError> =>
  attempt("cannot normalize Hyperresearch site permissions", async () => {
    const visit = async (entryPath: string): Promise<void> => {
      const entry = await lstat(entryPath)
      if (entry.isSymbolicLink()) return
      if (entry.isDirectory()) {
        await chmod(entryPath, 0o755)
        await Promise.all((await readdir(entryPath)).map((name) => visit(path.join(entryPath, name))))
        return
      }
      if (entry.isFile()) {
        await chmod(entryPath, (entry.mode & 0o111) === 0 ? 0o644 : 0o755)
      }
    }

    await visit(sitePackages)
  })

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
  await visit("output-styles")
  try {
    const instructions = path.join(root, "CLAUDE.md")
    const status = await lstat(instructions)
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error("managed Claude seed contains an unsafe CLAUDE.md")
    }
    found.push("CLAUDE.md")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
  }
  return found.sort()
}

export const hyperresearchSeedInstallArguments = (installHome: string): ReadonlyArray<ReadonlyArray<string>> => [
  ["-m", "hyperresearch", "install", "--global", "--profile", "light"],
  ["-m", "hyperresearch", "install", "--steps-only", installHome, "--profile", "light"],
]

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

const vulnerableHyperresearchHookLoop = `\
    for entry in pre_tool:
        if isinstance(entry, dict):
            for h in entry.get("hooks", []):
                if "hyperresearch" in h.get("command", ""):
                    return None

    pre_tool.append({`

const portableHyperresearchHookLoop = `\
    hook_command = 'node "$CLAUDE_PROJECT_DIR/.hyperresearch/hook.cjs"'
    for entry in pre_tool:
        if isinstance(entry, dict):
            for h in entry.get("hooks", []):
                command = h.get("command", "")
                if "hyperresearch" not in command:
                    continue
                if command == hook_command:
                    return None
                h["command"] = hook_command
                settings_path.write_text(json.dumps(settings, indent=2) + "\\n", encoding="utf-8")
                return "Claude Code: .claude/settings.json (PreToolUse hook updated)"

    pre_tool.append({`

const vulnerableHyperresearchHookCommand = '            "command": f"node {hook_path.as_posix()}",'
const portableHyperresearchHookCommand = '            "command": hook_command,'
const vulnerableHyperresearchHookScriptPath = '    hook_path = hook_dir / "hook.js"'
const portableHyperresearchHookScriptPath = '    hook_path = hook_dir / "hook.cjs"'

const replaceExactlyOnce = (source: string, vulnerable: string, portable: string): string => {
  const first = source.indexOf(vulnerable)
  if (first < 0 || source.indexOf(vulnerable, first + vulnerable.length) >= 0) {
    throw new Error("unsupported Hyperresearch project hook installer source")
  }
  return `${source.slice(0, first)}${portable}${source.slice(first + vulnerable.length)}`
}

export const normalizeHyperresearchHookInstaller = (
  sitePackages: string,
): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.tryPromise({
    try: async () => {
      const hooksPath = path.join(sitePackages, "hyperresearch", "core", "hooks.py")
      const source = await readFile(hooksPath, "utf8")
      const portableFragments = [
        portableHyperresearchHookScriptPath,
        `hook_command = 'node "$CLAUDE_PROJECT_DIR/.hyperresearch/hook.cjs"'`,
        'if "hyperresearch" not in command:',
        "if command == hook_command:",
        'h["command"] = hook_command',
        portableHyperresearchHookCommand,
      ] as const
      if (portableFragments.every((fragment) => source.includes(fragment))) {
        if (
          source.includes(vulnerableHyperresearchHookLoop) ||
          source.includes(vulnerableHyperresearchHookCommand) ||
          source.includes(vulnerableHyperresearchHookScriptPath)
        ) {
          throw new Error("unsupported Hyperresearch project hook installer source")
        }
        return
      }
      if (portableFragments.some((fragment) => source.includes(fragment))) {
        throw new Error("unsupported Hyperresearch project hook installer source")
      }

      const normalizedLoop = replaceExactlyOnce(source, vulnerableHyperresearchHookLoop, portableHyperresearchHookLoop)
      const normalized = replaceExactlyOnce(
        normalizedLoop,
        vulnerableHyperresearchHookCommand,
        portableHyperresearchHookCommand,
      )
      const normalizedScriptPath = replaceExactlyOnce(
        normalized,
        vulnerableHyperresearchHookScriptPath,
        portableHyperresearchHookScriptPath,
      )
      await writeFile(hooksPath, normalizedScriptPath)
    },
    catch: (cause) =>
      new ClaudeMaterializeError({
        message: `cannot normalize Hyperresearch project hook installer${
          cause instanceof Error ? `: ${cause.message}` : ""
        }`,
        cause,
      }),
  })

export const materializeHyperresearchPackage = (
  sourceDirectory: string,
  sitePackages: string,
  executable?: string,
): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.gen(function* () {
    yield* attempt("cannot materialize Hyperresearch Python package", () =>
      cp(path.join(sourceDirectory, "src", "hyperresearch"), path.join(sitePackages, "hyperresearch"), {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      }),
    )
    yield* normalizeHyperresearchHookInstaller(sitePackages)
    if (executable !== undefined) {
      yield* attempt("cannot materialize Hyperresearch executable", () =>
        writeFile(executable, '#!/bin/sh\nexec "$(dirname "$0")/python" -m hyperresearch "$@"\n', {
          mode: 0o755,
        }),
      )
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
      const pluginVersions = source.plugin_versions
      const marketplace = path.join(request.context, `claude-marketplace-${index}`)
      yield* attempt("cannot copy Claude marketplace source", () =>
        cp(sourceDirectory, marketplace, {
          recursive: true,
          errorOnExist: true,
          force: false,
          verbatimSymlinks: true,
        }),
      )
      yield* verifyInventory(marketplace, source.files, { allowSymlinks: true }).pipe(
        Effect.mapError(
          (cause) => new ClaudeMaterializeError({ message: "copied Claude marketplace inventory mismatch", cause }),
        ),
      )
      yield* attempt("cannot stamp locked Claude marketplace plugin versions", () =>
        stampClaudeMarketplaceVersions(marketplace, pluginVersions),
      )
      marketplaces.push({
        marketplace: source.marketplace,
        source: `/src/claude-marketplace-${index}`,
        commit: source.commit,
        plugins: source.select.map((plugin) => ({
          plugin,
          version: pluginVersions[plugin]!,
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
        writeFile(
          path.join(seed, "default-onboarding.json"),
          `${JSON.stringify(claudeDefaultOnboarding(request.lock.packages.harness.version), null, 2)}\n`,
          { mode: 0o644 },
        ),
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

        const uv = ["x", "uv@0.11.21", "--", "uv"]
        const pythonPackage = path.join(request.context, "hyperresearch-package")
        yield* attempt("cannot create Hyperresearch package target", () => mkdir(pythonPackage, { recursive: true }))
        yield* materializeHyperresearchPackage(request.sourceDirectories[0]!, pythonPackage)
        yield* normalizeHyperresearchSitePermissions(pythonPackage)

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
        const hostSitePackages = (yield* run(hostPython, [
          "-c",
          "import site; print(site.getsitepackages()[0])",
        ])).trim()
        const resolvedHostVenv = yield* attempt("cannot resolve Hyperresearch host venv", () => realpath(hostVenv))
        const resolvedHostSitePackages = yield* attempt("cannot resolve Hyperresearch host site-packages", () =>
          realpath(hostSitePackages),
        )
        if (
          !path.isAbsolute(hostSitePackages) ||
          (resolvedHostSitePackages !== resolvedHostVenv &&
            !resolvedHostSitePackages.startsWith(`${resolvedHostVenv}${path.sep}`))
        ) {
          return yield* Effect.fail(
            new ClaudeMaterializeError({ message: "Hyperresearch host site-packages escaped the staging venv" }),
          )
        }
        yield* materializeHyperresearchPackage(
          request.sourceDirectories[0]!,
          resolvedHostSitePackages,
          path.join(hostVenv, "bin", "hyperresearch"),
        )
        const installHome = path.join(staging, "seed-home")
        yield* attempt("cannot create Claude seed home", () => mkdir(installHome, { recursive: true }))
        for (const args of hyperresearchSeedInstallArguments(installHome)) {
          yield* run(hostPython, args, {
            env: { ...process.env, HOME: installHome, PYTHONDONTWRITEBYTECODE: "1" },
          })
        }

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
            `${JSON.stringify(claudeDefaultOnboarding(request.lock.packages.harness.version), null, 2)}\n`,
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
