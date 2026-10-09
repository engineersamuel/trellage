import { execFile, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { lstat, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { readTrellageConfig, TrellageConfigError, type NativeCatalog } from "../native-config.ts"
import {
  PI_EXTENSION_PACKAGES,
  piExtensionEntries,
  piExtensionsHome,
  adapterFor,
  assertEffort,
  hostDefaults,
  type HostDefaults,
  assertForwardedArgs,
  type LaunchCommand,
  type NativeAdapter,
  type ResumeRequest,
} from "./adapters.ts"
import { planComposition, publishGeneration, type CompositionPlan, type GenerationLayout } from "./compose.ts"
import { createSelectionHistory, scopeKeysFor, type Selection } from "./history.ts"
import { acquireLease, pruneGenerations } from "./lease.ts"
import { NativeRunError, resolveNativeRunPaths, type NativeRunPaths } from "./paths.ts"
import { createSourceResolver, gitSourceTransport, type SourceTransport } from "./source.ts"

export interface RunOptions {
  readonly harness: string
  readonly profiles: ReadonlyArray<string>
  readonly model?: string | undefined
  readonly effort?: string | undefined
  readonly dryRun: boolean
  readonly allowUnprovenIsolation: boolean
  /** Launch without always-on profiles (a clean base harness). */
  readonly noAlways?: boolean
  readonly forwardedArgs: ReadonlyArray<string>
  /** Reopen the most recent conversation (continue) or choose one (pick, optionally by id). */
  readonly resume?: ResumeRequest | undefined
}

export const RUN_USAGE = `Usage:
  trx run <harness> [<profile>...] [--model NAME] [--effort NAME] [--dry-run]
          [--no-always] [--require-proven-isolation] [--continue | --resume[=ID]]
          [-- <harness-args>]

Harnesses: pi, copilot, claude, codex, grok. Profiles come from ~/.config/trellage/config.toml.
Profiles with always = true are added to every run; --no-always skips them. --dry-run prepares the composition and
prints the launch plan without starting the harness.
Conversations are kept per harness and profile set. --continue reopens the most recent one in this directory;
--resume lists them (or --resume=ID opens one). Use the same harness and profiles as the original run.`

interface RunArgumentState {
  model?: string
  effort?: string
  dryRun: boolean
  allowUnprovenIsolation: boolean
  noAlways: boolean
  resume?: ResumeRequest
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
  if (state.model !== undefined && state.model.length === 0) throw new NativeRunError("usage", "--model requires a value")
  return { harness, profiles, forwardedArgs, ...state }
}

const MAX_INSTRUCTION_BYTES = 64 * 1024

/** Read every instruction file the catalog declares; paths are relative to the config directory. */
const loadInstructions = async (configDirectory: string, catalog: NativeCatalog): Promise<Record<string, string>> => {
  const texts: Record<string, string> = {}
  for (const [id, instruction] of Object.entries(catalog.instructions)) {
    const file = path.join(configDirectory, instruction.file)
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.size > MAX_INSTRUCTION_BYTES) throw new Error("not a regular file within the size limit")
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
  (command: LaunchCommand, environment: NodeJS.ProcessEnv, cwd: string, onSpawn: () => void): Promise<number>
}

export const spawnInherited: Spawner = (launch, environment, cwd, onSpawn) =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...environment }
    for (const [key, value] of Object.entries(launch.env)) {
      if (value === null) delete env[key]
      else env[key] = value
    }
    const child = spawn(launch.command, [...launch.args], { cwd, env, stdio: "inherit" })
    child.once("spawn", onSpawn)
    child.once("error", (error) => reject(new NativeRunError("launch", `could not start ${launch.command}: ${error.message}`)))
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
    const term = forward("SIGTERM")
    process.on("SIGTERM", term)
    child.once("exit", (code, signal) => {
      process.off("SIGTERM", term)
      resolve(code ?? (signal ? 128 : 1))
    })
  })

