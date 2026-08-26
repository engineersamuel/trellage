import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Data, Effect } from "effect"

import { verifyInventory } from "./inventory.js"
import { renderLock } from "./lock-file.js"
import { hasLegacySourceProvenance, type ProfileLock } from "./lock.js"
import {
  claudeHasBeads,
  claudeHasCodexReviewer,
  claudeHasSerena,
  claudePypiToolNames,
  isClaudeProfile,
  isPrimeProfile,
  type ClaudeProfile,
  type PrimeProfile,
  type ProfileDocument,
} from "./profile.js"
import { renderCodexConfig, renderCodexConfiguration, renderMiseConfig } from "./render.js"
import {
  claudeDefaultOnboarding,
  claudeDefaultSettings,
  claudeDefaultUserSettings,
  managedClaudeFiles,
  materializeClaudeAssets,
  materializeClaudeExtraRuntime,
} from "./claude-materialize.js"
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

export type RuntimeSupport = RuntimeSupportPaths

export interface ClaudeMaterializeRequest {
  readonly adapter: "claude-marketplace" | "hyperresearch"
  readonly sourceDirectories: ReadonlyArray<string>
  readonly context: string
  readonly lock: ProfileLock
  readonly requirementsPath?: string
  readonly browserAgentPath?: string
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

const primeModels = {
  providers: {
    "copilot-proxy-rs": {
      baseUrl: "http://copilot-proxy-rs:8080",
      api: "anthropic-messages",
      apiKey: "trellage-local-proxy",
      compat: { supportsEagerToolInputStreaming: false },
      models: [{ id: "claude-opus-5" }],
    },
  },
} as const

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

type RuntimeSupportInput = RuntimeSupportSnapshot | RuntimeSupport | string
type ProfilePlugin = ProfileDocument["profile"]["plugins"][number]

const buildRequestError = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  runtimeSupport: RuntimeSupportInput,
): string | undefined => {
  if (document.profile.harness.kind !== lock.packages.harness.kind) {
    return "profile and lock harness kinds do not match"
  }
  if (document.profile.harness.kind !== "codex" && typeof runtimeSupport === "string") {
    return "non-Codex build context materialization requires a runtime support bundle"
  }
  return sourceDirectories.length === lock.sources.length ? undefined : "resolved source count does not match lock"
}

const verifySourceDirectories = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* verifyResolvedSources() {
    for (let index = 0; index < sourceDirectories.length; index += 1) {
      const source = lock.sources[index]!
      const legacyCodexInventory =
        document.profile.harness.kind === "codex" &&
        hasLegacySourceProvenance(lock, index) &&
        hasLegacyInventoryIntegrity(source)
      yield* verifyInventory(sourceDirectories[index]!, source.files, {
        allowSymlinks: source.adapter === "copilot-marketplace" || source.adapter === "claude-marketplace",
        verifyExecutableBits: !legacyCodexInventory,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new MaterializeError({ message: `source inventory mismatch: ${lock.sources[index]!.repository}`, cause }),
        ),
      )
    }
  })

const sourceMatchesPlugin = (source: ProfileLock["sources"][number] | undefined, plugin: ProfilePlugin): boolean =>
  source !== undefined &&
  source.kind === "plugin" &&
  source.adapter === plugin.adapter &&
  source.repository === plugin.repository &&
  source.ref === plugin.ref &&
  JSON.stringify(source.select) === JSON.stringify(plugin.select)

const copilotSourceError = (document: ProfileDocument, lock: ProfileLock): string | undefined => {
  if (document.profile.harness.kind !== "copilot") return undefined
  const profilePlugin = document.profile.plugins[0]
  const source = lock.sources[0]
  const matchesMarketplace =
    profilePlugin !== undefined && "marketplace" in profilePlugin && source?.marketplace === profilePlugin.marketplace
  return document.profile.plugins.length === 1 &&
    lock.sources.length === 1 &&
    profilePlugin !== undefined &&
    source?.adapter === "copilot-marketplace" &&
    matchesMarketplace &&
    sourceMatchesPlugin(source, profilePlugin)
    ? undefined
    : "Copilot build requires exactly one matching marketplace source"
}

