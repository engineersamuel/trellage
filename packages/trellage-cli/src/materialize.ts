import { createHash } from "node:crypto"
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { Data, Effect } from "effect"

import { verifyInventory } from "./inventory.js"
import { renderLock } from "./lock-file.js"
import { hasLegacySourceProvenance, type HarnessPackageLock, type ProfileLock } from "./lock.js"
import type { ProfileDocument } from "./profile.js"
import { renderCodexConfig, renderMiseConfig } from "./render.js"
import {
  claudeDefaultOnboarding,
  claudeDefaultSettings,
  claudeDefaultUserSettings,
  managedClaudeFiles,
  materializeClaudeAssets,
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

export type SkillGenerator = (
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

interface GeneratedSkill {
  readonly name: string
  readonly alwaysOn: boolean
  readonly instructions: string
}

const verifyGeneratedSkillDirectory = (directory: string, name: string): Effect.Effect<string, MaterializeError> =>
  io(`generated skill is unsafe: ${name}`, async () => {
    const visit = async (candidate: string): Promise<void> => {
      const status = await lstat(candidate)
      if (status.isSymbolicLink()) throw new Error("symlink")
      if (status.isDirectory()) {
        for (const entry of (await readdir(candidate)).sort((left, right) => left.localeCompare(right, "en"))) {
          await visit(path.join(candidate, entry))
        }
      } else if (!status.isFile()) {
        throw new Error("unsupported entry")
      }
    }
    const skill = path.join(directory, name)
    const skillFile = path.join(skill, "SKILL.md")
    const [skillStatus, skillFileStatus] = await Promise.all([lstat(skill), lstat(skillFile)])
    if (!skillStatus.isDirectory() || skillStatus.isSymbolicLink()) throw new Error("skill root")
    if (!skillFileStatus.isFile() || skillFileStatus.isSymbolicLink()) throw new Error("SKILL.md")
    await visit(skill)
    const instructions = await readFile(skillFile, "utf8")
    if (instructions.includes("\r")) throw new Error("SKILL.md must use LF line endings")
    return instructions
  })

const renderAlwaysOnInstructions = (skills: ReadonlyArray<GeneratedSkill>): string =>
  skills
    .filter((skill) => skill.alwaysOn)
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .map((skill) => `# Trellage managed always-on skill: ${skill.name}\n\n${skill.instructions}\n`)
    .join("")

const materializeGenericSkills = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  context: string,
  destination: string,
  generateSkills: SkillGenerator,
): Effect.Effect<ReadonlyArray<GeneratedSkill>, MaterializeError> =>
  Effect.gen(function* () {
    const candidates = document.profile.skills
      .map((skill, index) => ({
        skill,
        source: lock.sources[index],
        sourceDirectory: sourceDirectories[index],
      }))
      .filter((candidate) => candidate.skill.adapter === undefined)
      .sort(
        (left, right) =>
          (left.source?.repository ?? "").localeCompare(right.source?.repository ?? "", "en") ||
          (left.source?.ref ?? "").localeCompare(right.source?.ref ?? "", "en") ||
          JSON.stringify(left.source?.select).localeCompare(JSON.stringify(right.source?.select), "en"),
      )
    const generatedSkills: Array<GeneratedSkill> = []
    for (const candidate of candidates) {
      const { skill, source, sourceDirectory } = candidate
      if (
        source === undefined ||
        sourceDirectory === undefined ||
        source.kind !== "skill" ||
        source.adapter !== undefined ||
        source.repository !== skill.repository ||
        source.ref !== skill.ref ||
        JSON.stringify(source.select) !== JSON.stringify(skill.select)
      ) {
        return yield* Effect.fail(new MaterializeError({ message: "generic skill source does not match lock" }))
      }
      const generated = path.join(
        context,
        `.skills-generated-${createHash("sha256")
          .update(`${source.repository}\u0000${source.ref}\u0000${JSON.stringify(source.select)}`)
          .digest("hex")}`,
      )
      yield* io("cannot create skills generation directory", () => mkdir(generated, { recursive: true }))
      yield* generateSkills(
        sourceDirectory,
        [...source.select].sort((left, right) => left.localeCompare(right, "en")),
        generated,
      ).pipe(Effect.mapError((cause) => new MaterializeError({ message: "Skills CLI generation failed", cause })))
      const skillRoot = path.join(generated, ".agents", "skills")
      const actual = yield* io("cannot enumerate Skills CLI output", () => readdir(skillRoot))
      const expected = [...source.select].sort((left, right) => left.localeCompare(right, "en"))
      actual.sort((left, right) => left.localeCompare(right, "en"))
      if (
        (expected.includes("*") && actual.length === 0) ||
        (!expected.includes("*") && JSON.stringify(actual) !== JSON.stringify(expected))
      ) {
        return yield* Effect.fail(
          new MaterializeError({ message: "Skills CLI output does not match locked selections" }),
        )
      }
      for (const name of actual) {
        const instructions = yield* verifyGeneratedSkillDirectory(skillRoot, name)
        yield* copy(path.join(skillRoot, name), path.join(destination, name))
        generatedSkills.push({ name, alwaysOn: skill.always_on === true, instructions })
      }
      yield* io("cannot remove skills generation staging", () => rm(generated, { recursive: true, force: true }))
    }
    return generatedSkills
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

/** Fail unless the profile and lock agree on the harness kind being materialized. */
const assertHarnessKindMatches = (
  document: ProfileDocument,
  lock: ProfileLock,
): Effect.Effect<void, MaterializeError> =>
  document.profile.harness.kind !== lock.packages.harness.kind
    ? Effect.fail(new MaterializeError({ message: "profile and lock harness kinds do not match" }))
    : Effect.void

/** Fail unless a full runtime support bundle is provided for non-Codex harnesses. */
const assertRuntimeSupportProvided = (
  document: ProfileDocument,
  runtimeSupport: RuntimeSupportSnapshot | RuntimeSupport | string,
): Effect.Effect<void, MaterializeError> =>
  document.profile.harness.kind !== "codex" && typeof runtimeSupport === "string"
    ? Effect.fail(
        new MaterializeError({
          message: "non-Codex build context materialization requires a runtime support bundle",
        }),
      )
    : Effect.void

/** Fail unless the resolved source directories align one-to-one with the lock's sources. */
const assertSourceDirectoryCountMatches = (
  sourceDirectories: ReadonlyArray<string>,
  lock: ProfileLock,
): Effect.Effect<void, MaterializeError> =>
  sourceDirectories.length !== lock.sources.length
    ? Effect.fail(new MaterializeError({ message: "resolved source count does not match lock" }))
    : Effect.void

/** Verify every resolved source directory still matches its locked file inventory. */
const verifySourceInventories = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* () {
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

/** True unless the single locked Copilot marketplace source matches the profile's single plugin, by index. */
const copilotMarketplaceSourceMismatch = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceIndex: number,
): boolean => {
  const profilePlugin = document.profile.plugins[0]
  const source = lock.sources[sourceIndex]
  return (
    document.profile.plugins.length !== 1 ||
    lock.sources.length !== sourceIndex + 1 ||
    profilePlugin === undefined ||
    !("marketplace" in profilePlugin) ||
    source === undefined ||
    source.kind !== "plugin" ||
    source.adapter !== "copilot-marketplace" ||
    source.marketplace !== profilePlugin.marketplace ||
    source.repository !== profilePlugin.repository ||
    source.ref !== profilePlugin.ref ||
    JSON.stringify(source.select) !== JSON.stringify(profilePlugin.select)
  )
}

/** Fail unless a Copilot build has exactly one matching marketplace plugin source. */
const assertCopilotMarketplaceSourceMatches = (
  document: ProfileDocument,
  lock: ProfileLock,
): Effect.Effect<void, MaterializeError> => {
  if (document.profile.harness.kind !== "copilot") return Effect.void
  const sourceIndex = document.profile.skills.length
  return copilotMarketplaceSourceMismatch(document, lock, sourceIndex)
    ? Effect.fail(new MaterializeError({ message: "Copilot build requires exactly one matching marketplace source" }))
    : Effect.void
}

/** Fail unless a single locked plugin source matches its profile counterpart, by index. */
const claudePluginSourceMismatch = (
  profilePlugin: ProfileDocument["profile"]["plugins"][number],
  source: ProfileLock["sources"][number] | undefined,
): boolean =>
  source === undefined ||
  source.kind !== "plugin" ||
  source.adapter !== profilePlugin.adapter ||
  source.repository !== profilePlugin.repository ||
  source.ref !== profilePlugin.ref ||
  JSON.stringify(source.select) !== JSON.stringify(profilePlugin.select)

/** Fail unless every Claude profile plugin has a matching locked plugin source. */
const assertClaudePluginSourcesMatch = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
): Effect.Effect<void, MaterializeError> => {
  if (document.profile.harness.kind !== "claude" || document.profile.plugins.length === 0) return Effect.void
  const sourceOffset = document.profile.skills.length
  if (
    document.profile.plugins.length !== lock.sources.length - sourceOffset ||
    lock.sources.length !== sourceDirectories.length
  ) {
    return Effect.fail(new MaterializeError({ message: "Claude build requires matching plugin sources" }))
  }
  for (let index = 0; index < document.profile.plugins.length; index += 1) {
    const profilePlugin = document.profile.plugins[index]!
    const source = lock.sources[sourceOffset + index]
    if (claudePluginSourceMismatch(profilePlugin, source)) {
      return Effect.fail(new MaterializeError({ message: "Claude build requires matching plugin sources" }))
    }
  }
  return Effect.void
}

/** Validate the profile, lock, and resolved sources agree before any build-context files are written. */
const assertBuildContextInputsValid = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  runtimeSupport: RuntimeSupportSnapshot | RuntimeSupport | string,
): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* () {
    yield* assertHarnessKindMatches(document, lock)
    yield* assertRuntimeSupportProvided(document, runtimeSupport)
    yield* assertSourceDirectoryCountMatches(sourceDirectories, lock)
    yield* verifySourceInventories(document, lock, sourceDirectories)
    yield* assertCopilotMarketplaceSourceMatches(document, lock)
    yield* assertClaudePluginSourcesMatch(document, lock, sourceDirectories)
  })

