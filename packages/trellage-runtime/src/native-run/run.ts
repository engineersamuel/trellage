import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { lstat, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { constants as osConstants } from "node:os"
import { promisify } from "node:util"
import { expandTrellagePath, readTrellageConfig, TrellageConfigError, type NativeCatalog } from "../native-config.ts"
import {
  PI_EXTENSION_PACKAGES,
  adapters,
  piExtensionEntries,
  piExtensionsHome,
  adapterFor,
  assertEffort,
  hostDefaults,
  type HostDefaults,
  type CleanLaunch,
  type IsolationStatus,
  type LaunchInput,
  assertForwardedArgs,
  type LaunchCommand,
  type NativeAdapter,
  type ResumeRequest,
  type LaunchGuard,
} from "./adapters.ts"
import { planComposition, publishGeneration, type CompositionPlan, type GenerationLayout } from "./compose.ts"
import { createSelectionHistory, scopeKeysFor, type Selection } from "./history.ts"
import { acquireLease, pruneGenerations } from "./lease.ts"
import { NativeRunCancelledError, NativeRunError, resolveNativeRunPaths, type NativeRunPaths } from "./paths.ts"
import { createSourceResolver, gitSourceTransport, type SourceTransport } from "./source.ts"
import { devSourceRoots, devSourceTransport } from "./dev-sources.ts"
import { builtinProfile, ensureNativeConfig, withBuiltinPreset } from "./config-init.ts"
import { nativePresetProfiles, nativeSharedPresets } from "./presets.ts"
import { resolveProfileKey } from "./selection.ts"
import { resolveInstructionFile } from "./resources.ts"
import { acquireProfileGuard } from "./lifecycle-guard.ts"
import { childSettlement } from "./child-settlement.ts"
import { syncProfileRepository, type ProfileRepository } from "./repository-sync.ts"
import {
  clearFirstmatePiWorkers,
  markWorkerGeneration,
  workerPath,
  writeClaudeWorkerEnvironment,
  writeFirstmatePiWorkers,
  writePiWorkerShell,
} from "./worker-handoff.ts"
import { defaultPrerequisiteIo, ensurePrerequisites, missingPrerequisites, type PrerequisiteIo } from "./prerequisites.ts"

export interface RunOptions {
  readonly harness: string
  readonly profiles: ReadonlyArray<string>
  readonly model?: string | undefined
  readonly effort?: string | undefined
  readonly dryRun: boolean
  readonly allowUnprovenIsolation: boolean
  readonly plan?: boolean
  /** Launch without always-on profiles (a clean base harness). */
  readonly noAlways?: boolean
  /** Ad hoc skills as `owner/repo:name`; composed as one extra profile. */
  readonly skills?: ReadonlyArray<string>
  readonly forwardedArgs: ReadonlyArray<string>
  /** Reopen the most recent conversation (continue) or choose one (pick, optionally by id). */
  readonly resume?: ResumeRequest | undefined
}

export const RUN_USAGE = `Usage:
  trx run <harness> [<profile>...] [--model NAME] [--effort NAME] [--dry-run]
          [--no-always] [--skill OWNER/REPO:NAME]... [--require-proven-isolation]
          [--continue | --resume[=ID]] [-- <harness-args>]

Harnesses: agency, claude, codex, copilot, empryo, fx, grok, headlong, jcode, omp, pi, prime, uji, nodecode.
Profiles come from ~/.config/trellage/config.toml and built-in per-harness presets; a config profile with the same
name wins. Run trx list to see them. With no profile, only always-on profiles are used. --no-always skips them.
--dry-run prepares the composition and prints the launch plan without starting the harness. --skill adds one skill
from a GitHub repository without a configured profile; repeat it for more skills.
Conversations are kept per harness and profile set. --continue reopens the most recent one in this directory;
--resume lists them (or --resume=ID opens one). Use the same harness and profiles as the original run.
These trx resume options support claude, codex, copilot, grok, pi, and uji; other adapters reject them.
Profile clean launches the harness with no skills, MCP servers, instructions, hooks or plugins from trx, the
repository or the host, and installs nothing. Supported: claude, codex, copilot, pi.
A profile with current_working_directory starts the harness there instead of this directory; with repository it
is cloned when missing and rebased onto the latest remote branch before every launch. Profile firstmate runs
Firstmate (claude, pi).`

export const CLEAN_PROFILE = "clean"

type SupportedCleanLaunch = Extract<CleanLaunch, { supported: true }>

const cleanLaunchFor = (adapter: NativeAdapter, options: RunOptions): SupportedCleanLaunch | undefined => {
  if (!options.profiles.includes(CLEAN_PROFILE)) return undefined
  if (options.profiles.length > 1 || options.skills?.length)
    throw new NativeRunError("usage", "clean cannot be combined with other profiles or --skill")
  if (adapter.clean.supported) return adapter.clean
  const supported = Object.entries(adapters)
    .filter(([, candidate]) => candidate.clean.supported)
    .map(([id]) => id)
    .sort()
  throw new NativeRunError(
    "unsupported",
    `${adapter.label} cannot run clean: ${adapter.clean.reason}. Clean runs support: ${supported.join(", ")}`,
  )
}

interface RunArgumentState {
  model?: string
  effort?: string
  dryRun: boolean
  allowUnprovenIsolation: boolean
  noAlways: boolean
  plan: boolean
  resume?: ResumeRequest
  skills?: string[]
}

const optionValue = (
  argument: string,
  name: string,
  own: ReadonlyArray<string>,
  index: number,
): { value: string; index: number } => {
  if (argument.startsWith(`${name}=`)) return { value: argument.slice(name.length + 1), index }
  const next = own[index + 1]
  if (next === undefined || next.startsWith("-")) throw new NativeRunError("usage", `${name} requires a value`)
  return { value: next, index: index + 1 }
}

const parseValuedRunArgument = (
  argument: string,
  own: ReadonlyArray<string>,
  index: number,
  state: RunArgumentState,
): number | undefined => {
  if (argument === "--model" || argument.startsWith("--model=")) {
    const parsed = optionValue(argument, "--model", own, index)
    state.model = parsed.value
    return parsed.index
  }
  if (argument === "--effort" || argument.startsWith("--effort=")) {
    const parsed = optionValue(argument, "--effort", own, index)
    state.effort = parsed.value
    return parsed.index
  }
  if (argument === "--skill" || argument.startsWith("--skill=")) {
    const parsed = optionValue(argument, "--skill", own, index)
    // Match the repository identities accepted by Native config: owners cannot
    // be paths, and a repository cannot be the dot or parent directory name.
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/(?!\.{1,2}:)[a-z0-9._-]+:[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(parsed.value))
      throw new NativeRunError("usage", `--skill requires OWNER/REPO:NAME, got ${parsed.value}`)
    state.skills = [...(state.skills ?? []), parsed.value]
    return parsed.index
  }
  if (argument.startsWith("--resume=")) {
    state.resume = { kind: "pick", id: optionValue(argument, "--resume", own, index).value }
    return index
  }
  return undefined
}

const parseFlagRunArgument = (argument: string, state: RunArgumentState): boolean => {
  const flags: Readonly<Record<string, () => void>> = {
    "--dry-run": () => {
      state.dryRun = true
    },
    "--plan": () => {
      state.plan = true
    },
    "--no-always": () => {
      state.noAlways = true
    },
    "--continue": () => {
      state.resume = { kind: "continue" }
    },
    "--resume": () => {
      state.resume = { kind: "pick" }
    },
    "--require-proven-isolation": () => {
      state.allowUnprovenIsolation = false
    },
    "--allow-unproven-isolation": () => {
      state.allowUnprovenIsolation = true
    },
  }
  const apply = flags[argument]
  if (!apply) return false
  apply()
  return true
}

export const parseRunArguments = (argv: ReadonlyArray<string>): RunOptions => {
  const separator = argv.indexOf("--")
  const own = separator === -1 ? argv : argv.slice(0, separator)
  const forwardedArgs = separator === -1 ? [] : argv.slice(separator + 1)
  const positionals: string[] = []
  const state: RunArgumentState = {
    dryRun: false,
    allowUnprovenIsolation: true,
    noAlways: false,
    plan: false,
  }
  for (let index = 0; index < own.length; index += 1) {
    const argument = own[index]!
    if (!argument.startsWith("-")) {
      positionals.push(argument)
      continue
    }
    const consumed = parseValuedRunArgument(argument, own, index, state)
    if (consumed !== undefined) {
      index = consumed
      continue
    }
    if (!parseFlagRunArgument(argument, state))
      throw new NativeRunError("usage", `unknown option ${argument}; harness arguments must follow --`)
  }
  const [harness, ...profiles] = positionals
  if (!harness) throw new NativeRunError("usage", "run requires a harness")
  if (state.model !== undefined && state.model.length === 0)
    throw new NativeRunError("usage", "--model requires a value")
  return { harness, profiles, forwardedArgs, ...state }
}

const MAX_INSTRUCTION_BYTES = 64 * 1024

/** Read effective profiles' instructions relative to the config directory. */
const loadInstructions = async (
  configDirectory: string,
  catalog: NativeCatalog,
  profiles: ReadonlyArray<string>,
  options: RunOptions,
): Promise<Record<string, string>> => {
  const instructions = new Set(
    Object.entries(catalog.profiles)
      .filter(([id, profile]) => profiles.includes(id) || (
        !options.noAlways && profile.always && (!profile.harnesses || profile.harnesses.includes(options.harness))
      ))
      .flatMap(([, profile]) => profile.instructions),
  )
  const texts: Record<string, string> = {}
  for (const id of instructions) {
    const instruction = catalog.instructions[id]!
    const file = resolveInstructionFile(instruction.file, configDirectory, fileURLToPath(new URL("../../../../",import.meta.url)))
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.size > MAX_INSTRUCTION_BYTES)
        throw new Error("not a regular file within the size limit")
      texts[id] = await readFile(file, "utf8")
    } catch (error) {
      throw new NativeRunError(
        "config",
        `instruction ${id}: cannot read ${file} (${error instanceof Error ? error.message : "unknown error"})`,
      )
    }
  }
  return texts
}