const claudeSourceError = (document: ProfileDocument, lock: ProfileLock): string | undefined => {
  if (document.profile.harness.kind !== "claude" || document.profile.plugins.length === 0) return undefined
  if (document.profile.plugins.length !== lock.sources.length) return "Claude build requires matching plugin sources"
  for (let index = 0; index < document.profile.plugins.length; index += 1) {
    if (!sourceMatchesPlugin(lock.sources[index], document.profile.plugins[index]!)) {
      return "Claude build requires matching plugin sources"
    }
  }
  return undefined
}

const profileSourceError = (document: ProfileDocument, lock: ProfileLock): string | undefined =>
  copilotSourceError(document, lock) ?? claudeSourceError(document, lock)

const claudeRuntimeAdapter = (document: ProfileDocument): "claude-marketplace" | "hyperresearch" | undefined => {
  if (document.profile.harness.kind !== "claude") return undefined
  const adapter = document.profile.plugins[0]?.adapter
  return adapter === "claude-marketplace" || adapter === "hyperresearch" ? adapter : undefined
}

const resolveRuntimeSupport = (
  document: ProfileDocument,
  runtimeSupport: RuntimeSupportInput,
): Effect.Effect<RuntimeSupportSnapshot, MaterializeError> => {
  const support = isRuntimeSupportSnapshot(runtimeSupport)
    ? Effect.succeed(runtimeSupport)
    : createRuntimeSupportSnapshot(
        document.profile.harness.kind,
        typeof runtimeSupport === "string"
          ? { codexEntry: runtimeSupport, copilotEntry: "", finalizeCopilotSeed: "" }
          : runtimeSupport,
        claudeRuntimeAdapter(document),
        document.profile.harness.kind === "claude"
          ? (document.profile.harness.claude.mode ?? "hyperresearch")
          : "hyperresearch",
      )
  return support.pipe(
    Effect.mapError((cause) => new MaterializeError({ message: cause.message, cause })),
    Effect.flatMap((snapshot) =>
      snapshot.harnessKind === document.profile.harness.kind
        ? Effect.succeed(snapshot)
        : Effect.fail(
            new MaterializeError({ message: "runtime support snapshot harness kind does not match profile" }),
          ),
    ),
  )
}

const readInitialPrompt = (document: ProfileDocument): Effect.Effect<Buffer | undefined, MaterializeError> => {
  if (document.resolvedInitialPrompt === undefined) return Effect.succeed(undefined)
  return io("cannot read initial prompt", () => readFile(document.resolvedInitialPrompt!)).pipe(
    Effect.flatMap((bytes) => {
      const integrity = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
      return integrity === document.initialPromptIntegrity
        ? Effect.succeed(bytes)
        : Effect.fail(
            new MaterializeError({
              message: "initial prompt changed after profile validation; rerun profile validation and build",
            }),
          )
    }),
  )
}

const initializeBuildContext = (
  support: RuntimeSupportSnapshot,
  context: string,
  harnessKind: ProfileDocument["profile"]["harness"]["kind"],
): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* initializeContext() {
    yield* writeRuntimeSupportSnapshot(support, context).pipe(
      Effect.mapError((cause) => new MaterializeError({ message: cause.message, cause })),
    )
    if (harnessKind !== "codex") return
    yield* io("cannot initialize build context", () =>
      Promise.all([
        mkdir(path.join(context, "assets", "skills"), { recursive: true }),
        mkdir(path.join(context, "assets", "agents"), { recursive: true }),
      ]).then(() => undefined),
    )
  })