/** The Claude plugin adapter (if any) that should influence the runtime support snapshot for this profile. */
const claudeAdapterForRuntimeSupport = (
  document: ProfileDocument,
): "claude-marketplace" | "hyperresearch" | undefined => {
  if (document.profile.harness.kind !== "claude") return undefined
  const adapter = document.profile.plugins[0]?.adapter
  return adapter === "claude-marketplace" || adapter === "hyperresearch" ? adapter : undefined
}

/** The Claude harness mode governing which runtime support files are required, defaulting to "hyperresearch". */
const claudeModeForRuntimeSupport = (document: ProfileDocument): "core" | "hyperresearch" =>
  document.profile.harness.kind === "claude"
    ? (document.profile.harness.claude.mode ?? "hyperresearch")
    : "hyperresearch"

/** Resolve (or accept an already-resolved) runtime support snapshot, validated against the profile's harness kind. */
const resolveValidatedRuntimeSupport = (
  document: ProfileDocument,
  runtimeSupport: RuntimeSupportSnapshot | RuntimeSupport | string,
): Effect.Effect<RuntimeSupportSnapshot, MaterializeError> =>
  Effect.gen(function* () {
    const support = yield* (
      isRuntimeSupportSnapshot(runtimeSupport)
        ? Effect.succeed(runtimeSupport)
        : createRuntimeSupportSnapshot(
            document.profile.harness.kind,
            typeof runtimeSupport === "string"
              ? { codexEntry: runtimeSupport, copilotEntry: "", finalizeCopilotSeed: "" }
              : runtimeSupport,
            claudeAdapterForRuntimeSupport(document),
            claudeModeForRuntimeSupport(document),
          )
    ).pipe(Effect.mapError((cause) => new MaterializeError({ message: cause.message, cause })))
    if (support.harnessKind !== document.profile.harness.kind) {
      return yield* Effect.fail(
        new MaterializeError({ message: "runtime support snapshot harness kind does not match profile" }),
      )
    }
    return support
  })

