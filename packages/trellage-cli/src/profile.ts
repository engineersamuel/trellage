import { createHash } from "node:crypto"
import path from "node:path"
import { readFile, realpath } from "node:fs/promises"

import { parse } from "smol-toml"
import { Data, Effect, ParseResult, Schema } from "effect"

import { githubRepositoryError } from "./github-repository.js"

const NonEmpty = Schema.String.pipe(Schema.minLength(1))
const RuntimeSize = Schema.String.pipe(Schema.pattern(/^[1-9][0-9]*(?:k|m|g)$/))
const StringMap = Schema.Record({ key: NonEmpty, value: Schema.String })
const SecretMap = Schema.Record({ key: NonEmpty, value: NonEmpty })
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const isControlCharacter = (character: string): boolean => {
  const codePoint = character.charCodeAt(0)
  return codePoint <= 0x1f || codePoint === 0x7f
}

const Tools = Schema.Struct({
  allow: Schema.optional(Schema.Array(NonEmpty)),
  deny: Schema.optional(Schema.Array(NonEmpty)),
})

const HttpMcp = Schema.Struct({
  name: NonEmpty,
  transport: Schema.Literal("http"),
  url: NonEmpty,
  required: Schema.optional(Schema.Boolean),
  bearer_token_env: Schema.optional(NonEmpty),
  headers: Schema.optional(StringMap),
  headers_from_secret: Schema.optional(SecretMap),
  tools: Schema.optional(Tools),
})

const StdioMcp = Schema.Struct({
  name: NonEmpty,
  transport: Schema.Literal("stdio"),
  command: NonEmpty,
  args: Schema.optional(Schema.Array(Schema.String)),
  required: Schema.optional(Schema.Boolean),
  env: Schema.optional(StringMap),
  env_from_secret: Schema.optional(SecretMap),
  tools: Schema.optional(Tools),
})

const CodexPlugin = Schema.Struct({
  adapter: Schema.Literal("codex-native", "wshobson-agents"),
  repository: NonEmpty,
  ref: NonEmpty,
  select: Schema.Array(NonEmpty),
})

const CopilotPlugin = Schema.Struct({
  adapter: Schema.Literal("copilot-marketplace"),
  repository: NonEmpty,
  ref: NonEmpty,
  marketplace: NonEmpty,
  select: Schema.Array(NonEmpty),
})

const ClaudeMarketplacePlugin = Schema.Struct({
  adapter: Schema.Literal("claude-marketplace"),
  repository: NonEmpty,
  ref: NonEmpty,
  marketplace: NonEmpty,
  select: Schema.Array(NonEmpty),
  include_mcp: Schema.optional(Schema.Boolean),
  config: Schema.optional(Schema.Record({ key: NonEmpty, value: NonEmpty })),
})

const HyperresearchPlugin = Schema.Struct({
  adapter: Schema.Literal("hyperresearch"),
  repository: Schema.Literal("https://github.com/jordan-gibbs/hyperresearch.git"),
  ref: NonEmpty,
  select: Schema.Tuple(Schema.Literal("light")),
  gear: Schema.Literal("full", "premier"),
})

const PrimeExtensionPlugin = Schema.Struct({
  adapter: Schema.Literal("prime-extension"),
  repository: NonEmpty,
  ref: NonEmpty,
  select: Schema.Array(NonEmpty),
})

const Provider = Schema.Struct({
  base_url: NonEmpty,
  wire_api: Schema.Literal("responses", "chat"),
  name: Schema.optional(NonEmpty),
  request_max_retries: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  stream_max_retries: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  stream_idle_timeout_ms: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
})

const Codex = Schema.Struct({
  model: NonEmpty,
  reasoning_effort: Schema.Literal("minimal", "low", "medium", "high", "xhigh"),
  model_provider: NonEmpty,
  providers: Schema.Record({ key: NonEmpty, value: Provider }),
})

const Copilot = Schema.Struct({
  auth: Schema.Literal("host-or-login"),
  model: Schema.optional(NonEmpty),
})

const Claude = Schema.Struct({
  mode: Schema.optional(Schema.Literal("core", "hyperresearch")),
  default_auth: Schema.Literal("proxy"),
  model: NonEmpty,
  gateway: NonEmpty,
  opus_model: Schema.optional(NonEmpty),
  sonnet_model: Schema.optional(NonEmpty),
  haiku_model: Schema.optional(NonEmpty),
})

