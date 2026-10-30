import { constants as fsConstants } from "node:fs"
import { access, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import type { CompositionPlan } from "./compose.ts"
import { lifecycleRuntime, lifecycleRuntimeCommand } from "./lifecycle-runtime.ts"
import { prepareRun, type PreparedRun, type RunDependencies } from "./run.ts"
import { primeRuntimePaths } from "./prime-runtime.ts"

export type InventoryReadiness = "healthy" | "unhealthy" | "not-setup" | "busy"
export type InventoryCheckStatus = "ok" | "failed" | "skipped"

export interface InventoryCheck {
  readonly id: string
  readonly status: InventoryCheckStatus
  readonly detail: string
}

export interface CompositionInventory {
  readonly schemaVersion: 2
  readonly harness: string
  readonly profiles: ReadonlyArray<string>
  readonly effectiveProfiles: ReadonlyArray<string>
  readonly readiness: InventoryReadiness
  readonly binary: {
    readonly command: string
    readonly path: string | null
    readonly version: string | null
  }
  readonly checks: ReadonlyArray<InventoryCheck>
  readonly plugins: ReadonlyArray<{ readonly name: string; readonly version: string }>
  readonly skills: {
    readonly packageCount: number | null
    readonly visibleCount: number | null
    readonly names: ReadonlyArray<string>
  }
  readonly mcps: ReadonlyArray<string>
  readonly isolation: PreparedRun["isolation"]
}

export interface InventoryOptions {
  readonly harness: string
  readonly profiles: ReadonlyArray<string>
  readonly noAlways?: boolean
}

export interface InventoryProcessResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

type ProcessRunner = (
  command: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  cwd?: string,
) => Promise<InventoryProcessResult>

export interface InventoryDependencies extends RunDependencies {
  readonly prepare?: typeof prepareRun
  readonly runProcess?: ProcessRunner
  readonly resolveBinary?: (command: string, environment: NodeJS.ProcessEnv) => Promise<string | null>
}

interface DependencyCheck extends InventoryCheck {
  readonly readiness?: Exclude<InventoryReadiness, "healthy">
}

const runProcess: ProcessRunner = (command, args, environment, timeoutMs, cwd) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      resolve({ status: null, stdout, stderr: stderr || error.message, timedOut })
    })
    child.once("close", (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr, timedOut })
    })
  })

const executablePath = async (command: string, environment: NodeJS.ProcessEnv): Promise<string | null> => {
  const candidates = path.isAbsolute(command)
    ? [command]
    : (environment.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, command))
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK)
      return await realpath(candidate)
    } catch {
      // Continue through PATH. A missing or non-executable candidate is not usable.
    }
  }
  return null
}

const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : undefined
  } catch {
    return undefined
  }
}

const publicProfile = (harness: string, profile: string): string => {
  const prefix = `preset-${harness}-`
  return profile.startsWith(prefix) ? profile.slice(prefix.length) : profile
}

const selectedPreset = (plan: CompositionPlan): string | undefined => {
  const prefix = `preset-${plan.harness}-`
  return plan.profiles.find((profile) => profile.startsWith(prefix))?.slice(prefix.length)
}

const lifecycleAdmissionProfile = (prepared: PreparedRun): string | undefined => {
  if (prepared.clean) return undefined
  const preset = selectedPreset(prepared.plan)
  switch (prepared.adapter.id) {
    case "agency":
      return "azure"
    case "copilot":
      return preset ?? "hve"
    case "claude": {
      const profile = preset ?? "default"
      return ["default", "office", "office-charts"].includes(profile) ? profile : undefined
    }
    case "jcode":
    case "prime":
      return "default"
    case "omp":
      return preset ?? "default"
    default:
      return undefined
  }
}

const readinessValue = (value: unknown): InventoryReadiness | undefined =>
  value === "healthy" || value === "unhealthy" || value === "not-setup" || value === "busy"
    ? value
    : undefined

interface AdmissionCheckResult {
  readonly check: DependencyCheck
  readonly inventory?: Readonly<Record<string, unknown>>
}

