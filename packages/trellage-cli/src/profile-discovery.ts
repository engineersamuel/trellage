import { readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"

import { Data, Effect, Option } from "effect"
import { productionPlatforms, type Platform } from "./platform.js"

import { sandboxHeadlessRuntimeAdapter, type SandboxHeadlessRuntimeAdapter } from "./headless-capabilities.js"
import {
  isClaudeProfile,
  isCodexProfile,
  isCopilotProfile,
  isHeadlongProfile,
  isPiProfile,
  isPrimeProfile,
  parseProfile,
  type Mcp,
  type Profile,
  type ProfileDocument,
} from "./profile.js"

export interface ProfileChoiceSource {
  readonly repository: string
  readonly ref: string
  readonly select: ReadonlyArray<string>
}

export interface ProfileChoicePlugin extends ProfileChoiceSource {
  readonly adapter: string
  readonly marketplace?: string
}

export type ProfileChoiceMcp =
  | {
      readonly name: string
      readonly transport: "http"
      readonly required: boolean
      readonly url: string
      readonly tools: {
        readonly allow: ReadonlyArray<string>
        readonly deny: ReadonlyArray<string>
      }
    }
  | {
      readonly name: string
      readonly transport: "stdio"
      readonly required: boolean
      readonly command: string
      readonly args: ReadonlyArray<string>
      readonly tools: {
        readonly allow: ReadonlyArray<string>
        readonly deny: ReadonlyArray<string>
      }
    }

export interface ProfileChoice {
  readonly value: string
  readonly name: string
  readonly description: string
  readonly supported_platforms: ReadonlyArray<Platform>
  readonly harness: {
    readonly kind: Profile["harness"]["kind"]
    readonly version: string
    readonly model?: string
  }
  readonly headlessRuntime: SandboxHeadlessRuntimeAdapter
  readonly resolutionPolicy?: "floating"
  readonly skillBundles?: ReadonlyArray<string>
  readonly skillsMode?: "floating" | "locked"
  readonly skills: ReadonlyArray<ProfileChoiceSource>
  readonly plugins: ReadonlyArray<ProfileChoicePlugin>
  readonly mcps: ReadonlyArray<ProfileChoiceMcp>
}

export interface ProfileDiscoveryRoots {
  readonly bundled: string
  readonly worktree?: string
}

export class ProfileDiscoveryError extends Data.TaggedError("ProfileDiscoveryError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

type ProfileOrigin = "bundled" | "worktree"

interface DiscoveredProfile {
  readonly origin: ProfileOrigin
  readonly document: ProfileDocument
  readonly supportedPlatforms: ReadonlyArray<Platform>
}

// Each projector reports whether its harness matched (Some) with the model
// resolved from that harness (including Copilot's default), or that it did
// not match (None).
const codexModel = (profile: Profile): Option.Option<string> =>
  isCodexProfile(profile) ? Option.some(profile.harness.codex.model) : Option.none()

const copilotModel = (profile: Profile): Option.Option<string> =>
  isCopilotProfile(profile) ? Option.some(profile.harness.copilot.model ?? "gpt-5.6-sol") : Option.none()

const claudeModel = (profile: Profile): Option.Option<string> =>
  isClaudeProfile(profile) ? Option.some(profile.harness.claude.model) : Option.none()

const piModel = (profile: Profile): Option.Option<string> =>
  isPiProfile(profile) ? Option.some(profile.harness.pi.model) : Option.none()

const primeModel = (profile: Profile): Option.Option<string> =>
  isPrimeProfile(profile) ? Option.some(profile.harness.prime.model) : Option.none()

const headlongModel = (profile: Profile): Option.Option<string> =>
  isHeadlongProfile(profile) ? Option.some("claude-sonnet-5") : Option.none()

const modelProjectors: ReadonlyArray<(profile: Profile) => Option.Option<string>> = [
  codexModel,
  copilotModel,
  claudeModel,
  piModel,
  primeModel,
  headlongModel,
]

const model = (profile: Profile): string | undefined =>
  Option.getOrUndefined(Option.firstSomeOf(modelProjectors.map((project) => project(profile))))

const projectMcp = (mcp: Mcp): ProfileChoiceMcp => {
  const common = {
    name: mcp.name,
    required: mcp.required ?? false,
    tools: {
      allow: mcp.tools?.allow ?? [],
      deny: mcp.tools?.deny ?? [],
    },
  }
  return mcp.transport === "http"
    ? { ...common, transport: "http", url: mcp.url }
    : { ...common, transport: "stdio", command: mcp.command, args: mcp.args ?? [] }
}

export const projectProfileChoice = (
  document: ProfileDocument,
  supportedPlatforms: ReadonlyArray<Platform> = [],
): ProfileChoice => {
  const profile = document.profile
  const profileModel = model(profile)
  return {
    value: document.path,
    name: profile.name,
    description: profile.description,
    supported_platforms: supportedPlatforms,
    harness: {
      kind: profile.harness.kind,
      version: profile.harness.version,
      ...(profileModel === undefined ? {} : { model: profileModel }),
    },
    headlessRuntime: sandboxHeadlessRuntimeAdapter(profile),
    resolutionPolicy: profile.resolution,
    skillBundles: profile.skill_bundles,
    skillsMode: profile.skill_bundles.length > 0 ? "floating" : "locked",
    skills: [],
    plugins: profile.plugins.map((plugin) => ({
      adapter: plugin.adapter,
      repository: plugin.repository,
      ref: plugin.ref,
      select: plugin.select,
      ...("marketplace" in plugin ? { marketplace: plugin.marketplace } : {}),
    })),
    mcps: profile.mcps.map(projectMcp),
  }
}

const canonicalRoot = (root: string): Effect.Effect<string | undefined, ProfileDiscoveryError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await realpath(path.resolve(root))
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw cause
      }
    },
    catch: (cause) => new ProfileDiscoveryError({ message: `cannot resolve profiles root: ${root}`, cause }),
  })