const Pi = Schema.Struct({
  implementation: Schema.Literal("oh-my-pi"),
  provider: Schema.Literal("github-copilot"),
  model: Schema.Literal("gpt-5.6-terra"),
  auth: Schema.Literal("host-or-login"),
})

const Prime = Schema.Struct({
  provider: Schema.Literal("copilot-proxy-rs"),
  model: Schema.Literal("claude-opus-5"),
  base_url: Schema.Literal("http://copilot-proxy-rs:8080"),
  api: Schema.Literal("anthropic-messages"),
})

const CommonHarness = {
  version: NonEmpty,
  args: Schema.optional(Schema.Array(Schema.String)),
  initial_prompt: Schema.optional(NonEmpty),
}

const CodexHarness = Schema.Struct({
  ...CommonHarness,
  kind: Schema.Literal("codex"),
  codex: Codex,
})

const CopilotHarness = Schema.Struct({
  ...CommonHarness,
  kind: Schema.Literal("copilot"),
  copilot: Copilot,
})

const ClaudeHarness = Schema.Struct({
  ...CommonHarness,
  kind: Schema.Literal("claude"),
  claude: Claude,
})

const PiHarness = Schema.Struct({
  ...CommonHarness,
  kind: Schema.Literal("pi"),
  pi: Pi,
})

const PrimeHarness = Schema.Struct({
  ...CommonHarness,
  kind: Schema.Literal("prime"),
  prime: Prime,
})

const HeadlongHarness = Schema.Struct({
  ...CommonHarness,
  kind: Schema.Literal("headlong"),
})

const ImagePypiTool = Schema.Struct({
  kind: Schema.Literal("pypi"),
  name: NonEmpty,
})

const ImageGithubReleaseTool = Schema.Struct({
  kind: Schema.Literal("github-release"),
  repository: NonEmpty,
  name: NonEmpty,
})

const ImageWorktreeCliTool = Schema.Struct({
  kind: Schema.Literal("worktree-cli"),
  name: NonEmpty,
})

const ImageTool = Schema.Union(ImagePypiTool, ImageGithubReleaseTool, ImageWorktreeCliTool)

const Image = Schema.Struct({
  base: NonEmpty,
  shell: Schema.Literal("bash", "fish", "zsh"),
  packages: Schema.Array(NonEmpty),
  tools: Schema.optional(Schema.Array(ImageTool)),
})

const Secrets = Schema.Struct({
  provider: Schema.Literal("env", "varlock"),
  required: Schema.Array(NonEmpty),
  varlock_path: Schema.optional(NonEmpty),
})

const Runtime = Schema.Struct({
  memory_size: Schema.optional(RuntimeSize),
  tmpfs_size: Schema.optional(RuntimeSize),
})

const CommonProfile = {
  schema: Schema.Literal(1),
  name: NonEmpty,
  description: NonEmpty,
  resolution: Schema.optional(Schema.Literal("floating")),
  image: Image,
  runtime: Schema.optional(Runtime),
  skill_bundles: Schema.optional(Schema.Array(NonEmpty)),
  mcps: Schema.optional(Schema.Array(Schema.Union(HttpMcp, StdioMcp))),
  secrets: Schema.optional(Secrets),
}

const CodexProfileSchema = Schema.Struct({
  ...CommonProfile,
  harness: CodexHarness,
  plugins: Schema.optional(Schema.Array(CodexPlugin)),
})

const CopilotProfileSchema = Schema.Struct({
  ...CommonProfile,
  harness: CopilotHarness,
  plugins: Schema.optional(Schema.Array(CopilotPlugin)),
})

const ClaudeProfileSchema = Schema.Struct({
  ...CommonProfile,
  harness: ClaudeHarness,
  plugins: Schema.optional(Schema.Array(Schema.Union(HyperresearchPlugin, ClaudeMarketplacePlugin))),
})

const PiProfileSchema = Schema.Struct({
  ...CommonProfile,
  harness: PiHarness,
  plugins: Schema.optional(Schema.Array(CodexPlugin)),
})