const checkLegacyAdmission = async (
  prepared: PreparedRun,
  environment: NodeJS.ProcessEnv,
  execute: ProcessRunner,
): Promise<AdmissionCheckResult> => {
  const profile = lifecycleAdmissionProfile(prepared)
  if (profile === undefined)
    return {
      check: { id: "admission", status: "skipped", detail: "this composition has no lifecycle admission dependency" },
    }
  const runtime = lifecycleRuntime(prepared.adapter.id)
  if (!runtime)
    return {
      check: {
        id: "admission",
        status: "failed",
        detail: `no lifecycle runtime is registered for ${prepared.adapter.id}`,
        readiness: "unhealthy",
      },
    }
  let command: string
  try {
    command = lifecycleRuntimeCommand(runtime, environment.HOME)
  } catch (error) {
    return {
      check: {
        id: "admission",
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
        readiness: "not-setup",
      },
    }
  }
  const result = await execute(command, ["inventory", runtime.profileName(profile), "--json"], environment, 15_000)
  const payload = parseJsonObject(result.stdout)
  const readiness = readinessValue(payload?.readiness)
  if (result.status !== 0 || payload === undefined || readiness === undefined)
    return {
      check: {
        id: "admission",
        status: "failed",
        detail: result.timedOut
          ? `${runtime.runtimeName} inventory timed out`
          : result.stderr.trim() || `invalid ${runtime.runtimeName} inventory response`,
        readiness: "unhealthy",
      },
    }
  if (readiness !== "healthy")
    return {
      check: {
        id: "admission",
        status: "failed",
        detail: `${runtime.runtimeName} reports ${runtime.profileName(profile)} ${readiness}`,
        readiness,
      },
      inventory: payload,
    }
  if (prepared.adapter.id === "agency" && typeof payload?.authenticationMethod !== "string")
    return {
      check: {
        id: "admission",
        status: "failed",
        detail: "Agency inventory did not report an authentication method",
        readiness: "unhealthy",
      },
      inventory: payload,
    }
  return {
    check: {
      id: "admission",
      status: "ok",
      detail: `${runtime.runtimeName} reports ${runtime.profileName(profile)} healthy`,
    },
    inventory: payload,
  }
}

const knownVersionHarnesses = new Set(["agency", "claude", "codex", "copilot", "empryo", "fx", "grok", "jcode", "omp", "pi", "prime", "uji", "nodecode"])

const checkBinary = async (
  prepared: PreparedRun,
  environment: NodeJS.ProcessEnv,
  execute: ProcessRunner,
  resolve: (command: string, environment: NodeJS.ProcessEnv) => Promise<string | null>,
): Promise<{
  readonly binary: CompositionInventory["binary"]
  readonly checks: ReadonlyArray<DependencyCheck>
}> => {
  const command = prepared.launch.command
  let probeCommand = command
  if (prepared.adapter.id === "jcode" && !(environment.TRELLAGE_JCODE_BIN && path.isAbsolute(environment.TRELLAGE_JCODE_BIN))) {
    const runtime = lifecycleRuntime("jcode")
    if (runtime) {
      try {
        const admission = await execute(lifecycleRuntimeCommand(runtime, environment.HOME), ["_trx-executable"], environment, 15_000)
        const candidate = admission.stdout.trim()
        if (admission.status === 0 && path.isAbsolute(candidate)) probeCommand = candidate
      } catch {
        // The admission inventory check below reports the lifecycle ownership failure.
      }
    }
  } else if (prepared.adapter.id === "prime" && !path.isAbsolute(command)) {
    const candidate = path.join(primeRuntimePaths({ environment }).rustPrefix, "bin", "prime-agent")
    if ((await resolve(candidate, environment)) !== null) probeCommand = candidate
  }
  const resolved = await resolve(probeCommand, environment)
  if (resolved === null)
    return {
      binary: { command, path: null, version: null },
      checks: [
        { id: "binary", status: "failed", detail: `${command} is not executable on PATH`, readiness: "not-setup" },
        { id: "binary-version", status: "skipped", detail: "binary is unavailable" },
      ],
    }
  const binaryCheck: DependencyCheck = { id: "binary", status: "ok", detail: resolved }
  if (!knownVersionHarnesses.has(prepared.adapter.id))
    return {
      binary: { command, path: resolved, version: null },
      checks: [binaryCheck, { id: "binary-version", status: "skipped", detail: "no supported version probe" }],
    }
  const result = await execute(resolved, ["--version"], environment, 3_000)
  const version = `${result.stdout}\n${result.stderr}`.match(/(?<![\d.])\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?\b/)?.[0] ?? null
  if (result.status !== 0 || version === null)
    return {
      binary: { command, path: resolved, version: null },
      checks: [
        binaryCheck,
        {
          id: "binary-version",
          status: "failed",
          detail: result.timedOut ? `${command} --version timed out` : `${command} --version did not report a version`,
          readiness: "unhealthy",
        },
      ],
    }
  return {
    binary: { command, path: resolved, version },
    checks: [binaryCheck, { id: "binary-version", status: "ok", detail: version }],
  }
}