const materializeCopilotProfileAssets = (
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  support: RuntimeSupportSnapshot,
  context: string,
): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* materializeCopilotAssets() {
    yield* copy(sourceDirectories[0]!, path.join(context, "hve-core"))
    yield* verifyInventory(path.join(context, "hve-core"), lock.sources[0]!.files, {
      allowSymlinks: true,
    }).pipe(
      Effect.mapError((cause) => new MaterializeError({ message: "copied Copilot source inventory mismatch", cause })),
    )
    const instruction = runtimeSupportFile(support, "copilot-instruction-rundown")
    yield* copy(
      path.join(context, instruction.buildContextPath),
      path.join(context, "copilot-seed", "instructions", "rundown.instructions.md"),
    )
  })

const writeClaudeCoreSeed = (context: string, harnessVersion: string): Effect.Effect<void, MaterializeError> =>
  io("cannot initialize Claude core seed", async () => {
    const seed = path.join(context, "claude-seed")
    await mkdir(seed, { recursive: true })
    await writeFile(path.join(seed, "default-settings.json"), `${JSON.stringify(claudeDefaultSettings, null, 2)}\n`)
    await writeFile(
      path.join(seed, "default-user-settings.json"),
      `${JSON.stringify(claudeDefaultUserSettings, null, 2)}\n`,
    )
    await writeFile(
      path.join(seed, "default-onboarding.json"),
      `${JSON.stringify(claudeDefaultOnboarding(harnessVersion), null, 2)}\n`,
    )
    await writeFile(path.join(seed, "managed-paths.txt"), "")
  })

const materializeClaudePlugins = (
  profile: ClaudeProfile,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  support: RuntimeSupportSnapshot,
  context: string,
  materializeClaude: ClaudeMaterializer,
): Effect.Effect<void, MaterializeError> => {
  if (profile.plugins.length === 0) return Effect.void
  const adapter = profile.plugins[0]?.adapter
  if (adapter !== "hyperresearch" && adapter !== "claude-marketplace") {
    return Effect.fail(new MaterializeError({ message: "unsupported Claude plugin adapter" }))
  }
  const requirements =
    adapter === "hyperresearch" ? runtimeSupportFile(support, "hyperresearch-requirements") : undefined
  const browserAgent = adapter === "hyperresearch" ? runtimeSupportFile(support, "claude-browser-agent") : undefined
  return materializeClaude({
    adapter,
    sourceDirectories,
    context,
    lock,
    ...(requirements === undefined ? {} : { requirementsPath: path.join(context, requirements.buildContextPath) }),
    ...(browserAgent === undefined ? {} : { browserAgentPath: path.join(context, browserAgent.buildContextPath) }),
  }).pipe(Effect.mapError((cause) => new MaterializeError({ message: "Claude asset materialization failed", cause })))
}

const materializeClaudeProfileAssets = (
  profile: ClaudeProfile,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  support: RuntimeSupportSnapshot,
  context: string,
  materializeClaude: ClaudeMaterializer,
): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* materializeClaudeAssetsForProfile() {
    yield* materializeClaudePlugins(profile, lock, sourceDirectories, support, context, materializeClaude)
    if ((profile.harness.claude.mode ?? "hyperresearch") === "core") {
      yield* writeClaudeCoreSeed(context, lock.packages.harness.version)
    }
    const outputStyle = runtimeSupportFile(support, "claude-output-style-rundown")
    yield* copy(
      path.join(context, outputStyle.buildContextPath),
      path.join(context, "claude-seed", "output-styles", "rundown.md"),
    )
    const manifest = yield* io("cannot enumerate managed Claude seed", () =>
      managedClaudeFiles(path.join(context, "claude-seed")),
    )
    yield* io("cannot write managed Claude seed manifest", () =>
      writeFile(path.join(context, "claude-seed", "managed-paths.txt"), `${manifest.join("\n")}\n`),
    )
  })

