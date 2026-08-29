import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { Data, Effect } from "effect"

import { verifyInventory } from "./inventory.js"
import type { ArtifactLock, ProfileLock } from "./lock.js"
import type { ClaudeMaterializeRequest } from "./materialize.js"
import { claudeGithubReleaseTools, claudeHasWorktreeCli, claudePypiToolNames, type ClaudeProfile } from "./profile.js"
import { cachedArtifactPath } from "./artifact-cache.js"
import { npmTarballUrl, parseNpmArtifactIdentity } from "./npm-artifact.js"

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

export const claudeDefaultUserSettings = {
  outputStyle: "Rundown",
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

type MarketplacePluginEntry = { name?: string; version?: string; [key: string]: unknown }

/**
 * Stamp a single marketplace plugin entry with its locked version in place, removing
 * the plugin name from `remaining` once satisfied. Entries not present in `pluginVersions`
 * are left untouched.
 */
const applyLockedMarketplacePluginVersion = (
  plugin: MarketplacePluginEntry,
  pluginVersions: Readonly<Record<string, string>>,
  remaining: Set<string>,
): void => {
  if (typeof plugin.name !== "string" || !remaining.has(plugin.name)) return
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

/** Stamp locked versions into the marketplace.json plugin list, requiring every locked plugin to be present. */
const stampClaudeMarketplaceMetadata = async (
  marketplacePath: string,
  pluginVersions: Readonly<Record<string, string>>,
): Promise<void> => {
  const marketplaceSource = await readFile(marketplacePath, "utf8")
  const marketplace = JSON.parse(marketplaceSource) as {
    plugins?: Array<MarketplacePluginEntry>
    [key: string]: unknown
  }
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error("Claude marketplace metadata plugins array is missing")
  }
  const remaining = new Set(Object.keys(pluginVersions))
  for (const plugin of marketplace.plugins) {
    applyLockedMarketplacePluginVersion(plugin, pluginVersions, remaining)
  }
  if (remaining.size > 0) {
    throw new Error(`Claude plugin versions missing from marketplace metadata: ${[...remaining].sort().join(", ")}`)
  }
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, { mode: 0o644 })
}

/** Stamp the locked version into a single-plugin plugin.json, tolerating a missing file. */
const stampClaudePluginManifest = async (
  pluginManifestPath: string,
  pluginVersions: Readonly<Record<string, string>>,
): Promise<void> => {
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

/**
 * After inventory verification, stamp locked plugin versions into the build-context
 * marketplace copy so `claude plugin install` registers the same version finalize expects.
 * Upstream may omit versions (e.g. caveman); the lock holds the ref-derived fallback.
 * Must run only after verifyInventory against the pristine locked tree.
 */
const synthesizeClaudeMarketplaceMetadata = async (
  marketplaceRoot: string,
  pluginVersions: Readonly<Record<string, string>>,
): Promise<string> => {
  const pluginManifestPath = path.join(marketplaceRoot, ".claude-plugin", "plugin.json")
  const pluginSource = await readFile(pluginManifestPath, "utf8")
  const pluginManifest = JSON.parse(pluginSource) as {
    name?: string
    version?: string
    description?: string
    author?: { name?: string }
  }
  if (typeof pluginManifest.name !== "string" || pluginManifest.name.length === 0) {
    throw new Error("Claude plugin metadata name is missing")
  }
  const locked = pluginVersions[pluginManifest.name]
  const version = locked ?? pluginManifest.version
  if (version === undefined) {
    throw new Error(`Claude plugin version is missing: ${pluginManifest.name}`)
  }
  const description =
    typeof pluginManifest.description === "string" && pluginManifest.description.length > 0
      ? pluginManifest.description
      : pluginManifest.name
  const ownerName =
    typeof pluginManifest.author?.name === "string" && pluginManifest.author.name.length > 0
      ? pluginManifest.author.name
      : pluginManifest.name
  const marketplace = {
    name: pluginManifest.name,
    owner: { name: ownerName },
    plugins: [
      {
        name: pluginManifest.name,
        source: ".",
        description,
        version,
      },
    ],
  }
  const marketplacePath = path.join(marketplaceRoot, ".claude-plugin", "marketplace.json")
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, { mode: 0o644 })
  return marketplacePath
}

