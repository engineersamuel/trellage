import { createHash } from "node:crypto"
import path from "node:path"
import { readFile, realpath } from "node:fs/promises"

import { parse } from "smol-toml"
import { Data, Effect, ParseResult, Schema } from "effect"

import { githubRepositoryError } from "./github-repository.js"

const NonEmpty = Schema.String.pipe(Schema.minLength(1))
const TmpfsSize = Schema.String.pipe(Schema.pattern(/^[1-9][0-9]*(?:k|m|g)$/))
const StringMap = Schema.Record({ key: NonEmpty, value: Schema.String })
const SecretMap = Schema.Record({ key: NonEmpty, value: NonEmpty })

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

const Source = Schema.Struct({
  adapter: Schema.optional(Schema.Literal("omp-native")),
  repository: NonEmpty,
  ref: NonEmpty,
  select: Schema.Array(NonEmpty),
  always_on: Schema.optional(Schema.Boolean),
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
})

const HyperresearchPlugin = Schema.Struct({
  adapter: Schema.Literal("hyperresearch"),
  repository: Schema.Literal("https://github.com/jordan-gibbs/hyperresearch.git"),
  ref: NonEmpty,
  select: Schema.Tuple(Schema.Literal("light")),
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

const Image = Schema.Struct({
  base: NonEmpty,
  shell: Schema.Literal("bash", "fish", "zsh"),
  packages: Schema.Array(NonEmpty),
})

const Secrets = Schema.Struct({
  provider: Schema.Literal("env", "varlock"),
  required: Schema.Array(NonEmpty),
  varlock_path: Schema.optional(NonEmpty),
})

const Runtime = Schema.Struct({
  tmpfs_size: Schema.optional(TmpfsSize),
})

const CommonProfile = {
  schema: Schema.Literal(1),
  name: NonEmpty,
  description: NonEmpty,
  image: Image,
  runtime: Schema.optional(Runtime),
  skills: Schema.optional(Schema.Array(Source)),
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
  plugins: Schema.optional(Schema.Array(CodexPlugin)),
})

export const ProfileSchema = Schema.Union(
  CodexProfileSchema,
  CopilotProfileSchema,
  ClaudeProfileSchema,
  PiProfileSchema,
  PrimeProfileSchema,
)

type DecodedProfile = Schema.Schema.Type<typeof ProfileSchema>
type DecodedCodexProfile = Schema.Schema.Type<typeof CodexProfileSchema>
type DecodedCopilotProfile = Schema.Schema.Type<typeof CopilotProfileSchema>
type DecodedClaudeProfile = Schema.Schema.Type<typeof ClaudeProfileSchema>
type DecodedPiProfile = Schema.Schema.Type<typeof PiProfileSchema>
type DecodedPrimeProfile = Schema.Schema.Type<typeof PrimeProfileSchema>

type NormalizedProfile<T extends DecodedProfile> = Omit<T, "runtime" | "skills" | "plugins" | "mcps" | "secrets"> & {
  readonly runtime: { readonly tmpfs_size: string }
  readonly skills: NonNullable<T["skills"]>
  readonly plugins: NonNullable<T["plugins"]>
  readonly mcps: NonNullable<T["mcps"]>
  readonly secrets: NonNullable<T["secrets"]>
}

export type Mcp = NonNullable<DecodedProfile["mcps"]>[number]
export type CodexProfile = NormalizedProfile<DecodedCodexProfile>
export type CopilotProfile = NormalizedProfile<DecodedCopilotProfile>
export type ClaudeProfile = NormalizedProfile<DecodedClaudeProfile>
export type PiProfile = NormalizedProfile<DecodedPiProfile>
export type PrimeProfile = NormalizedProfile<DecodedPrimeProfile>
export type Profile = CodexProfile | CopilotProfile | ClaudeProfile | PiProfile | PrimeProfile

export const isCodexProfile = (profile: Profile): profile is CodexProfile => profile.harness.kind === "codex"

export const isCopilotProfile = (profile: Profile): profile is CopilotProfile => profile.harness.kind === "copilot"

export const isClaudeProfile = (profile: Profile): profile is ClaudeProfile => profile.harness.kind === "claude"

export const isPiProfile = (profile: Profile): profile is PiProfile => profile.harness.kind === "pi"

export const isPrimeProfile = (profile: Profile): profile is PrimeProfile => profile.harness.kind === "prime"

const isDecodedCodexProfile = (profile: DecodedProfile): profile is DecodedCodexProfile =>
  profile.harness.kind === "codex"

const isDecodedClaudeProfile = (profile: DecodedProfile): profile is DecodedClaudeProfile =>
  profile.harness.kind === "claude"

const isDecodedPiProfile = (profile: DecodedProfile): profile is DecodedPiProfile => profile.harness.kind === "pi"

const isDecodedPrimeProfile = (profile: DecodedProfile): profile is DecodedPrimeProfile =>
  profile.harness.kind === "prime"

export interface ProfileDocument {
  readonly path: string
  readonly directory: string
  readonly source: string
  readonly profile: Profile
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
  if (Object.hasOwn(raw, "plugins")) return fail("Prime profiles do not support standalone plugins")
  if (Object.hasOwn(raw, "mcps")) return fail("Prime profiles do not support MCPs")
  if (Object.hasOwn(raw, "secrets")) return fail("Prime profiles do not support declared secrets")
  return Effect.void
}

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

const normalize = (profile: DecodedProfile): Profile =>
  isDecodedCodexProfile(profile)
    ? {
        ...profile,
        runtime: { tmpfs_size: profile.runtime?.tmpfs_size ?? "256m" },
        skills: profile.skills ?? [],
        plugins: profile.plugins ?? [],
        mcps: profile.mcps ?? [],
        secrets: profile.secrets ?? { provider: "env", required: [] },
      }
    : isDecodedClaudeProfile(profile)
      ? {
          ...profile,
          runtime: { tmpfs_size: profile.runtime?.tmpfs_size ?? "256m" },
          skills: profile.skills ?? [],
          plugins: profile.plugins ?? [],
          mcps: profile.mcps ?? [],
          secrets: profile.secrets ?? { provider: "env", required: [] },
        }
      : isDecodedPiProfile(profile)
        ? {
            ...profile,
            runtime: { tmpfs_size: profile.runtime?.tmpfs_size ?? "256m" },
            skills: profile.skills ?? [],
            plugins: profile.plugins ?? [],
            mcps: profile.mcps ?? [],
            secrets: profile.secrets ?? { provider: "env", required: [] },
          }
        : isDecodedPrimeProfile(profile)
          ? {
              ...profile,
              runtime: { tmpfs_size: profile.runtime?.tmpfs_size ?? "256m" },
              skills: profile.skills ?? [],
              plugins: profile.plugins ?? [],
              mcps: profile.mcps ?? [],
              secrets: profile.secrets ?? { provider: "env", required: [] },
            }
          : {
              ...profile,
              runtime: { tmpfs_size: profile.runtime?.tmpfs_size ?? "256m" },
              skills: profile.skills ?? [],
              plugins: profile.plugins ?? [],
              mcps: profile.mcps ?? [],
              secrets: profile.secrets ?? { provider: "env", required: [] },
            }

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
    if (isCodexProfile(profile)) {
      if (!/^(?:latest|\d+\.\d+\.\d+)$/.test(profile.harness.version)) {
        return yield* fail(`invalid Codex version: ${profile.harness.version}`)
      }
      if (!Object.hasOwn(profile.harness.codex.providers, profile.harness.codex.model_provider)) {
        return yield* fail(`unknown model provider: ${profile.harness.codex.model_provider}`)
      }
      if (profile.skills.some((skill) => skill.adapter !== undefined)) {
        return yield* fail("Codex skill sources do not support adapters")
      }
    } else if (isCopilotProfile(profile)) {
      if (!/^(?:latest|\d+\.\d+\.\d+)$/.test(profile.harness.version)) {
        return yield* fail(`invalid Copilot version: ${profile.harness.version}`)
      }
      if (profile.skills.some((skill) => skill.adapter !== undefined)) {
        return yield* fail("Copilot skill sources do not support adapters")
      }
      if (profile.mcps.length > 0) return yield* fail("Copilot profiles do not support MCPs")
      if (
        profile.secrets.required.length > 0 ||
        profile.secrets.provider !== "env" ||
        profile.secrets.varlock_path !== undefined
      ) {
        return yield* fail("Copilot profiles do not support declared secrets")
      }
      const plugin = profile.plugins[0]
      if (profile.plugins.length !== 1 || plugin === undefined) {
        return yield* fail("Copilot profiles require exactly one marketplace plugin")
      }
      yield* unique(plugin.select, "selected asset")
      if (plugin.select.length !== 1) {
        return yield* fail("Copilot profiles require exactly one plugin selection")
      }
      yield* unique(
        profile.plugins.map((candidate) => candidate.marketplace),
        "Copilot marketplace",
      )
    } else if (isClaudeProfile(profile)) {
      if (!/^(?:latest|\d+\.\d+\.\d+)$/.test(profile.harness.version)) {
        return yield* fail(`invalid Claude version: ${profile.harness.version}`)
      }
      if (profile.skills.some((skill) => skill.adapter !== undefined)) {
        return yield* fail("Claude skill sources do not support adapters")
      }
      if (profile.mcps.length > 0) return yield* fail("Claude profile MCPs are managed by Trellage")
      if (
        profile.secrets.required.length > 0 ||
        profile.secrets.provider !== "env" ||
        profile.secrets.varlock_path !== undefined
      ) {
        return yield* fail("Claude credentials are selected at launch")
      }
      if (profile.plugins.length === 0 && profile.harness.claude.mode !== "core") {
        return yield* fail("Claude profiles require at least one plugin")
      }
      const hyperresearch = profile.plugins.filter((plugin) => plugin.adapter === "hyperresearch")
      if (hyperresearch.length > 0 && profile.plugins.length !== 1) {
        return yield* fail("Hyperresearch cannot be combined with Claude marketplace plugins")
      }
      for (const plugin of profile.plugins) {
        if (plugin.adapter === "claude-marketplace") {
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(plugin.marketplace)) {
            return yield* fail(`Claude marketplace name is unsafe: ${plugin.marketplace}`)
          }
          yield* unique(plugin.select, "selected asset")
          if (plugin.select.length === 0) return yield* fail("Claude marketplace plugin selection is empty")
        }
      }
      yield* unique(
        profile.plugins.filter((plugin) => plugin.adapter === "claude-marketplace").map((plugin) => plugin.marketplace),
        "Claude marketplace",
      )
    } else if (isPrimeProfile(profile)) {
      if (!/^(?:latest|\d+\.\d+\.\d+)$/.test(profile.harness.version)) {
        return yield* fail(`invalid Prime version: ${profile.harness.version}`)
      }
      if (profile.skills.some((skill) => skill.adapter !== undefined)) {
        return yield* fail("Prime skill sources use an unsupported adapter")
      }
      if (profile.plugins.length > 0) return yield* fail("Prime profiles do not support standalone plugins")
      if (profile.mcps.length > 0) return yield* fail("Prime profiles do not support MCPs")
      if (
        profile.secrets.required.length > 0 ||
        profile.secrets.provider !== "env" ||
        profile.secrets.varlock_path !== undefined
      ) {
        return yield* fail("Prime profiles do not support declared secrets")
      }
    } else {
      if (!/^(?:latest|\d+\.\d+\.\d+)$/.test(profile.harness.version)) {
        return yield* fail(`invalid Pi version: ${profile.harness.version}`)
      }
      if (profile.skills.some((skill) => skill.adapter !== undefined && skill.adapter !== "omp-native")) {
        return yield* fail("Pi skill sources use an unsupported adapter")
      }
    }
    for (const source of [...profile.skills, ...profile.plugins]) {
      const repositoryError = githubRepositoryError(source.repository)
      if (repositoryError !== undefined) {
        return yield* fail(`${repositoryError}: ${source.repository}`)
      }
      yield* unique(source.select, "selected asset")
    }
    for (const skill of profile.skills) {
      if (skill.adapter !== undefined && skill.always_on === true) {
        return yield* fail("always_on is only supported by generic skill sources")
      }
      for (const selection of skill.select) {
        if (selection !== "*" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(selection)) {
          return yield* fail(`unsafe selected asset: ${selection}`)
        }
      }
      yield* unique(
        profile.skills.flatMap((skill) => skill.select),
        "selected standalone skill",
      )
    }
    for (const plugin of profile.plugins) {
      for (const selection of plugin.select) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(selection)) {
          return yield* fail(`unsafe selected asset: ${selection}`)
        }
      }
    }
    yield* unique(
      profile.mcps.map((mcp) => mcp.name),
      "MCP name",
    )
    yield* unique(profile.secrets.required, "required secret")
    for (const secret of profile.secrets.required) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret)) return yield* fail(`invalid secret environment name: ${secret}`)
    }

    const declared = new Set(profile.secrets.required)
    const references: Array<string> = []
    for (const mcp of profile.mcps) {
      if (mcp.tools?.allow && mcp.tools.deny) {
        const denied = new Set(mcp.tools.deny)
        const overlap = mcp.tools.allow.find((tool) => denied.has(tool))
        if (overlap !== undefined) return yield* fail(`MCP ${mcp.name} both allows and denies tool: ${overlap}`)
      }
      if (mcp.transport === "http") {
        if (mcp.bearer_token_env) references.push(mcp.bearer_token_env)
        references.push(...Object.values(mcp.headers_from_secret ?? {}))
      } else {
        for (const target of Object.keys(mcp.env_from_secret ?? {})) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) return yield* fail(`invalid MCP environment name: ${target}`)
          if (profile.secrets.provider === "varlock" && mcp.env_from_secret?.[target] !== target) {
            return yield* fail(`varlock requires identical secret source and target names: ${target}`)
          }
        }
        references.push(...Object.values(mcp.env_from_secret ?? {}))
      }
    }
    for (const reference of references) {
      if (!declared.has(reference)) return yield* fail(`undeclared secret reference: ${reference}`)
    }

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
    const resolved = yield* validate(profile, directory)
    return {
      path: absolutePath,
      directory,
      source,
      profile,
      ...resolved,
    }
  })