const PrimeProfileSchema = Schema.Struct({
  ...CommonProfile,
  harness: PrimeHarness,
  plugins: Schema.optional(Schema.Array(PrimeExtensionPlugin)),
})

const HeadlongProfileSchema = Schema.Struct({
  ...CommonProfile,
  harness: HeadlongHarness,
  plugins: Schema.optional(Schema.Array(CodexPlugin)),
})

export const ProfileSchema = Schema.Union(
  CodexProfileSchema,
  CopilotProfileSchema,
  ClaudeProfileSchema,
  PiProfileSchema,
  PrimeProfileSchema,
  HeadlongProfileSchema,
)

type DecodedProfile = Schema.Schema.Type<typeof ProfileSchema>
type DecodedCodexProfile = Schema.Schema.Type<typeof CodexProfileSchema>
type DecodedCopilotProfile = Schema.Schema.Type<typeof CopilotProfileSchema>
type DecodedClaudeProfile = Schema.Schema.Type<typeof ClaudeProfileSchema>
type DecodedPiProfile = Schema.Schema.Type<typeof PiProfileSchema>
type DecodedPrimeProfile = Schema.Schema.Type<typeof PrimeProfileSchema>
type DecodedHeadlongProfile = Schema.Schema.Type<typeof HeadlongProfileSchema>

type NormalizedProfile<T extends DecodedProfile> = Omit<
  T,
  "resolution" | "runtime" | "skill_bundles" | "plugins" | "mcps" | "secrets"
> & {
  readonly resolution: "floating"
  readonly runtime: { readonly memory_size: string; readonly tmpfs_size: string }
  readonly skill_bundles: NonNullable<T["skill_bundles"]>
  readonly plugins: NonNullable<T["plugins"]>
  readonly mcps: NonNullable<T["mcps"]>
  readonly secrets: NonNullable<T["secrets"]>
}

export type Mcp = NonNullable<DecodedProfile["mcps"]>[number]
export type ImageTool = NonNullable<DecodedProfile["image"]["tools"]>[number]
export type CodexProfile = NormalizedProfile<DecodedCodexProfile>
export type CopilotProfile = NormalizedProfile<DecodedCopilotProfile>
export type ClaudeProfile = NormalizedProfile<DecodedClaudeProfile>
export type PiProfile = NormalizedProfile<DecodedPiProfile>
export type PrimeProfile = NormalizedProfile<DecodedPrimeProfile>
export type HeadlongProfile = NormalizedProfile<DecodedHeadlongProfile>
type ClaudeMarketplaceProfilePlugin = Extract<
  ClaudeProfile["plugins"][number],
  { readonly adapter: "claude-marketplace" }
>
export type Profile = CodexProfile | CopilotProfile | ClaudeProfile | PiProfile | PrimeProfile | HeadlongProfile

export const isCodexProfile = (profile: Profile): profile is CodexProfile => profile.harness.kind === "codex"

export const isCopilotProfile = (profile: Profile): profile is CopilotProfile => profile.harness.kind === "copilot"

export const isClaudeProfile = (profile: Profile): profile is ClaudeProfile => profile.harness.kind === "claude"

export const claudePypiToolNames = (profile: ClaudeProfile): ReadonlyArray<string> =>
  (profile.image.tools ?? []).flatMap((tool) => (tool.kind === "pypi" ? [tool.name] : []))

export const claudeGithubReleaseTools = (
  profile: ClaudeProfile,
): ReadonlyArray<Extract<ImageTool, { kind: "github-release" }>> =>
  (profile.image.tools ?? []).flatMap((tool) => (tool.kind === "github-release" ? [tool] : []))

const claudeHasGithubReleaseTool = (profile: ClaudeProfile, name: string): boolean =>
  claudeGithubReleaseTools(profile).some((tool) => tool.name === name)

export const claudeHasCodexReviewer = (profile: ClaudeProfile): boolean => claudeHasGithubReleaseTool(profile, "codex")

export const claudeHasBeads = (profile: ClaudeProfile): boolean => claudeHasGithubReleaseTool(profile, "bd")

export const claudeHasLefthook = (profile: ClaudeProfile): boolean =>
  claudeHasGithubReleaseTool(profile, "lefthook-linux-arm64")

