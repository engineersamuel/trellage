import { readFileSync } from "node:fs"
import { execFile, spawn } from "node:child_process"
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { parse as parseToml } from "smol-toml"
import { NativeRunError } from "./paths.ts"
import { PRIME_MANAGED_FLAGS, ensurePrimeRuntime, primeLaunchCommand, primeRuntimePaths } from "./prime-runtime.ts"
import type { GenerationLayout, CompositionPlan } from "./compose.ts"
import { lifecycleRuntime, lifecycleRuntimeCommand } from "./lifecycle-runtime.ts"
import { nativePresetProfiles } from "./presets.ts"

const execFileAsync = promisify(execFile)

const runFirstmateAdmission = (
  lifecycle: string,
  profile: string,
  forwardedArgs: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(lifecycle, ["_trx-admit", profile, ...forwardedArgs], {
      env: { ...environment, TRELLAGE_TRX_FIRSTMATE_ADAPTER: "1" },
      stdio: ["inherit", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk)
      process.stderr.write(chunk)
    })
    child.once("error", reject)
    child.once("close", (status, signal) => {
      const output = Buffer.concat(stdout).toString("utf8")
      if (status === 0) return resolve(output)
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim()
      reject(new Error(diagnostic || `Firstmate admission exited ${status ?? signal ?? "without status"}`))
    })
  })

export interface IsolationStatus {
  readonly status: "proven" | "unproven"
  readonly evidence: string
}

export interface EffectivePolicy {
  readonly normal: string
  readonly plan: string
}

export type ResumeRequest = { readonly kind: "continue" } | { readonly kind: "pick"; readonly id?: string | undefined }

export interface LaunchInput {
  /** Arguments that reopen a previous conversation, already translated for this harness. */
  readonly resumeArgs: ReadonlyArray<string>
  readonly layout: GenerationLayout
  readonly plan: CompositionPlan
  readonly planMode?: boolean
  readonly model?: string | undefined
  readonly effort?: string | undefined
  readonly forwardedArgs: ReadonlyArray<string>
  readonly environment: NodeJS.ProcessEnv
  /** Directory the harness starts in. */
  readonly workspace: string
}

export interface LaunchCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
  /** A string sets the variable; null removes it from the child environment. */
  readonly env: Readonly<Record<string, string | null>>
  /** Harnesses such as Firstmate run from their prepared runtime, not the entry worktree. */
  readonly cwd?: string
}

export interface NativeAdapter {
  readonly id: string
  readonly label: string
  readonly isolation: IsolationStatus
  readonly skillsSubdirectory: string
  readonly instructionsFile: string
  readonly efforts: ReadonlyArray<string>
  readonly planDefaults?: Readonly<{ model: string; effort: string }>
  /** Extensions installed and loaded on every launch. */
  readonly extensions?: ReadonlyArray<string>
  /** Bump when launch behavior or generated configuration changes. */
  readonly policyVersion: string
  readonly providerPolicy: (model: string | undefined) => string
  readonly effectivePolicy: (model: string | undefined, effort: string | undefined) => EffectivePolicy
  readonly writeAdapterFiles: (stage: string, model: string | undefined, layout: GenerationLayout) => Promise<void>
  /** Marks the workspace as trusted in the generation so the harness starts without a trust prompt. */
  readonly trustWorkspace?: (layout: GenerationLayout, workspace: string) => Promise<void>
  /** Generation-relative directories holding conversations, kept across generations. */
  readonly persistentState: ReadonlyArray<string>
  /** Harness arguments that reopen a previous conversation. */
  readonly resumeArgs: (resume: ResumeRequest) => ReadonlyArray<string>
  readonly launch: (input: LaunchInput) => LaunchCommand
  /** Final launch-only environment, prepared after dry-run handling and lease acquisition. */
  readonly beforeLaunch?: (input: LaunchInput) => Promise<Readonly<Record<string, string | null>>>
  readonly resolveLaunch?: (input: LaunchInput, planned: LaunchCommand) => Promise<LaunchCommand>
  /** Flags the adapter owns; forwarding them would undo the prepared boundary. */
  readonly managedFlags: ReadonlyArray<string>
}

const mergeJson = async (
  file: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> => {
  let current: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>
  } catch {
    // A missing or unreadable file starts from an empty object.
  }
  await writeFile(file, `${JSON.stringify(update(current), null, 2)}\n`, { mode: 0o600 })
}

const FX_PROVIDER = "trellage-copilot-proxy"
const FX_DEFAULT_MODEL = "gpt-6.1-sol"
const FX_DEFAULT_EFFORT = "medium"
const FX_PLAN_MODEL = "gpt-6-astra"
const FX_PLAN_EFFORT = "max"
const FX_PROVIDER_DEFINITION = {
  protocol: "openai-chat-completions",
  base_url: "http://127.0.0.1:8080/v1",
  auth: { type: "none" },
  tool_choice_mode: "send",
  reviewer_model: FX_DEFAULT_MODEL,
  model_metadata: {
    [FX_DEFAULT_MODEL]: {
      context_window: 1_050_000,
      max_output_tokens: 128_000,
      supports_tool_use: true,
      supports_vision: true,
    },
    [FX_PLAN_MODEL]: {
      context_window: 1_050_000,
      max_output_tokens: 128_000,
      supports_tool_use: true,
      supports_vision: true,
    },
  },
}

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