const piInstaller = fileURLToPath(new URL("../../../../scripts/install-pi-release.sh", import.meta.url))
const execFilePromise = promisify(execFile)
const LATEST_CHECK_TIMEOUT_MS = 2_000

const latestPiReleaseTag = async (environment: NodeJS.ProcessEnv): Promise<string> => {
  const { stdout } = await execFilePromise("gh", ["release", "view", "-R", "earendil-works/pi", "--json", "tagName", "--jq", ".tagName"], {
    env: environment, encoding: "utf8", timeout: LATEST_CHECK_TIMEOUT_MS,
  })
  const tag = stdout.trim()
  if (!/^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.]+)?$/.test(tag)) throw new Error(`GitHub returned an invalid Pi release tag: ${tag}`)
  return tag
}

/** Install the given Pi GitHub release; resolving it separately lets source and release checks overlap. */
export const refreshPiRelease = (environment: NodeJS.ProcessEnv, tag?: string): Promise<string | undefined> => {
  if (environment.TRELLAGE_PI_BIN || environment.TRELLAGE_PI_AUTO_UPDATE === "0") return Promise.resolve(undefined)
  return new Promise((resolve) => {
    execFile("bash", tag === undefined ? [piInstaller] : [piInstaller, tag], { env: environment, timeout: 120_000 }, (error, _stdout, stderr) => {
      resolve(error ? `Pi release update failed, using the installed Pi: ${stderr.trim().split("\n").pop() || error.message}` : undefined)
    })
  })
}

type LatestPackageVersion = (name: string, environment: NodeJS.ProcessEnv) => Promise<string>

const npmLatestPackageVersion: LatestPackageVersion = async (name, environment) => {
  const { stdout } = await execFilePromise("npm", ["view", name, "version", "--json"], {
    env: environment, encoding: "utf8", timeout: LATEST_CHECK_TIMEOUT_MS,
  })
  const version: unknown = JSON.parse(stdout)
  if (typeof version !== "string" || version.length === 0) throw new Error(`npm returned an invalid latest version for ${name}`)
  return version
}

export const piExtensionsNeedUpdate = async (
  environment: NodeJS.ProcessEnv,
  latestVersion: LatestPackageVersion = npmLatestPackageVersion,
): Promise<boolean> => {
  const home = piExtensionsHome(environment)
  const installed = await Promise.all(PI_EXTENSION_PACKAGES.map(async (name) => {
    try {
      const manifest: unknown = JSON.parse(await readFile(path.join(home, "node_modules", name, "package.json"), "utf8"))
      return manifest && typeof manifest === "object" && "version" in manifest && typeof manifest.version === "string"
        ? manifest.version : undefined
    } catch {
      return undefined
    }
  }))
  if (installed.some((version) => version === undefined)) return true
  const latest = await Promise.all(PI_EXTENSION_PACKAGES.map((name) => latestVersion(name, environment)))
  return installed.some((version, index) => version !== latest[index])
}