const materializePiProfileAssets = (context: string): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* materializePiAssets() {
    const seed = path.join(context, "pi-seed")
    yield* io("cannot initialize Pi seed", () => mkdir(path.join(seed, "skills"), { recursive: true }))
    yield* io("cannot write Pi managed skill manifest", () => writeFile(path.join(seed, "managed-skills.txt"), ""))
  })

const primeSourceMatches = (
  sourceLock: ProfileLock["sources"][number] | undefined,
  sourceDirectory: string | undefined,
  profilePlugin: PrimeProfile["plugins"][number],
): sourceLock is ProfileLock["sources"][number] =>
  sourceLock !== undefined &&
  sourceDirectory !== undefined &&
  sourceLock.kind === "plugin" &&
  sourceLock.adapter === "prime-extension" &&
  profilePlugin.adapter === "prime-extension" &&
  sourceLock.repository === profilePlugin.repository &&
  sourceLock.ref === profilePlugin.ref &&
  JSON.stringify(sourceLock.select) === JSON.stringify(profilePlugin.select)

const listPrimeExtensionFiles = (
  extensionsRoot: string,
  selection: string,
): Effect.Effect<ReadonlyArray<string>, MaterializeError> =>
  io(`cannot list Prime extension source: ${selection}`, () => readdir(extensionsRoot, { withFileTypes: true })).pipe(
    Effect.flatMap((entries) => {
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, "en"))
      return files.length === 0
        ? Effect.fail(
            new MaterializeError({ message: `Prime extension selection has no TypeScript files: ${selection}` }),
          )
        : Effect.succeed(files)
    }),
  )

const copyPrimeExtensionFiles = (
  extensionsRoot: string,
  destination: string,
  files: ReadonlyArray<string>,
  managedNames: Array<string>,
): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* copyPrimeExtensions() {
    for (const fileName of files) {
      const extensionName = fileName.slice(0, -".ts".length)
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(extensionName)) {
        return yield* Effect.fail(new MaterializeError({ message: `Prime extension name is unsafe: ${fileName}` }))
      }
      if (managedNames.includes(extensionName)) {
        return yield* Effect.fail(
          new MaterializeError({ message: `managed Prime extension names collide: ${extensionName}` }),
        )
      }
      managedNames.push(extensionName)
      yield* copy(path.join(extensionsRoot, fileName), path.join(destination, fileName))
    }
  })

const materializePrimeSource = (
  sourceLock: ProfileLock["sources"][number],
  sourceDirectory: string,
  destination: string,
  managedNames: Array<string>,
): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* materializeSelectedPrimeExtensions() {
    for (const selection of [...sourceLock.select].sort((left, right) => left.localeCompare(right, "en"))) {
      const extensionsRoot = path.join(sourceDirectory, "plugins", selection, "extensions")
      const files = yield* listPrimeExtensionFiles(extensionsRoot, selection)
      yield* copyPrimeExtensionFiles(extensionsRoot, destination, files, managedNames)
    }
  })

const materializePrimeProfileAssets = (
  profile: PrimeProfile,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  context: string,
): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* materializePrimeAssets() {
    const seed = path.join(context, "prime-seed")
    yield* io("cannot write Prime managed skill manifest", async () => {
      await mkdir(seed, { recursive: true })
      await writeFile(path.join(seed, "managed-skills.txt"), "")
    })
    const extensionsDestination = path.join(seed, "extensions")
    yield* io("cannot initialize Prime extension destination", () => mkdir(extensionsDestination, { recursive: true }))
    const managedNames: Array<string> = []
    for (let index = 0; index < profile.plugins.length; index += 1) {
      const sourceLock = lock.sources[index]
      const sourceDirectory = sourceDirectories[index]
      if (!primeSourceMatches(sourceLock, sourceDirectory, profile.plugins[index]!)) {
        return yield* Effect.fail(
          new MaterializeError({ message: "Prime build requires matching prime-extension sources" }),
        )
      }
      yield* materializePrimeSource(sourceLock, sourceDirectory!, extensionsDestination, managedNames)
    }
    managedNames.sort((left, right) => left.localeCompare(right, "en"))
    yield* io("cannot write Prime managed extension manifest", () =>
      writeFile(path.join(seed, "managed-extensions.txt"), managedNames.map((name) => `${name}\n`).join("")),
    )
  })