export interface Spawner {
  (command: LaunchCommand, environment: NodeJS.ProcessEnv, cwd: string, onSpawn: (pid?: number) => void, guard?: LaunchGuard): Promise<number>
}

export const spawnInherited: Spawner = (launch, environment, cwd, onSpawn, guard) =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...environment }
    for (const [key, value] of Object.entries(launch.env)) {
      if (value === null) delete env[key]
      else env[key] = value
    }
    const child = spawn(launch.command, [...launch.args], { cwd, env, stdio: "inherit" })
    const settlement = childSettlement(child, guard)
    let attachmentFailed = false
    child.once("spawn", () => {
      try {
        onSpawn(child.pid)
      } catch (error) {
        attachmentFailed = true
        void settlement.terminate().then((settled) => {
          process.off("SIGTERM", term)
          reject(settled ? error : new NativeRunError("launch", `child cleanup did not settle after SIGKILL: ${String(error)}`))
        }, reject)
      }
    })
    child.once("error", (error) =>
      reject(new NativeRunError("launch", `could not start ${launch.command}: ${error.message}`)),
    )
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
    const term = forward("SIGTERM")
    process.on("SIGTERM", term)
    child.once("exit", (code, signal) => {
      process.off("SIGTERM", term)
      if (attachmentFailed) return
      resolve(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1))
    })
  })