export const claudeHasSerena = (profile: ClaudeProfile): boolean =>
  claudePypiToolNames(profile).includes("serena-agent") || profile.mcps.some((mcp) => mcp.name === "serena")

export const claudeHasWorktreeCli = (profile: ClaudeProfile): boolean =>
  (profile.image.tools ?? []).some((tool) => tool.kind === "worktree-cli")

export const isPiProfile = (profile: Profile): profile is PiProfile => profile.harness.kind === "pi"

export const isPrimeProfile = (profile: Profile): profile is PrimeProfile => profile.harness.kind === "prime"

export const isHeadlongProfile = (profile: Profile): profile is HeadlongProfile => profile.harness.kind === "headlong"

const isDecodedCodexProfile = (profile: DecodedProfile): profile is DecodedCodexProfile =>
  profile.harness.kind === "codex"

const isDecodedClaudeProfile = (profile: DecodedProfile): profile is DecodedClaudeProfile =>
  profile.harness.kind === "claude"

const isDecodedPiProfile = (profile: DecodedProfile): profile is DecodedPiProfile => profile.harness.kind === "pi"

const isDecodedPrimeProfile = (profile: DecodedProfile): profile is DecodedPrimeProfile =>
  profile.harness.kind === "prime"

const isDecodedHeadlongProfile = (profile: DecodedProfile): profile is DecodedHeadlongProfile =>
  profile.harness.kind === "headlong"

export interface ProfileDocument {
  readonly path: string
  readonly directory: string
  readonly source: string
  readonly profile: Profile
  readonly floatingSkillPolicy?: string
  readonly resolvedInitialPrompt?: string
  readonly initialPromptIntegrity?: string
  readonly resolvedVarlockPath?: string
}

export class ProfileError extends Data.TaggedError("ProfileError")<{
  readonly message: string
}> {}

const fail = (message: string): Effect.Effect<never, ProfileError> => Effect.fail(new ProfileError({ message }))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const rejectUnsupportedCopilotSections = (raw: unknown): Effect.Effect<void, ProfileError> => {
  if (!isRecord(raw) || !isRecord(raw.harness) || raw.harness.kind !== "copilot") return Effect.void
  if (Object.hasOwn(raw, "mcps")) return fail("Copilot profiles do not support MCPs")
  if (Object.hasOwn(raw, "secrets")) return fail("Copilot profiles do not support declared secrets")
  return Effect.void
}

const rejectUnsupportedPiSections = (raw: unknown): Effect.Effect<void, ProfileError> => {
  if (!isRecord(raw) || !isRecord(raw.harness) || raw.harness.kind !== "pi") return Effect.void
  if (Object.hasOwn(raw, "plugins")) return fail("Pi profiles do not support standalone plugins")
  if (Object.hasOwn(raw, "mcps")) return fail("Pi profiles do not support MCPs")
  if (Object.hasOwn(raw, "secrets")) return fail("Pi profiles do not support declared secrets")
  return Effect.void
}

const rejectUnsupportedPrimeSections = (raw: unknown): Effect.Effect<void, ProfileError> => {
  if (!isRecord(raw) || !isRecord(raw.harness) || raw.harness.kind !== "prime") return Effect.void
  if (Object.hasOwn(raw, "mcps")) return fail("Prime profiles do not support MCPs")
  if (Object.hasOwn(raw, "secrets")) return fail("Prime profiles do not support declared secrets")
  return Effect.void
}

const rejectUnsupportedHeadlongSections = (raw: unknown): Effect.Effect<void, ProfileError> => {
  if (!isRecord(raw) || !isRecord(raw.harness) || raw.harness.kind !== "headlong") return Effect.void
  if (Object.hasOwn(raw.harness, "args")) return fail("Headlong profiles do not support harness arguments")
  if (Object.hasOwn(raw.harness, "initial_prompt")) return fail("Headlong profiles do not support initial prompts")
  if (Object.hasOwn(raw, "plugins")) return fail("Headlong profiles do not support plugins")
  if (Object.hasOwn(raw, "mcps")) return fail("Headlong profiles do not support MCPs")
  if (Object.hasOwn(raw, "secrets")) return fail("Headlong profiles do not support declared secrets")
  return Effect.void
}