const pluginInventory = async (
  plan: CompositionPlan,
): Promise<ReadonlyArray<{ readonly name: string; readonly version: string }>> =>
  Promise.all(
    plan.plugins.map(async (plugin) => {
      try {
        const manifest = parseJsonObject(
          await readFile(path.join(plugin.directory, ".claude-plugin", "plugin.json"), "utf8"),
        )
        if (typeof manifest?.version === "string" && manifest.version.length > 0)
          return { name: plugin.name, version: manifest.version }
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined
        if (code !== "ENOENT") throw error
      }
      return { name: plugin.name, version: plugin.commit }
    }),
  )

const pluginMcps = async (plan: CompositionPlan): Promise<string[]> => {
  const names = new Set<string>()
  for (const plugin of plan.plugins) {
    if (!plugin.includeMcp) continue
    try {
      const payload = parseJsonObject(await readFile(path.join(plugin.directory, ".mcp.json"), "utf8"))
      const servers = payload?.mcpServers
      if (servers !== null && typeof servers === "object" && !Array.isArray(servers))
        for (const name of Object.keys(servers)) names.add(name)
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined
      if (code !== "ENOENT") throw error
    }
  }
  return [...names].sort()
}

interface LegacyResources {
  readonly plugins: ReadonlyArray<{ readonly name: string; readonly version: string }>
  readonly packageCount: number | null
  readonly visibleCount: number | null
  readonly mcps: ReadonlyArray<string>
}

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined

const legacyResources = (inventory: Readonly<Record<string, unknown>> | undefined): LegacyResources => {
  const plugins = Array.isArray(inventory?.plugins)
    ? inventory.plugins.flatMap((value) => {
        const plugin = objectValue(value)
        return typeof plugin?.name === "string" && typeof plugin.version === "string"
          ? [{ name: plugin.name, version: plugin.version }]
          : []
      })
    : []
  const skills = objectValue(inventory?.skills)
  return {
    plugins,
    packageCount: typeof skills?.packageCount === "number" ? skills.packageCount : null,
    visibleCount: typeof skills?.visibleCount === "number" ? skills.visibleCount : null,
    mcps: Array.isArray(inventory?.mcps)
      ? inventory.mcps.filter((value): value is string => typeof value === "string")
      : [],
  }
}

export const aggregateInventoryReadiness = (checks: ReadonlyArray<DependencyCheck>): InventoryReadiness => {
  const failures = checks.filter((check) => check.status === "failed").map((check) => check.readiness ?? "unhealthy")
  if (failures.length === 0) return "healthy"
  if (failures.includes("busy")) return "busy"
  if (failures.includes("not-setup")) return "not-setup"
  return "unhealthy"
}

const launchEnvironment = (
  environment: NodeJS.ProcessEnv,
  overlay: Readonly<Record<string, string | null>>,
): NodeJS.ProcessEnv => {
  const merged = { ...environment }
  for (const [name, value] of Object.entries(overlay)) {
    if (value === null) delete merged[name]
    else merged[name] = value
  }
  return merged
}