const materializeCodexSource = (
  sourceLock: ProfileLock["sources"][number],
  sourceDirectory: string,
  sourceIndex: number,
  context: string,
  generatePlugin: PluginGenerator,
): Effect.Effect<void, MaterializeError> => {
  if (sourceLock.adapter === "codex-native") {
    return Effect.forEach(
      sourceLock.select,
      (selection) => copyCodexTree(path.join(sourceDirectory, "plugins", selection, ".codex"), context),
      { discard: true },
    )
  }
  const generated = path.join(context, `.plugin-generated-${sourceIndex}`)
  return Effect.gen(function* materializeCompatibilityPlugin() {
    yield* io("cannot create plugin generation directory", () => mkdir(generated, { recursive: true }))
    yield* generatePlugin(sourceDirectory, sourceLock.select, generated).pipe(
      Effect.mapError((cause) => new MaterializeError({ message: "compatibility plugin generation failed", cause })),
    )
    yield* copyCodexTree(path.join(generated, ".codex"), context)
    yield* io("cannot remove plugin generation staging", () => rm(generated, { recursive: true, force: true }))
  })
}

const materializeCodexProfileAssets = (
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  context: string,
  generatePlugin: PluginGenerator,
): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* materializeCodexAssets() {
    for (let index = 0; index < lock.sources.length; index += 1) {
      yield* materializeCodexSource(lock.sources[index]!, sourceDirectories[index]!, index, context, generatePlugin)
    }
  })

const claudeToolLock = (
  harness: ProfileLock["packages"]["harness"],
  misePlatform: string,
): string => `[[tools."http:claude"]]
version = ${JSON.stringify(harness.version)}
backend = "http:claude"

[tools."http:claude".options]
rename_exe = "claude"

[tools."http:claude"."platforms.${misePlatform}"]
checksum = ${JSON.stringify(harness.integrity)}
url = ${JSON.stringify(harness.url)}
`

const claudeUvLock = (misePlatform: string): string => {
  const platform =
    misePlatform === "linux-arm64"
      ? {
          checksum: "sha256:e71badaed2a2c3a404a0a00974b51c7ed5f5bc7be947916846005b739c68a5a2",
          asset: "uv-aarch64-unknown-linux-musl.tar.gz",
        }
      : {
          checksum: "sha256:9dadff5b9e7b1d2d011e41852a1cbca713d9d5d88194f2eb6bd240fa4fb0a719",
          asset: "uv-x86_64-unknown-linux-musl.tar.gz",
        }
  return `[[tools.uv]]
version = "0.11.21"
backend = "aqua:astral-sh/uv"

[tools.uv."platforms.${misePlatform}"]
checksum = "${platform.checksum}"
url = "https://github.com/astral-sh/uv/releases/download/0.11.21/${platform.asset}"
provenance = "github-attestations"
`
}