const piInstaller = fileURLToPath(new URL("../../../../scripts/install-pi-release.sh", import.meta.url))
const execFilePromise = promisify(execFile)
const LATEST_CHECK_TIMEOUT_MS = 2_000

const latestPiReleaseTag = async (environment: NodeJS.ProcessEnv): Promise<string> => {
  const { stdout } = await execFilePromise(
    "gh",
    ["release", "view", "-R", "earendil-works/pi", "--json", "tagName", "--jq", ".tagName"],
    {
      env: environment,
      encoding: "utf8",
      timeout: LATEST_CHECK_TIMEOUT_MS,
    },
  )
  const tag = stdout.trim()
  if (!/^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.]+)?$/.test(tag))
    throw new Error(`GitHub returned an invalid Pi release tag: ${tag}`)
  return tag
}

/** Install the given Pi GitHub release; resolving it separately lets source and release checks overlap. */
export const refreshPiRelease = (environment: NodeJS.ProcessEnv, tag?: string): Promise<string | undefined> => {
  if (environment.TRELLAGE_PI_BIN || environment.TRELLAGE_PI_AUTO_UPDATE === "0") return Promise.resolve(undefined)
  return new Promise((resolve) => {
    execFile(
      "bash",
      tag === undefined ? [piInstaller] : [piInstaller, tag],
      { env: environment, timeout: 120_000 },
      (error, _stdout, stderr) => {
        resolve(
          error
            ? `Pi release update failed, using the installed Pi: ${stderr.trim().split("\n").pop() || error.message}`
            : undefined,
        )
      },
    )
  })
}

type LatestPackageVersion = (name: string, environment: NodeJS.ProcessEnv) => Promise<string>

const npmLatestPackageVersion: LatestPackageVersion = async (name, environment) => {
  const { stdout } = await execFilePromise("npm", ["view", name, "version", "--json"], {
    env: environment,
    encoding: "utf8",
    timeout: LATEST_CHECK_TIMEOUT_MS,
  })
  const version: unknown = JSON.parse(stdout)
  if (typeof version !== "string" || version.length === 0)
    throw new Error(`npm returned an invalid latest version for ${name}`)
  return version
}

export const piExtensionsNeedUpdate = async (
  environment: NodeJS.ProcessEnv,
  latestVersion: LatestPackageVersion = npmLatestPackageVersion,
): Promise<boolean> => {
  const home = piExtensionsHome(environment)
  const installed = await Promise.all(
    PI_EXTENSION_PACKAGES.map(async (name) => {
      try {
        const manifest: unknown = JSON.parse(
          await readFile(path.join(home, "node_modules", name, "package.json"), "utf8"),
        )
        return manifest && typeof manifest === "object" && "version" in manifest && typeof manifest.version === "string"
          ? manifest.version
          : undefined
      } catch {
        return undefined
      }
    }),
  )
  if (installed.some((version) => version === undefined)) return true
  const latest = await Promise.all(PI_EXTENSION_PACKAGES.map((name) => latestVersion(name, environment)))
  return installed.some((version, index) => version !== latest[index])
}

/** Check the always-on Pi extensions and install only when a package is missing or outdated. */
export const refreshPiExtensions = async (
  environment: NodeJS.ProcessEnv,
  needsUpdate?: boolean,
): Promise<string | undefined> => {
  if (environment.TRELLAGE_PI_BIN || environment.TRELLAGE_PI_AUTO_UPDATE === "0") return undefined
  const home = piExtensionsHome(environment)
  try {
    await mkdir(home, { recursive: true })
    if (!(needsUpdate ?? (await piExtensionsNeedUpdate(environment)))) return undefined
    await execFilePromise(
      "npm",
      [
        "install",
        "--prefix",
        home,
        "--no-audit",
        "--no-fund",
        "--no-progress",
        "--loglevel=error",
        ...PI_EXTENSION_PACKAGES.map((name) => `${name}@latest`),
      ],
      { env: environment, timeout: 120_000 },
    )
    return undefined
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n").pop() : String(error)
    return `Pi extension update failed, using the installed extensions: ${detail}`
  }
}

interface PiRefreshCheck {
  readonly releaseTag?: string
  readonly releaseWarning?: string
  readonly extensionsNeedUpdate?: boolean
  readonly extensionsWarning?: string
}

const checkPiRefresh = async (environment: NodeJS.ProcessEnv): Promise<PiRefreshCheck> => {
  if (environment.TRELLAGE_PI_BIN || environment.TRELLAGE_PI_AUTO_UPDATE === "0") return {}
  const [release, extensions] = await Promise.all([
    latestPiReleaseTag(environment).then(
      (releaseTag) => ({ releaseTag }),
      (error: unknown) => ({
        releaseWarning: `Pi release update failed, using the installed Pi: ${error instanceof Error ? error.message : String(error)}`,
      }),
    ),
    piExtensionsNeedUpdate(environment).then(
      (extensionsNeedUpdate) => ({ extensionsNeedUpdate }),
      (error: unknown) => ({
        extensionsWarning: `Pi extension update failed, using the installed extensions: ${error instanceof Error ? error.message : String(error)}`,
      }),
    ),
  ])
  return { ...release, ...extensions }
}