/** Read the resolved initial prompt bytes, if any, and verify they still match the profile's recorded integrity. */
const readValidatedInitialPromptBytes = (
  document: ProfileDocument,
): Effect.Effect<Uint8Array | undefined, MaterializeError> =>
  Effect.gen(function* () {
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
    return initialPromptBytes
  })

/** Codex build contexts stage generated skills and agents under dedicated asset directories. */
const initializeCodexAssetDirectories = (
  document: ProfileDocument,
  context: string,
): Effect.Effect<void, MaterializeError> => {
  if (document.profile.harness.kind !== "codex") return Effect.void
  return io("cannot initialize build context", () =>
    Promise.all([
      mkdir(path.join(context, "assets", "skills"), { recursive: true }),
      mkdir(path.join(context, "assets", "agents"), { recursive: true }),
    ]).then(() => undefined),
  )
}

/** Copilot builds copy the marketplace's HVE core source into the build context and re-verify its inventory. */
const materializeCopilotCoreAssets = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  context: string,
): Effect.Effect<void, MaterializeError> => {
  if (document.profile.harness.kind !== "copilot") return Effect.void
  const sourceIndex = document.profile.skills.length
  return Effect.gen(function* () {
    yield* copy(sourceDirectories[sourceIndex]!, path.join(context, "hve-core"))
    yield* verifyInventory(path.join(context, "hve-core"), lock.sources[sourceIndex]!.files, {
      allowSymlinks: true,
    }).pipe(
      Effect.mapError((cause) => new MaterializeError({ message: "copied Copilot source inventory mismatch", cause })),
    )
  })
}

/** Claude builds with a plugin adapter (marketplace or Hyperresearch) materialize that plugin's assets. */
const materializeClaudePluginAssets = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  context: string,
  support: RuntimeSupportSnapshot,
  materializeClaude: ClaudeMaterializer,
): Effect.Effect<void, MaterializeError> => {
  if (document.profile.harness.kind !== "claude" || document.profile.plugins.length === 0) return Effect.void
  return Effect.gen(function* () {
    const adapter = document.profile.plugins[0]?.adapter
    if (adapter !== "hyperresearch" && adapter !== "claude-marketplace") {
      return yield* Effect.fail(new MaterializeError({ message: "unsupported Claude plugin adapter" }))
    }
    const requirements =
      adapter === "hyperresearch" ? runtimeSupportFile(support, "hyperresearch-requirements") : undefined
    const browserAgent = adapter === "hyperresearch" ? runtimeSupportFile(support, "claude-browser-agent") : undefined
    yield* materializeClaude({
      adapter,
      sourceDirectories: sourceDirectories.slice(document.profile.skills.length),
      context,
      lock: { ...lock, sources: lock.sources.slice(document.profile.skills.length) },
      ...(requirements === undefined ? {} : { requirementsPath: path.join(context, requirements.buildContextPath) }),
      ...(browserAgent === undefined ? {} : { browserAgentPath: path.join(context, browserAgent.buildContextPath) }),
    }).pipe(Effect.mapError((cause) => new MaterializeError({ message: "Claude asset materialization failed", cause })))
  })
}