const renderClaudeMiseLock = (
  document: ProfileDocument,
  harness: ProfileLock["packages"]["harness"],
  misePlatform: string,
): string => {
  const toolLock = claudeToolLock(harness, misePlatform)
  if (
    document.profile.harness.kind === "claude" &&
    (document.profile.harness.claude.mode ?? "hyperresearch") === "core"
  ) {
    return `# @generated by Trellage profile compiler

[[tools.node]]
version = "22.17.0"
backend = "core:node"

[tools.node."platforms.${misePlatform}"]
checksum = "sha256:3e99df8b01b27dc8b334a2a30d1cd500442b3b0877d217b308fd61a9ccfc33d4"
url = "https://nodejs.org/dist/v22.17.0/node-v22.17.0-linux-arm64.tar.gz"

${toolLock}
`
  }
  const claudeMarketplace = document.profile.plugins[0]?.adapter === "claude-marketplace"
  const extraPython = isClaudeProfile(document.profile) && claudePypiToolNames(document.profile).length > 0
  const uvLock =
    isClaudeProfile(document.profile) && claudeHasSerena(document.profile) ? claudeUvLock(misePlatform) : ""
  const pythonLock =
    claudeMarketplace && !extraPython
      ? ""
      : `[[tools.python]]
version = "3.13.14"
backend = "core:python"

[tools.python."platforms.${misePlatform}"]
checksum = "sha256:1eaf979af6c6986553b91a9e3b03647f63ce52a888e00892d3bddc96f43748e9"
url = "https://github.com/astral-sh/python-build-standalone/releases/download/20260728/cpython-3.13.14+20260728-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz"
provenance = "github-attestations"

`
  const playwrightLock = claudeMarketplace
    ? ""
    : `[[tools."npm:@playwright/mcp"]]
version = "0.0.78"
backend = "npm:@playwright/mcp"
`
  return `# @generated by Trellage profile compiler

[[tools.node]]
version = "22.17.0"
backend = "core:node"

[tools.node."platforms.${misePlatform}"]
checksum = "sha256:3e99df8b01b27dc8b334a2a30d1cd500442b3b0877d217b308fd61a9ccfc33d4"
url = "https://nodejs.org/dist/v22.17.0/node-v22.17.0-linux-arm64.tar.gz"

${pythonLock}
${toolLock}

${uvLock}
${playwrightLock}
`
}

const renderPrimeMiseLock = (misePlatform: string): string => `# @generated by Trellage profile compiler

[[tools.node]]
version = "22.17.0"
backend = "core:node"

[tools.node."platforms.${misePlatform}"]
checksum = "sha256:3e99df8b01b27dc8b334a2a30d1cd500442b3b0877d217b308fd61a9ccfc33d4"
url = "https://nodejs.org/dist/v22.17.0/node-v22.17.0-linux-arm64.tar.gz"
`

const renderHarnessMiseLock = (harness: ProfileLock["packages"]["harness"], misePlatform: string): string => {
  const executable = harness.kind
  const installedExecutable = harness.kind === "pi" ? "omp" : executable
  return `# @generated by Trellage profile compiler

[[tools."http:${executable}"]]
version = ${JSON.stringify(harness.version)}
backend = "http:${executable}"

[tools."http:${executable}".options]
rename_exe = "${installedExecutable}"

[tools."http:${executable}"."platforms.${misePlatform}"]
checksum = ${JSON.stringify(harness.integrity)}
url = ${JSON.stringify(harness.url)}
`
}

const renderMaterializedMiseLock = (document: ProfileDocument, lock: ProfileLock): string => {
  const harness = lock.packages.harness
  const misePlatform = lock.platform === "linux/arm64" ? "linux-arm64" : "linux-x64"
  if (harness.kind === "claude") return renderClaudeMiseLock(document, harness, misePlatform)
  return harness.kind === "prime" ? renderPrimeMiseLock(misePlatform) : renderHarnessMiseLock(harness, misePlatform)
}