export const ensureFxProvider = async (environment: NodeJS.ProcessEnv): Promise<void> => {
  const home = environment.HOME ?? os.homedir()
  const directory = path.join(home, ".fx")
  const file = path.join(directory, "settings.json")
  const directoryStatus = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (directoryStatus && (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()))
    throw new NativeRunError("launch", `unsafe Fx settings directory: ${directory}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const fileStatus = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (fileStatus && (!fileStatus.isFile() || fileStatus.isSymbolicLink() || fileStatus.size > 64 * 1024))
    throw new NativeRunError("launch", `unsafe Fx settings file: ${file}`)
  let settings: Record<string, unknown> = {}
  if (fileStatus) {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object")
      settings = parsed as Record<string, unknown>
    } catch (error) {
      throw new NativeRunError(
        "launch",
        `invalid Fx settings: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const providers = settings.providers
  if (providers !== undefined && (!providers || typeof providers !== "object" || Array.isArray(providers)))
    throw new NativeRunError("launch", "invalid Fx providers configuration")
  const current = (providers as Record<string, unknown> | undefined)?.[FX_PROVIDER]
  if (current !== undefined && !sameJson(current, FX_PROVIDER_DEFINITION))
    throw new NativeRunError("launch", `Fx provider ${FX_PROVIDER} already exists with different settings`)
  if (current !== undefined) return
  const temporary = path.join(directory, `.settings-${randomUUID()}.json`)
  const next = {
    ...settings,
    providers: { ...(providers as Record<string, unknown> | undefined), [FX_PROVIDER]: FX_PROVIDER_DEFINITION },
  }
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  await rename(temporary, file)
}

const fxArguments = (effort: string, forwarded: ReadonlyArray<string>): string[] => {
  if (forwarded.length === 0) return ["--effort", effort]
  if (["ask", "acp"].includes(forwarded[0]!)) return [forwarded[0]!, "--effort", effort, ...forwarded.slice(1)]
  if (
    [
      "help",
      "-h",
      "--help",
      "-v",
      "--version",
      "status",
      "doctor",
      "models",
      "provider",
      "login",
      "logout",
      "setup",
      "teams",
      "credits",
      "balance",
      "usage",
      "sessions",
      "session",
      "mcp",
      "slack",
      "permissions",
      "workspace",
    ].includes(forwarded[0]!)
  )
    return [...forwarded]
  return ["--effort", effort, ...forwarded]
}

export const fxAdapter: NativeAdapter = {
  id: "fx",
  label: "Fx",
  isolation: {
    status: "unproven",
    evidence:
      "Fx intentionally uses the host HOME and ~/.fx so GitHub CLI, Git, SSH and shell context remain available",
  },
  skillsSubdirectory: "skills",
  instructionsFile: "instructions.md",
  efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  planDefaults: { model: FX_PLAN_MODEL, effort: FX_PLAN_EFFORT },
  policyVersion: "fx-1",
  providerPolicy: (model) => `${FX_PROVIDER}:${model ?? FX_DEFAULT_MODEL}`,
  effectivePolicy: (model, effort) => ({
    normal: `${model ?? `${FX_DEFAULT_MODEL} (default)`} · effort ${effort ?? `${FX_DEFAULT_EFFORT} (default)`}`,
    plan: `${FX_PLAN_MODEL} · effort ${FX_PLAN_EFFORT}`,
  }),
  managedFlags: ["--provider", "--model", "--effort"],
  writeAdapterFiles: async (stage) => {
    await mkdir(stage, { recursive: true })
  },
  persistentState: [],
  resumeArgs: () => [],
  launch: ({ model, effort, forwardedArgs, environment }) => ({
    command: binary(environment, "TRELLAGE_FX_BIN", "fx"),
    args: fxArguments(effort ?? FX_DEFAULT_EFFORT, forwardedArgs),
    env: {
      FX_AUTO_UPGRADE: "0",
      FX_PROVIDER,
      FX_MODEL: model ?? FX_DEFAULT_MODEL,
    },
  }),
  beforeLaunch: async ({ environment }) => {
    await ensureFxProvider(environment)
    return {}
  },
}

const flagName = (argument: string): string => argument.split("=", 1)[0]!

export const assertForwardedArgs = (adapter: NativeAdapter, args: ReadonlyArray<string>): void => {
  for (const argument of args) {
    if (adapter.managedFlags.includes(flagName(argument)))
      throw new NativeRunError(
        "usage",
        `${flagName(argument)} is managed by the ${adapter.label} adapter and cannot be forwarded`,
      )
  }
}

export const assertEffort = (adapter: NativeAdapter, effort: string | undefined): void => {
  if (effort !== undefined && !adapter.efforts.includes(effort))
    throw new NativeRunError(
      "usage",
      `${adapter.label} does not support effort ${effort}; supported: ${adapter.efforts.join(", ")}`,
    )
}

const binary = (environment: NodeJS.ProcessEnv, variable: string, fallback: string): string =>
  environment[variable] && path.isAbsolute(environment[variable]!) ? environment[variable]! : fallback

const lifecycleBinary = (
  environment: NodeJS.ProcessEnv,
  variable: string,
  runtime: string,
  executable: string,
): string =>
  binary(
    environment,
    variable,
    path.join(environment.HOME ?? os.homedir(), ".local", "share", "trellage", runtime, "bin", executable),
  )

const unprovenEvidence = (detail: string): IsolationStatus => ({
  status: "unproven",
  evidence: detail,
})

const selectedPreset = (plan: CompositionPlan, harness: string, fallback: string): string => {
  const prefix = `preset-${harness}-`
  return plan.profiles.find((profile) => profile.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

const lifecycleProfile = (plan: CompositionPlan, harness: string, fallback: string): string => {
  const preset = selectedPreset(plan, harness, "")
  if (preset) return preset
  const profiles = nativePresetProfiles(harness)
  return plan.profiles.find((profile) => profiles.includes(profile as never)) ?? fallback
}

const privateAdmission = async (
  harness: string,
  variable: string,
  guard: string,
  profile: string,
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> => {
  const runtime = lifecycleRuntime(harness)!
  const command = binary(environment, variable, lifecycleRuntimeCommand(runtime, environment.HOME))
  const { stdout } = await execFileAsync(command, ["_trx-admit", profile], {
    env: { ...environment, [guard]: "1" },
    encoding: "utf8",
  })
  try {
    const value: unknown = JSON.parse(stdout)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object")
    return value as Record<string, unknown>
  } catch {
    throw new NativeRunError("launch", `${harness} admission returned invalid JSON`)
  }
}

const ensureManagedSymlink = async (link: string, target: string): Promise<void> => {
  const status = await lstat(link).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (status) {
    if (!status.isSymbolicLink() || (await realpath(link)) !== (await realpath(target)))
      throw new NativeRunError("launch", `managed plugin path conflicts with generated content: ${link}`)
    return
  }
  await symlink(target, link)
}

const instructionsArgument = (layout: GenerationLayout): string[] => {
  const file = path.join(layout.generationPath, "always-on.md")
  try {
    return ["--append-system-prompt", readFileSync(file, "utf8")]
  } catch {
    return []
  }
}

export const agencyAdapter: NativeAdapter = {
  id: "agency",
  label: "Agency",
  isolation: unprovenEvidence("Agency owns the Copilot process while Trellage supplies its generated Copilot home"),
  skillsSubdirectory: "skills",
  instructionsFile: "always-on.md",
  efforts: ["low", "medium", "high", "xhigh", "max"],
  policyVersion: "agency-direct-1",
  providerPolicy: (model) => `agency:${model ?? "gpt-6-astra"}`,
  effectivePolicy: (model, effort) => ({
    normal: `${model ?? "gpt-6-astra"} · effort ${effort ?? "low"}`,
    plan: "Agency profile policy",
  }),
  managedFlags: ["--profile-only", "--model", "--effort"],
  writeAdapterFiles: async (stage) => {
    await mkdir(stage, { recursive: true })
    await writeFile(
      path.join(stage, "settings.json"),
      `${JSON.stringify({ model: "gpt-6-astra", effortLevel: "low", planModel: "gpt-6-astra", planEffortLevel: "max" }, null, 2)}\n`,
    )
  },
  persistentState: ["session-state"],
  resumeArgs: () => [],
  launch: ({ layout, model, effort, forwardedArgs, environment }) => ({
    command: binary(environment, "TRELLAGE_AGENCY_BIN", "agency"),
    args: [
      "copilot",
      "--profile-only",
      "trellage-azure",
      "--",
      "--model",
      model ?? "gpt-6-astra",
      "--effort",
      effort ?? "low",
      ...forwardedArgs,
    ],
    env: { COPILOT_HOME: layout.generationPath },
  }),
  beforeLaunch: async ({ environment }) => {
    const lifecycle = lifecycleBinary(environment, "TRELLAGE_AGENCY_LIFECYCLE_BIN", "agx", "agx")
    try {
      const result = await execFileAsync(lifecycle, ["inventory", "trellage-azure", "--json"], {
        env: environment,
        encoding: "utf8",
      })
      const inventory = JSON.parse(String(result.stdout)) as { readiness?: unknown; authenticationMethod?: unknown }
      if (inventory.readiness !== "healthy" || typeof inventory.authenticationMethod !== "string")
        throw new Error("Agency profile is not healthy; run trx setup agency azure")
      return { AZURE_TOKEN_CREDENTIALS: inventory.authenticationMethod }
    } catch (error) {
      throw new NativeRunError(
        "launch",
        `Agency readiness check failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },
}

export const firstmateAdapter: NativeAdapter = {
  id: "firstmate",
  label: "Firstmate",
  isolation: unprovenEvidence(
    "Firstmate retains its prepared fleet runtime and captain home while trx owns process dispatch",
  ),
  skillsSubdirectory: "skills",
  instructionsFile: "always-on.md",
  efforts: [],
  policyVersion: "firstmate-canonical-2",
  providerPolicy: () => "copilot-proxy-rs:claude-opus-5.5",
  effectivePolicy: () => ({ normal: "claude-opus-5.5 · effort managed", plan: "Firstmate fleet policy" }),
  managedFlags: [],
  writeAdapterFiles: async (stage) => {
    await mkdir(stage, { recursive: true })
  },
  persistentState: [],
  resumeArgs: () => [],
  launch: ({ forwardedArgs, environment }) => {
    return {
      command: binary(environment, "TRELLAGE_CLAUDE_BIN", "claude"),
      args: forwardedArgs,
      env: {},
    }
  },
  resolveLaunch: async ({ plan, forwardedArgs, environment }) => {
    const profile = selectedPreset(plan, "firstmate", "default")
    const lifecycle = binary(environment, "TRELLAGE_FIRSTMATE_LIFECYCLE_BIN", "fmx")
    let stdout: string
    try {
      stdout = await runFirstmateAdmission(lifecycle, profile, forwardedArgs, environment)
    } catch (error) {
      throw new NativeRunError(
        "launch",
        `Firstmate admission failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const line = stdout.trim().split(/\r?\n/u).at(-1)
    const launchOffset = line === undefined ? -1 : stdout.lastIndexOf(line)
    if (launchOffset > 0) process.stdout.write(stdout.slice(0, launchOffset))
    let value: unknown
    try {
      value = JSON.parse(line ?? "")
    } catch {
      throw new NativeRunError("launch", "Firstmate admission returned invalid launch JSON")
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new NativeRunError("launch", "Firstmate admission returned invalid launch JSON")
    const record = value as Record<string, unknown>
    if (
      typeof record.command !== "string" ||
      !path.isAbsolute(record.command) ||
      !Array.isArray(record.args) ||
      !record.args.every((argument) => typeof argument === "string") ||
      typeof record.cwd !== "string" ||
      !path.isAbsolute(record.cwd) ||
      !record.env ||
      typeof record.env !== "object" ||
      Array.isArray(record.env) ||
      !Object.values(record.env).every((entry) => typeof entry === "string" || entry === null)
    )
      throw new NativeRunError("launch", "Firstmate admission returned invalid launch JSON")
    return {
      command: record.command,
      args: record.args as string[],
      cwd: record.cwd,
      env: record.env as Record<string, string | null>,
    }
  },
}

export const jcodeAdapter: NativeAdapter = {
  id: "jcode",
  label: "JCode",
  isolation: unprovenEvidence("JCode receives a generated JCODE_HOME but may still discover repository context"),
  skillsSubdirectory: "skills",
  instructionsFile: "always-on.md",
  efforts: ["low", "medium", "high"],
  policyVersion: "jcode-direct-1",
  providerPolicy: (model) => `trellage-copilot-proxy:${model ?? "gpt-5.6-sol"}`,
  effectivePolicy: (model, effort) => ({
    normal: `${model ?? "gpt-5.6-sol"} · effort ${effort ?? "medium"}`,
    plan: "JCode native plan mode",
  }),
  managedFlags: ["--no-update"],
  writeAdapterFiles: async (stage, model) => {
    await mkdir(stage, { recursive: true })
    await writeFile(
      path.join(stage, "config.toml"),
      `[provider]\ndefault_provider = "trellage-copilot-proxy"\ndefault_model = ${JSON.stringify(model ?? "gpt-5.6-sol")}\nopenai_reasoning_effort = "medium"\ncross_provider_failover = "manual"\n\n[providers.trellage-copilot-proxy]\ntype = "open-ai-compatible"\nbase_url = "http://127.0.0.1:8080/v1"\nauth = "none"\ndefault_model = ${JSON.stringify(model ?? "gpt-5.6-sol")}\nrequires_api_key = false\nprovider_routing = false\nmodel_catalog = true\nallow_provider_pinning = false\nsupports_reasoning_effort = true\n`,
    )
    await writeFile(path.join(stage, "setup_hints.json"), '{"launch_count":6}\n')
  },
  persistentState: ["sessions", "memory"],
  resumeArgs: () => [],
  launch: ({ layout, model, effort, forwardedArgs, environment }) => ({
    command: binary(environment, "TRELLAGE_JCODE_BIN", "jcode"),
    args: ["--no-update", ...forwardedArgs],
    env: {
      JCODE_HOME: layout.generationPath,
      JCODE_NO_TELEMETRY: "1",
      JCODE_PROVIDER: "trellage-copilot-proxy",
      JCODE_MODEL: model ?? "gpt-5.6-sol",
      JCODE_OPENAI_REASONING_EFFORT: effort ?? "medium",
      JCODE_OPENAI_EXTRA_BODY: "{}",
      JCODE_CROSS_PROVIDER_FAILOVER: "manual",
    },
  }),
  resolveLaunch: async ({ environment }, planned) => {
    if (environment.TRELLAGE_JCODE_BIN && path.isAbsolute(environment.TRELLAGE_JCODE_BIN)) return planned
    const runtime = lifecycleRuntime("jcode")!
    const command = binary(
      environment,
      "TRELLAGE_JCODE_LIFECYCLE_BIN",
      lifecycleRuntimeCommand(runtime, environment.HOME),
    )
    const { stdout } = await execFileAsync(command, ["_trx-executable"], {
      env: { ...environment, TRELLAGE_TRX_JCODE_ADAPTER: "1" },
      encoding: "utf8",
    })
    const executable = stdout.trim()
    if (!path.isAbsolute(executable))
      throw new NativeRunError("launch", "JCode admission returned an invalid executable")
    return { ...planned, command: executable }
  },
}

export const ompAdapter: NativeAdapter = {
  id: "omp",
  label: "Oh My Pi",
  isolation: unprovenEvidence(
    "OMP uses its native profile store and receives selected Trellage instructions explicitly",
  ),
  skillsSubdirectory: "skills",
  instructionsFile: "always-on.md",
  efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  policyVersion: "omp-direct-1",
  providerPolicy: (model) => `github-copilot:${model ?? "gpt-5.6-sol"}`,
  effectivePolicy: (model, effort) => ({
    normal: `${model ?? "gpt-5.6-sol"} · effort ${effort ?? "medium"}`,
    plan: "OMP profile policy",
  }),
  managedFlags: ["--approval-mode", "--append-system-prompt"],
  writeAdapterFiles: async (stage) => {
    await mkdir(stage, { recursive: true })
  },
  persistentState: [],
  resumeArgs: () => [],
  launch: ({ layout, plan, forwardedArgs, environment }) => ({
    command: binary(environment, "TRELLAGE_OMP_BIN", "omp"),
    args: ["--approval-mode", "yolo", ...instructionsArgument(layout), ...forwardedArgs],
    env: {
      OMP_PROFILE:
        selectedPreset(plan, "omp", "default") === "default" ? "trellage-copilot-native" : "trellage-qwen-local",
    },
  }),
}

export const primeAdapter: NativeAdapter = {
  id: "prime",
  label: "Prime",
  isolation: unprovenEvidence("Prime uses the generated coding-agent directory while its kernel remains native"),
  skillsSubdirectory: "skills",
  instructionsFile: "AGENTS.md",
  efforts: [],
  policyVersion: "prime-canonical-2",
  providerPolicy: (model) => `copilot-proxy-rs:${model ?? "claude-opus-5"}`,
  effectivePolicy: (model) => ({
    normal: `${model ?? "claude-opus-5"} · effort managed`,
    plan: "Prime autonomous policy",
  }),
  managedFlags: PRIME_MANAGED_FLAGS.filter((flag) => flag !== "--single-turn"),
  writeAdapterFiles: async (stage, model) => {
    await mkdir(stage, { recursive: true })
    await writeFile(
      path.join(stage, "models.json"),
      `${JSON.stringify({ providers: { "copilot-proxy-rs": { baseUrl: "http://127.0.0.1:8080", api: "anthropic-messages", apiKey: "trellage-local-proxy", compat: { supportsEagerToolInputStreaming: false }, models: [{ id: model ?? "claude-opus-5" }] } } }, null, 2)}\n`,
    )
  },
  persistentState: ["sessions", "memory"],
  resumeArgs: () => [],
  launch: ({ layout, model, forwardedArgs, environment }) => ({
    command: binary(environment, "TRELLAGE_PRIME_BIN", "prime-agent"),
    args: [
      "--provider",
      "copilot-proxy-rs",
      "--model",
      model ?? "claude-opus-5",
      "--offline",
      "--autonomous",
      ...instructionsArgument(layout),
      ...forwardedArgs,
    ],
    env: {
      PRIME_AGENT_CODING_AGENT_DIR: layout.generationPath,
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_AUTH_TOKEN: null,
      CLAUDE_CODE_OAUTH_TOKEN: null,
      OPENAI_API_KEY: null,
    },
  }),
  resolveLaunch: async ({ layout, model, forwardedArgs, environment }) => {
    if (environment.TRELLAGE_PRIME_SKIP_REPAIR !== "1") {
      const lifecycle = binary(environment, "TRELLAGE_PRIME_LIFECYCLE_BIN", "prx")
      const paths = primeRuntimePaths({ environment })
      const installed = await lstat(paths.receiptFile).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false
          throw error
        },
      )
      try {
        await execFileAsync(lifecycle, [installed ? "repair" : "setup", "default"], {
          env: environment,
          encoding: "utf8",
        })
      } catch (error) {
        const failure = error as { stderr?: string; message?: string }
        throw new NativeRunError(
          "launch",
          `Prime lifecycle repair failed: ${(failure.stderr ?? failure.message ?? String(error)).trim()}`,
        )
      }
    }
    const state = await ensurePrimeRuntime({ environment })
    const singleTurnCount = forwardedArgs.filter((argument) => argument === "--single-turn").length
    if (singleTurnCount > 1) throw new NativeRunError("usage", "--single-turn may be specified only once")
    const singleTurn = singleTurnCount === 1
    const agentArgs = forwardedArgs.filter((argument) => argument !== "--single-turn")
    return primeLaunchCommand(state, {
      model,
      forwardedArgs: agentArgs,
      singleTurn,
      codingAgentDirectory: layout.generationPath,
    })
  },
}

/** Always-available Pi extensions, installed unpinned (latest) into a shared directory outside any generation. */
export const PI_EXTENSION_PACKAGES: ReadonlyArray<string> = ["@narumitw/pi-plan-mode"]

export const piExtensionsHome = (environment: NodeJS.ProcessEnv): string =>
  environment.TRELLAGE_PI_EXTENSIONS_HOME ??
  path.join(environment.HOME ?? os.homedir(), ".local/share/trellage/pi-extensions")

/** Entry files declared by each installed extension package's `pi.extensions` manifest. */
export const piExtensionEntries = (environment: NodeJS.ProcessEnv): string[] =>
  PI_EXTENSION_PACKAGES.flatMap((name) => {
    const root = path.join(piExtensionsHome(environment), "node_modules", name)
    try {
      const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
        pi?: { extensions?: string[] }
      }
      return (manifest.pi?.extensions ?? []).map((entry) => path.join(root, entry))
    } catch {
      return []
    }
  })

const PI_DEFAULT_MODEL = "gpt-6-astra"
const PI_PROVIDER = "copilot-proxy-rs"
const PI_CLAUDE_PROVIDER = "copilot-proxy-rs-claude"

// The proxy's Responses translation rejects Claude tool calls that follow text (the upstream tool index is not 0),
// so Claude models use the native Messages wire API instead.
const piProviderFor = (model: string | undefined): string =>
  model?.startsWith("claude-") ? PI_CLAUDE_PROVIDER : PI_PROVIDER

const piModelEntries = (ids: string[]) =>
  ids.map((id) => ({
    id,
    name: id,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1050000,
    maxTokens: 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }))

const piModelsJson = (model: string | undefined): string => {
  const ids = [...new Set([PI_DEFAULT_MODEL, ...(model ? [model] : [])])]
  const claudeIds = ids.filter((id) => id.startsWith("claude-"))
  return `${JSON.stringify(
    {
      providers: {
        [PI_PROVIDER]: {
          api: "openai-responses",
          apiKey: "none",
          authHeader: false,
          baseUrl: "http://127.0.0.1:8080/v1",
          models: piModelEntries(ids.filter((id) => !id.startsWith("claude-"))),
        },
        ...(claudeIds.length > 0
          ? {
              [PI_CLAUDE_PROVIDER]: {
                api: "anthropic-messages",
                apiKey: "none",
                authHeader: false,
                baseUrl: "http://127.0.0.1:8080",
                models: piModelEntries(claudeIds),
              },
            }
          : {}),
      },
    },
    null,
    2,
  )}\n`
}

export const piAdapter: NativeAdapter = {
  id: "pi",
  label: "Pi",
  isolation: {
    status: "proven",
    evidence:
      "Pi 1.0.4 resource loader: --no-skills plus explicit --skill kept only selected skills and retained AGENTS.md",
  },
  skillsSubdirectory: "skills",
  instructionsFile: "APPEND_SYSTEM.md",
  efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  extensions: PI_EXTENSION_PACKAGES,
  policyVersion: "pi-7",
  providerPolicy: (model) => `${piProviderFor(model)}:${model ?? PI_DEFAULT_MODEL}`,
  effectivePolicy: (model, effort) => ({
    normal: `${model ?? `${PI_DEFAULT_MODEL} (default)`} · effort ${effort ?? "medium (default)"}`,
    plan: "same model: /plan (pi-plan-mode) has no separate planning model",
  }),
  managedFlags: [
    "--skill",
    "--no-skills",
    "-ns",
    "--extension",
    "-e",
    "--no-extensions",
    "-ne",
    "--approve",
    "-a",
    "--no-approve",
    "-na",
    "--session-dir",
    "--prompt-template",
    "--theme",
  ],
  writeAdapterFiles: async (stage, model) => {
    await mkdir(stage, { recursive: true })
    await writeFile(
      path.join(stage, "settings.json"),
      `${JSON.stringify(
        {
          defaultProvider: piProviderFor(model),
          defaultModel: model ?? PI_DEFAULT_MODEL,
          defaultThinkingLevel: "medium",
          defaultTools: ["+codemode"],
          defaultProjectTrust: "never",
          enableInstallTelemetry: false,
          packages: [],
        },
        null,
        2,
      )}\n`,
    )
    await writeFile(path.join(stage, "models.json"), piModelsJson(model))
  },
  persistentState: [],
  resumeArgs: (resume) =>
    resume.kind === "continue" ? ["--continue"] : resume.id ? ["--resume", resume.id] : ["--resume"],
  launch: ({ layout, plan, model, effort, forwardedArgs, resumeArgs, environment }) => ({
    command: binary(environment, "TRELLAGE_PI_BIN", "pi"),
    args: [
      "--no-skills",
      "--no-extensions",
      "--extension",
      "builtin:codemode",
      ...piExtensionEntries(environment).flatMap((entry) => ["--extension", entry]),
      "--no-prompt-templates",
      "--no-approve",
      ...plan.skills.flatMap((skill) => ["--skill", path.join(layout.generationPath, "skills", skill.name)]),
      "--session-dir",
      layout.sessionsPath,
      "--provider",
      piProviderFor(model),
      "--model",
      model ?? PI_DEFAULT_MODEL,
      "--thinking",
      effort ?? "medium",
      ...resumeArgs,
      ...forwardedArgs,
    ],
    env: {
      PI_CODING_AGENT_DIR: layout.generationPath,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      NODE_OPTIONS: null,
      NODE_PATH: null,
      NODE_COMPILE_CACHE: null,
    },
  }),
}

export const copilotAdapter: NativeAdapter = {
  id: "copilot",
  label: "Copilot",
  isolation: unprovenEvidence(
    "Copilot CLI 1.0.93-1 still discovers trusted repository skills with a dedicated COPILOT_HOME (scripts/probe-native-isolation.ts)",
  ),
  skillsSubdirectory: "skills",
  instructionsFile: "copilot-instructions.md",
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  policyVersion: "copilot-5",
  providerPolicy: () => "copilot-native",
  effectivePolicy: (model, effort) => ({
    normal: `${model ?? "gpt-6-astra"} · effort ${effort ?? "low"}`,
    plan: "harness default planModel",
  }),
  managedFlags: ["--config-dir", "--no-custom-instructions"],
  writeAdapterFiles: async () => {},
  trustWorkspace: async (layout, workspace) => {
    await mergeJson(path.join(layout.generationPath, "config.json"), (current) => {
      const folders = Array.isArray(current.trustedFolders) ? (current.trustedFolders as unknown[]) : []
      return {
        ...current,
        trustedFolders: folders.includes(workspace) ? folders : [...folders, workspace],
      }
    })
  },
  persistentState: ["session-state"],
  resumeArgs: (resume) =>
    resume.kind === "continue" ? ["--continue"] : resume.id ? [`--resume=${resume.id}`] : ["--resume"],
  launch: ({ layout, model, effort, forwardedArgs, resumeArgs, environment, planMode }) => {
    const planning = planMode === true || forwardedArgs.includes("--plan")
    return {
      command: binary(environment, "TRELLAGE_COPILOT_BIN", "copilot"),
      args: [
        ...(planning ? ["--plan"] : ["--autopilot", "--allow-all", "--no-ask-user"]),
        "--model",
        model ?? "gpt-6-astra",
        "--effort",
        effort ?? "low",
        ...resumeArgs,
        ...forwardedArgs.filter((argument) => argument !== "--plan"),
      ],
      env: { COPILOT_HOME: layout.generationPath },
    }
  },
  resolveLaunch: async (input, planned) => {
    const profile = lifecycleProfile(input.plan, "copilot", "hve")
    const admitted = await privateAdmission(
      "copilot",
      "TRELLAGE_COPILOT_LIFECYCLE_BIN",
      "TRELLAGE_TRX_COPILOT_ADAPTER",
      profile,
      input.environment,
    )
    if (typeof admitted.installedPlugins !== "string" || !path.isAbsolute(admitted.installedPlugins))
      throw new NativeRunError("launch", "Copilot admission returned an invalid plugin root")
    if (!admitted.settings || typeof admitted.settings !== "object" || Array.isArray(admitted.settings))
      throw new NativeRunError("launch", "Copilot admission returned invalid plugin settings")
    await ensureManagedSymlink(path.join(input.layout.generationPath, "installed-plugins"), admitted.installedPlugins)
    await mergeJson(path.join(input.layout.generationPath, "settings.json"), (current) => ({
      ...current,
      ...(admitted.settings as Record<string, unknown>),
    }))
    return planned
  },
}

// Route Codex through copilot-proxy-rs without writing a config.toml into the generation.
const CODEX_PROXY_OVERRIDES: ReadonlyArray<string> = [
  'model_provider="copilotproxy"',
  'model_providers.copilotproxy.name="copilot-proxy-rs"',
  'model_providers.copilotproxy.base_url="http://127.0.0.1:8080/v1"',
  'model_providers.copilotproxy.wire_api="responses"',
  "model_providers.copilotproxy.requires_openai_auth=false",
  "features.context_management.experimental_mode=true",
]

export const codexAdapter: NativeAdapter = {
  id: "codex",
  label: "Codex",
  isolation: unprovenEvidence(
    "Codex 0.160.1 skills/list still returns repository skills despite skip_host_skill_discovery and extra-root controls (scripts/probe-native-isolation.ts)",
  ),
  skillsSubdirectory: "skills",
  instructionsFile: "AGENTS.md",
  efforts: ["minimal", "low", "medium", "high", "xhigh"],
  policyVersion: "codex-6",
  providerPolicy: () => "codex-native",
  effectivePolicy: (model, effort) => ({
    normal: `${model ?? "harness default"} · effort ${effort ?? "harness default"}`,
    plan: "harness default",
  }),
  managedFlags: [
    "--profile",
    "-p",
    "--dangerously-bypass-approvals-and-sandbox",
    "--ask-for-approval",
    "-a",
    "--sandbox",
    "-s",
    "--full-auto",
  ],
  writeAdapterFiles: async () => {},
  persistentState: ["sessions", "archived_sessions"],
  resumeArgs: (resume) =>
    resume.kind === "continue" ? ["resume", "--last"] : resume.id ? ["resume", resume.id] : ["resume"],
  launch: ({ layout, model, effort, forwardedArgs, resumeArgs, environment, workspace }) => ({
    command: binary(environment, "TRELLAGE_CODEX_BIN", "codex"),
    args: [
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      `projects.${JSON.stringify(workspace)}.trust_level="trusted"`,
      ...CODEX_PROXY_OVERRIDES.flatMap((override) => ["-c", override]),
      ...(model ? ["-m", model] : []),
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
      ...(resumeArgs.length > 0 && forwardedArgs[0] === "exec"
        ? ["exec", ...resumeArgs, ...forwardedArgs.slice(1)]
        : [...resumeArgs, ...forwardedArgs]),
    ],
    env: { CODEX_HOME: layout.generationPath },
  }),
}

const STATUSLINE_SOURCE = fileURLToPath(new URL("../../../../scripts/trellage-statusline.sh", import.meta.url))

// Route Claude Code through copilot-proxy-rs; drop host credentials for other backends.
const CLAUDE_FOREIGN_AUTH: Readonly<Record<string, null>> = Object.fromEntries(
  [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_ROLE_ARN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "CLOUD_ML_REGION",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
    "GOOGLE_CLOUD_REGION",
    "VERTEX_PROJECT",
    "VERTEX_REGION",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_TENANT_ID",
    "OPENAI_API_KEY",
    "AZURE_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "OPENAI_BASE_URL",
    "COPILOT_GITHUB_TOKEN",
    "COPILOT_PROXY_GITHUB_TOKEN",
    "COPILOT_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
  ].map((name) => [name, null]),
)

/** Context window of a model from the host Copilot model list, if it is listed. */
export const modelContextWindow = (model: string | undefined, home: string | undefined): number | undefined => {
  if (!model || !home) return undefined
  const models = readStructured(path.join(home, ".copilot", "models.json"), "json").models
  if (!Array.isArray(models)) return undefined
  const entry = models.find(
    (candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === model,
  ) as { context_window?: unknown } | undefined
  return typeof entry?.context_window === "number" && entry.context_window > 0 ? entry.context_window : undefined
}

export const claudeAdapter: NativeAdapter = {
  id: "claude",
  label: "Claude",
  isolation: unprovenEvidence("no model-free native proof exists for Claude Code discovery yet"),
  skillsSubdirectory: "skills",
  instructionsFile: "CLAUDE.md",
  efforts: ["low", "medium", "high", "xhigh", "max"],
  planDefaults: { model: "opusplan", effort: "max" },
  policyVersion: "claude-8",
  providerPolicy: () => "claude-native",
  effectivePolicy: (model, effort) => ({
    normal: `${model ?? "opusplan"} · effort ${effort ?? "medium"}`,
    plan: "opusplan · effort max · permission mode plan",
  }),
  managedFlags: [
    "--setting-sources",
    "--plugin-dir",
    "--bare",
    "--dangerously-skip-permissions",
    "--permission-mode",
    "--disallowedTools",
  ],
  writeAdapterFiles: async (stage) => {
    await mkdir(stage, { recursive: true })
    // Skip first-run onboarding (theme picker) and the bypass-permissions confirmation in a fresh config directory.
    await writeFile(
      path.join(stage, ".claude.json"),
      `${JSON.stringify({ hasCompletedOnboarding: true, shiftEnterKeyBindingInstalled: true }, null, 2)}\n`,
      { mode: 0o600 },
    )
    const statusline = path.join(stage, "statusline.sh")
    await copyFile(STATUSLINE_SOURCE, statusline)
    await chmod(statusline, 0o755)
    await writeFile(
      path.join(stage, "settings.json"),
      `${JSON.stringify(
        {
          theme: "dark",
          outputStyle: "Rundown",
          model: "opusplan",
          effortLevel: "medium",
          skipDangerousModePermissionPrompt: true,
          statusLine: {
            type: "command",
            command: 'bash "$CLAUDE_CONFIG_DIR/statusline.sh"',
            refreshInterval: 15,
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
  },
  trustWorkspace: async (layout, workspace) => {
    await mergeJson(path.join(layout.generationPath, ".claude.json"), (current) => {
      const projects = (current.projects && typeof current.projects === "object" ? current.projects : {}) as Record<
        string,
        object
      >
      return {
        ...current,
        projects: {
          ...projects,
          [workspace]: {
            ...projects[workspace],
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
          },
        },
      }
    })
  },
  persistentState: ["projects", "sessions", "file-history", "todos"],
  resumeArgs: (resume) =>
    resume.kind === "continue" ? ["--continue"] : resume.id ? ["--resume", resume.id] : ["--resume"],
  launch: ({ layout, model, effort, forwardedArgs, resumeArgs, environment, planMode }) => {
    // Claude Code does not know proxy model ids, so state the window it should assume.
    const window = modelContextWindow(model, environment.HOME)
    return {
      command: binary(environment, "TRELLAGE_CLAUDE_BIN", "claude"),
      args: [
        ...(planMode
          ? ["--allow-dangerously-skip-permissions"]
          : ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions"]),
        ...(planMode && effort ? ["--effort", effort] : []),
        "--disallowedTools",
        "AskUserQuestion",
        ...(model ? ["--model", model] : []),
        ...(planMode ? ["--permission-mode", "plan"] : effort ? ["--effort", effort] : []),
        ...resumeArgs,
        ...forwardedArgs,
      ],
      env: {
        CLAUDE_CONFIG_DIR: layout.generationPath,
        ...CLAUDE_FOREIGN_AUTH,
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
        ANTHROPIC_AUTH_TOKEN: "trellage-local-proxy",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4.5",
        ...(model ? { ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model } : {}),
        ...(window
          ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(window) }
          : { CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1" }),
      },
    }
  },
  resolveLaunch: async (input, planned) => {
    const profile = lifecycleProfile(input.plan, "claude", "default")
    const admitted = await privateAdmission(
      "claude",
      "TRELLAGE_CLAUDE_LIFECYCLE_BIN",
      "TRELLAGE_TRX_CLAUDE_ADAPTER",
      profile,
      input.environment,
    )
    if (admitted.pluginDir === null) return planned
    if (typeof admitted.pluginDir !== "string" || !path.isAbsolute(admitted.pluginDir))
      throw new NativeRunError("launch", "Claude admission returned an invalid plugin directory")
    return { ...planned, args: [...planned.args, "--plugin-dir", admitted.pluginDir] }
  },
}

const GROK_REQUIREMENTS = `fail_closed = true

[compat.claude]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.cursor]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.codex]
sessions = false

[skills]
ignore = ["~/.agents/skills", "~/.agents/commands"]
`
const GROK_DEFAULT_MODEL = "grok-4.7"
const GROK_DEFAULT_EFFORT = "medium"
const GROK_PLAN_EFFORT = "xhigh"
const GROK_REASONING_EFFORTS = `[
  { id = "xhigh", value = "xhigh", label = "Extra High", description = "Maximum reasoning for the hardest tasks.", default = false },
  { id = "high", value = "high", label = "High", description = "Thorough reasoning and quality.", default = false },
  { id = "medium", value = "medium", label = "Medium", description = "Strong quality with a faster turnaround.", default = true },
  { id = "low", value = "low", label = "Low", description = "Fastest responses for simple tasks.", default = false },
]`

const grokGithubEnvironment = async (
  environment: NodeJS.ProcessEnv,
): Promise<Readonly<Record<string, string | null>>> => {
  const bridge = environment.TRELLAGE_GROK_GH_AUTH_BRIDGE ?? "1"
  if (bridge !== "0" && bridge !== "1")
    throw new NativeRunError("launch", "TRELLAGE_GROK_GH_AUTH_BRIDGE must be 0 or 1")
  if (bridge === "0" || environment.GH_TOKEN || environment.GITHUB_TOKEN) return {}
  if (environment.GH_HOST && environment.GH_HOST !== "github.com")
    throw new NativeRunError("launch", "Grok GitHub auth bridge supports only github.com")
  const child = Bun.spawn(["gh", "auth", "token", "--hostname", "github.com"], {
    env: { ...environment, GH_PROMPT_DISABLED: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const output = await new Response(child.stdout).text()
  const status = await child.exited
  const token = output.endsWith("\n") ? output.slice(0, -1) : output
  if (status !== 0) throw new NativeRunError("launch", `host GitHub credential lookup failed (exit ${status})`)
  if (!token || /[\s\u0000-\u001f\u007f]/u.test(token))
    throw new NativeRunError("launch", "host GitHub credential lookup returned an unusable value")
  return { GH_TOKEN: token }
}

export const grokAdapter: NativeAdapter = {
  id: "grok",
  label: "Grok",
  isolation: unprovenEvidence(
    "generated GROK_HOME disables host Claude/Cursor compatibility, but Grok still discovers repository-native instructions and skills",
  ),
  skillsSubdirectory: "skills",
  instructionsFile: "Agents.md",
  efforts: ["low", "medium", "high", "xhigh"],
  extensions: ["terminal-browser"],
  policyVersion: "grok-7",
  providerPolicy: (model) => `copilot-proxy-rs:${model ?? GROK_DEFAULT_MODEL}`,
  effectivePolicy: (model, effort) => ({
    normal: `${model ?? `${GROK_DEFAULT_MODEL} (default)`} · effort ${effort ?? `${GROK_DEFAULT_EFFORT} (default)`}`,
    plan: `${model ?? GROK_DEFAULT_MODEL} · effort ${GROK_PLAN_EFFORT} after /effort xhigh`,
  }),
  managedFlags: ["--sandbox", "--permission-mode", "--always-approve", "--trust"],
  writeAdapterFiles: async (stage, selectedModel, layout) => {
    const model = selectedModel ?? GROK_DEFAULT_MODEL
    await mkdir(stage, { recursive: true })
    await writeFile(path.join(stage, "requirements.toml"), GROK_REQUIREMENTS, { mode: 0o644 })
    const statusline = path.join(stage, "statusline.sh")
    await copyFile(STATUSLINE_SOURCE, statusline)
    await chmod(statusline, 0o755)
    await writeFile(
      path.join(stage, "config.toml"),
      `[auth]
preferred_method = "api_key"

[endpoints]
models_base_url = "http://127.0.0.1:8080/v1"

[models]
default_reasoning_effort = ${JSON.stringify(GROK_DEFAULT_EFFORT)}

[model.${JSON.stringify(model)}]
env_key = "XAI_API_KEY"
reasoning_efforts = ${GROK_REASONING_EFFORTS}

[ui.status_line]
type = "command"
command = "bash \\"$GROK_HOME/statusline.sh\\""
refresh_interval = 15
`,
      { mode: 0o600 },
    )
    await writeFile(
      path.join(stage, "sandbox.toml"),
      `[profiles.trellage-workspace]
extends = "workspace"
read_write = [${JSON.stringify(layout.generationPath)}, ${JSON.stringify(path.join(layout.ownerHome, "state"))}]
`,
      { mode: 0o600 },
    )
  },
  trustWorkspace: async (layout, workspace) => {
    const trusted = await realpath(workspace)
    await writeFile(
      path.join(layout.generationPath, "trusted_folders.toml"),
      `[folders.${JSON.stringify(trusted)}]
trusted = true
decided_at = ${Math.floor(Date.now() / 1000)}
`,
      { mode: 0o600 },
    )
  },
  persistentState: ["sessions", "memory", "permissions"],
  resumeArgs: (resume) =>
    resume.kind === "continue" ? ["--continue"] : resume.id ? ["--resume", resume.id] : ["--resume"],
  launch: ({ layout, model, effort, forwardedArgs, resumeArgs, environment }) => ({
    command: binary(environment, "TRELLAGE_GROK_BIN", "grok"),
    args: [
      "--sandbox",
      "trellage-workspace",
      "--permission-mode",
      "bypassPermissions",
      "--always-approve",
      "--trust",
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--reasoning-effort", effort] : []),
      ...resumeArgs,
      ...forwardedArgs,
    ],
    env: {
      GROK_HOME: layout.generationPath,
      GROK_MODELS_BASE_URL: "http://127.0.0.1:8080/v1",
      GROK_MODELS_LIST_URL: "http://127.0.0.1:8080/v1/models",
      GROK_DEFAULT_MODEL: model ?? GROK_DEFAULT_MODEL,
      XAI_API_KEY: "local-copilot-proxy",
    },
  }),
  beforeLaunch: ({ environment }) => grokGithubEnvironment(environment),
}

export interface HostDefaults {
  readonly model: string | undefined
  readonly effort: string | undefined
}

const readStructured = (file: string, format: "json" | "toml"): Record<string, unknown> => {
  try {
    const text = readFileSync(file, "utf8")
    const parsed: unknown = format === "json" ? JSON.parse(text) : parseToml(text)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined)

/** The model and effort a launch uses when the caller names none; read from the host's own harness settings. */
export const hostDefaults = (harness: string, home: string = os.homedir()): HostDefaults => {
  const adapter = adapterFor(harness)
  const valid = (effort: string | undefined) =>
    effort !== undefined && adapter.efforts.includes(effort) ? effort : undefined
  if (harness === "pi") return { model: PI_DEFAULT_MODEL, effort: "medium" }
  if (harness === "fx") return { model: FX_DEFAULT_MODEL, effort: FX_DEFAULT_EFFORT }
  if (harness === "agency") return { model: "gpt-6-astra", effort: "low" }
  if (harness === "jcode") return { model: "gpt-5.6-sol", effort: "medium" }
  if (harness === "omp") return { model: "gpt-5.6-sol", effort: "medium" }
  if (harness === "prime") return { model: "claude-opus-5", effort: undefined }
  if (harness === "firstmate") return { model: "claude-opus-5.5", effort: undefined }
  if (harness === "copilot") {
    const settings = readStructured(path.join(home, ".copilot", "settings.json"), "json")
    return { model: text(settings.model), effort: valid(text(settings.effortLevel)) }
  }
  if (harness === "claude") return { model: "opusplan", effort: "medium" }
  if (harness === "grok") {
    const settings = readStructured(path.join(home, ".grok", "config.toml"), "toml")
    return {
      model: text(settings.model) ?? GROK_DEFAULT_MODEL,
      effort: valid(text(settings.reasoning_effort)) ?? GROK_DEFAULT_EFFORT,
    }
  }
  const settings = readStructured(path.join(home, ".codex", "config.toml"), "toml")
  return { model: text(settings.model), effort: valid(text(settings.model_reasoning_effort)) }
}

export const adapters: Readonly<Record<string, NativeAdapter>> = {
  agency: agencyAdapter,
  pi: piAdapter,
  copilot: copilotAdapter,
  claude: claudeAdapter,
  codex: codexAdapter,
  firstmate: firstmateAdapter,
  jcode: jcodeAdapter,
  omp: ompAdapter,
  prime: primeAdapter,
  grok: grokAdapter,
  fx: fxAdapter,
}

export const adapterFor = (harness: string): NativeAdapter => {
  const adapter = Object.hasOwn(adapters, harness) ? adapters[harness] : undefined
  if (!adapter)
    throw new NativeRunError("usage", `unknown harness ${harness}; supported: ${Object.keys(adapters).join(", ")}`)
  return adapter
}