const loadCandidate = (
  candidate: string,
  origin: ProfileOrigin,
): Effect.Effect<Option.Option<DiscoveredProfile>, never> =>
  Effect.gen(function* () {
    const canonicalPath = yield* Effect.tryPromise({
      try: () => realpath(candidate),
      catch: () => undefined,
    })
    if (canonicalPath === undefined) return Option.none()
    const source = yield* Effect.tryPromise({
      try: () => readFile(canonicalPath, "utf8"),
      catch: () => undefined,
    })
    if (source === undefined) return Option.none()
    const document = yield* parseProfile(source, canonicalPath).pipe(Effect.option)
    return Option.map(document, (parsed) => ({ origin, document: parsed, supportedPlatforms: productionPlatforms }))
  }).pipe(Effect.orElseSucceed(() => Option.none()))

const discoverRoot = (
  root: string,
  origin: ProfileOrigin,
): Effect.Effect<ReadonlyArray<DiscoveredProfile>, ProfileDiscoveryError> =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(root, { withFileTypes: true }),
      catch: (cause) => new ProfileDiscoveryError({ message: `cannot read profiles root: ${root}`, cause }),
    })
    const candidates = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name, "en"))
      .map((entry) => path.join(root, entry.name, "profile.toml"))
    const discovered = yield* Effect.forEach(candidates, (candidate) => loadCandidate(candidate, origin))
    return discovered.flatMap((candidate) => (Option.isSome(candidate) ? [candidate.value] : []))
  })

export const discoverProfileChoices = (
  roots: ProfileDiscoveryRoots,
): Effect.Effect<ReadonlyArray<ProfileChoice>, ProfileDiscoveryError> =>
  Effect.gen(function* () {
    const bundled = yield* canonicalRoot(roots.bundled)
    const worktree = roots.worktree === undefined ? undefined : yield* canonicalRoot(roots.worktree)
    const discovered: Array<DiscoveredProfile> = []
    if (bundled !== undefined) discovered.push(...(yield* discoverRoot(bundled, "bundled")))
    if (worktree !== undefined && worktree !== bundled) {
      discovered.push(...(yield* discoverRoot(worktree, "worktree")))
    }

    const byPath = new Map<string, DiscoveredProfile>()
    const byName = new Map<string, string>()
    for (const candidate of discovered) {
      const canonicalPath = candidate.document.path
      if (byPath.has(canonicalPath)) continue
      const priorPath = byName.get(candidate.document.profile.name)
      if (priorPath !== undefined) {
        const prior = byPath.get(priorPath)
        if (candidate.origin !== "worktree" || prior?.origin === "worktree") continue
        byPath.delete(priorPath)
      }
      byPath.set(canonicalPath, candidate)
      byName.set(candidate.document.profile.name, canonicalPath)
    }

    return [...byPath.values()]
      .map(({ document, supportedPlatforms }) => projectProfileChoice(document, supportedPlatforms))
      .sort((left, right) => left.name.localeCompare(right.name, "en"))
  })