export interface RunDependencies {
  /** Refresh the harness binary before launch; returns a warning on failure. */
  readonly refreshHarness?: (harness: string, environment: NodeJS.ProcessEnv) => Promise<string | undefined>

  readonly environment?: NodeJS.ProcessEnv
  readonly cwd?: string | undefined
  readonly paths?: NativeRunPaths
  readonly transport?: SourceTransport
  readonly spawner?: Spawner
  readonly write?: (line: string) => void
  readonly configHome?: string
  readonly syncRepository?: (directory: string, repository: ProfileRepository, environment: NodeJS.ProcessEnv) => Promise<void>
  readonly prerequisiteIo?: PrerequisiteIo
}

export interface PreparedRun {
  readonly adapter: NativeAdapter
  readonly plan: CompositionPlan
  readonly layout: GenerationLayout
  readonly launch: LaunchCommand
  readonly selection: Selection
  /** Host defaults applied when the selection names no model or effort. */
  readonly defaults: HostDefaults
  readonly isolation: IsolationStatus
  /** Launched through the adapter's clean boundary; no refresh or admission runs. */
  readonly clean: boolean
  /** Directory the harness starts in: the profile's working directory or the invocation directory. */
  readonly workspace: string
  /** Prerequisite commands not on PATH when the run was prepared. */
  readonly missing: ReadonlyArray<string>
}