const rejectInlineSkills = (raw: unknown): Effect.Effect<void, ProfileError> =>
  isRecord(raw) && Object.hasOwn(raw, "skills") ? fail("inline skills are unsupported; use skill_bundles") : Effect.void

const unique = (values: ReadonlyArray<string>, label: string): Effect.Effect<void, ProfileError> => {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) return fail(`duplicate ${label}: ${value}`)
    seen.add(value)
  }
  return Effect.void
}

const resolveContained = (directory: string, candidate: string, label: string): Effect.Effect<string, ProfileError> => {
  if (path.isAbsolute(candidate)) return fail(`${label} must be profile-relative: ${candidate}`)
  const resolved = path.resolve(directory, candidate)
  const relative = path.relative(directory, resolved)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return fail(`${label} escapes profile directory: ${candidate}`)
  }
  return Effect.tryPromise({
    try: async () => {
      const [realDirectory, realCandidate] = await Promise.all([realpath(directory), realpath(resolved)])
      const realRelative = path.relative(realDirectory, realCandidate)
      if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        throw new ProfileError({ message: `${label} escapes profile directory: ${candidate}` })
      }
      return realCandidate
    },
    catch: (cause) =>
      cause instanceof ProfileError
        ? cause
        : new ProfileError({ message: `${label} cannot be resolved: ${candidate}` }),
  })
}

const normalizeCommon = <T extends DecodedProfile>(profile: T): NormalizedProfile<T> =>
  ({
    ...profile,
    resolution: profile.resolution ?? "floating",
    runtime: {
      memory_size: profile.runtime?.memory_size ?? "2g",
      tmpfs_size: profile.runtime?.tmpfs_size ?? "256m",
    },
    skill_bundles: profile.skill_bundles ?? [],
    plugins: profile.plugins ?? [],
    mcps: profile.mcps ?? [],
    secrets: profile.secrets ?? { provider: "env", required: [] },
  }) as NormalizedProfile<T>

const normalize = (profile: DecodedProfile): Profile => {
  if (isDecodedCodexProfile(profile)) return normalizeCommon(profile)
  if (isDecodedClaudeProfile(profile)) return normalizeCommon(profile)
  if (isDecodedPiProfile(profile)) return normalizeCommon(profile)
  if (isDecodedPrimeProfile(profile)) return normalizeCommon(profile)
  if (isDecodedHeadlongProfile(profile)) return normalizeCommon(profile)
  return normalizeCommon(profile)
}

const validateSkillBundles = (profile: Profile): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    yield* unique(profile.skill_bundles, "skill bundle")
    for (const bundle of profile.skill_bundles) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bundle)) {
        return yield* fail(`skill bundle is unsafe: ${bundle}`)
      }
    }
  })

const validateHarnessVersion = (label: string, version: string): Effect.Effect<void, ProfileError> =>
  /^(?:latest|\d+\.\d+\.\d+)$/.test(version) ? Effect.void : fail(`invalid ${label} version: ${version}`)

const validateCodexProfile = (profile: CodexProfile): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    yield* validateHarnessVersion("Codex", profile.harness.version)
    if (!Object.hasOwn(profile.harness.codex.providers, profile.harness.codex.model_provider)) {
      return yield* fail(`unknown model provider: ${profile.harness.codex.model_provider}`)
    }
  })

const hasDeclaredSecrets = (profile: Profile): boolean =>
  profile.secrets.required.length > 0 ||
  profile.secrets.provider !== "env" ||
  profile.secrets.varlock_path !== undefined

const validateCopilotProfile = (profile: CopilotProfile): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    yield* validateHarnessVersion("Copilot", profile.harness.version)
    if (profile.mcps.length > 0) return yield* fail("Copilot profiles do not support MCPs")
    if (hasDeclaredSecrets(profile)) return yield* fail("Copilot profiles do not support declared secrets")
    const plugin = profile.plugins[0]
    if (profile.plugins.length !== 1 || plugin === undefined) {
      return yield* fail("Copilot profiles require exactly one marketplace plugin")
    }
    yield* unique(plugin.select, "selected asset")
    if (plugin.select.length !== 1) return yield* fail("Copilot profiles require exactly one plugin selection")
    yield* unique(
      profile.plugins.map((candidate) => candidate.marketplace),
      "Copilot marketplace",
    )
  })