/** Check the always-on Pi extensions and install only when a package is missing or outdated. */
export const refreshPiExtensions = async (environment: NodeJS.ProcessEnv, needsUpdate?: boolean): Promise<string | undefined> => {
  if (environment.TRELLAGE_PI_BIN || environment.TRELLAGE_PI_AUTO_UPDATE === "0") return undefined
  const home = piExtensionsHome(environment)
  try {
    await mkdir(home, { recursive: true })
    if (!(needsUpdate ?? (await piExtensionsNeedUpdate(environment)))) return undefined
    await execFilePromise("npm", [
      "install", "--prefix", home, "--no-audit", "--no-fund", "--no-progress", "--loglevel=error",
      ...PI_EXTENSION_PACKAGES.map((name) => `${name}@latest`),
    ], { env: environment, timeout: 120_000 })
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
      (error: unknown) => ({ releaseWarning: `Pi release update failed, using the installed Pi: ${error instanceof Error ? error.message : String(error)}` }),
    ),
    piExtensionsNeedUpdate(environment).then(
      (extensionsNeedUpdate) => ({ extensionsNeedUpdate }),
      (error: unknown) => ({ extensionsWarning: `Pi extension update failed, using the installed extensions: ${error instanceof Error ? error.message : String(error)}` }),
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
}

export interface PreparedRun {
  readonly adapter: NativeAdapter
  readonly plan: CompositionPlan
  readonly layout: GenerationLayout
  readonly launch: LaunchCommand
  readonly selection: Selection
  /** Host defaults applied when the selection names no model or effort. */
  readonly defaults: HostDefaults
}

const shellWord = (word: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)

const launchModel = (prepared: PreparedRun): string | undefined => prepared.selection.model ?? prepared.defaults.model
const launchEffort = (prepared: PreparedRun): string | undefined => prepared.selection.effort ?? prepared.defaults.effort

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
  layout: GenerationLayout,
  plan: CompositionPlan,
  options: RunOptions,
  defaults: HostDefaults,
  environment: NodeJS.ProcessEnv,
  workspace: string,
): LaunchCommand =>
  adapter.launch({
    layout,
    plan,
    model: options.model ?? defaults.model,
    effort: options.effort ?? defaults.effort,
    forwardedArgs: options.forwardedArgs,
    resumeArgs: options.resume ? adapter.resumeArgs(options.resume) : [],
    environment,
    workspace,
  })

export const describePreparedRun = (prepared: PreparedRun): string[] => {
  const { adapter, plan, layout, launch } = prepared
  const policy = adapter.effectivePolicy(launchModel(prepared), launchEffort(prepared))
  return [
    `Harness     ${adapter.label}${plan.profiles.length ? ` + ${plan.profiles.join(" + ")}` : " (no selected profiles)"}`,
    ...(adapter.extensions?.length ? [`Extensions  ${adapter.extensions.join(", ")}`] : []),
    `Always-on   ${plan.alwaysProfiles.join(", ") || "none"}`,
    `Instructions ${plan.instructions.map((instruction) => instruction.id).join(", ") || "none"}`,
    `Normal      ${policy.normal}`,
    `Plan        ${policy.plan}`,
    `Isolation   ${adapter.isolation.status} — ${adapter.isolation.evidence}`,
    `Generation  ${layout.generationPath}`,
    ...(plan.skills.length === 0
      ? ["Skills      none"]
      : plan.skills.map(
          (skill, index) => `${index === 0 ? "Skills      " : "            "}${skill.name}  ${skill.sourceId}@${skill.commit.slice(0, 12)}`,
        )),
    ...plan.warnings.map((warning) => `Warning     ${warning}`),
    `Command     ${[launch.command, ...launch.args].map(shellWord).join(" ")}`,
  ]
}

/** Resolve, validate, stage and publish the composition without starting the harness. */
export const prepareRun = async (options: RunOptions, dependencies: RunDependencies = {}): Promise<PreparedRun> => {
  const environment = dependencies.environment ?? process.env
  const paths = dependencies.paths ?? resolveNativeRunPaths({ environment })
  const adapter = adapterFor(options.harness)
  assertEffort(adapter, options.effort)
  assertForwardedArgs(adapter, options.forwardedArgs)

  const loaded = await loadNativeCatalog(dependencies, environment)
  const catalog = loaded.config.native
  const instructionTexts = await loadInstructions(path.dirname(loaded.path), catalog)
  const resolver = createSourceResolver({ paths, transport: dependencies.transport ?? gitSourceTransport() })
  const plan = await planComposition(
    {
      harness: adapter.id,
      profiles: options.profiles,
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
    writeAdapterFiles: (stage, generationLayout) => adapter.writeAdapterFiles(stage, options.model, generationLayout),
  })
  for (const source of plan.sources) await resolver.markGood(source)
  await pruneGenerations(paths, layout.ownerHome, 3, plan.generationId)

  const defaults = hostDefaults(adapter.id, dependencies.configHome ?? environment.HOME)
  const launch = buildLaunch(adapter, layout, plan, options, defaults, environment, dependencies.cwd ?? process.cwd())
  return {
    adapter,
    plan,
    layout,
    launch,
    defaults,
    selection: { harness: adapter.id, profiles: plan.profiles, model: options.model, effort: options.effort },
  }
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
      warnings.push(...await Promise.all([
        piRefresh.releaseWarning ? undefined : refreshPiRelease(currentEnvironment, piRefresh.releaseTag),
        piRefresh.extensionsWarning ? undefined : refreshPiExtensions(currentEnvironment, piRefresh.extensionsNeedUpdate),
      ]))
      return warnings.filter(Boolean).join("; ") || undefined
    })
  const warning = await refresh(prepared.adapter.id, environment)
  if (warning) write(`Warning     ${warning}`)
  if (prepared.adapter.id !== "pi" || piExtensionEntries(environment).join("\0") === extensionsBefore) return prepared
  return prepareRun(options, dependencies)
}

