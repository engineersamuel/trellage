import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { Data, Effect } from "effect"

import { verifyInventory } from "./inventory.js"
import { renderLock } from "./lock-file.js"
import { hasLegacySourceProvenance, type ProfileLock } from "./lock.js"
import type { ProfileDocument } from "./profile.js"
import { renderCodexConfig, renderMiseConfig } from "./render.js"
import { claudeDefaultSettings, materializeClaudeAssets } from "./claude-materialize.js"
import {
  createRuntimeSupportSnapshot,
  isRuntimeSupportSnapshot,
  runtimeSupportFile,
  type RuntimeSupportPaths,
  type RuntimeSupportSnapshot,
  writeRuntimeSupportSnapshot,
} from "./runtime-support.js"

export type PluginGenerator = (
  sourceDirectory: string,
  selections: ReadonlyArray<string>,
  destination: string,
) => Effect.Effect<void, unknown>

export type SkillGenerator = (
  sourceDirectory: string,
  selections: ReadonlyArray<string>,
  destination: string,
) => Effect.Effect<void, unknown>

export type RuntimeSupport = RuntimeSupportPaths

export interface ClaudeMaterializeRequest {
  readonly sourceDirectory: string
  readonly context: string
  readonly lock: ProfileLock
  readonly requirementsPath: string
  readonly browserAgentPath: string
}

export type ClaudeMaterializer = (request: ClaudeMaterializeRequest) => Effect.Effect<void, unknown>

export class MaterializeError extends Data.TaggedError("MaterializeError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const io = <A>(message: string, operation: () => Promise<A>): Effect.Effect<A, MaterializeError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new MaterializeError({ message, cause }),
  })

const copy = (source: string, destination: string): Effect.Effect<void, MaterializeError> =>
  io(`cannot copy build asset: ${source}`, async () => {
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    })
  })

const copyCodexTree = (source: string, context: string): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* () {
    for (const category of ["skills", "agents"] as const) {
      const directory = path.join(source, category)
      const exists = yield* io("cannot inspect plugin output", async () => {
        try {
          return (await import("node:fs/promises").then(({ stat }) => stat(directory))).isDirectory()
        } catch {
          return false
        }
      })
      if (exists) {
        const entries = yield* io("cannot enumerate plugin output", () =>
          import("node:fs/promises").then(({ readdir }) => readdir(directory)),
        )
        for (const entry of entries.sort()) {
          yield* copy(path.join(directory, entry), path.join(context, "assets", category, entry))
        }
      }
    }
  })

const hasLegacyInventoryIntegrity = (source: ProfileLock["sources"][number]): boolean => {
  if (!source.files.every((file) => file.kind === "file" && file.executable !== true)) return false
  const legacyFiles = source.files.map((file) => ({
    path: file.path,
    sha256: "sha256" in file ? file.sha256 : "",
  }))
  const integrity = `sha256:${createHash("sha256").update(JSON.stringify(legacyFiles)).digest("hex")}`
  return source.integrity === integrity
}