const claudeGithubTools: Readonly<Record<string, string>> = {
  bd: "gastownhall/beads",
  bv: "Dicklesworthstone/beads_viewer",
  raindrop: "raindrop-ai/workshop",
  codex: "openai/codex",
  "lefthook-linux-arm64": "evilmartians/lefthook",
}
const claudePypiTools = new Set(["bernstein", "serena-agent", "waku-agent"])

const validateClaudeImageTools = (profile: ClaudeProfile): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    for (const tool of profile.image.tools ?? []) {
      if (tool.kind === "github-release" && claudeGithubTools[tool.name] !== tool.repository) {
        return yield* fail(`unsupported GitHub image tool: ${tool.name}`)
      }
      if (tool.kind === "pypi" && !claudePypiTools.has(tool.name)) {
        return yield* fail(`unsupported PyPI image tool: ${tool.name}`)
      }
      if (tool.kind === "worktree-cli" && tool.name !== "wt") {
        return yield* fail(`unsupported worktree image tool: ${tool.name}`)
      }
    }
  })

const validateClaudeExtras = (profile: ClaudeProfile): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    const hyperresearch = profile.plugins.filter((plugin) => plugin.adapter === "hyperresearch")
    if (hyperresearch.length > 0) {
      if (profile.mcps.length > 0) return yield* fail("Claude profile MCPs are managed by Trellage")
      if ((profile.image.tools ?? []).length > 0) {
        return yield* fail("Hyperresearch cannot declare extra image tools")
      }
      return
    }
    yield* unique(
      profile.mcps.map((mcp) => mcp.name),
      "MCP",
    )
    for (const mcp of profile.mcps) {
      if (mcp.transport !== "stdio") return yield* fail(`Claude extra MCP ${mcp.name} must use stdio`)
    }
    yield* validateClaudeImageTools(profile)
    yield* unique(
      (profile.image.tools ?? []).map((tool) => tool.name),
      "image tool",
    )
  })

const unsafeClaudePluginConfigKeys = new Set(["__proto__", "constructor", "prototype"])

const validateClaudeMarketplaceConfig = (plugin: ClaudeMarketplaceProfilePlugin): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    if (plugin.config === undefined) return
    const entries = Object.entries(plugin.config)
    if (entries.length === 0) return yield* fail("Claude marketplace plugin config is empty")
    if (plugin.select.length !== 1) {
      return yield* fail("Claude marketplace plugin config requires exactly one selected asset")
    }
    for (const [key, value] of entries) {
      if (!safeName.test(key) || unsafeClaudePluginConfigKeys.has(key) || Object.hasOwn(Object.prototype, key)) {
        return yield* fail(`Claude marketplace plugin config key is unsafe: ${key}`)
      }
      if (Array.from(value).some(isControlCharacter)) {
        return yield* fail(`Claude marketplace plugin config value contains control characters: ${key}`)
      }
    }
  })

const validateClaudeMarketplacePlugin = (plugin: ClaudeMarketplaceProfilePlugin): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    if (!safeName.test(plugin.marketplace)) {
      return yield* fail(`Claude marketplace name is unsafe: ${plugin.marketplace}`)
    }
    yield* unique(plugin.select, "selected asset")
    if (plugin.select.length === 0) return yield* fail("Claude marketplace plugin selection is empty")
    yield* validateClaudeMarketplaceConfig(plugin)
  })

const validateClaudeProfile = (profile: ClaudeProfile): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    yield* validateHarnessVersion("Claude", profile.harness.version)
    yield* validateClaudeExtras(profile)
    if (hasDeclaredSecrets(profile)) return yield* fail("Claude credentials are selected at launch")
    if (profile.plugins.length === 0 && profile.harness.claude.mode !== "core") {
      return yield* fail("Claude profiles require at least one plugin")
    }
    const hyperresearch = profile.plugins.filter((plugin) => plugin.adapter === "hyperresearch")
    if (hyperresearch.length > 0 && profile.plugins.length !== 1) {
      return yield* fail("Hyperresearch cannot be combined with Claude marketplace plugins")
    }
    const marketplaces = profile.plugins.filter((plugin) => plugin.adapter === "claude-marketplace")
    for (const plugin of marketplaces) {
      yield* validateClaudeMarketplacePlugin(plugin)
    }
    yield* unique(
      marketplaces.map((plugin) => plugin.marketplace),
      "Claude marketplace",
    )
  })