/** Pi builds seed only the locked OMP-native skill selections into the Pi seed directory. */
const materializePiNativeSkillAssets = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  context: string,
): Effect.Effect<void, MaterializeError> => {
  if (document.profile.harness.kind !== "pi") return Effect.void
  return Effect.gen(function* () {
    const seed = path.join(context, "pi-seed")
    const skills = path.join(seed, "skills")
    yield* io("cannot initialize Pi seed", () => mkdir(skills, { recursive: true }))
    const sourceIndex = lock.sources.findIndex((source) => source.kind === "skill" && source.adapter === "omp-native")
    if (sourceIndex >= 0) {
      const source = lock.sources[sourceIndex]!
      const sourceDirectory = sourceDirectories[sourceIndex]!
      for (const selection of [...source.select].sort()) {
        yield* copy(path.join(sourceDirectory, ".omp", "skills", selection), path.join(skills, selection))
      }
    }
  })
}

/** Claude "core" mode seeds default settings, onboarding, and an empty managed-paths marker. */
const writeClaudeCoreSeed = (
  document: ProfileDocument,
  lock: ProfileLock,
  context: string,
): Effect.Effect<void, MaterializeError> => {
  if (
    document.profile.harness.kind !== "claude" ||
    (document.profile.harness.claude.mode ?? "hyperresearch") !== "core"
  ) {
    return Effect.void
  }
  return io("cannot initialize Claude core seed", async () => {
    const seed = path.join(context, "claude-seed")
    await mkdir(seed, { recursive: true })
    await writeFile(path.join(seed, "default-settings.json"), `${JSON.stringify(claudeDefaultSettings, null, 2)}\n`)
    await writeFile(
      path.join(seed, "default-user-settings.json"),
      `${JSON.stringify(claudeDefaultUserSettings, null, 2)}\n`,
    )
    await writeFile(
      path.join(seed, "default-onboarding.json"),
      `${JSON.stringify(claudeDefaultOnboarding(lock.packages.harness.version), null, 2)}\n`,
    )
    await writeFile(path.join(seed, "managed-paths.txt"), "")
  })
}

/** The per-harness destination directory where generically-generated skills are seeded. */
const genericSkillDestination = (document: ProfileDocument, context: string): string =>
  document.profile.harness.kind === "codex"
    ? path.join(context, "assets", "skills")
    : document.profile.harness.kind === "copilot"
      ? path.join(context, "copilot-seed", "skills")
      : document.profile.harness.kind === "claude"
        ? path.join(context, "claude-seed", "skills")
        : document.profile.harness.kind === "prime"
          ? path.join(context, "prime-seed", "skills")
          : path.join(context, "pi-seed", "skills")

/** Generate and copy every generic (non-adapter-specific) locked skill into its harness destination. */
const materializeGenericSkillAssets = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  context: string,
  generateSkills: SkillGenerator,
): Effect.Effect<ReadonlyArray<GeneratedSkill>, MaterializeError> =>
  Effect.gen(function* () {
    const destination = genericSkillDestination(document, context)
    yield* io("cannot initialize generic skill destination", () => mkdir(destination, { recursive: true }))
    return yield* materializeGenericSkills(document, lock, sourceDirectories, context, destination, generateSkills)
  })

/** The per-harness destination file where always-on skill instructions are appended. */
const alwaysOnInstructionsDestination = (document: ProfileDocument, context: string): string =>
  document.profile.harness.kind === "codex"
    ? path.join(context, "assets", "AGENTS.md")
    : document.profile.harness.kind === "copilot"
      ? path.join(context, "copilot-seed", "copilot-instructions.md")
      : document.profile.harness.kind === "claude"
        ? path.join(context, "claude-seed", "CLAUDE.md")
        : document.profile.harness.kind === "prime"
          ? path.join(context, "prime-seed", "APPEND_SYSTEM.md")
          : path.join(context, "pi-seed", "APPEND_SYSTEM.md")

/** Write the rendered always-on skill instructions file, if any always-on skills were generated. */
const writeAlwaysOnInstructionsFile = (
  document: ProfileDocument,
  context: string,
  generatedSkills: ReadonlyArray<GeneratedSkill>,
): Effect.Effect<void, MaterializeError> => {
  const alwaysOnInstructions = renderAlwaysOnInstructions(generatedSkills)
  if (alwaysOnInstructions.length === 0) return Effect.void
  const destination = alwaysOnInstructionsDestination(document, context)
  return io("cannot write managed always-on instructions", () => writeFile(destination, alwaysOnInstructions))
}