export const stampClaudeMarketplaceVersions = async (
  marketplaceRoot: string,
  pluginVersions: Readonly<Record<string, string>>,
): Promise<void> => {
  const marketplacePath = path.join(marketplaceRoot, ".claude-plugin", "marketplace.json")
  try {
    await stampClaudeMarketplaceMetadata(marketplacePath, pluginVersions)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
    await synthesizeClaudeMarketplaceMetadata(marketplaceRoot, pluginVersions)
    await stampClaudeMarketplaceMetadata(marketplacePath, pluginVersions)
  }

  const pluginManifestPath = path.join(marketplaceRoot, ".claude-plugin", "plugin.json")
  await stampClaudePluginManifest(pluginManifestPath, pluginVersions)
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

export const trustedHostUvArguments = (version: string): ReadonlyArray<string> => {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`host uv version is not exact: ${version}`)
  }
  // The host can be macOS while the release lock targets Linux. The target
  // checksum cannot cover this executable, so isolate mise configuration and
  // require the exact version selected by the target resolver.
  return ["--no-config", "x", `uv@${version}`, "--", "uv"]
}

export const trustedHostUvVersionMatches = (expected: string, observed: string): boolean =>
  new RegExp(`^uv ${expected.replaceAll(".", "\\.")}(?:\\s|$)`).test(observed.trim())