const validatePrimeProfile = (profile: PrimeProfile): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    yield* validateHarnessVersion("Prime", profile.harness.version)
    for (const plugin of profile.plugins) {
      if (plugin.adapter !== "prime-extension") {
        return yield* fail("Prime profiles only support prime-extension plugins")
      }
      yield* unique(plugin.select, "selected asset")
      if (plugin.select.length === 0) return yield* fail("Prime extension plugin selection is empty")
    }
    yield* unique(
      profile.plugins.flatMap((plugin) => plugin.select),
      "selected Prime extension",
    )
    if (profile.mcps.length > 0) return yield* fail("Prime profiles do not support MCPs")
    if (hasDeclaredSecrets(profile)) return yield* fail("Prime profiles do not support declared secrets")
  })

const validatePiProfile = (profile: PiProfile): Effect.Effect<void, ProfileError> =>
  validateHarnessVersion("Pi", profile.harness.version)

const validateHeadlongProfile = (profile: HeadlongProfile): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    if (!/^(?:latest|[0-9a-f]{40})$/.test(profile.harness.version)) {
      return yield* fail(`invalid Headlong version: ${profile.harness.version}`)
    }
    if (profile.plugins.length > 0) return yield* fail("Headlong profiles do not support plugins")
    if (profile.mcps.length > 0) return yield* fail("Headlong profiles do not support MCPs")
    if (hasDeclaredSecrets(profile)) return yield* fail("Headlong profiles do not support declared secrets")
  })

const validateHarness = (profile: Profile): Effect.Effect<void, ProfileError> => {
  if (isCodexProfile(profile)) return validateCodexProfile(profile)
  if (isCopilotProfile(profile)) return validateCopilotProfile(profile)
  if (isClaudeProfile(profile)) return validateClaudeProfile(profile)
  if (isPrimeProfile(profile)) return validatePrimeProfile(profile)
  if (isHeadlongProfile(profile)) return validateHeadlongProfile(profile)
  return validatePiProfile(profile)
}

const validateSourceIdentities = (profile: Profile): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    for (const source of profile.plugins) {
      const repositoryError = githubRepositoryError(source.repository)
      if (repositoryError !== undefined) {
        return yield* fail(`${repositoryError}: ${source.repository}`)
      }
      yield* unique(source.select, "selected asset")
    }
  })

const validateSources = (profile: Profile): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    yield* validateSourceIdentities(profile)
    for (const plugin of profile.plugins) {
      for (const selection of plugin.select) {
        if (!safeName.test(selection)) return yield* fail(`unsafe selected asset: ${selection}`)
      }
    }
  })

const validateSecretNames = (profile: Profile): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    yield* unique(
      profile.mcps.map((mcp) => mcp.name),
      "MCP name",
    )
    yield* unique(profile.secrets.required, "required secret")
    for (const secret of profile.secrets.required) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret)) return yield* fail(`invalid secret environment name: ${secret}`)
    }
  })

const validateMcpTools = (mcp: Mcp): Effect.Effect<void, ProfileError> => {
  if (!mcp.tools?.allow || !mcp.tools.deny) return Effect.void
  const denied = new Set(mcp.tools.deny)
  const overlap = mcp.tools.allow.find((tool) => denied.has(tool))
  return overlap === undefined ? Effect.void : fail(`MCP ${mcp.name} both allows and denies tool: ${overlap}`)
}

const mcpSecretReferences = (
  mcp: Mcp,
  provider: Profile["secrets"]["provider"],
): Effect.Effect<ReadonlyArray<string>, ProfileError> =>
  Effect.gen(function* () {
    yield* validateMcpTools(mcp)
    if (mcp.transport === "http") {
      return [
        ...(mcp.bearer_token_env === undefined ? [] : [mcp.bearer_token_env]),
        ...Object.values(mcp.headers_from_secret ?? {}),
      ]
    }
    for (const target of Object.keys(mcp.env_from_secret ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) return yield* fail(`invalid MCP environment name: ${target}`)
      if (provider === "varlock" && mcp.env_from_secret?.[target] !== target) {
        return yield* fail(`varlock requires identical secret source and target names: ${target}`)
      }
    }
    return Object.values(mcp.env_from_secret ?? {})
  })