/** Run Codex's own feature listing with the exact generated composition and launch overrides. */
export const inventoryCodexGoalFeatures = async (
  options: InventoryOptions,
  dependencies: InventoryDependencies = {},
): Promise<InventoryProcessResult> => {
  if (options.harness !== "codex") throw new Error("goal feature inventory is supported only for codex")
  const environment = dependencies.environment ?? process.env
  const prepared = await (dependencies.prepare ?? prepareRun)(
    {
      harness: "codex",
      profiles: options.profiles,
      dryRun: true,
      allowUnprovenIsolation: true,
      noAlways: options.noAlways === true,
      forwardedArgs: ["features", "list"],
    },
    dependencies,
  )
  return (dependencies.runProcess ?? runProcess)(
    prepared.launch.command,
    prepared.launch.args,
    launchEnvironment(environment, prepared.launch.env),
    30_000,
    prepared.workspace,
  )
}

/**
 * Resolve the same composition as `trx run --dry-run`. Source caches and an immutable
 * generation may be written by prepareRun; setup, repair, installers, admission and the
 * harness itself are never invoked here.
 */
export const inventoryComposition = async (
  options: InventoryOptions,
  dependencies: InventoryDependencies = {},
): Promise<CompositionInventory> => {
  const environment = dependencies.environment ?? process.env
  const prepared = await (dependencies.prepare ?? prepareRun)(
    {
      harness: options.harness,
      profiles: options.profiles,
      dryRun: true,
      allowUnprovenIsolation: true,
      noAlways: options.noAlways === true,
      forwardedArgs: [],
    },
    dependencies,
  )
  const execute = dependencies.runProcess ?? runProcess
  const binary = await checkBinary(prepared, environment, execute, dependencies.resolveBinary ?? executablePath)
  const admission = await checkLegacyAdmission(prepared, environment, execute)
  const checks: DependencyCheck[] = [
    {
      id: "composition",
      status: "ok",
      detail: `resolved ${prepared.plan.generationId}; dry-run may refresh source caches and publish this generation`,
    },
    ...binary.checks,
    admission.check,
  ]
  if (prepared.missing.length === 0)
    checks.push({ id: "prerequisites", status: "ok", detail: "all profile prerequisites are executable" })
  else
    checks.push({
      id: "prerequisites",
      status: "failed",
      detail: `missing: ${prepared.missing.join(", ")}`,
      readiness: "not-setup",
    })
  for (const [index, warning] of (prepared.plan.mcpWarnings ?? []).entries())
    checks.push({ id: `mcp-${index}`, status: "skipped", detail: warning })
  const names = prepared.plan.skills.map((skill) => skill.name).sort()
  const effectiveProfiles = [
    ...prepared.plan.alwaysProfiles.map((profile) => publicProfile(options.harness, profile)),
    ...prepared.plan.profiles.map((profile) => publicProfile(options.harness, profile)),
  ].filter((profile, index, all) => all.indexOf(profile) === index)
  const nativePlugins = await pluginInventory(prepared.plan)
  const legacy = legacyResources(admission.inventory)
  const plugins = [...new Map([...nativePlugins, ...legacy.plugins].map((plugin) => [plugin.name, plugin])).values()]
  const mcps = [...new Set([...Object.keys(prepared.plan.mcp?.servers ?? {}), ...(await pluginMcps(prepared.plan)), ...legacy.mcps])].sort()
  return {
    schemaVersion: 2,
    harness: options.harness,
    profiles: [...options.profiles],
    effectiveProfiles,
    readiness: aggregateInventoryReadiness(checks),
    binary: binary.binary,
    checks: checks.map(({ id, status, detail }) => ({ id, status, detail })),
    plugins,
    skills: {
      packageCount: legacy.packageCount,
      visibleCount: legacy.visibleCount ?? names.length,
      names,
    },
    mcps,
    isolation: prepared.isolation,
  }
}