const archiveEntries = (listing: string): ReadonlySet<string> =>
  new Set(
    listing
      .split("\n")
      .filter(Boolean)
      .map((entry) => entry.replace(/^\.\//, "")),
  )

const download = (
  locked: ArtifactLock,
  destination: string,
  cacheHome?: string,
  npmRegistry?: string,
): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.gen(function* () {
    const cached =
      cacheHome === undefined
        ? undefined
        : yield* attempt("cannot inspect cached artifact", async () => {
            const candidate = cachedArtifactPath(cacheHome, locked.integrity)
            try {
              return (await lstat(candidate)).isFile() ? candidate : undefined
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
              throw cause
            }
          })
    if (cached === undefined) {
      const npmIdentity = parseNpmArtifactIdentity(locked.url)
      const downloadUrl =
        npmIdentity === undefined
          ? locked.url
          : yield* Effect.try({
              try: () => npmTarballUrl(npmRegistry ?? "", npmIdentity.name, npmIdentity.version),
              catch: (cause) =>
                new ClaudeMaterializeError({ message: `npm registry is unavailable: ${locked.name}`, cause }),
            })
      yield* run("curl", [
        "--fail",
        "--location",
        "--retry",
        "5",
        "--retry-all-errors",
        downloadUrl,
        "--output",
        destination,
      ])
    } else {
      yield* attempt("cannot reuse cached artifact", () => cp(cached, destination))
    }
    const actual = yield* digestFile(destination)
    if (actual !== locked.integrity) {
      return yield* Effect.fail(
        new ClaudeMaterializeError({
          message: `artifact integrity mismatch: ${locked.name}; expected ${locked.integrity}, actual ${actual}`,
        }),
      )
    }
    const size = yield* attempt("cannot inspect downloaded artifact", () => lstat(destination))
    if (locked.size !== undefined && size.size !== locked.size) {
      return yield* Effect.fail(
        new ClaudeMaterializeError({
          message: `artifact size mismatch: ${locked.name}; expected ${locked.size}, actual ${size.size}`,
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
      yield* download(locked, archivePath, request.artifactCacheHome, request.npmRegistry)
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

export const hyperresearchSeedInstallArguments = (
  installHome: string,
  gear: "full" | "premier",
): ReadonlyArray<ReadonlyArray<string>> => [
  ["-m", "hyperresearch", "install", "--global", "--profile", gear],
  ["-m", "hyperresearch", "install", "--steps-only", installHome, "--profile", gear],
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

const hyperresearchTierUpstream =
  '**Default is `"full"`.** When uncertain, tier up. Running the full pipeline on a simple query wastes money; running the light pipeline on a complex query produces a bad report.'

const hyperresearchTierTrellage =
  '**Default is `"light"` in Trellage.** When uncertain, stay light. Select `"full"` only when the user explicitly requests deep or full research, or when the query clearly requires deep analysis, conflicting-evidence synthesis, a defended thesis, a literature review, or an evidence-chain forecast. Do not ask the user to choose a tier; resolve tier ambiguity to `"light"`.'

const hyperresearchRoutingUpstream = "If you're uncertain, tier up — but never silently upgrade every query to `full`."

const hyperresearchRoutingTrellage =
  "If you're uncertain, stay `light`. Upgrade to `full` only for clear full-tier signals or an explicit user request. Never ask the user to choose a tier."

const hyperresearchRunProfileUpstream = (gear: string): string =>
  `For a standard run, pass the installed gear (\`${gear}\`) unless the user asked for something else.`

const hyperresearchRunProfileTrellage =
  "For a standard Trellage run, pass `light` unless the user explicitly requested deep, full, premier, or dissertation research. Never ask the user to choose a tier; resolve ambiguity to `light`. The manifest profile is informational if step 1 later classifies the query differently."

const hyperresearchFullTierRowUpstream =
  '| `"full"` | Deep analysis, synthesis of conflicting evidence, defended thesis, literature review, forecast with evidence chains. | "Analyze the impact of...", "Evaluate whether...", multi-paragraph prompts, explicit request for depth/rigor, research-grade questions, contested topics |'

const hyperresearchFullTierRowTrellage =
  '| `"full"` | The user explicitly requests deep, full, rigorous, adversarial, literature-review, thesis, or evidence-chain forecast research. | "deep research", "full pipeline", "adversarial review", "literature review", "defended thesis", or another explicit depth requirement. Do not select full only because a prompt is multi-paragraph, uses "analyze" or "evaluate", or covers a contested topic. |'

const hyperresearchStepSkillsUpstream =
  '- **Step-skills check.** If `.claude/skills/hyperresearch-1-decompose/SKILL.md` doesn\'t exist relative to the working directory, run `hyperresearch install --steps-only . --json`. Installs the 16 step skill files needed by `Skill(skill: "hyperresearch-N-...")` calls in later steps.'

const hyperresearchStepSkillsTrellage = (gear: string): string =>
  `- **Step-skills refresh.** Run \`hyperresearch install --steps-only . --profile ${gear} --json\` before every run. This refreshes changed Trellage prompt contracts and is a cheap no-op when the installed files already match.`

const hyperresearchVaultBootstrapUpstream =
  "- **Vault check.** If `.hyperresearch/` doesn't exist in the working directory, run `hyperresearch init . --json`. Creates the SQLite vault and `research/` directory."

const hyperresearchVaultBootstrapTrellage =
  "- **Vault check.** If `.hyperresearch/` doesn't exist in the working directory, run `hyperresearch init . --json`, then run `hyperresearch config set web.provider crawl4ai --json`. This creates the SQLite vault and `research/` directory and selects the bundled Crawl4AI provider. Do not change the provider when the vault already exists."

const replacePromptContract = (source: string, upstream: string, adapted: string): string => {
  const upstreamIndex = source.indexOf(upstream)
  const adaptedIndex = source.indexOf(adapted)
  const hasOneUpstream = upstreamIndex >= 0 && source.indexOf(upstream, upstreamIndex + upstream.length) < 0
  const hasOneAdapted = adaptedIndex >= 0 && source.indexOf(adapted, adaptedIndex + adapted.length) < 0
  if (hasOneUpstream && !hasOneAdapted) {
    return `${source.slice(0, upstreamIndex)}${adapted}${source.slice(upstreamIndex + upstream.length)}`
  }
  if (!hasOneUpstream && hasOneAdapted) return source
  throw new Error("unsupported Hyperresearch prompt contract")
}

const normalizeHyperresearchPromptFiles = (
  entryPath: string,
  stepOnePath: string,
  defaultTier: "light",
  gearMarker: string,
): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.tryPromise({
    try: async () => {
      if (defaultTier !== "light") throw new Error(`unsupported Hyperresearch default tier: ${defaultTier}`)
      const [entrySource, stepOneSource] = await Promise.all([
        readFile(entryPath, "utf8"),
        readFile(stepOnePath, "utf8"),
      ])
      const normalizedEntry = replacePromptContract(
        replacePromptContract(
          replacePromptContract(entrySource, hyperresearchRoutingUpstream, hyperresearchRoutingTrellage),
          hyperresearchVaultBootstrapUpstream,
          hyperresearchVaultBootstrapTrellage,
        ),
        hyperresearchStepSkillsUpstream,
        hyperresearchStepSkillsTrellage(gearMarker),
      )
      const normalizedEntryProfile = replacePromptContract(
        normalizedEntry,
        hyperresearchRunProfileUpstream(gearMarker),
        hyperresearchRunProfileTrellage,
      )
      const normalizedStepOne = replacePromptContract(
        replacePromptContract(stepOneSource, hyperresearchFullTierRowUpstream, hyperresearchFullTierRowTrellage),
        hyperresearchTierUpstream,
        hyperresearchTierTrellage,
      )
      await Promise.all([
        normalizedEntryProfile === entrySource ? Promise.resolve() : writeFile(entryPath, normalizedEntryProfile),
        normalizedStepOne === stepOneSource ? Promise.resolve() : writeFile(stepOnePath, normalizedStepOne),
      ])
    },
    catch: (cause) =>
      new ClaudeMaterializeError({
        message: `cannot normalize Hyperresearch prompt contracts${cause instanceof Error ? `: ${cause.message}` : ""}`,
        cause,
      }),
  })

export const normalizeHyperresearchPromptContracts = (
  seed: string,
  defaultTier: "light",
  gear: "full" | "premier",
): Effect.Effect<void, ClaudeMaterializeError> =>
  normalizeHyperresearchPromptFiles(
    path.join(seed, "skills", "hyperresearch", "SKILL.md"),
    path.join(seed, "skills", "hyperresearch-1-decompose", "SKILL.md"),
    defaultTier,
    gear,
  )

export const normalizeHyperresearchPackagePromptContracts = (
  sitePackages: string,
  defaultTier: "light",
): Effect.Effect<void, ClaudeMaterializeError> =>
  normalizeHyperresearchPromptFiles(
    path.join(sitePackages, "hyperresearch", "skills", "hyperresearch.md"),
    path.join(sitePackages, "hyperresearch", "skills", "hyperresearch-1-decompose.md"),
    defaultTier,
    "<< p.name >>",
  )

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
    if (request.lock.packages.harness.kind !== "claude") {
      return yield* Effect.fail(new ClaudeMaterializeError({ message: "Claude harness package lock is missing" }))
    }
    const harnessVersion = request.lock.packages.harness.version
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
          path.join(seed, "default-user-settings.json"),
          `${JSON.stringify(claudeDefaultUserSettings, null, 2)}\n`,
          { mode: 0o644 },
        ),
        writeFile(
          path.join(seed, "default-onboarding.json"),
          `${JSON.stringify(claudeDefaultOnboarding(harnessVersion), null, 2)}\n`,
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
        if (request.lock.packages.harness.kind !== "claude") {
          return yield* Effect.fail(new ClaudeMaterializeError({ message: "Claude harness package lock is missing" }))
        }
        const harnessVersion = request.lock.packages.harness.version
        if (
          request.requirementsPath === undefined ||
          request.browserAgentPath === undefined ||
          request.hyperresearchGear === undefined ||
          request.hyperresearchDefaultTier === undefined
        ) {
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

        const uvArtifact = request.lock.packages.artifacts?.find((candidate) => candidate.name === "uv")
        if (uvArtifact === undefined) {
          return yield* Effect.fail(new ClaudeMaterializeError({ message: "uv artifact lock is missing" }))
        }
        const uv = trustedHostUvArguments(uvArtifact.version)
        const observedUvVersion = (yield* run("mise", [...uv, "--version"])).trim()
        if (!trustedHostUvVersionMatches(uvArtifact.version, observedUvVersion)) {
          return yield* Effect.fail(new ClaudeMaterializeError({ message: "host uv version does not match lock" }))
        }
        const pythonPackage = path.join(request.context, "hyperresearch-package")
        yield* attempt("cannot create Hyperresearch package target", () => mkdir(pythonPackage, { recursive: true }))
        yield* materializeHyperresearchPackage(request.sourceDirectories[0]!, pythonPackage)
        yield* normalizeHyperresearchPackagePromptContracts(pythonPackage, request.hyperresearchDefaultTier)
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
        yield* normalizeHyperresearchPackagePromptContracts(resolvedHostSitePackages, request.hyperresearchDefaultTier)
        const installHome = path.join(staging, "seed-home")
        yield* attempt("cannot create Claude seed home", () => mkdir(installHome, { recursive: true }))
        for (const args of hyperresearchSeedInstallArguments(installHome, request.hyperresearchGear)) {
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
            path.join(seed, "default-user-settings.json"),
            `${JSON.stringify(claudeDefaultUserSettings, null, 2)}\n`,
            { mode: 0o644 },
          )
          await writeFile(
            path.join(seed, "default-onboarding.json"),
            `${JSON.stringify(claudeDefaultOnboarding(harnessVersion), null, 2)}\n`,
            { mode: 0o644 },
          )
        })
        yield* normalizeHyperresearchSeed(seed, path.join(hostVenv, "bin", "hyperresearch"))
        yield* normalizeHyperresearchPromptContracts(seed, request.hyperresearchDefaultTier, request.hyperresearchGear)
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
        yield* download(obscura, obscuraArchive, request.artifactCacheHome, request.npmRegistry)
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

const graphToolWrapperScript = `#!/bin/sh
name="$(basename "$0")"
case "$name" in
  serena-agent|serena)
    exec python -c 'import sys; from serena.cli import top_level; sys.argv[0] = "serena"; top_level()' "$@"
    ;;
  waku-agent) name=waku ;;
esac
exec python -m "$name" "$@"
`

const worktreeCliScript = `#!/bin/sh
set -eu
cmd="\${1:-help}"
[ "$#" -gt 0 ] && shift
case "$cmd" in
  new)
    branch="\${1:-wt-$(date +%s)}"
    root="\${AGENT_WORKTREE_DIR:-$HOME/.agent-worktree}"
    mkdir -p "$root"
    git worktree add -b "$branch" "$root/$branch"
    ;;
  ls)
    git worktree list --porcelain
    ;;
  merge)
    if [ "$#" -ne 1 ]; then
      printf 'usage: wt merge <source-branch>\\n' >&2
      exit 2
    fi
    source_branch="$1"
    if ! git rev-parse --verify --quiet "$source_branch^{commit}" >/dev/null; then
      printf 'wt: unknown source branch: %s\\n' "$source_branch" >&2
      exit 2
    fi
    if git merge --no-edit "$source_branch"; then
      exit 0
    else
      status=$?
      if git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then
        git merge --abort
      fi
      printf 'wt: merge aborted due to conflicts\\n' >&2
      exit "$status"
    fi
    ;;
  --help|help)
    printf 'wt new [branch]\\nwt ls\\nwt merge <source-branch>\\n'
    ;;
  *)
    printf 'wt: unknown command %s\\n' "$cmd" >&2
    exit 2
    ;;
esac
`

const claudeMcpConfig = (profile: ClaudeProfile): string =>
  `${JSON.stringify(
    {
      mcpServers: Object.fromEntries(
        profile.mcps
          .filter((mcp) => mcp.transport === "stdio")
          .map((mcp) => [
            mcp.name,
            {
              command: mcp.command,
              ...(mcp.args === undefined ? {} : { args: mcp.args }),
            },
          ]),
      ),
    },
    null,
    2,
  )}\n`

const materializeClaudePypiRuntime = (
  profile: ClaudeProfile,
  lock: ProfileLock,
  context: string,
  pythonRequirementsPath?: string,
): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.gen(function* () {
    if (claudePypiToolNames(profile).length === 0) return
    if (pythonRequirementsPath === undefined) {
      return yield* Effect.fail(
        new ClaudeMaterializeError({ message: "Python extra-tool requirements path is missing" }),
      )
    }
    const expected = lock.packages.python_lock_integrity
    const actual = yield* digestFile(pythonRequirementsPath)
    if (expected === undefined || actual !== expected) {
      return yield* Effect.fail(
        new ClaudeMaterializeError({
          message: `Python dependency lock integrity mismatch; expected ${expected ?? "missing"}, actual ${actual}`,
        }),
      )
    }
    yield* attempt("cannot copy graph-of-loops Python lock", () =>
      cp(pythonRequirementsPath, path.join(context, "graph-of-loops-requirements.lock")),
    )
    yield* attempt("cannot write graph tool wrapper", () =>
      writeFile(path.join(context, "graph-tool-wrapper.sh"), graphToolWrapperScript, { mode: 0o755 }),
    )
  })

const installBdBinary = (
  staging: string,
  archivePath: string,
  context: string,
): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.gen(function* () {
    const listing = yield* run("tar", ["-tzf", archivePath])
    if (!safeArchivePaths(listing)) {
      return yield* Effect.fail(new ClaudeMaterializeError({ message: "bd archive has unsafe paths" }))
    }
    const extract = path.join(staging, "bd")
    yield* attempt("cannot extract bd", () => mkdir(extract, { recursive: true }))
    yield* run("tar", ["-xzf", archivePath, "-C", extract])
    const binary = path.join(extract, "bd")
    yield* attempt("cannot install bd", async () => {
      await chmod(binary, 0o755)
      await cp(binary, path.join(context, "binaries", "bd"))
    })
  })

const installBvBinary = (
  staging: string,
  archivePath: string,
  context: string,
): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.gen(function* () {
    const listing = yield* run("tar", ["-tzf", archivePath])
    if (!safeArchivePaths(listing)) {
      return yield* Effect.fail(new ClaudeMaterializeError({ message: "bv archive has unsafe paths" }))
    }
    const entries = listing.split("\n").filter((entry) => entry.length > 0 && !entry.endsWith("/"))
    if (entries.filter((entry) => entry === "bv").length !== 1) {
      return yield* Effect.fail(new ClaudeMaterializeError({ message: "bv archive has an unexpected layout" }))
    }
    const extract = path.join(staging, "bv")
    yield* attempt("cannot extract bv", () => mkdir(extract, { recursive: true }))
    yield* run("tar", ["-xzf", archivePath, "-C", extract, "bv"])
    yield* attempt("cannot install bv", async () => {
      const destination = path.join(context, "binaries", "bv")
      await rename(path.join(extract, "bv"), destination)
      await chmod(destination, 0o755)
    })
  })

const installRaindropBinary = (archivePath: string, context: string): Effect.Effect<void, ClaudeMaterializeError> =>
  attempt("cannot install raindrop", async () => {
    const destination = path.join(context, "binaries", "raindrop")
    const result = await execFilePromise("gzip", ["-dc", archivePath], {
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
    })
    await writeFile(destination, result.stdout, { mode: 0o755 })
  })

const installCodexBinary = (
  archivePath: string,
  context: string,
  staging: string,
  archiveMember: string,
  destinationName: string,
): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.gen(function* () {
    const listing = yield* run("tar", ["-tzf", archivePath])
    if (!safeArchivePaths(listing)) {
      return yield* Effect.fail(new ClaudeMaterializeError({ message: "codex archive has unsafe paths" }))
    }
    const entries = listing.split("\n").filter((entry) => entry.length > 0 && !entry.endsWith("/"))
    if (entries.length !== 1 || path.posix.basename(entries[0]!) !== archiveMember) {
      return yield* Effect.fail(new ClaudeMaterializeError({ message: "codex archive has an unexpected layout" }))
    }
    const extract = path.join(staging, destinationName)
    yield* attempt("cannot extract codex", () => mkdir(extract, { recursive: true }))
    yield* run("tar", ["-xzf", archivePath, "-C", extract])
    yield* attempt("cannot install codex", async () => {
      const destination = path.join(context, "binaries", destinationName)
      await rename(path.join(extract, entries[0]!), destination)
      await chmod(destination, 0o755)
    })
  })

const installLefthookBinary = (artifactPath: string, context: string): Effect.Effect<void, ClaudeMaterializeError> =>
  attempt("cannot install Lefthook", async () => {
    const destination = path.join(context, "lefthook-linux-arm64", "bin", "lefthook")
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(artifactPath, destination)
    await chmod(destination, 0o755)
  })

const materializeClaudeGithubBinaries = (
  profile: ClaudeProfile,
  lock: ProfileLock,
  context: string,
  staging: string,
): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.gen(function* () {
    const githubTools = claudeGithubReleaseTools(profile)
    if (githubTools.length === 0) return
    yield* attempt("cannot create extra binary destination", () =>
      mkdir(path.join(context, "binaries"), { recursive: true }),
    )
    const request = { lock } as ClaudeMaterializeRequest
    for (const tool of githubTools) {
      const locked = yield* artifact(request, tool.name)
      const archivePath = path.join(staging, path.posix.basename(new URL(locked.url).pathname))
      yield* download(locked, archivePath, request.artifactCacheHome, request.npmRegistry)
      if (tool.name === "bd") yield* installBdBinary(staging, archivePath, context)
      else if (tool.name === "bv") yield* installBvBinary(staging, archivePath, context)
      else if (tool.name === "raindrop") yield* installRaindropBinary(archivePath, context)
      else if (tool.name === "codex") {
        yield* installCodexBinary(archivePath, context, staging, "codex-aarch64-unknown-linux-musl", "codex")
        const host = yield* artifact(request, "codex-code-mode-host")
        if (host.version !== locked.version) {
          return yield* Effect.fail(new ClaudeMaterializeError({ message: "Codex code-mode host version mismatch" }))
        }
        const hostArchive = path.join(staging, path.posix.basename(new URL(host.url).pathname))
        yield* download(host, hostArchive, request.artifactCacheHome, request.npmRegistry)
        yield* installCodexBinary(
          hostArchive,
          context,
          staging,
          "codex-code-mode-host-aarch64-unknown-linux-musl",
          "codex-code-mode-host",
        )
      } else if (tool.name === "lefthook-linux-arm64") {
        yield* installLefthookBinary(archivePath, context)
      }
    }
  })

const materializeClaudeExtraSidecars = (
  profile: ClaudeProfile,
  context: string,
): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.gen(function* () {
    if (claudeHasWorktreeCli(profile)) {
      yield* attempt("cannot write worktree CLI wrapper", () =>
        writeFile(path.join(context, "wt-wrapper.sh"), worktreeCliScript, { mode: 0o755 }),
      )
    }
    if (profile.mcps.length > 0) {
      yield* attempt("cannot write Claude extra MCP config", () =>
        writeFile(path.join(context, "claude-mcp.json"), claudeMcpConfig(profile), { mode: 0o644 }),
      )
    }
  })

export const materializeClaudeExtraRuntime = (
  profile: ClaudeProfile,
  lock: ProfileLock,
  context: string,
  pythonRequirementsPath?: string,
): Effect.Effect<void, ClaudeMaterializeError> =>
  Effect.acquireUseRelease(
    attempt("cannot create Claude extra-tool staging", () => mkdtemp(path.join(os.tmpdir(), "trellage-claude-tools-"))),
    (staging) =>
      Effect.gen(function* () {
        yield* materializeClaudePypiRuntime(profile, lock, context, pythonRequirementsPath)
        yield* materializeClaudeExtraSidecars(profile, context)
        yield* materializeClaudeGithubBinaries(profile, lock, context, staging)
      }),
    (staging) =>
      attempt("cannot clean Claude extra-tool staging", () => rm(staging, { recursive: true, force: true })).pipe(
        Effect.orDie,
      ),
  )

export const materializeClaudeAssets = (
  request: ClaudeMaterializeRequest,
): Effect.Effect<void, ClaudeMaterializeError> =>
  request.adapter === "claude-marketplace"
    ? materializeClaudeMarketplaceAssets(request)
    : materializeHyperresearchAssets(request)