const validateMcpSecretReferences = (profile: Profile): Effect.Effect<void, ProfileError> =>
  Effect.gen(function* () {
    const declared = new Set(profile.secrets.required)
    const references = yield* Effect.forEach(profile.mcps, (mcp) => mcpSecretReferences(mcp, profile.secrets.provider))
    for (const reference of references.flat()) {
      if (!declared.has(reference)) return yield* fail(`undeclared secret reference: ${reference}`)
    }
  })

const resolveProfileFiles = (
  profile: Profile,
  directory: string,
): Effect.Effect<
  Pick<ProfileDocument, "resolvedInitialPrompt" | "initialPromptIntegrity" | "resolvedVarlockPath">,
  ProfileError
> =>
  Effect.gen(function* () {
    let resolvedInitialPrompt: string | undefined
    let initialPromptIntegrity: string | undefined
    if (profile.harness.initial_prompt) {
      resolvedInitialPrompt = yield* resolveContained(directory, profile.harness.initial_prompt, "initial prompt")
      initialPromptIntegrity = yield* Effect.tryPromise({
        try: async () =>
          `sha256:${createHash("sha256")
            .update(await readFile(resolvedInitialPrompt!))
            .digest("hex")}`,
        catch: () => new ProfileError({ message: "initial prompt cannot be read" }),
      })
    }

    let resolvedVarlockPath: string | undefined
    if (profile.secrets.provider === "varlock") {
      if (!profile.secrets.varlock_path) return yield* fail("varlock secrets require varlock_path")
      resolvedVarlockPath = yield* resolveContained(directory, profile.secrets.varlock_path, "varlock path")
    } else if (profile.secrets.varlock_path !== undefined) {
      return yield* fail("varlock_path requires the varlock secrets provider")
    }

    return {
      ...(resolvedInitialPrompt === undefined ? {} : { resolvedInitialPrompt }),
      ...(initialPromptIntegrity === undefined ? {} : { initialPromptIntegrity }),
      ...(resolvedVarlockPath === undefined ? {} : { resolvedVarlockPath }),
    }
  })

const validate = (
  profile: Profile,
  directory: string,
): Effect.Effect<
  Pick<ProfileDocument, "resolvedInitialPrompt" | "initialPromptIntegrity" | "resolvedVarlockPath">,
  ProfileError
> =>
  Effect.gen(function* () {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.name)) {
      return yield* fail(`profile name is unsafe: ${profile.name}`)
    }
    yield* validateHarness(profile)
    yield* validateSources(profile)
    yield* validateSecretNames(profile)
    yield* validateMcpSecretReferences(profile)
    return yield* resolveProfileFiles(profile, directory)
  })

export const parseProfile = (source: string, profilePath: string): Effect.Effect<ProfileDocument, ProfileError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: () => parse(source),
      catch: (cause) => {
        const detail = String(cause)
        const prefix = detail.includes("redefine an already defined") ? "duplicate TOML key" : "invalid TOML"
        return new ProfileError({ message: `${prefix}: ${detail}` })
      },
    })
    yield* rejectUnsupportedCopilotSections(raw)
    yield* rejectUnsupportedPiSections(raw)
    yield* rejectUnsupportedPrimeSections(raw)
    yield* rejectUnsupportedHeadlongSections(raw)
    yield* rejectInlineSkills(raw)
    const decoded = yield* Schema.decodeUnknown(ProfileSchema)(raw, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProfileError({
            message: ParseResult.TreeFormatter.formatErrorSync(cause),
          }),
      ),
    )
    const absolutePath = path.resolve(profilePath)
    const directory = path.dirname(absolutePath)
    const profile = normalize(decoded)
    yield* validateSkillBundles(profile)
    const resolved = yield* validate(profile, directory)
    return {
      path: absolutePath,
      directory,
      source,
      profile,
      ...resolved,
    }
  })