/** Copilot builds copy the managed Rundown instruction file into the Copilot seed. */
const materializeCopilotInstructionAssets = (
  document: ProfileDocument,
  context: string,
  support: RuntimeSupportSnapshot,
): Effect.Effect<void, MaterializeError> => {
  if (document.profile.harness.kind !== "copilot") return Effect.void
  const instruction = runtimeSupportFile(support, "copilot-instruction-rundown")
  return copy(
    path.join(context, instruction.buildContextPath),
    path.join(context, "copilot-seed", "instructions", "rundown.instructions.md"),
  )
}

/** Claude builds copy the managed Rundown output style and rewrite the managed-paths manifest to include it. */
const materializeClaudeManagedSeedAssets = (
  document: ProfileDocument,
  context: string,
  support: RuntimeSupportSnapshot,
): Effect.Effect<void, MaterializeError> => {
  if (document.profile.harness.kind !== "claude") return Effect.void
  return Effect.gen(function* () {
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
}

/** Pi builds record every managed skill name (OMP-native and generic) into a manifest, rejecting collisions. */
const writePiManagedSkillManifest = (
  document: ProfileDocument,
  lock: ProfileLock,
  context: string,
  generatedSkills: ReadonlyArray<GeneratedSkill>,
): Effect.Effect<void, MaterializeError> => {
  if (document.profile.harness.kind !== "pi") return Effect.void
  const managedNames = [
    ...lock.sources
      .filter((source) => source.kind === "skill" && source.adapter === "omp-native")
      .flatMap((source) => source.select),
    ...generatedSkills.map((skill) => skill.name),
  ].sort((left, right) => left.localeCompare(right, "en"))
  if (new Set(managedNames).size !== managedNames.length) {
    return Effect.fail(new MaterializeError({ message: "managed Pi skill names collide" }))
  }
  return io("cannot write Pi managed skill manifest", () =>
    writeFile(path.join(context, "pi-seed", "managed-skills.txt"), managedNames.map((name) => `${name}\n`).join("")),
  )
}

/** Prime builds record every generated skill name into a manifest. */
const writePrimeManagedSkillManifest = (
  context: string,
  generatedSkills: ReadonlyArray<GeneratedSkill>,
): Effect.Effect<void, MaterializeError> => {
  const managedNames = generatedSkills.map((skill) => skill.name).sort((left, right) => left.localeCompare(right, "en"))
  return io("cannot write Prime managed skill manifest", () =>
    writeFile(path.join(context, "prime-seed", "managed-skills.txt"), managedNames.map((name) => `${name}\n`).join("")),
  )
}

/** Fail unless a single locked Prime extension source matches its profile plugin counterpart. */
const verifyPrimeExtensionSource = (
  profilePlugin: ProfileDocument["profile"]["plugins"][number],
  sourceLock: ProfileLock["sources"][number] | undefined,
  sourceDirectory: string | undefined,
): Effect.Effect<void, MaterializeError> =>
  sourceLock === undefined ||
  sourceDirectory === undefined ||
  sourceLock.kind !== "plugin" ||
  sourceLock.adapter !== "prime-extension" ||
  profilePlugin.adapter !== "prime-extension" ||
  sourceLock.repository !== profilePlugin.repository ||
  sourceLock.ref !== profilePlugin.ref ||
  JSON.stringify(sourceLock.select) !== JSON.stringify(profilePlugin.select)
    ? Effect.fail(new MaterializeError({ message: "Prime build requires matching prime-extension sources" }))
    : Effect.void

/** Copy one Prime extension TypeScript file into the destination, registering its name and rejecting collisions. */
const registerPrimeExtensionFile = (
  fileName: string,
  extensionsRoot: string,
  extensionsDestination: string,
  managedExtensionNames: Array<string>,
): Effect.Effect<void, MaterializeError> => {
  const extensionName = fileName.slice(0, -".ts".length)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(extensionName)) {
    return Effect.fail(new MaterializeError({ message: `Prime extension name is unsafe: ${fileName}` }))
  }
  if (managedExtensionNames.includes(extensionName)) {
    return Effect.fail(new MaterializeError({ message: `managed Prime extension names collide: ${extensionName}` }))
  }
  managedExtensionNames.push(extensionName)
  return copy(path.join(extensionsRoot, fileName), path.join(extensionsDestination, fileName))
}

/** Materialize every TypeScript extension file from one locked Prime extension selection. */
const materializePrimeExtensionSelection = (
  sourceDirectory: string,
  selection: string,
  extensionsDestination: string,
  managedExtensionNames: Array<string>,
): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* () {
    const extensionsRoot = path.join(sourceDirectory, "plugins", selection, "extensions")
    const entries = yield* io(`cannot list Prime extension source: ${selection}`, () =>
      readdir(extensionsRoot, { withFileTypes: true }),
    )
    const typescriptFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "en"))
    if (typescriptFiles.length === 0) {
      return yield* Effect.fail(
        new MaterializeError({ message: `Prime extension selection has no TypeScript files: ${selection}` }),
      )
    }
    for (const fileName of typescriptFiles) {
      yield* registerPrimeExtensionFile(fileName, extensionsRoot, extensionsDestination, managedExtensionNames)
    }
  })