const shellWord = (word: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`

const launchModel = (prepared: PreparedRun): string | undefined => prepared.selection.model ?? prepared.defaults.model
const launchEffort = (prepared: PreparedRun): string | undefined =>
  prepared.selection.effort ?? prepared.defaults.effort

const loadNativeCatalog = async (dependencies: RunDependencies, environment: NodeJS.ProcessEnv) => {
  try {
    return await readTrellageConfig({
      environment,
      ...(dependencies.configHome ? { home: dependencies.configHome } : {}),
      ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
    })
  } catch (error) {
    if (error instanceof TrellageConfigError) throw new NativeRunError("config", error.message)
    throw error
  }
}

const buildLaunch = (
  adapter: NativeAdapter,
  launch: (input: LaunchInput) => LaunchCommand,
  layout: GenerationLayout,
  plan: CompositionPlan,
  options: RunOptions,
  defaults: HostDefaults,
  environment: NodeJS.ProcessEnv,
  workspace: string,
): LaunchCommand =>
  launch({
    layout,
    plan,
    planMode: options.plan === true,
    model: options.model ?? defaults.model,
    effort: options.effort ?? defaults.effort,
    forwardedArgs: options.forwardedArgs,
    resumeArgs: options.resume ? adapter.resumeArgs(options.resume) : [],
    environment,
    workspace,
  })

export const describePreparedRun = (prepared: PreparedRun): string[] => {
  const { adapter, plan, layout, launch, isolation } = prepared
  const policy = adapter.effectivePolicy(launchModel(prepared), launchEffort(prepared))
  return [
    `Harness     ${adapter.label}${plan.profiles.length ? ` + ${plan.profiles.join(" + ")}` : " (no selected profiles)"}`,
    ...(adapter.extensions?.length && !prepared.clean ? [`Extensions  ${adapter.extensions.join(", ")}`] : []),
    `Always-on   ${plan.alwaysProfiles.join(", ") || "none"}`,
    `Instructions ${plan.instructions.map((instruction) => instruction.id).join(", ") || "none"}`,
    `Normal      ${policy.normal}`,
    `Plan        ${policy.plan}`,
    `Isolation   ${isolation.status} — ${isolation.evidence}`,
    `Generation  ${layout.generationPath}`,
    ...(plan.workingDirectory ? [`Directory   ${prepared.workspace}`] : []),
    ...(plan.repository ? [`Repository  ${plan.repository.url} (${plan.repository.branch}, pulled before launch)`] : []),
    ...(plan.prerequisites?.length
      ? [
          `Requires    ${plan.prerequisites
            .map((entry) => (prepared.missing.includes(entry.command) ? `${entry.command} (missing)` : entry.command))
            .join(", ")}`,
        ]
      : []),
    ...(plan.skills.length === 0
      ? ["Skills      none"]
      : plan.skills.map(
          (skill, index) =>
            `${index === 0 ? "Skills      " : "            "}${skill.name}  ${skill.sourceId}@${skill.commit.slice(0, 12)}`,
        )),
    ...plan.warnings.map((warning) => `Warning     ${warning}`),
    `Command     ${[launch.command, ...launch.args].map(shellWord).join(" ")}`,
  ]
}

/**
 * Turns `--skill owner/repo:name` values into one synthetic profile. A configured
 * source for the same repository is reused, so its policy and cache stay shared.
 */
const adHocSkillProfile = (catalog: NativeCatalog, skills: ReadonlyArray<string>) => {
  if (skills.length === 0) return undefined
  const byRepository = new Map<string, string[]>()
  for (const skill of skills) {
    const [repository, name] = skill.toLowerCase().split(":") as [string, string]
    byRepository.set(repository, [...new Set([...(byRepository.get(repository) ?? []), name])])
  }
  const sources: Record<string, NativeCatalog["sources"][string]> = {}
  const selections = [...byRepository].sort().map(([repository, names]) => {
    const configured = Object.entries(catalog.sources).find(([, source]) => source.repository === repository)?.[0]
    const source = configured ?? `adhoc-${repository.replace(/[^a-z0-9]+/g, "-")}`
    if (configured === undefined) sources[source] = { repository }
    return { source, names }
  })
  const id = `adhoc-${createHash("sha256").update(JSON.stringify(selections)).digest("hex").slice(0, 12)}`
  const profile: NativeCatalog["profiles"][string] = { label: "Ad hoc skills", always: false, instructions: [], plugins: [], skills: selections }
  return {
    id,
    catalog: { ...catalog, sources: { ...catalog.sources, ...sources }, profiles: { ...catalog.profiles, [id]: profile } },
  }
}

const availableRunProfiles = async (adapter: NativeAdapter, catalog: NativeCatalog): Promise<string[]> => {
  const profiles = Object.entries(catalog.profiles)
    .filter(([, profile]) => !profile.harnesses || profile.harnesses.includes(adapter.id))
    .map(([name]) => name)
  profiles.push(...nativePresetProfiles(adapter.id).filter((preset) => !Object.hasOwn(catalog.profiles, preset)))
  for (const shared of nativeSharedPresets) {
    if (Object.hasOwn(catalog.profiles, shared)) continue
    const profile = await builtinProfile(shared)
    if (profile && (!profile.harnesses || profile.harnesses.includes(adapter.id))) profiles.push(shared)
  }
  if (adapter.clean.supported) profiles.push(CLEAN_PROFILE)
  return [...new Set(profiles)].sort()
}

const assertKnownRunProfiles = (
  adapter: NativeAdapter,
  options: RunOptions,
  sourceCatalog: NativeCatalog,
  available: ReadonlyArray<string>,
): void => {
  // Declared and shared profiles that exist but skip this harness get the specific "does not support" error below.
  for (const profile of options.profiles) {
    if (available.includes(profile) || Object.hasOwn(sourceCatalog.profiles, profile) || nativeSharedPresets.includes(profile))
      continue
    throw new NativeRunError(
      "unknown-profile",
      `unknown profile ${profile} for ${adapter.id}; available: ${available.join(", ") || "none"}`,
    )
  }
}

const assertProfileHarnessSupport = (
  adapter: NativeAdapter,
  catalog: NativeCatalog,
  profiles: ReadonlyArray<string>,
): void => {
  for (const profile of profiles) {
    const harnesses = catalog.profiles[profile]?.harnesses
    if (harnesses && !harnesses.includes(adapter.id))
      throw new NativeRunError(
        "unsupported",
        `profile ${profile} does not support ${adapter.label}; it supports: ${[...harnesses].sort().join(", ")}`,
      )
  }
}

const resolveRunProfiles = async (
  adapter: NativeAdapter,
  options: RunOptions,
  sourceCatalog: NativeCatalog,
): Promise<{ catalog: NativeCatalog; profiles: string[] }> => {
  assertKnownRunProfiles(adapter, options, sourceCatalog, await availableRunProfiles(adapter, sourceCatalog))
  const adHoc = adHocSkillProfile(sourceCatalog, options.skills ?? [])
  let catalog = adHoc?.catalog ?? sourceCatalog
  const profiles = options.profiles.map((profile) =>
    resolveProfileKey(catalog, adapter.id, profile),
  )
  for (const profile of profiles) {
    if (profile.startsWith(`preset-${adapter.id}-`) || nativeSharedPresets.includes(profile))
      catalog = await withBuiltinPreset(catalog, profile)
  }
  assertProfileHarnessSupport(adapter, catalog, profiles)
  return { catalog, profiles: adHoc === undefined ? profiles : [...profiles, adHoc.id] }
}

const composeRun = async (
  adapter: NativeAdapter,
  options: RunOptions,
  dependencies: RunDependencies,
  environment: NodeJS.ProcessEnv,
  paths: NativeRunPaths,
  configDirectory: string,
  catalog: NativeCatalog,
  profiles: ReadonlyArray<string>,
): Promise<{ plan: CompositionPlan; layout: GenerationLayout }> => {
  const instructionTexts = await loadInstructions(configDirectory, catalog, profiles, options)
  const transport = devSourceTransport(
    dependencies.transport ?? gitSourceTransport(),
    devSourceRoots(environment.TRELLAGE_DEV_SOURCES),
  )
  const resolver = createSourceResolver({ paths, transport })
  const plan = await planComposition(
    {
      harness: adapter.id,
      profiles,
      catalog,
      adapterPolicy: adapter.policyVersion,
      providerPolicy: adapter.providerPolicy(options.model),
      instructionTexts,
      skipAlways: options.noAlways === true,
    },
    { resolver },
  )

  const layout = await publishGeneration({
    paths,
    plan,
    skillsSubdirectory: adapter.skillsSubdirectory,
    instructionsFile: adapter.instructionsFile,
    persistentState: adapter.persistentState,
    writeAdapterFiles: (stage, generationLayout) =>
      adapter.writeAdapterFiles(stage, options.model, generationLayout, plan),
  })
  for (const source of plan.sources) await resolver.markGood(source)
  await pruneGenerations(paths, layout.ownerHome, 3, plan.generationId)
  return { plan, layout }
}

const buildPreparedRun = (
  adapter: NativeAdapter,
  plan: CompositionPlan,
  layout: GenerationLayout,
  options: RunOptions,
  dependencies: RunDependencies,
  environment: NodeJS.ProcessEnv,
  workspace: string,
): PreparedRun => {
  const host = hostDefaults(adapter.id, dependencies.configHome ?? environment.HOME, plan)
  const defaults = options.plan
    ? { model: adapter.planDefaults?.model ?? host.model, effort: adapter.planDefaults?.effort ?? host.effort }
    : host
  const launch = buildLaunch(
    adapter,
    adapter.launch,
    layout,
    plan,
    options,
    defaults,
    environment,
    workspace,
  )
  return {
    adapter,
    plan,
    layout,
    launch,
    defaults,
    isolation: adapter.isolation,
    clean: false,
    workspace,
    missing: missingPrerequisites(plan.prerequisites ?? [], environment).map((entry) => entry.command),
    selection: { harness: adapter.id, profiles: options.profiles, model: options.model, effort: options.effort },
  }
}

/** Compose an empty generation without reading the user config, resolving sources or reading host defaults. */
const prepareCleanRun = async (
  adapter: NativeAdapter,
  clean: SupportedCleanLaunch,
  options: RunOptions,
  dependencies: RunDependencies,
  environment: NodeJS.ProcessEnv,
  paths: NativeRunPaths,
): Promise<PreparedRun> => {
  const reopened = options.forwardedArgs.find((argument) => clean.managedFlags?.includes(argument.split("=", 1)[0]!))
  if (reopened !== undefined)
    throw new NativeRunError("usage", `${reopened.split("=", 1)[0]} cannot be forwarded to a clean ${adapter.label} run`)
  const blocked = (await clean.blockers?.find(dependencies.cwd ?? process.cwd())) ?? []
  if (blocked.length > 0)
    throw new NativeRunError(
      "unsupported",
      `${adapter.label} cannot run clean here: ${blocked.join(", ")} ${clean.blockers!.effect}`,
    )
  const plan = await planComposition(
    {
      harness: adapter.id,
      profiles: [CLEAN_PROFILE],
      catalog: {
        sources: {},
        instructions: {},
        profiles: { [CLEAN_PROFILE]: { always: false, instructions: [], skills: [], plugins: [] } },
      },
      adapterPolicy: adapter.policyVersion,
      providerPolicy: adapter.providerPolicy(options.model),
      instructionTexts: {},
      skipAlways: true,
    },
    { resolver: createSourceResolver({ paths, transport: dependencies.transport ?? gitSourceTransport() }) },
  )
  const layout = await publishGeneration({
    paths,
    plan,
    skillsSubdirectory: adapter.skillsSubdirectory,
    instructionsFile: adapter.instructionsFile,
    persistentState: adapter.persistentState,
    writeAdapterFiles: (stage, generationLayout) => clean.writeAdapterFiles(stage, options.model, generationLayout),
  })
  await pruneGenerations(paths, layout.ownerHome, 3, plan.generationId)
  const defaults = options.plan
    ? {
        model: adapter.planDefaults?.model ?? clean.defaults.model,
        effort: adapter.planDefaults?.effort ?? clean.defaults.effort,
      }
    : clean.defaults
  const workspace = dependencies.cwd ?? process.cwd()
  const launch = buildLaunch(adapter, clean.launch, layout, plan, options, defaults, environment, workspace)
  return {
    adapter,
    plan,
    layout,
    launch,
    defaults,
    isolation: { status: "proven", evidence: clean.evidence },
    clean: true,
    workspace,
    missing: [],
    selection: { harness: adapter.id, profiles: options.profiles, model: options.model, effort: options.effort },
  }
}

const resolveRunWorkspace = (
  plan: CompositionPlan,
  dependencies: RunDependencies,
  environment: NodeJS.ProcessEnv,
): string => {
  const invocation = dependencies.cwd ?? process.cwd()
  return plan.workingDirectory
    ? expandTrellagePath(plan.workingDirectory, dependencies.configHome ?? environment.HOME ?? invocation, invocation)
    : invocation
}

const prepareRunPrerequisites = async (
  plan: CompositionPlan,
  options: RunOptions,
  dependencies: RunDependencies,
  environment: NodeJS.ProcessEnv,
  workspace: string,
): Promise<void> => {
  if (plan.prerequisites && !options.dryRun)
    await ensurePrerequisites(
      `Profile ${options.profiles.join(" + ")}`,
      plan.prerequisites,
      environment,
      dependencies.prerequisiteIo ?? defaultPrerequisiteIo(dependencies.write ?? ((line) => process.stderr.write(`${line}\n`))),
    )
  if (plan.repository && !options.dryRun)
    await (dependencies.syncRepository ?? syncProfileRepository)(workspace, plan.repository, environment)
}

/** Resolve, validate, stage and publish the composition without starting the harness. */
export const prepareRun = async (options: RunOptions, dependencies: RunDependencies = {}): Promise<PreparedRun> => {
  const environment = dependencies.environment ?? process.env
  const paths = dependencies.paths ?? resolveNativeRunPaths({ environment })
  const adapter = adapterFor(options.harness)
  assertEffort(adapter, options.effort)
  assertForwardedArgs(adapter, options.forwardedArgs)
  if (options.resume && adapter.resumeArgs(options.resume).length === 0)
    throw new NativeRunError(
      "unsupported",
      `${adapter.label} does not support trx resume options; pass supported native resume arguments after --`,
    )
  const clean = cleanLaunchFor(adapter, options)
  if (clean) return prepareCleanRun(adapter, clean, options, dependencies, environment, paths)

  await ensureNativeConfig({ environment, ...(dependencies.configHome ? { home: dependencies.configHome } : {}) })
  const loaded = await loadNativeCatalog(dependencies, environment)
  const resolved = await resolveRunProfiles(adapter, options, loaded.config.native)
  const { plan, layout } = await composeRun(
    adapter,
    options,
    dependencies,
    environment,
    paths,
    path.dirname(loaded.path),
    resolved.catalog,
    resolved.profiles,
  )
  const workspace = resolveRunWorkspace(plan, dependencies, environment)
  await prepareRunPrerequisites(plan, options, dependencies, environment, workspace)
  return buildPreparedRun(adapter, plan, layout, options, dependencies, environment, workspace)
}

/** The command that reopens the latest conversation of this harness and profile set. */
export const resumeCommand = (options: RunOptions): string =>
  ["trx run", options.harness, ...options.profiles, ...(options.noAlways ? ["--no-always"] : []), "--continue"]
    .map((word) => shellWord(word).replace(/^'trx run'$/, "trx run"))
    .join(" ")

const refreshPreparedRun = async (
  prepared: PreparedRun,
  options: RunOptions,
  dependencies: RunDependencies,
  environment: NodeJS.ProcessEnv,
  write: (line: string) => void,
  piRefresh: PiRefreshCheck = {},
): Promise<PreparedRun> => {
  const extensionsBefore = piExtensionEntries(environment).join("\0")
  const refresh =
    dependencies.refreshHarness ??
    (async (harness: string, currentEnvironment: NodeJS.ProcessEnv) => {
      if (harness !== "pi") return undefined
      const warnings = [piRefresh.releaseWarning, piRefresh.extensionsWarning]
      warnings.push(
        ...(await Promise.all([
          piRefresh.releaseWarning ? undefined : refreshPiRelease(currentEnvironment, piRefresh.releaseTag),
          piRefresh.extensionsWarning
            ? undefined
            : refreshPiExtensions(currentEnvironment, piRefresh.extensionsNeedUpdate),
        ])),
      )
      return warnings.filter(Boolean).join("; ") || undefined
    })
  const warning = await refresh(prepared.adapter.id, environment)
  if (warning) write(`Warning     ${warning}`)
  if (prepared.adapter.id !== "pi" || piExtensionEntries(environment).join("\0") === extensionsBefore) return prepared
  return prepareRun(options, dependencies)
}

const assertLaunchIsolation = (prepared: PreparedRun, options: RunOptions): void => {
  if (prepared.isolation.status === "proven" || options.allowUnprovenIsolation) return
  throw new NativeRunError(
    "isolation",
    `${prepared.adapter.label} configuration isolation is not proven, so the launch was not started. Unselected skills from the repository or host may load. Remove --require-proven-isolation to launch anyway.`,
  )
}

const createRunWriter = (options: RunOptions, dependencies: RunDependencies): ((line: string) => void) => {
  if (dependencies.write) return dependencies.write
  const outputFormatIndex = options.forwardedArgs.findIndex((argument) => argument === "--output-format")
  const outputFormat =
    outputFormatIndex === -1
      ? options.forwardedArgs
          .find((argument) => argument.startsWith("--output-format="))
          ?.slice("--output-format=".length)
      : options.forwardedArgs[outputFormatIndex + 1]
  const machineOutput = outputFormat === "json" || outputFormat === "jsonl" || outputFormat === "stream-json"
  if (machineOutput || (!options.dryRun && !process.stdout.isTTY)) return () => undefined
  return (line: string) => process.stdout.write(`${line}\n`)
}

const resolvePreparedLaunch = async (prepared: PreparedRun, launchInput: LaunchInput): Promise<LaunchCommand> => {
  const resolve = prepared.clean
    ? prepared.adapter.clean.supported
      ? prepared.adapter.clean.resolveLaunch
      : undefined
    : prepared.adapter.resolveLaunch
  const resolvedLaunch = (await resolve?.(launchInput, prepared.launch)) ?? prepared.launch
  const finalEnvironment = prepared.clean ? undefined : await prepared.adapter.beforeLaunch?.(launchInput)
  return finalEnvironment === undefined
    ? resolvedLaunch
    : { ...resolvedLaunch, env: { ...resolvedLaunch.env, ...finalEnvironment } }
}

const argumentAfter = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = args.lastIndexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Give the workers Firstmate starts the same proxy setup as the supervisor (see worker-handoff.ts). */
const handOffToFirstmateWorkers = async (
  prepared: PreparedRun,
  launch: LaunchCommand,
  paths: NativeRunPaths,
  environment: NodeJS.ProcessEnv,
): Promise<void> => {
  const compositions = path.join(paths.data, "compositions")
  const home = environment.HOME ?? ""
  await markWorkerGeneration(prepared.layout.generationPath)
  if (prepared.adapter.id === "claude") {
    await writeClaudeWorkerEnvironment(prepared.layout.generationPath, launch, workerPath(home, environment.PATH))
    await clearFirstmatePiWorkers(prepared.workspace, compositions)
    return
  }
  if (prepared.adapter.id !== "pi") return
  const provider = argumentAfter(launch.args, "--provider")
  const model = argumentAfter(launch.args, "--model")
  if (!provider || !model) throw new NativeRunError("launch", "the Pi launch names no provider and model for Firstmate's workers")
  await writePiWorkerShell(prepared.layout.generationPath, home)
  await writeFirstmatePiWorkers(
    prepared.workspace,
    compositions,
    prepared.layout.generationPath,
    provider,
    model,
    argumentAfter(launch.args, "--thinking"),
  )
}

const launchPreparedRun = async (
  prepared: PreparedRun,
  options: RunOptions,
  dependencies: RunDependencies,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  paths: NativeRunPaths,
  write: (line: string) => void,
): Promise<number> => {
  await prepared.adapter.trustWorkspace?.(prepared.layout, prepared.workspace)
  const history = createSelectionHistory(paths)
  const keys = await scopeKeysFor(cwd)
  const lease = await acquireLease(paths, prepared.plan.generationId)
  const ompProfile = prepared.plan.profiles.find((profile) => profile.startsWith("preset-omp-"))?.slice("preset-omp-".length)
  let guard: ReturnType<typeof acquireProfileGuard> | undefined
  let cleanup: (() => void | Promise<void>) | undefined
  try {
    guard =
      prepared.adapter.id === "omp"
        ? acquireProfileGuard("omp", [ompProfile ?? "default"], "run", environment.HOME)
        : undefined
    const launchInput = {
      layout: prepared.layout,
      plan: prepared.plan,
      planMode: options.plan === true,
      model: launchModel(prepared),
      effort: launchEffort(prepared),
      forwardedArgs: options.forwardedArgs,
      resumeArgs: options.resume ? prepared.adapter.resumeArgs(options.resume) : [],
      environment,
      workspace: prepared.workspace,
      ...(guard === undefined ? {} : { guard }),
    }
    const launch = await resolvePreparedLaunch(prepared, launchInput)
    cleanup = launch.cleanup
    if (prepared.plan.workers === "firstmate") await handOffToFirstmateWorkers(prepared, launch, paths, environment)
    let recorded: Promise<void> = Promise.resolve()
    const status = await (dependencies.spawner ?? spawnInherited)(launch, environment, prepared.workspace, (pid) => {
      if (pid !== undefined) guard?.attachChild(pid)
      recorded = history.record(keys, prepared.selection).catch(() => undefined)
    }, guard)
    await recorded
    if (prepared.adapter.resumeArgs({ kind: "continue" }).length > 0)
      write(`Resume     ${resumeCommand(options)}`)
    return status
  } finally {
    try {
      await cleanup?.()
    } finally {
      try {
        guard?.release()
      } finally {
        await lease.release()
      }
    }
  }
}

const checkRunPiRefresh = (
  options: RunOptions,
  dependencies: RunDependencies,
  environment: NodeJS.ProcessEnv,
): Promise<PiRefreshCheck> => {
  const clean = options.profiles.includes(CLEAN_PROFILE)
  return options.harness === "pi" && !clean && !options.dryRun && dependencies.refreshHarness === undefined
    ? checkPiRefresh(environment)
    : Promise.resolve({})
}

const pickRunResumeSession = async (
  prepared: PreparedRun,
  options: RunOptions,
  dependencies: RunDependencies,
): Promise<{ options: RunOptions; prepared: PreparedRun } | undefined> => {
  if (options.resume?.kind !== "pick" || options.resume.id !== undefined || !prepared.adapter.pickResumeSession)
    return { options, prepared }
  const id = await prepared.adapter.pickResumeSession({
    ownerHome: prepared.layout.ownerHome,
    workspace: prepared.workspace,
  })
  if (id === undefined) return undefined
  const resumedOptions: RunOptions = { ...options, resume: { kind: "pick", id } }
  return { options: resumedOptions, prepared: await prepareRun(resumedOptions, dependencies) }
}

export const runNative = async (options: RunOptions, dependencies: RunDependencies = {}): Promise<number> => {
  const write = createRunWriter(options, dependencies)
  const environment = dependencies.environment ?? process.env
  const cwd = dependencies.cwd ?? process.cwd()
  const paths = dependencies.paths ?? resolveNativeRunPaths({ environment })
  const piRefresh = checkRunPiRefresh(options, dependencies, environment)

  let prepared = await prepareRun(options, dependencies)
  for (const line of describePreparedRun(prepared)) write(line)
  if (options.dryRun) return 0
  const resumed = await pickRunResumeSession(prepared, options, dependencies)
  if (resumed === undefined) return 0
  const effectiveOptions = resumed.options
  prepared = resumed.prepared
  if (!prepared.clean)
    prepared = await refreshPreparedRun(prepared, effectiveOptions, dependencies, environment, write, await piRefresh)
  assertLaunchIsolation(prepared, effectiveOptions)
  return launchPreparedRun(prepared, effectiveOptions, dependencies, environment, cwd, paths, write)
}

export const main = async (argv: ReadonlyArray<string>, dependencies: RunDependencies = {}): Promise<number> => {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(`${RUN_USAGE}\n`)
    return argv.length === 0 ? 2 : 0
  }
  try {
    return await runNative(parseRunArguments(argv), dependencies)
  } catch (error) {
    if (error instanceof NativeRunError) {
      process.stderr.write(`trx run: ${error.message}\n`)
      if (error instanceof NativeRunCancelledError) return 128 + (osConstants.signals[error.signal] ?? 0)
      return error.code === "usage" ? 2 : 1
    }
    throw error
  }
}