export const createBuildContext = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  runtimeSupport: RuntimeSupportSnapshot | RuntimeSupport | string,
  temporaryParent: string,
  generateSkills: SkillGenerator,
  generatePlugin: PluginGenerator,
  materializeClaude: ClaudeMaterializer = materializeClaudeAssets,
): Effect.Effect<string, MaterializeError> =>
  Effect.gen(function* () {
    if (document.profile.harness.kind !== lock.packages.harness.kind) {
      return yield* Effect.fail(
        new MaterializeError({
          message: "profile and lock harness kinds do not match",
        }),
      )
    }
    if (document.profile.harness.kind !== "codex" && typeof runtimeSupport === "string") {
      return yield* Effect.fail(
        new MaterializeError({
          message: "non-Codex build context materialization requires a runtime support bundle",
        }),
      )
    }
    const harnessPackage = lock.packages.harness
    if (sourceDirectories.length !== lock.sources.length) {
      return yield* Effect.fail(new MaterializeError({ message: "resolved source count does not match lock" }))
    }
    for (let index = 0; index < sourceDirectories.length; index += 1) {
      const source = lock.sources[index]!
      const legacyCodexInventory =
        document.profile.harness.kind === "codex" &&
        hasLegacySourceProvenance(lock, index) &&
        hasLegacyInventoryIntegrity(source)
      yield* verifyInventory(sourceDirectories[index]!, source.files, {
        allowSymlinks: source.adapter === "copilot-marketplace",
        verifyExecutableBits: !legacyCodexInventory,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new MaterializeError({ message: `source inventory mismatch: ${lock.sources[index]!.repository}`, cause }),
        ),
      )
    }
    if (document.profile.harness.kind === "copilot") {
      const profilePlugin = document.profile.plugins[0]
      const source = lock.sources[0]
      if (
        document.profile.plugins.length !== 1 ||
        lock.sources.length !== 1 ||
        sourceDirectories.length !== 1 ||
        profilePlugin === undefined ||
        !("marketplace" in profilePlugin) ||
        source === undefined ||
        source.kind !== "plugin" ||
        source.adapter !== "copilot-marketplace" ||
        source.marketplace !== profilePlugin.marketplace ||
        source.repository !== profilePlugin.repository ||
        source.ref !== profilePlugin.ref ||
        JSON.stringify(source.select) !== JSON.stringify(profilePlugin.select)
      ) {
        return yield* Effect.fail(
          new MaterializeError({
            message: "Copilot build requires exactly one matching marketplace source",
          }),
        )
      }
    }
    if (document.profile.harness.kind === "claude") {
      const claudeMode = document.profile.harness.claude.mode ?? "hyperresearch"
      const profilePlugin = document.profile.plugins[0]
      const source = lock.sources[0]
      if (
        claudeMode === "hyperresearch" &&
        (document.profile.plugins.length !== 1 ||
          lock.sources.length !== 1 ||
          sourceDirectories.length !== 1 ||
          profilePlugin === undefined ||
          source === undefined ||
          source.kind !== "plugin" ||
          source.adapter !== "hyperresearch" ||
          profilePlugin.adapter !== "hyperresearch" ||
          source.repository !== profilePlugin.repository ||
          source.ref !== profilePlugin.ref ||
          JSON.stringify(source.select) !== JSON.stringify(profilePlugin.select))
      ) {
        return yield* Effect.fail(
          new MaterializeError({ message: "Claude build requires one matching Hyperresearch source" }),
        )
      }
    }

    const support = yield* (
      isRuntimeSupportSnapshot(runtimeSupport)
        ? Effect.succeed(runtimeSupport)
        : createRuntimeSupportSnapshot(
            document.profile.harness.kind,
            typeof runtimeSupport === "string"
              ? { codexEntry: runtimeSupport, copilotEntry: "", finalizeCopilotSeed: "" }
              : runtimeSupport,
            undefined,
            document.profile.harness.kind === "claude"
              ? (document.profile.harness.claude.mode ?? "hyperresearch")
              : "hyperresearch",
          )
    ).pipe(Effect.mapError((cause) => new MaterializeError({ message: cause.message, cause })))
    if (support.harnessKind !== document.profile.harness.kind) {
      return yield* Effect.fail(
        new MaterializeError({ message: "runtime support snapshot harness kind does not match profile" }),
      )
    }

    const initialPromptPath = document.resolvedInitialPrompt
    const initialPromptBytes =
      initialPromptPath === undefined
        ? undefined
        : yield* io("cannot read initial prompt", () => readFile(initialPromptPath))
    if (initialPromptBytes !== undefined) {
      const integrity = `sha256:${createHash("sha256").update(initialPromptBytes).digest("hex")}`
      if (integrity !== document.initialPromptIntegrity) {
        return yield* Effect.fail(
          new MaterializeError({
            message: "initial prompt changed after profile validation; rerun profile validation and build",
          }),
        )
      }
    }

    yield* io("cannot create build-context parent", () => mkdir(temporaryParent, { recursive: true }))
    const context = yield* io("cannot create temporary build context", () =>
      mkdtemp(path.join(temporaryParent, "trellage-build-")),
    )
    const build = Effect.gen(function* () {
      yield* writeRuntimeSupportSnapshot(support, context).pipe(
        Effect.mapError((cause) => new MaterializeError({ message: cause.message, cause })),
      )
      if (document.profile.harness.kind === "codex") {
        yield* io("cannot initialize build context", () =>
          Promise.all([
            mkdir(path.join(context, "assets", "skills"), { recursive: true }),
            mkdir(path.join(context, "assets", "agents"), { recursive: true }),
          ]).then(() => undefined),
        )
      }

      if (document.profile.harness.kind === "copilot") {
        yield* copy(sourceDirectories[0]!, path.join(context, "hve-core"))
        yield* verifyInventory(path.join(context, "hve-core"), lock.sources[0]!.files, { allowSymlinks: true }).pipe(
          Effect.mapError(
            (cause) => new MaterializeError({ message: "copied Copilot source inventory mismatch", cause }),
          ),
        )
      }

      if (
        document.profile.harness.kind === "claude" &&
        (document.profile.harness.claude.mode ?? "hyperresearch") === "hyperresearch"
      ) {
        const requirements = runtimeSupportFile(support, "hyperresearch-requirements")
        const browserAgent = runtimeSupportFile(support, "claude-browser-agent")
        yield* materializeClaude({
          sourceDirectory: sourceDirectories[0]!,
          context,
          lock,
          requirementsPath: path.join(context, requirements.buildContextPath),
          browserAgentPath: path.join(context, browserAgent.buildContextPath),
        }).pipe(
          Effect.mapError((cause) => new MaterializeError({ message: "Claude asset materialization failed", cause })),
        )
      }

      if (document.profile.harness.kind === "pi") {
        const seed = path.join(context, "pi-seed")
        const skills = path.join(seed, "skills")
        yield* io("cannot initialize Pi seed", () => mkdir(skills, { recursive: true }))
        const sourceIndex = lock.sources.findIndex(
          (source) => source.kind === "skill" && source.adapter === "omp-native",
        )
        const managedSkills: Array<string> = []
        if (sourceIndex >= 0) {
          const source = lock.sources[sourceIndex]!
          const sourceDirectory = sourceDirectories[sourceIndex]!
          for (const selection of [...source.select].sort()) {
            yield* copy(path.join(sourceDirectory, ".omp", "skills", selection), path.join(skills, selection))
            managedSkills.push(selection)
          }
        }
        yield* io("cannot write Pi managed skill manifest", () =>
          writeFile(path.join(seed, "managed-skills.txt"), managedSkills.map((name) => `${name}\n`).join("")),
        )
      }

      if (
        document.profile.harness.kind === "claude" &&
        (document.profile.harness.claude.mode ?? "hyperresearch") === "core"
      ) {
        yield* io("cannot initialize Claude core seed", async () => {
          const seed = path.join(context, "claude-seed")
          await mkdir(seed, { recursive: true })
          await writeFile(
            path.join(seed, "default-settings.json"),
            `${JSON.stringify(claudeDefaultSettings, null, 2)}\n`,
          )
          await writeFile(path.join(seed, "managed-paths.txt"), "")
        })
      }

      for (let index = 0; document.profile.harness.kind === "codex" && index < lock.sources.length; index += 1) {
        const sourceLock = lock.sources[index]!
        const sourceDirectory = sourceDirectories[index]!
        if (sourceLock.kind === "skill") {
          const generated = path.join(context, `.skills-generated-${index}`)
          yield* io("cannot create skills generation directory", () => mkdir(generated, { recursive: true }))
          yield* generateSkills(sourceDirectory, sourceLock.select, generated).pipe(
            Effect.mapError((cause) => new MaterializeError({ message: "Skills CLI generation failed", cause })),
          )
          const skillRoot = path.join(generated, ".agents", "skills")
          const entries = yield* io("cannot enumerate Skills CLI output", () =>
            import("node:fs/promises").then(({ readdir }) => readdir(skillRoot)),
          )
          for (const selection of entries.sort()) {
            yield* copy(path.join(skillRoot, selection), path.join(context, "assets", "skills", selection))
          }
          yield* io("cannot remove skills generation staging", () => rm(generated, { recursive: true, force: true }))
          continue
        }
        if (sourceLock.adapter === "codex-native") {
          for (const selection of sourceLock.select) {
            yield* copyCodexTree(path.join(sourceDirectory, "plugins", selection, ".codex"), context)
          }
          continue
        }
        const generated = path.join(context, `.plugin-generated-${index}`)
        yield* io("cannot create plugin generation directory", () => mkdir(generated, { recursive: true }))
        yield* generatePlugin(sourceDirectory, sourceLock.select, generated).pipe(
          Effect.mapError(
            (cause) => new MaterializeError({ message: "compatibility plugin generation failed", cause }),
          ),
        )
        yield* copyCodexTree(path.join(generated, ".codex"), context)
        yield* io("cannot remove plugin generation staging", () => rm(generated, { recursive: true, force: true }))
      }

      const packageVersions = Object.fromEntries(lock.packages.runtime.map((entry) => [entry.name, entry.version]))
      const baseReference = lock.image.base.includes("@sha256:")
        ? lock.image.base
        : `docker.io/library/${lock.image.base.split(":", 1)[0]}@${lock.image.base_digest}`
      const imageTag = `trellage-profile-${document.profile.name}:locked`
      yield* io("cannot write rendered build context", async () => {
        await mkdir(path.join(context, "build-support"), { recursive: true })
        await writeFile(
          path.join(context, "build-support", "apt-get"),
          `#!/bin/sh
set -eu

/usr/bin/apt-get "$@"

rootfs=
for argument do
  case "$argument" in
    Dir=*) rootfs=\${argument#Dir=} ;;
  esac
done

if [ -n "$rootfs" ]; then
  rm -f "$rootfs/var/cache/ldconfig/aux-cache" "$rootfs/var/log/alternatives.log"
  for package_cache_dir in apt debconf man; do
    if [ -d "$rootfs/var/cache/$package_cache_dir" ]; then
      find "$rootfs/var/cache/$package_cache_dir" -type f -delete
    fi
  done
fi
`,
          { mode: 0o755 },
        )
        if (document.profile.harness.kind === "codex") {
          await writeFile(path.join(context, "codex-config.toml"), renderCodexConfig(document.profile))
        }
        await writeFile(
          path.join(context, "mise.toml"),
          renderMiseConfig(document.profile, lock, {
            baseReference,
            imageTag,
            packageVersions,
            runtimeSupport: support,
          }),
        )
        await writeFile(path.join(context, "profile.lock.toml"), renderLock(lock))
        const executable = harnessPackage.kind
        const installedExecutable = harnessPackage.kind === "pi" ? "omp" : executable
        const misePlatform = document.profile.image.platform === "linux/arm64" ? "linux-arm64" : "linux-x64"
        await writeFile(
          path.join(context, "mise.lock"),
          harnessPackage.kind === "claude" &&
            (document.profile.harness.kind !== "claude" ||
              (document.profile.harness.claude.mode ?? "hyperresearch") !== "core")
            ? `# @generated by Trellage profile compiler

[[tools.node]]
version = "22.17.0"
backend = "core:node"

[tools.node."platforms.${misePlatform}"]
checksum = "sha256:3e99df8b01b27dc8b334a2a30d1cd500442b3b0877d217b308fd61a9ccfc33d4"
url = "https://nodejs.org/dist/v22.17.0/node-v22.17.0-linux-arm64.tar.gz"

[[tools.python]]
version = "3.13.14"
backend = "core:python"

[tools.python."platforms.${misePlatform}"]
checksum = "sha256:1eaf979af6c6986553b91a9e3b03647f63ce52a888e00892d3bddc96f43748e9"
url = "https://github.com/astral-sh/python-build-standalone/releases/download/20260728/cpython-3.13.14+20260728-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz"
provenance = "github-attestations"

[[tools."npm:@anthropic-ai/claude-code"]]
version = "2.1.218"
backend = "npm:@anthropic-ai/claude-code"

[tools."npm:@anthropic-ai/claude-code".options]
npm_args = "--ignore-scripts=false"

[[tools."npm:@playwright/mcp"]]
version = "0.0.78"
backend = "npm:@playwright/mcp"
`
            : harnessPackage.kind === "claude"
              ? `# @generated by Trellage profile compiler

[[tools.node]]
version = "22.17.0"
backend = "core:node"

[tools.node."platforms.${misePlatform}"]
checksum = "sha256:3e99df8b01b27dc8b334a2a30d1cd500442b3b0877d217b308fd61a9ccfc33d4"
url = "https://nodejs.org/dist/v22.17.0/node-v22.17.0-linux-arm64.tar.gz"

[[tools."npm:@anthropic-ai/claude-code"]]
version = "2.1.218"
backend = "npm:@anthropic-ai/claude-code"

[tools."npm:@anthropic-ai/claude-code".options]
npm_args = "--ignore-scripts=false"
`
              : `# @generated by Trellage profile compiler

[[tools."http:${executable}"]]
version = ${JSON.stringify(harnessPackage.version)}
backend = "http:${executable}"

[tools."http:${executable}".options]
rename_exe = "${installedExecutable}"

[tools."http:${executable}"."platforms.${misePlatform}"]
checksum = ${JSON.stringify(harnessPackage.integrity)}
url = ${JSON.stringify(harnessPackage.url)}
`,
        )
        await writeFile(path.join(context, "workspace.keep"), "")
        if (document.profile.harness.kind === "pi") {
          await writeFile(
            path.join(context, "pi-config.yml"),
            "startup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: off\n",
          )
        }
        if (document.profile.harness.kind === "copilot") {
          await mkdir(path.join(context, "copilot-seed"), { recursive: true })
        }
        if (initialPromptBytes !== undefined) {
          await writeFile(path.join(context, "initial-prompt.md"), initialPromptBytes)
        }
      })
      return context
    })
    return yield* build.pipe(
      Effect.catchAll((cause) =>
        io("cannot clean failed build context", () => rm(context, { recursive: true, force: true })).pipe(
          Effect.zipRight(Effect.fail(cause)),
        ),
      ),
    )
  })