/** Materialize every locked Prime extension plugin source into the extensions destination. */
const materializePrimeExtensionAssets = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  context: string,
): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* () {
    const extensionsDestination = path.join(context, "prime-seed", "extensions")
    yield* io("cannot initialize Prime extension destination", () => mkdir(extensionsDestination, { recursive: true }))
    const managedExtensionNames: Array<string> = []
    const sourceOffset = document.profile.skills.length
    for (let index = 0; index < document.profile.plugins.length; index += 1) {
      const profilePlugin = document.profile.plugins[index]!
      const sourceLock = lock.sources[sourceOffset + index]
      const sourceDirectory = sourceDirectories[sourceOffset + index]
      yield* verifyPrimeExtensionSource(profilePlugin, sourceLock, sourceDirectory)
      for (const selection of [...sourceLock!.select].sort((left, right) => left.localeCompare(right, "en"))) {
        yield* materializePrimeExtensionSelection(
          sourceDirectory!,
          selection,
          extensionsDestination,
          managedExtensionNames,
        )
      }
    }
    managedExtensionNames.sort((left, right) => left.localeCompare(right, "en"))
    yield* io("cannot write Prime managed extension manifest", () =>
      writeFile(
        path.join(context, "prime-seed", "managed-extensions.txt"),
        managedExtensionNames.map((name) => `${name}\n`).join(""),
      ),
    )
  })

/** Prime builds materialize managed skills and locked Prime extensions. */
const materializePrimeManagedAssets = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  context: string,
  generatedSkills: ReadonlyArray<GeneratedSkill>,
): Effect.Effect<void, MaterializeError> => {
  if (document.profile.harness.kind !== "prime") return Effect.void
  return Effect.gen(function* () {
    yield* writePrimeManagedSkillManifest(context, generatedSkills)
    yield* materializePrimeExtensionAssets(document, lock, sourceDirectories, context)
  })
}

/** Materialize one Codex plugin source: run its plugin generator (or copy a native `.codex` tree directly). */
const materializeCodexPluginSource = (
  sourceLock: ProfileLock["sources"][number],
  sourceDirectory: string,
  index: number,
  context: string,
  generatePlugin: PluginGenerator,
): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* () {
    if (sourceLock.adapter === "codex-native") {
      for (const selection of sourceLock.select) {
        yield* copyCodexTree(path.join(sourceDirectory, "plugins", selection, ".codex"), context)
      }
      return
    }
    const generated = path.join(context, `.plugin-generated-${index}`)
    yield* io("cannot create plugin generation directory", () => mkdir(generated, { recursive: true }))
    yield* generatePlugin(sourceDirectory, sourceLock.select, generated).pipe(
      Effect.mapError((cause) => new MaterializeError({ message: "compatibility plugin generation failed", cause })),
    )
    yield* copyCodexTree(path.join(generated, ".codex"), context)
    yield* io("cannot remove plugin generation staging", () => rm(generated, { recursive: true, force: true }))
  })

/** Codex builds materialize every non-skill locked plugin source beyond the profile's declared skills. */
const materializeCodexPluginAssets = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  context: string,
  generatePlugin: PluginGenerator,
): Effect.Effect<void, MaterializeError> => {
  if (document.profile.harness.kind !== "codex") return Effect.void
  return Effect.gen(function* () {
    for (let index = document.profile.skills.length; index < lock.sources.length; index += 1) {
      const sourceLock = lock.sources[index]!
      const sourceDirectory = sourceDirectories[index]!
      if (sourceLock.kind === "skill") continue
      yield* materializeCodexPluginSource(sourceLock, sourceDirectory, index, context, generatePlugin)
    }
  })
}

/** The apt-get wrapper script staged into every build context's build-support directory. */
const aptGetWrapperScript = `#!/bin/sh
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
`

/** Write the build-support/apt-get cache-trimming wrapper used during image builds. */
const writeAptGetWrapper = (context: string): Effect.Effect<void, MaterializeError> =>
  io("cannot write build-support/apt-get wrapper", async () => {
    await mkdir(path.join(context, "build-support"), { recursive: true })
    await writeFile(path.join(context, "build-support", "apt-get"), aptGetWrapperScript, { mode: 0o755 })
  })