const assertLaunchIsolation = (prepared: PreparedRun, options: RunOptions): void => {
  if (prepared.adapter.isolation.status === "proven" || options.allowUnprovenIsolation) return
  throw new NativeRunError(
    "isolation",
    `${prepared.adapter.label} configuration isolation is not proven, so the launch was not started. Unselected skills from the repository or host may load. Remove --require-proven-isolation to launch anyway.`,
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
  await prepared.adapter.trustWorkspace?.(prepared.layout, cwd)
  const history = createSelectionHistory(paths)
  const keys = await scopeKeysFor(cwd)
  const lease = await acquireLease(paths, prepared.plan.generationId)
  try {
    const launchInput = {
      layout: prepared.layout,
      plan: prepared.plan,
      model: launchModel(prepared),
      effort: launchEffort(prepared),
      forwardedArgs: options.forwardedArgs,
      resumeArgs: options.resume ? prepared.adapter.resumeArgs(options.resume) : [],
      environment,
      workspace: cwd,
    }
    const finalEnvironment = await prepared.adapter.beforeLaunch?.(launchInput)
    const launch =
      finalEnvironment === undefined
        ? prepared.launch
        : { ...prepared.launch, env: { ...prepared.launch.env, ...finalEnvironment } }
    let recorded: Promise<void> = Promise.resolve()
    const status = await (dependencies.spawner ?? spawnInherited)(launch, environment, cwd, () => {
      recorded = history.record(keys, prepared.selection).catch(() => undefined)
    })
    await recorded
    write(`Resume     ${resumeCommand(options)}`)
    return status
  } finally {
    await lease.release()
  }
}

export const runNative = async (options: RunOptions, dependencies: RunDependencies = {}): Promise<number> => {
  const write = dependencies.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const environment = dependencies.environment ?? process.env
  const cwd = dependencies.cwd ?? process.cwd()
  const paths = dependencies.paths ?? resolveNativeRunPaths({ environment })
  const piRefresh = options.harness === "pi" && !options.dryRun && dependencies.refreshHarness === undefined
    ? checkPiRefresh(environment) : Promise.resolve({})

  let prepared = await prepareRun(options, dependencies)
  for (const line of describePreparedRun(prepared)) write(line)
  if (options.dryRun) return 0
  prepared = await refreshPreparedRun(prepared, options, dependencies, environment, write, await piRefresh)
  assertLaunchIsolation(prepared, options)
  return launchPreparedRun(prepared, options, dependencies, environment, cwd, paths, write)
}

export const main = async (argv: ReadonlyArray<string>): Promise<number> => {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(`${RUN_USAGE}\n`)
    return argv.length === 0 ? 2 : 0
  }
  try {
    return await runNative(parseRunArguments(argv))
  } catch (error) {
    if (error instanceof NativeRunError) {
      process.stderr.write(`trx run: ${error.message}\n`)
      return error.code === "usage" ? 2 : 1
    }
    throw error
  }
}