export const createBuildContext = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  runtimeSupport: RuntimeSupportInput,
  temporaryParent: string,
  generatePlugin: PluginGenerator,
  materializeClaude: ClaudeMaterializer = materializeClaudeAssets,
): Effect.Effect<string, MaterializeError> =>
  Effect.gen(function* createProfileBuildContext() {
    const requestError = buildRequestError(document, lock, sourceDirectories, runtimeSupport)
    if (requestError !== undefined) return yield* Effect.fail(new MaterializeError({ message: requestError }))
    yield* verifySourceDirectories(document, lock, sourceDirectories)
    const sourceError = profileSourceError(document, lock)
    if (sourceError !== undefined) return yield* Effect.fail(new MaterializeError({ message: sourceError }))
    const support = yield* resolveRuntimeSupport(document, runtimeSupport)
    const initialPromptBytes = yield* readInitialPrompt(document)

    yield* io("cannot create build-context parent", () => mkdir(temporaryParent, { recursive: true }))
    const context = yield* io("cannot create temporary build context", () =>
      mkdtemp(path.join(temporaryParent, "trellage-build-")),
    )
    const build = Effect.gen(function* materializeBuildContext() {
      yield* initializeBuildContext(support, context, document.profile.harness.kind)
      if (document.profile.harness.kind === "copilot") {
        yield* materializeCopilotProfileAssets(lock, sourceDirectories, support, context)
      }
      if (isClaudeProfile(document.profile)) {
        yield* materializeClaudeProfileAssets(
          document.profile,
          lock,
          sourceDirectories,
          support,
          context,
          materializeClaude,
        )
        if (document.profile.plugins[0]?.adapter === "claude-marketplace") {
          const pythonRequirementsPath =
            claudePypiToolNames(document.profile).length === 0
              ? undefined
              : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/graph-of-loops-requirements.lock")
          yield* materializeClaudeExtraRuntime(document.profile, lock, context, pythonRequirementsPath).pipe(
            Effect.mapError((cause) => new MaterializeError({ message: cause.message, cause })),
          )
        }
      }
      if (document.profile.harness.kind === "pi") {
        yield* materializePiProfileAssets(context)
      }
      if (isPrimeProfile(document.profile)) {
        yield* materializePrimeProfileAssets(document.profile, lock, sourceDirectories, context)
      }
      if (document.profile.harness.kind === "codex") {
        yield* materializeCodexProfileAssets(lock, sourceDirectories, context, generatePlugin)
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
        if (isClaudeProfile(document.profile) && claudeHasCodexReviewer(document.profile)) {
          await writeFile(
            path.join(context, "codex-reviewer-config.toml"),
            `approval_policy = "never"\nsandbox_mode = "danger-full-access"\n\n${renderCodexConfiguration(
              {
                model: "gpt-5.6-sol",
                reasoning_effort: "medium",
                model_provider: "copilot_proxy",
                providers: {
                  copilot_proxy: {
                    name: "Copilot Proxy RS",
                    base_url: "http://copilot-proxy-rs:8080/v1",
                    wire_api: "responses",
                    request_max_retries: 3,
                    stream_max_retries: 5,
                    stream_idle_timeout_ms: 300000,
                  },
                },
              },
              [],
            )}\n[features]\nmulti_agent = true\n`,
          )
          if (claudeHasBeads(document.profile)) {
            const graphOfLoopsPromptPath = path.resolve(
              document.directory,
              "../../.github/prompts/graph-of-loops.prompt.md",
            )
            await writeFile(path.join(context, "codex-graph-of-loops-skill.md"), await readFile(graphOfLoopsPromptPath))
            await writeFile(
              path.join(context, "codex-graph-of-loops-skill.yaml"),
              `interface:
  display_name: "Graph of Loops"
  short_description: "Run a dependency-aware engineering workflow"
  default_prompt: '$graph-of-loops OBJECTIVE="<objective>" CONSTRAINTS="<constraints and evidence>"'
policy:
  allow_implicit_invocation: false
`,
            )
          }
        }
        if (document.profile.harness.kind === "prime") {
          await writeFile(
            path.join(context, "prime-agent-wrapper.sh"),
            '#!/bin/sh\nexec /mise/installs/node/22.17.0/bin/node /usr/local/lib/node_modules/prime-agent/dist/bundle/cli.js "$@"\n',
            { mode: 0o755 },
          )
          await mkdir(path.join(context, "prime-seed"), { recursive: true })
          await writeFile(path.join(context, "prime-seed", "models.json"), `${JSON.stringify(primeModels, null, 2)}\n`)
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
        await writeFile(path.join(context, "mise.lock"), renderMaterializedMiseLock(document, lock))
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