/** Write harness-specific top-level files: Codex's config, and Prime's wrapper script and model config. */
const writeHarnessSpecificFiles = async (document: ProfileDocument, context: string): Promise<void> => {
  if (document.profile.harness.kind === "codex") {
    await writeFile(path.join(context, "codex-config.toml"), renderCodexConfig(document.profile))
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
}

/** Render the `[[tools.python]]` mise.lock stanza pinned for non-marketplace Claude builds. */
const renderClaudePythonToolLock = (misePlatform: string): string => `[[tools.python]]
version = "3.13.14"
backend = "core:python"

[tools.python."platforms.${misePlatform}"]
checksum = "sha256:1eaf979af6c6986553b91a9e3b03647f63ce52a888e00892d3bddc96f43748e9"
url = "https://github.com/astral-sh/python-build-standalone/releases/download/20260728/cpython-3.13.14+20260728-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz"
provenance = "github-attestations"

`

/** Render the `[[tools."npm:@playwright/mcp"]]` mise.lock stanza pinned for non-marketplace Claude builds. */
const renderClaudePlaywrightToolLock = `[[tools."npm:@playwright/mcp"]]
version = "0.0.78"
backend = "npm:@playwright/mcp"
`

/** Render the `[[tools."http:claude"]]` mise.lock stanza for the locked Claude harness package. */
const renderClaudeHarnessToolLock = (
  harnessPackage: HarnessPackageLock,
  misePlatform: string,
): string => `[[tools."http:claude"]]
version = ${JSON.stringify(harnessPackage.version)}
backend = "http:claude"

[tools."http:claude".options]
rename_exe = "claude"

[tools."http:claude"."platforms.${misePlatform}"]
checksum = ${JSON.stringify(harnessPackage.integrity)}
url = ${JSON.stringify(harnessPackage.url)}
`

/** Render the `[[tools.node]]` mise.lock stanza pinned for every Claude and Prime build. */
const renderPinnedNodeToolLock = (misePlatform: string): string => `[[tools.node]]
version = "22.17.0"
backend = "core:node"

[tools.node."platforms.${misePlatform}"]
checksum = "sha256:3e99df8b01b27dc8b334a2a30d1cd500442b3b0877d217b308fd61a9ccfc33d4"
url = "https://nodejs.org/dist/v22.17.0/node-v22.17.0-linux-arm64.tar.gz"
`

/** Render the generic `[[tools."http:<harness>"]]` mise.lock stanza used by every non-Claude/Prime harness. */
const renderGenericHarnessToolLock = (
  harnessPackage: HarnessPackageLock,
  executable: string,
  installedExecutable: string,
  misePlatform: string,
): string => `[[tools."http:${executable}"]]
version = ${JSON.stringify(harnessPackage.version)}
backend = "http:${executable}"

[tools."http:${executable}".options]
rename_exe = "${installedExecutable}"

[tools."http:${executable}"."platforms.${misePlatform}"]
checksum = ${JSON.stringify(harnessPackage.integrity)}
url = ${JSON.stringify(harnessPackage.url)}
`

/** Render the full mise.lock content for a Claude build outside of "core" mode. */
const renderClaudeHyperresearchMiseLock = (
  document: ProfileDocument,
  harnessPackage: HarnessPackageLock,
  misePlatform: string,
): string => {
  const claudeMarketplace = document.profile.plugins[0]?.adapter === "claude-marketplace"
  const claudePythonLock = claudeMarketplace ? "" : renderClaudePythonToolLock(misePlatform)
  const claudePlaywrightLock = claudeMarketplace ? "" : renderClaudePlaywrightToolLock
  const claudeToolLock = renderClaudeHarnessToolLock(harnessPackage, misePlatform)
  return `# @generated by Trellage profile compiler

${renderPinnedNodeToolLock(misePlatform)}
${claudePythonLock}
${claudeToolLock}

${claudePlaywrightLock}
`
}

/** Render the full mise.lock content for a Claude "core" mode build. */
const renderClaudeCoreMiseLock = (
  harnessPackage: HarnessPackageLock,
  misePlatform: string,
): string => `# @generated by Trellage profile compiler

${renderPinnedNodeToolLock(misePlatform)}
${renderClaudeHarnessToolLock(harnessPackage, misePlatform)}
`

/** Render the full mise.lock content for a Prime build. */
const renderPrimeMiseLock = (misePlatform: string): string => `# @generated by Trellage profile compiler

${renderPinnedNodeToolLock(misePlatform)}
`

/** Render the full mise.lock content for every harness kind other than Claude and Prime. */
const renderGenericMiseLock = (
  harnessPackage: HarnessPackageLock,
  executable: string,
  installedExecutable: string,
  misePlatform: string,
): string => `# @generated by Trellage profile compiler

${renderGenericHarnessToolLock(harnessPackage, executable, installedExecutable, misePlatform)}`

/** Render the full mise.lock content, selecting the harness-appropriate stanza layout. */
const renderMiseLockContent = (
  document: ProfileDocument,
  lock: ProfileLock,
  harnessPackage: HarnessPackageLock,
  executable: string,
  installedExecutable: string,
  misePlatform: string,
): string => {
  if (harnessPackage.kind === "claude") {
    return document.profile.harness.kind !== "claude" ||
      (document.profile.harness.claude.mode ?? "hyperresearch") !== "core"
      ? renderClaudeHyperresearchMiseLock(document, harnessPackage, misePlatform)
      : renderClaudeCoreMiseLock(harnessPackage, misePlatform)
  }
  return harnessPackage.kind === "prime"
    ? renderPrimeMiseLock(misePlatform)
    : renderGenericMiseLock(harnessPackage, executable, installedExecutable, misePlatform)
}

/** Write mise.toml, mise.lock, profile.lock.toml, and every remaining top-level build-context artifact. */
const writeFinalBuildArtifacts = async (
  document: ProfileDocument,
  lock: ProfileLock,
  support: RuntimeSupportSnapshot,
  context: string,
  harnessPackage: HarnessPackageLock,
  baseReference: string,
  imageTag: string,
  packageVersions: Record<string, string>,
  initialPromptBytes: Uint8Array | undefined,
): Promise<void> => {
  await writeFile(
    path.join(context, "mise.toml"),
    renderMiseConfig(document.profile, lock, { baseReference, imageTag, packageVersions, runtimeSupport: support }),
  )
  await writeFile(path.join(context, "profile.lock.toml"), renderLock(lock))
  const executable = harnessPackage.kind
  const installedExecutable = harnessPackage.kind === "pi" ? "omp" : executable
  const misePlatform = lock.platform === "linux/arm64" ? "linux-arm64" : "linux-x64"
  await writeFile(
    path.join(context, "mise.lock"),
    renderMiseLockContent(document, lock, harnessPackage, executable, installedExecutable, misePlatform),
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
}

/** Render and write every remaining build-context file: apt-get wrapper, harness-specific files, mise, and lock artifacts. */
const writeRenderedBuildContext = (
  document: ProfileDocument,
  lock: ProfileLock,
  support: RuntimeSupportSnapshot,
  context: string,
  harnessPackage: HarnessPackageLock,
  initialPromptBytes: Uint8Array | undefined,
): Effect.Effect<void, MaterializeError> =>
  Effect.gen(function* () {
    yield* writeAptGetWrapper(context)
    yield* io("cannot write harness-specific build-context files", () => writeHarnessSpecificFiles(document, context))
    const packageVersions = Object.fromEntries(lock.packages.runtime.map((entry) => [entry.name, entry.version]))
    const baseReference = lock.image.base.includes("@sha256:")
      ? lock.image.base
      : `docker.io/library/${lock.image.base.split(":", 1)[0]}@${lock.image.base_digest}`
    const imageTag = `trellage-profile-${document.profile.name}:locked`
    yield* io("cannot write rendered build context", () =>
      writeFinalBuildArtifacts(
        document,
        lock,
        support,
        context,
        harnessPackage,
        baseReference,
        imageTag,
        packageVersions,
        initialPromptBytes,
      ),
    )
  })

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
    yield* assertBuildContextInputsValid(document, lock, sourceDirectories, runtimeSupport)
    const harnessPackage = lock.packages.harness
    const support = yield* resolveValidatedRuntimeSupport(document, runtimeSupport)
    const initialPromptBytes = yield* readValidatedInitialPromptBytes(document)

    yield* io("cannot create build-context parent", () => mkdir(temporaryParent, { recursive: true }))
    const context = yield* io("cannot create temporary build context", () =>
      mkdtemp(path.join(temporaryParent, "trellage-build-")),
    )
    const build = Effect.gen(function* () {
      yield* writeRuntimeSupportSnapshot(support, context).pipe(
        Effect.mapError((cause) => new MaterializeError({ message: cause.message, cause })),
      )
      yield* initializeCodexAssetDirectories(document, context)
      yield* materializeCopilotCoreAssets(document, lock, sourceDirectories, context)
      yield* materializeClaudePluginAssets(document, lock, sourceDirectories, context, support, materializeClaude)
      yield* materializePiNativeSkillAssets(document, lock, sourceDirectories, context)
      yield* writeClaudeCoreSeed(document, lock, context)
      const generatedSkills = yield* materializeGenericSkillAssets(
        document,
        lock,
        sourceDirectories,
        context,
        generateSkills,
      )
      yield* writeAlwaysOnInstructionsFile(document, context, generatedSkills)
      yield* materializeCopilotInstructionAssets(document, context, support)
      yield* materializeClaudeManagedSeedAssets(document, context, support)
      yield* writePiManagedSkillManifest(document, lock, context, generatedSkills)
      yield* materializePrimeManagedAssets(document, lock, sourceDirectories, context, generatedSkills)
      yield* materializeCodexPluginAssets(document, lock, sourceDirectories, context, generatePlugin)
      yield* writeRenderedBuildContext(document, lock, support, context, harnessPackage, initialPromptBytes)
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
