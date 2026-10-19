import { existsSync, readFileSync, readdirSync } from "node:fs"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { parse as parseToml, stringify as stringifyToml } from "smol-toml"
import { NativeRunCancelledError, NativeRunError } from "./paths.ts"
import { PRIME_DEFAULT_MODEL, PRIME_MANAGED_FLAGS, ensurePrimeRuntime, primeLaunchCommand, primeRuntimePaths } from "./prime-runtime.ts"
import type { GenerationLayout, CompositionPlan } from "./compose.ts"
import { lifecycleRuntime, lifecycleRuntimeCommand } from "./lifecycle-runtime.ts"
import { nativePresetProfiles } from "./presets.ts"
import { childSettlement } from "./child-settlement.ts"
import { digestDirectory } from "./source.ts"
import { pickCopilotSession } from "./session-picker.ts"
import { resolveNativeBinary } from "./requirements.ts"

const execFileAsync = promisify(execFile)

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
  /** Guard that owns launch-time admission and child processes, when applicable. */
  readonly guard?: LaunchGuard
}

export interface LaunchGuard {
  readonly attachChild: (pid: number, processGroup?: boolean) => void
  readonly signalTree: (pid: number, signal: NodeJS.Signals) => void
  readonly waitForTree?: (pid: number, timeout?: number) => Promise<boolean>
}

export interface LaunchCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
  /** A string sets the variable; null removes it from the child environment. */
  readonly env: Readonly<Record<string, string | null>>
  /** Release launch-scoped resources after the child settles or a spawn fails. */
  readonly cleanup?: () => void | Promise<void>
}

export interface NativeAdapter {
  readonly id: string
  readonly sandbox: boolean
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
  readonly writeAdapterFiles: (
    stage: string,
    model: string | undefined,
    layout: GenerationLayout,
    plan?: CompositionPlan,
  ) => Promise<void>
  /** Marks the workspace as trusted in the generation so the harness starts without a trust prompt. */
  readonly trustWorkspace?: (layout: GenerationLayout, workspace: string) => Promise<void>
  /** Generation-relative directories holding conversations, kept across generations. */
  readonly persistentState: ReadonlyArray<string>
  /** Harness arguments that reopen a previous conversation. */
  readonly resumeArgs: (resume: ResumeRequest) => ReadonlyArray<string>
  /** Selects a session for a bare --resume before any harness process starts. Undefined cancels the launch. */
  readonly pickResumeSession?: (input: {
    readonly ownerHome: string
    readonly workspace: string
  }) => Promise<string | undefined>
  readonly launch: (input: LaunchInput) => LaunchCommand
  /** Final launch-only environment, prepared after dry-run handling and lease acquisition. */
  readonly beforeLaunch?: (input: LaunchInput) => Promise<Readonly<Record<string, string | null>>>
  readonly resolveLaunch?: (input: LaunchInput, planned: LaunchCommand) => Promise<LaunchCommand>
  /** Flags the adapter owns; forwarding them would undo the prepared boundary. */
  readonly managedFlags: ReadonlyArray<string>
  readonly clean: CleanLaunch
}

export interface HostDefaults {
  readonly model: string | undefined
  readonly effort: string | undefined
}

export type CleanLaunch =
  | {
      readonly supported: true
      /** Probe that proved no repository or host content loads. */
      readonly evidence: string
      /** Model and effort used when the caller names none; never read from host harness settings. */
      readonly defaults: HostDefaults
      readonly writeAdapterFiles: (stage: string, model: string | undefined, layout: GenerationLayout) => Promise<void>
      readonly launch: (input: LaunchInput) => LaunchCommand
      /** Repository paths that would still load despite the clean flags, and what loading them does. */
      readonly blockers?: {
        readonly find: (workspace: string) => Promise<ReadonlyArray<string>>
        readonly effect: string
      }
      /** Harness flags that would reopen what the clean flags close; refused after `--`. */
      readonly managedFlags?: ReadonlyArray<string>
      /** Launch-time discovery of harness content that only a listing can name. */
      readonly resolveLaunch?: (input: LaunchInput, planned: LaunchCommand) => Promise<LaunchCommand>
    }
  | { readonly supported: false; readonly reason: string }

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

const readFxSettings = async (file: string): Promise<Record<string, unknown>> => {
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
  return settings
}

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
  const settings = await readFxSettings(file)
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
  sandbox: false,
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
  clean: {
    supported: false,
    reason: "Fx uses the host HOME and ~/.fx by design",
  },
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

const binary = resolveNativeBinary

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

const luaStringLiteral = (value: string): string => {
  let literal = '"'
  for (const character of value) {
    switch (character) {
      case "\\":
        literal += "\\\\"
        break
      case '"':
        literal += '\\"'
        break
      case "\n":
        literal += "\\n"
        break
      case "\r":
        literal += "\\r"
        break
      case "\t":
        literal += "\\t"
        break
      default: {
        const codepoint = character.codePointAt(0)!
        literal += codepoint < 0x20 || codepoint === 0x7f ? `\\${codepoint.toString().padStart(3, "0")}` : character
      }
    }
  }
  return `${literal}"`
}

const UJI_PROXY_PROVIDER = "copilot-proxy-rs"
const UJI_PROXY_BASE_URL = "http://127.0.0.1:8080/v1"
const UJI_PROXY_API_KEY = "trellage-local-proxy"
const UJI_PROXY_DEFAULT_MODEL = "gpt-6-astra"
const UJI_TOOLS_SOURCE = new URL("./uji-tools.lua", import.meta.url)
const UJI_TOOLS_CONTENT = readFileSync(UJI_TOOLS_SOURCE)
const UJI_TOOLS_POLICY = `uji-allow-all-${createHash("sha256").update(UJI_TOOLS_CONTENT).digest("hex")}`

const ujiModelSelection = (model: string | undefined): string => {
  const selection = model ?? `${UJI_PROXY_PROVIDER}/${UJI_PROXY_DEFAULT_MODEL}`
  const separator = selection.indexOf("/")
  if (separator < 1 || separator === selection.length - 1 || selection.slice(0, separator) !== UJI_PROXY_PROVIDER)
    throw new NativeRunError("usage", `Uji models must use ${UJI_PROXY_PROVIDER}/ID format`)
  return selection
}

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

interface OmpAdmission {
  readonly schemaVersion: 1
  readonly executable: string
  readonly ompProfile: string
  readonly piConfigFiles: string
  readonly version: string
  readonly copilotCredentialFile: string | null
}

const OMP_ADMISSION_KEYS = [
  "copilotCredentialFile",
  "executable",
  "ompProfile",
  "piConfigFiles",
  "schemaVersion",
  "version",
] as const

const assertAbsolutePath = (label: string, value: string): void => {
  if (!path.isAbsolute(value) || value.includes("\0"))
    throw new NativeRunError("launch", "OMP admission returned an invalid " + label)
}

const validOmpAdmissionShape = (value: Record<string, unknown>): boolean =>
  Object.keys(value).sort().join("\0") === OMP_ADMISSION_KEYS.join("\0") &&
  value.schemaVersion === 1 &&
  typeof value.executable === "string" &&
  typeof value.ompProfile === "string" &&
  typeof value.piConfigFiles === "string" &&
  typeof value.version === "string" &&
  (value.copilotCredentialFile === null || typeof value.copilotCredentialFile === "string")

const validateOmpAdmission = (value: Record<string, unknown>, expectedProfile: string): OmpAdmission => {
  const admission = value as unknown as OmpAdmission
  assertAbsolutePath("executable", admission.executable)
  if (admission.piConfigFiles.length === 0 || admission.piConfigFiles.split(":").some((entry) => !path.isAbsolute(entry)))
    throw new NativeRunError("launch", "OMP admission returned invalid PI_CONFIG_FILES")
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(admission.version))
    throw new NativeRunError("launch", "OMP admission returned an invalid host version")
  if (admission.ompProfile !== expectedProfile)
    throw new NativeRunError("launch", "OMP admission returned the wrong managed profile")
  if (admission.copilotCredentialFile !== null) assertAbsolutePath("Copilot credential file", admission.copilotCredentialFile)
  return admission
}

const parseOmpAdmission = (output: string, expectedProfile: string): OmpAdmission => {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new NativeRunError("launch", "OMP admission returned invalid JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new NativeRunError("launch", "OMP admission returned invalid JSON")
  const value = parsed as Record<string, unknown>
  if (!validOmpAdmissionShape(value)) throw new NativeRunError("launch", "OMP admission returned invalid JSON")
  return validateOmpAdmission(value, expectedProfile)
}

const admissionCredentialPath = (output: string): string | undefined => {
  try {
    const value: unknown = JSON.parse(output)
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const candidate = (value as Record<string, unknown>).copilotCredentialFile
    return typeof candidate === "string" && path.isAbsolute(candidate) && !candidate.includes("\0") ? candidate : undefined
  } catch {
    return undefined
  }
}

const removeAdmissionCredential = async (output: string): Promise<void> => {
  const file = admissionCredentialPath(output)
  if (file !== undefined) await unlink(file).catch(() => {})
}

const ompAdmissionWorker = fileURLToPath(new URL("./omp-admission-worker.ts", import.meta.url))

const runOmpAdmission = async (
  profile: string,
  environment: NodeJS.ProcessEnv,
  guard?: LaunchGuard,
): Promise<OmpAdmission> => {
  const runtime = lifecycleRuntime("omp")!
  const command = binary(
    environment,
    "TRELLAGE_OMP_LIFECYCLE_BIN",
    lifecycleRuntimeCommand(runtime, environment.HOME),
  )
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(guard ? process.execPath : command, guard ? [ompAdmissionWorker, command, "_trx-admit", profile] : ["_trx-admit", profile], {
        env: { ...environment, TRELLAGE_TRX_OMP_ADAPTER: "1" },
        stdio: guard ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
        detached: guard !== undefined,
      })
    } catch (error) {
      reject(new NativeRunError("launch", "OMP admission failed: " + String(error)))
      return
    }
    const stdout: string[] = []
    const stderr: string[] = []
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
    let settled = false
    const settlement = childSettlement(child, guard)
    const removeHandlers = () => signals.forEach((signal, index) => process.off(signal, handlers[index]!))
    const fail = async (error: unknown) => {
      if (settled) return
      settled = true
      removeHandlers()
      const terminated = await settlement.terminate()
      await removeAdmissionCredential(stdout.join(""))
      reject(terminated ? error : new NativeRunError("launch", "OMP admission cleanup did not settle after SIGKILL: " + String(error)))
    }
    const handlers = signals.map((signal) => () => {
      if (signal !== "SIGTERM") {
        try { settlement.signal(signal) } catch { /* The bounded cleanup still runs. */ }
      }
      void fail(new NativeRunCancelledError("OMP admission failed: cancelled by " + signal, signal))
    })
    signals.forEach((signal, index) => process.on(signal, handlers[index]!))
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")))
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      stderr.push(text)
      process.stderr.write(text)
    })
    child.once("error", (error) => {
      const diagnostic = stderr.join("").trim()
      void fail(new NativeRunError("launch", "OMP admission failed: " + (diagnostic || error.message)))
    })
    const finish = async (status: number | null, signal: string | null) => {
      if (settled) return
      if (status !== 0) {
        const diagnostic = stderr.join("").trim()
        const failure = new NativeRunError(
          "launch",
          "OMP admission failed: " + (diagnostic || String(status ?? signal ?? "without status")),
        )
        await fail(failure)
        return
      }
      settled = true
      removeHandlers()
      try {
        if (guard && !(await settlement.terminate()))
          throw new NativeRunError("launch", "OMP admission cleanup did not settle after SIGKILL")
        const admission = parseOmpAdmission(
          stdout.join(""),
          profile === "default" ? "trellage-copilot-native" : "trellage-qwen-local",
        )
        resolve(admission)
      } catch (error) {
        await removeAdmissionCredential(stdout.join(""))
        reject(error)
      }
    }
    child.once("close", (status, signal) => { void finish(status, signal) })
    child.once("message", (message: { status?: number | null; signal?: string | null; error?: string }) => {
      if (message.error !== undefined) void fail(new NativeRunError("launch", "OMP admission failed: " + message.error))
      else void finish(message.status ?? null, message.signal ?? null)
    })
    try {
      if (child.pid !== undefined) guard?.attachChild(child.pid, true)
      if (guard) child.send("start")
    } catch (error) {
      // The supervisor has not received permission to launch admission work.
      child.kill("SIGTERM")
      void fail(error)
    }
  })
}

const parseOmpHeadlessPolicy = (
  argument: string,
  next: string | undefined,
  alreadySelected: boolean,
): { readonly consumed: number } | undefined => {
  if (argument === "--headless-policy") {
    if (alreadySelected) throw new NativeRunError("usage", "--headless-policy may be specified only once")
    if (next === undefined || next.length === 0 || next.startsWith("-"))
      throw new NativeRunError("usage", "--headless-policy requires a value")
    if (next !== "no-user-input") throw new NativeRunError("usage", "unknown --headless-policy: " + next)
    return { consumed: 2 }
  }
  if (!argument.startsWith("--headless-policy=")) return undefined
  if (alreadySelected) throw new NativeRunError("usage", "--headless-policy may be specified only once")
  const value = argument.slice("--headless-policy=".length)
  if (value.length === 0) throw new NativeRunError("usage", "--headless-policy requires a value")
  if (value !== "no-user-input") throw new NativeRunError("usage", "unknown --headless-policy: " + value)
  return { consumed: 1 }
}

const parseOmpHeadlessArguments = (
  args: ReadonlyArray<string>,
): { readonly forwarded: string[]; readonly headless: boolean } => {
  let headless = false
  const forwarded: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const policy = parseOmpHeadlessPolicy(args[index]!, args[index + 1], headless)
    if (policy !== undefined) {
      headless = true
      index += policy.consumed - 1
      continue
    }
    forwarded.push(args[index]!)
  }
  return { forwarded, headless }
}

const createOmpHeadlessOverlay = async (layout: GenerationLayout): Promise<string> => {
  const overlay = path.join(layout.generationPath, ".headless-policy-" + randomUUID() + ".yml")
  await writeFile(overlay, "ask:\n  enabled: false\n", { flag: "wx", mode: 0o600 })
  return overlay
}

const readOmpCredential = async (file: string | null): Promise<{ token?: string; cleanup: () => Promise<void> }> => {
  if (file === null) return { cleanup: async () => {} }
  const cleanup = () => unlink(file).catch(() => {})
  try {
    const status = await lstat(file).catch(() => undefined)
    if (!status || !status.isFile() || status.isSymbolicLink())
      throw new NativeRunError("launch", "OMP admission returned an invalid Copilot credential file")
    const token = (await readFile(file, "utf8")).trim()
    if (token.length === 0 || token.includes("\n") || token.includes("\r"))
      throw new NativeRunError("launch", "OMP admission returned an invalid Copilot credential")
    await cleanup()
    return { token, cleanup: async () => {} }
  } catch (error) {
    await cleanup()
    throw error
  }
}

const prepareOmpHeadlessOverlay = async (
  layout: GenerationLayout,
  admission: OmpAdmission,
  requested: boolean,
): Promise<string | undefined> => {
  if (!requested) return undefined
  if (admission.version !== "18.8.5")
    throw new NativeRunError(
      "launch",
      "--headless-policy no-user-input is verified only for OMP 18.8.5; installed version is " +
        admission.version,
    )
  return createOmpHeadlessOverlay(layout)
}

const ompLaunchEnvironment = (
  admission: OmpAdmission,
  credential: { readonly token?: string },
): Record<string, string | null> => {
  const environment: Record<string, string | null> = {
    OMP_PROFILE: admission.ompProfile,
    PI_CONFIG_FILES: admission.piConfigFiles,
  }
  if (credential.token !== undefined) {
    environment.COPILOT_GITHUB_TOKEN = credential.token
    environment.GH_TOKEN = null
    environment.GITHUB_TOKEN = null
  }
  return environment
}

const buildOmpLaunch = async (
  layout: GenerationLayout,
  planned: LaunchCommand,
  forwardedArgs: ReadonlyArray<string>,
  parsed: { readonly forwarded: string[]; readonly headless: boolean },
  admission: OmpAdmission,
  credential: { readonly token?: string; readonly cleanup: () => Promise<void> },
): Promise<LaunchCommand> => {
  let headlessOverlay: string | undefined
  try {
    headlessOverlay = await prepareOmpHeadlessOverlay(layout, admission, parsed.headless)
    return {
      ...planned,
      command: admission.executable,
      args: [
        ...planned.args.slice(0, planned.args.length - forwardedArgs.length),
        ...(headlessOverlay === undefined ? [] : ["--config", headlessOverlay]),
        ...parsed.forwarded,
      ],
      env: ompLaunchEnvironment(admission, credential),
      cleanup: async () => {
        if (headlessOverlay !== undefined) await unlink(headlessOverlay).catch(() => {})
        await credential.cleanup()
      },
    }
  } catch (error) {
    if (headlessOverlay !== undefined) await unlink(headlessOverlay).catch(() => {})
    await credential.cleanup()
    throw error
  }
}

const headlongHome = (environment: NodeJS.ProcessEnv): string => {
  const home = environment.TRELLAGE_HEADLONG_HOME ?? path.join(environment.HOME ?? os.homedir(), ".headlong")
  if (!path.isAbsolute(home)) throw new NativeRunError("config", "TRELLAGE_HEADLONG_HOME must be absolute")
  return home
}

const headlongAppHome = (environment: NodeJS.ProcessEnv, home: string): string => {
  const appHome = environment.TRELLAGE_HEADLONG_APP_DIR ?? path.join(home, "app")
  if (!path.isAbsolute(appHome)) throw new NativeRunError("config", "TRELLAGE_HEADLONG_APP_DIR must be absolute")
  return appHome
}

const headlongEnvironment = (
  environment: NodeJS.ProcessEnv,
  home: string,
  appHome: string,
  model: string | undefined,
): Record<string, string | null> => ({
  HOME: environment.HOME ?? os.homedir(),
  HEADLONG_HOME: home,
  HEADLONG_APP_DIR: appHome,
  HEADLONG_UNSANDBOXED: "1",
  HEADLONG_IDENTITY_NAME: "ada",
  ANTHROPIC_API_KEY: "trellage-local-proxy",
  ANTHROPIC_AUTH_TOKEN: null,
  CLAUDE_CODE_OAUTH_TOKEN: null,
  OPENAI_API_KEY: null,
  GEMINI_API_KEY: null,
  OPENROUTER_API_KEY: null,
  LLM_API_URL: "http://127.0.0.1:8080/v1/messages",
  SHELLM_API_URL: "http://127.0.0.1:8080/v1/messages",
  SHELLM_MODEL: model ?? "claude-sonnet-5",
  SHELLM_WEB_ARGS: "--host 127.0.0.1 --port 18080",
  PATH: [
    path.join(environment.HOME ?? os.homedir(), ".local", "bin"),
    path.join(appHome, "bin"),
    path.join(appHome, "tools"),
    environment.PATH ?? "",
  ]
    .filter(Boolean)
    .join(path.delimiter),
})

const requireHeadlongDirectory = async (directory: string): Promise<void> => {
  const status = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (status && (!status.isDirectory() || status.isSymbolicLink()))
    throw new NativeRunError("launch", `unsafe Headlong directory: ${directory}`)
  if (!status) await mkdir(directory, { recursive: true, mode: 0o700 })
}

const headlongSkillStatus = async (target: string) =>
  lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })

const parseHeadlongManagedSkillNames = (contents: string): Set<string> => {
  const names = new Set<string>()
  const lines = contents.split(/\r?\n/u).filter(Boolean)
  for (const line of lines) {
    const [name, alwaysOn, extra] = line.split("\t")
    if (
      name === undefined ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) ||
      (alwaysOn !== "0" && alwaysOn !== "1") ||
      (extra !== undefined && extra !== "") ||
      names.has(name)
    )
      throw new NativeRunError("launch", `invalid Headlong skill manifest entry: ${line}`)
    names.add(name)
  }
  return names
}

const readHeadlongManagedSkillNames = async (metadata: string, store: string): Promise<Set<string>> => {
  const manifest = path.join(metadata, "managed-skills.tsv")
  const manifestStatus = await headlongSkillStatus(manifest)
  const storeStatus = await headlongSkillStatus(store)
  if (storeStatus && (!storeStatus.isDirectory() || storeStatus.isSymbolicLink()))
    throw new NativeRunError("launch", `unsafe Headlong managed skill store: ${store}`)
  if (!manifestStatus) {
    if (storeStatus && (await readdir(store)).length > 0)
      throw new NativeRunError("launch", "Headlong managed skill store exists without its ownership manifest")
    return new Set()
  }
  if (!manifestStatus.isFile() || manifestStatus.isSymbolicLink())
    throw new NativeRunError("launch", `unsafe Headlong skill manifest: ${manifest}`)
  return parseHeadlongManagedSkillNames(await readFile(manifest, "utf8"))
}

const stageHeadlongSkill = async (
  skill: CompositionPlan["skills"][number],
  store: string,
): Promise<string> => {
  const temporary = path.join(store, `.skill-${randomUUID()}`)
  await cp(skill.directory, temporary, { recursive: true, errorOnExist: true })
  try {
    if ((await digestDirectory(temporary)) !== skill.digest)
      throw new NativeRunError("launch", `Headlong skill changed while staging: ${skill.name}`)
    return temporary
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

const restoreHeadlongSkill = async (target: string, backup: string): Promise<void> => {
  const current = await headlongSkillStatus(target)
  if (current) return
  try {
    await rename(backup, target)
  } catch (error) {
    throw new NativeRunError(
      "launch",
      `Headlong skill update failed and its previous copy could not be restored: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const replaceHeadlongSkill = async (
  temporary: string,
  target: string,
  backup: string,
  existing: boolean,
): Promise<void> => {
  try {
    if (existing) await rename(target, backup)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    if (existing) await restoreHeadlongSkill(target, backup)
    throw error
  }
  if (existing) await rm(backup, { recursive: true, force: true })
}

const publishHeadlongSkill = async (
  skill: CompositionPlan["skills"][number],
  store: string,
  managedNames: ReadonlySet<string>,
): Promise<string> => {
  const target = path.join(store, skill.name)
  const status = await headlongSkillStatus(target)
  if (status && (!status.isDirectory() || status.isSymbolicLink()))
    throw new NativeRunError("launch", `unsafe Headlong managed skill: ${target}`)
  if (status) {
    const existingDigest = await digestDirectory(target)
    if (existingDigest === skill.digest) return target
    if (!managedNames.has(skill.name))
      throw new NativeRunError("launch", `Headlong managed skill collides with unmanaged state: ${skill.name}`)
  }

  const temporary = await stageHeadlongSkill(skill, store)
  await replaceHeadlongSkill(temporary, target, path.join(store, `.backup-${randomUUID()}`), status !== undefined)
  return target
}

const managedHeadlongTarget = (store: string, candidate: string): boolean => {
  const relative = path.relative(store, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

const removeStaleHeadlongLinks = async (
  identity: string,
  store: string,
  selected: ReadonlyMap<string, { readonly target: string; readonly alwaysOn: boolean }>,
): Promise<void> => {
  for (const category of ["skills", "kernel"] as const) {
    const directory = path.join(identity, category)
    await requireHeadlongDirectory(directory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue
      const link = path.join(directory, entry.name)
      const resolved = path.resolve(directory, await readlink(link))
      if (!managedHeadlongTarget(store, resolved)) continue
      const expected = selected.get(entry.name)
      if (expected?.target !== resolved || expected.alwaysOn !== (category === "kernel")) await unlink(link)
    }
  }
}

const linkHeadlongSkills = async (
  identity: string,
  selected: ReadonlyMap<string, { readonly target: string; readonly alwaysOn: boolean }>,
): Promise<void> => {
  for (const [name, skill] of selected) {
    const directory = path.join(identity, skill.alwaysOn ? "kernel" : "skills")
    const link = path.join(directory, name)
    const existing = await lstat(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (existing && !existing.isSymbolicLink())
      throw new NativeRunError("launch", `Headlong skill conflicts with unmanaged identity content: ${link}`)
    if (existing) {
      const existingTarget = path.resolve(directory, await readlink(link))
      if (!managedHeadlongTarget(path.dirname(skill.target), existingTarget))
        throw new NativeRunError("launch", `Headlong skill conflicts with an unmanaged symlink: ${link}`)
      if (existingTarget === skill.target) continue
    }
    const temporary = `${link}.trellage-${randomUUID()}`
    await symlink(skill.target, temporary)
    await rename(temporary, link)
  }
}

const updateHeadlongIdentitySkills = async (
  identity: string,
  store: string,
  selected: ReadonlyMap<string, { readonly target: string; readonly alwaysOn: boolean }>,
): Promise<void> => {
  await removeStaleHeadlongLinks(identity, store, selected)
  await linkHeadlongSkills(identity, selected)
}

const writeHeadlongManagedSkillManifest = async (
  metadata: string,
  skills: CompositionPlan["skills"],
): Promise<void> => {
  const lines = skills
    .map((skill) => `${skill.name}\t${skill.alwaysOn === true && !skill.manualOnly && skill.name !== "i-have-adhd" ? 1 : 0}\t`)
    .sort()
  const manifest = path.join(metadata, "managed-skills.tsv")
  const temporary = path.join(metadata, `.managed-skills-${randomUUID()}`)
  await writeFile(temporary, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, { flag: "wx", mode: 0o600 })
  await rename(temporary, manifest)
}

const syncHeadlongSkills = async (plan: CompositionPlan, home: string, appHome: string): Promise<void> => {
  const store = path.join(home, ".trellage", "skills")
  const metadata = path.dirname(store)
  const identitiesRoot = path.join(appHome, ".identities")
  await requireHeadlongDirectory(metadata)
  const managedNames = await readHeadlongManagedSkillNames(metadata, store)
  await requireHeadlongDirectory(store)
  await requireHeadlongDirectory(identitiesRoot)
  const identities = (await readdir(identitiesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(identitiesRoot, entry.name))
  if (identities.length === 0)
    throw new NativeRunError("launch", "Headlong has no initialized identity; run its host installer before trx run")

  const selected = new Map<string, { readonly target: string; readonly alwaysOn: boolean }>()
  for (const skill of plan.skills) {
    const target = await publishHeadlongSkill(skill, store, managedNames)
    if (skill.manualOnly || skill.name === "i-have-adhd") continue
    selected.set(skill.name, { target, alwaysOn: skill.alwaysOn === true })
  }
  await writeHeadlongManagedSkillManifest(metadata, plan.skills)
  for (const identity of identities) await updateHeadlongIdentitySkills(identity, store, selected)
}

const headlongInitEnvironment = (
  environment: NodeJS.ProcessEnv,
  values: Readonly<Record<string, string | null>>,
): NodeJS.ProcessEnv => {
  const result = { ...environment }
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete result[key]
    else result[key] = value
  }
  return result
}

export const headlongAdapter: NativeAdapter = {
  id: "headlong",
  sandbox: false,
  label: "Headlong",
  isolation: unprovenEvidence(
    "Headlong runs its persistent agent and shell on the host; it has full host access and continues thinking after the TUI exits",
  ),
  skillsSubdirectory: "skills",
  instructionsFile: "AGENTS.md",
  efforts: [],
  policyVersion: "headlong-native-1",
  clean: {
    supported: false,
    reason: "Headlong uses persistent host identities and their skill registries",
  },
  providerPolicy: (model) => `copilot-proxy-rs:${model ?? "claude-sonnet-5"}`,
  effectivePolicy: (model) => ({
    normal: `${model ?? "claude-sonnet-5"} · persistent agent`,
    plan: "Headlong persistent-agent policy",
  }),
  managedFlags: [],
  writeAdapterFiles: async (stage) => {
    await mkdir(stage, { recursive: true })
  },
  persistentState: [],
  resumeArgs: () => [],
  launch: ({ forwardedArgs, environment, model }) => {
    const home = headlongHome(environment)
    const appHome = headlongAppHome(environment, home)
    return {
      command: binary(environment, "TRELLAGE_HEADLONG_BIN", "ada"),
      args: [...forwardedArgs],
      env: headlongEnvironment(environment, home, appHome, model),
    }
  },
  resolveLaunch: async ({ environment, plan, model }, planned) => {
    const home = headlongHome(environment)
    const appHome = headlongAppHome(environment, home)
    const launchEnvironment = headlongEnvironment(environment, home, appHome, model)
    const initEnvironment = headlongInitEnvironment(environment, {
      ...launchEnvironment,
      HEADLONG_NO_THINKERS: "1",
      HEADLONG_NO_DASH: "1",
      HEADLONG_NO_TTY: "1",
    })
    const initCommand = binary(
      environment,
      "TRELLAGE_HEADLONG_INIT_BIN",
      path.join(environment.HOME ?? os.homedir(), ".local", "bin", "headlong-init"),
    )
    try {
      await execFileAsync(initCommand, [], { env: initEnvironment, encoding: "utf8", timeout: 60_000 })
    } catch (error) {
      throw new NativeRunError(
        "launch",
        `Headlong initialization failed; install Headlong on the host and verify headlong-init: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    await syncHeadlongSkills(plan, home, appHome)
    return { ...planned, env: launchEnvironment }
  },
}

export const agencyAdapter: NativeAdapter = {
  id: "agency",
  sandbox: false,
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
  clean: {
    supported: false,
    reason: "Agency launches its managed trellage-azure Copilot profile",
  },
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

export const jcodeAdapter: NativeAdapter = {
  id: "jcode",
  sandbox: false,
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
  clean: {
    supported: false,
    reason: "JCode discovers repository context and has no verified way to switch it off",
  },
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
    const command = lifecycleBinary(environment, "TRELLAGE_JCODE_LIFECYCLE_BIN", "jcx", "jcx")
    let stdout: string
    try {
      const result = await execFileAsync(command, ["_trx-executable"], {
        env: { ...environment, TRELLAGE_TRX_JCODE_ADAPTER: "1" },
        encoding: "utf8",
      })
      stdout = result.stdout
    } catch (error) {
      const failure = error as { stderr?: string; message?: string }
      const diagnostic = failure.stderr?.trim() || failure.message || String(error)
      throw new NativeRunError("launch", `JCode admission failed: ${diagnostic.trim()}`)
    }
    const executable = stdout.trim()
    if (!path.isAbsolute(executable))
      throw new NativeRunError("launch", "JCode admission returned an invalid executable")
    return { ...planned, command: executable }
  },
}

export const ompAdapter: NativeAdapter = {
  id: "omp",
  sandbox: false,
  label: "Oh My Pi",
  isolation: unprovenEvidence(
    "OMP uses its native profile store and receives selected Trellage instructions explicitly",
  ),
  skillsSubdirectory: "skills",
  instructionsFile: "always-on.md",
  efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  policyVersion: "omp-admission-2",
  providerPolicy: (model) => `github-copilot:${model ?? "gpt-5.6-sol"}`,
  effectivePolicy: (model, effort) => ({
    normal: `${model ?? "gpt-5.6-sol"} · effort ${effort ?? "medium"}`,
    plan: "OMP profile policy",
  }),
  managedFlags: ["--approval-mode", "--append-system-prompt", "--model", "--provider", "--thinking"],
  clean: {
    supported: false,
    reason: "OMP admission installs managed skills and profile overlays before every launch",
  },
  writeAdapterFiles: async (stage) => {
    await mkdir(stage, { recursive: true })
  },
  persistentState: [],
  resumeArgs: () => [],
  launch: ({ layout, plan, model, effort, forwardedArgs, environment }) => ({
    command: binary(environment, "TRELLAGE_OMP_BIN", "omp"),
    args: [
      ...instructionsArgument(layout),
      ...(model ? ["--model", model.includes("/") ? model : `github-copilot/${model}`] : []),
      ...(effort ? ["--thinking", effort] : []),
      ...forwardedArgs,
    ],
    env: {
      OMP_PROFILE:
        selectedPreset(plan, "omp", "default") === "default" ? "trellage-copilot-native" : "trellage-qwen-local",
    },
  }),
  resolveLaunch: async ({ layout, plan, forwardedArgs, environment, guard }, planned) => {
    const profile = selectedPreset(plan, "omp", "default")
    const parsed = parseOmpHeadlessArguments(forwardedArgs)
    const admission = await runOmpAdmission(profile, environment, guard)
    const credential = await readOmpCredential(admission.copilotCredentialFile)
    return buildOmpLaunch(layout, planned, forwardedArgs, parsed, admission, credential)
  },
}

export const primeAdapter: NativeAdapter = {
  id: "prime",
  sandbox: false,
  label: "Prime",
  isolation: unprovenEvidence("Prime uses the generated coding-agent directory while its kernel remains native"),
  skillsSubdirectory: "skills",
  instructionsFile: "AGENTS.md",
  efforts: [],
  policyVersion: "prime-canonical-2",
  providerPolicy: (model) => `copilot-proxy-rs:${model ?? PRIME_DEFAULT_MODEL}`,
  effectivePolicy: (model) => ({
    normal: `${model ?? PRIME_DEFAULT_MODEL} · effort managed`,
    plan: "Prime autonomous policy",
  }),
  managedFlags: PRIME_MANAGED_FLAGS.filter((flag) => flag !== "--single-turn"),
  clean: {
    supported: false,
    reason: "Prime repairs its runtime before launch and keeps its native kernel",
  },
  writeAdapterFiles: async (stage, model) => {
    await mkdir(stage, { recursive: true })
    await writeFile(
      path.join(stage, "models.json"),
      `${JSON.stringify({ providers: { "copilot-proxy-rs": { baseUrl: "http://127.0.0.1:8080", api: "anthropic-messages", apiKey: "trellage-local-proxy", compat: { supportsEagerToolInputStreaming: false }, models: [{ id: model ?? PRIME_DEFAULT_MODEL }] } } }, null, 2)}\n`,
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
      model ?? PRIME_DEFAULT_MODEL,
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
      const lifecycle = lifecycleBinary(environment, "TRELLAGE_PRIME_LIFECYCLE_BIN", "prx", "prx")
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
        const diagnostic = failure.stderr?.trim() || failure.message || String(error)
        throw new NativeRunError("launch", `Prime lifecycle repair failed: ${diagnostic.trim()}`)
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
export const PI_EXTENSION_PACKAGES: ReadonlyArray<string> = ["@narumitw/pi-plan-mode", "@narumitw/pi-goal"]

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

/** The working directory's own Pi extensions and skills, loaded explicitly so the rest of the isolation stays. */
export const piProjectResources = (workspace: string): string[] => {
  const entries = (directory: string) => {
    try {
      return readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    } catch {
      return []
    }
  }
  const extensions = path.join(workspace, ".pi", "extensions")
  const skills = path.join(workspace, ".agents", "skills")
  return [
    ...entries(extensions)
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .flatMap((entry) => ["--extension", path.join(extensions, entry.name)]),
    ...entries(skills)
      .filter((entry) => entry.isDirectory() && existsSync(path.join(skills, entry.name, "SKILL.md")))
      .flatMap((entry) => ["--skill", path.join(skills, entry.name)]),
  ]
}

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

const writePiSettings = async (
  stage: string,
  model: string | undefined,
  extra: Readonly<Record<string, unknown>>,
): Promise<void> => {
  await mkdir(stage, { recursive: true })
  await writeFile(
    path.join(stage, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: piProviderFor(model),
        defaultModel: model ?? PI_DEFAULT_MODEL,
        defaultThinkingLevel: "medium",
        ...extra,
        defaultProjectTrust: "never",
        enableInstallTelemetry: false,
        packages: [],
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(path.join(stage, "models.json"), piModelsJson(model))
}

const piLaunch = (
  loading: ReadonlyArray<string>,
  { layout, model, effort, forwardedArgs, resumeArgs, environment }: LaunchInput,
): LaunchCommand => ({
  command: binary(environment, "TRELLAGE_PI_BIN", "pi"),
  args: [
    ...loading,
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
})

export const piAdapter: NativeAdapter = {
  id: "pi",
  sandbox: false,
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
  writeAdapterFiles: (stage, model) => writePiSettings(stage, model, { defaultTools: ["+codemode"] }),
  persistentState: [],
  resumeArgs: (resume) =>
    resume.kind === "continue" ? ["--continue"] : resume.id ? ["--resume", resume.id] : ["--resume"],
  launch: (input) =>
    piLaunch(
      [
        "--no-skills",
        "--no-extensions",
        "--extension",
        "builtin:codemode",
        ...piExtensionEntries(input.environment).flatMap((entry) => ["--extension", entry]),
        "--no-prompt-templates",
        "--no-approve",
        ...input.plan.skills.flatMap((skill) => [
          "--skill",
          path.join(input.layout.generationPath, "skills", skill.name),
        ]),
        ...(input.plan.projectResources ? piProjectResources(input.workspace) : []),
      ],
      input,
    ),
  clean: {
    supported: true,
    evidence:
      "Pi 1.2.0: --no-skills, --no-extensions, --no-prompt-templates, --no-context-files, --no-mcp and --no-themes load no repository or host instructions, skills, extensions or MCP servers",
    defaults: { model: PI_DEFAULT_MODEL, effort: "medium" },
    writeAdapterFiles: (stage, model) => writePiSettings(stage, model, {}),
    launch: (input) =>
      piLaunch(
        [
          "--no-skills",
          "--no-extensions",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-mcp",
          "--no-themes",
          "--no-approve",
        ],
        input,
      ),
  },
}

/**
 * Copilot hides skills marked `disable-model-invocation: true` from the model
 * instead of offering them as user-only commands, so a composed skill would be
 * unreachable. The generation copy drops that front-matter line; sources are unchanged.
 */
export const allowCopilotModelInvocation = async (skillsDirectory: string): Promise<void> => {
  let entries: string[]
  try {
    entries = await readdir(skillsDirectory)
  } catch {
    return
  }
  for (const name of entries) {
    const file = path.join(skillsDirectory, name, "SKILL.md")
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch {
      continue
    }
    const updated = text.replace(/^(---\r?\n[\s\S]*?)^disable-model-invocation:\s*true\s*\r?\n([\s\S]*?^---)/m, "$1$2")
    if (updated !== text) await writeFile(file, updated)
  }
}

const exists = (file: string): Promise<boolean> =>
  lstat(file).then(
    () => true,
    () => false,
  )

/** Entries with the given relative names from the workspace up to and including the repository root, nearest first. */
const repositoryEntries =
  (names: ReadonlyArray<string>) =>
  async (workspace: string): Promise<ReadonlyArray<string>> => {
    const found: string[] = []
    for (let directory = path.resolve(workspace); ; directory = path.dirname(directory)) {
      for (const name of names) {
        const entry = path.join(directory, name)
        if (await exists(entry)) found.push(entry)
      }
      if ((await exists(path.join(directory, ".git"))) || path.dirname(directory) === directory) return found
    }
  }

const LISTING_TIMEOUT_MS = 20_000

/** Insert launch arguments right after the clean flags, before any subcommand or forwarded argument. */
const afterCleanArgs = (
  planned: LaunchCommand,
  cleanArgs: ReadonlyArray<string>,
  extra: ReadonlyArray<string>,
): LaunchCommand => ({
  ...planned,
  args: [...cleanArgs, ...extra, ...planned.args.slice(cleanArgs.length)],
})

const copilotLaunch = ({
  layout,
  model,
  effort,
  forwardedArgs,
  resumeArgs,
  environment,
  planMode,
}: LaunchInput): LaunchCommand => {
  const planning = planMode === true || forwardedArgs.includes("--plan")
  // Autopilot makes the model finish through task_complete, whose summary `-p` never prints.
  const oneShot = forwardedArgs.some(
    (argument) => argument === "-p" || argument === "--prompt" || argument.startsWith("--prompt="),
  )
  return {
    command: binary(environment, "TRELLAGE_COPILOT_BIN", "copilot"),
    args: [
      ...(planning ? ["--plan"] : [...(oneShot ? [] : ["--autopilot"]), "--allow-all", "--no-ask-user"]),
      "--model",
      model ?? "gpt-6-astra",
      "--effort",
      effort ?? "low",
      ...resumeArgs,
      ...forwardedArgs.filter((argument) => argument !== "--plan"),
    ],
    env: { COPILOT_HOME: layout.generationPath },
  }
}

const COPILOT_CLEAN_ARGS: ReadonlyArray<string> = [
  "--no-auto-update",
  "--no-custom-instructions",
  "--disable-builtin-mcps",
  "--excluded-tools=task,read_agent,list_agents,write_agent",
]

export const copilotAdapter: NativeAdapter = {
  id: "copilot",
  sandbox: false,
  label: "Copilot",
  isolation: unprovenEvidence(
    "Copilot CLI 1.0.93-1 still discovers trusted repository skills with a dedicated COPILOT_HOME (scripts/probe-native-isolation.ts)",
  ),
  skillsSubdirectory: "skills",
  instructionsFile: "copilot-instructions.md",
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  policyVersion: "copilot-6",
  providerPolicy: () => "copilot-native",
  effectivePolicy: (model, effort) => ({
    normal: `${model ?? "gpt-6-astra"} · effort ${effort ?? "low"}`,
    plan: "harness default planModel",
  }),
  managedFlags: ["--config-dir", "--no-custom-instructions"],
  clean: {
    supported: true,
    evidence:
      "Copilot 1.0.98: no custom instructions, every discovered skill and MCP server disabled by name, built-in MCP servers and agent tools off; refuses when the repository defines hooks or agents because a trusted folder always runs them",
    defaults: { model: "gpt-6-astra", effort: "low" },
    managedFlags: [
      "--enable-mcp-server",
      "--additional-mcp-config",
      "--enable-all-github-mcp-tools",
      "--add-github-mcp-toolset",
      "--add-github-mcp-tool",
      "--plugin-dir",
      "--add-dir",
      "--agent",
      "--available-tools",
      "--excluded-tools",
    ],
    writeAdapterFiles: async (stage) => {
      await mkdir(stage, { recursive: true })
    },
    launch: (input) => {
      const base = copilotLaunch(input)
      return { ...base, args: [...COPILOT_CLEAN_ARGS, ...base.args] }
    },
    blockers: {
      find: repositoryEntries([
        ".github/hooks",
        ".github/copilot",
        ".github/agents",
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".claude/agents",
      ]),
      effect:
        "loads repository hooks or agents in every trusted Copilot folder. Run from a directory without it, or use claude, codex or pi clean.",
    },
    resolveLaunch: async (input, planned) => {
      const list = async (args: ReadonlyArray<string>): Promise<unknown> => {
        try {
          const { stdout } = await execFileAsync(
            binary(input.environment, "TRELLAGE_COPILOT_BIN", "copilot"),
            ["--no-auto-update", ...args, "--json"],
            {
              cwd: input.workspace,
              env: { ...input.environment, COPILOT_HOME: input.layout.generationPath },
              encoding: "utf8",
              timeout: LISTING_TIMEOUT_MS,
            },
          )
          return JSON.parse(stdout)
        } catch (error) {
          throw new NativeRunError(
            "launch",
            `could not list Copilot ${args[0]}s: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      const skills = await list(["skill", "list"])
      const servers = ((await list(["mcp", "list"])) as { mcpServers?: unknown } | null)?.mcpServers
      if (!Array.isArray(skills) || !servers || typeof servers !== "object")
        throw new NativeRunError("launch", "Copilot returned an invalid skill or MCP server list")
      const disabledSkills = skills.flatMap((skill: { name?: unknown }) =>
        typeof skill.name === "string" ? [skill.name] : [],
      )
      await mergeJson(path.join(input.layout.generationPath, "settings.json"), (current) => ({
        ...current,
        disabledSkills,
        memory: false,
      }))
      return afterCleanArgs(
        planned,
        COPILOT_CLEAN_ARGS,
        Object.keys(servers).flatMap((name) => ["--disable-mcp-server", name]),
      )
    },
  },
  writeAdapterFiles: (stage) => allowCopilotModelInvocation(path.join(stage, "skills")),
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
  pickResumeSession: ({ ownerHome, workspace }) => pickCopilotSession(ownerHome, workspace),
  launch: copilotLaunch,
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
    const registrations = admitted.pluginRegistrations
    if (
      !Array.isArray(registrations) ||
      registrations.length === 0 ||
      !registrations.every(
        (entry: unknown) => !!entry && typeof entry === "object" && !Array.isArray(entry) && "cache_path" in entry,
      )
    )
      throw new NativeRunError("launch", "Copilot admission returned invalid plugin registrations")
    await ensureManagedSymlink(path.join(input.layout.generationPath, "installed-plugins"), admitted.installedPlugins)
    await mergeJson(path.join(input.layout.generationPath, "settings.json"), (current) => ({
      ...current,
      ...(admitted.settings as Record<string, unknown>),
    }))
    // Copilot discovers plugins only from config.json installedPlugins; settings and the plugin root alone load nothing.
    await mergeJson(path.join(input.layout.generationPath, "config.json"), (current) => ({
      ...current,
      installedPlugins: registrations,
    }))
    return planned
  },
}

// Keep provider routing launch-scoped; config.toml only records workspace trust and Codex's own settings.
const CODEX_PROXY_OVERRIDES: ReadonlyArray<string> = [
  'model_provider="copilotproxy"',
  'model_providers.copilotproxy.name="copilot-proxy-rs"',
  'model_providers.copilotproxy.base_url="http://127.0.0.1:8080/v1"',
  'model_providers.copilotproxy.wire_api="responses"',
  "model_providers.copilotproxy.requires_openai_auth=false",
  "features.context_management.experimental_mode=true",
]

const CODEX_CLEAN_ARGS: ReadonlyArray<string> = [
  "-c",
  "project_doc_max_bytes=0",
  "-c",
  "skills.include_instructions=false",
  "-c",
  "skills.bundled.enabled=false",
  "--enable",
  "skip_host_skill_discovery",
  "--disable",
  "apps",
  "--disable",
  "plugins",
  "--disable",
  "hooks",
  "--disable",
  "memories",
  "-c",
  "check_for_update_on_startup=false",
]

/** Paths of the skills a clean Codex would still list, read from its app server. */
const codexEnabledSkills = (input: LaunchInput): Promise<ReadonlyArray<string>> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      binary(input.environment, "TRELLAGE_CODEX_BIN", "codex"),
      [...CODEX_CLEAN_ARGS, "-c", `projects.${JSON.stringify(input.workspace)}.trust_level="trusted"`, "app-server"],
      {
        cwd: input.workspace,
        env: { ...input.environment, CODEX_HOME: input.layout.generationPath },
        stdio: ["pipe", "pipe", "ignore"],
      },
    )
    const settle = (finish: () => void) => {
      clearTimeout(timer)
      child.kill()
      finish()
    }
    const fail = (message: string) => settle(() => reject(new NativeRunError("launch", message)))
    const timer = setTimeout(() => fail("Codex skill listing timed out after 20s"), LISTING_TIMEOUT_MS)
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`)
    child.stdin.on("error", () => undefined)
    child.once("error", (error) => fail(`could not list Codex skills: ${error.message}`))
    child.once("exit", (code) => fail(`Codex app-server exited ${code ?? "by signal"} before listing skills`))
    let buffer = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line) continue
        let message: { id?: unknown; error?: { message?: unknown }; result?: unknown }
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.error) return fail(`Codex skill listing failed: ${String(message.error.message)}`)
        if (message.id === 1) {
          send({ method: "initialized" })
          send({ id: 2, method: "skills/list", params: { cwds: [input.workspace], forceReload: true } })
        }
        if (message.id === 2) {
          const skills = (message.result as { data?: Array<{ skills?: unknown }> } | undefined)?.data?.[0]?.skills
          if (!Array.isArray(skills)) return fail("Codex skill listing returned no skill list")
          const enabled = skills.flatMap((skill: { path?: unknown; enabled?: unknown }) =>
            skill.enabled === true && typeof skill.path === "string" ? [skill.path] : [],
          )
          return settle(() => resolve(enabled))
        }
      }
    })
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "trellage", version: "1" }, capabilities: { experimentalApi: true } },
    })
  })

const codexLaunch = ({
  layout,
  model,
  effort,
  forwardedArgs,
  resumeArgs,
  environment,
  workspace,
}: LaunchInput): LaunchCommand => ({
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
})

export const codexAdapter: NativeAdapter = {
  id: "codex",
  sandbox: false,
  label: "Codex",
  isolation: unprovenEvidence(
    "Codex 0.160.1 skills/list still returns repository skills despite skip_host_skill_discovery and extra-root controls (scripts/probe-native-isolation.ts)",
  ),
  skillsSubdirectory: "skills",
  instructionsFile: "AGENTS.md",
  efforts: ["minimal", "low", "medium", "high", "xhigh"],
  policyVersion: "codex-7",
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
  trustWorkspace: async (layout, workspace) => {
    const file = path.join(layout.generationPath, "config.toml")
    const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    const config = parseToml(text)
    const projects = config.projects ?? {}
    if (!projects || typeof projects !== "object" || Array.isArray(projects) || projects instanceof Date)
      throw new NativeRunError("launch", `invalid Codex projects configuration: ${file}`)
    const nextProjects = { ...projects }
    for (const directory of new Set([workspace, await realpath(workspace)]))
      nextProjects[directory] = { trust_level: "trusted" }
    const temporary = path.join(layout.generationPath, `.config-${randomUUID()}.toml`)
    try {
      // Codex's folder-access dialog reads saved configuration, not just CLI overrides.
      await writeFile(temporary, stringifyToml({ ...config, projects: nextProjects }), { flag: "wx", mode: 0o600 })
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
  },
  persistentState: ["sessions", "archived_sessions"],
  resumeArgs: (resume) =>
    resume.kind === "continue" ? ["resume", "--last"] : resume.id ? ["resume", resume.id] : ["resume"],
  launch: codexLaunch,
  clean: {
    supported: true,
    evidence:
      "Codex 0.160.0: zero project-doc bytes and disabled skill instructions, bundled skills, host skill discovery, apps, plugins, hooks and memories load no repository or host instructions or skills; refuses when a repository .codex directory is present because Codex loads it in every writable sandbox",
    defaults: { model: undefined, effort: undefined },
    writeAdapterFiles: async () => {},
    launch: (input) => {
      const base = codexLaunch(input)
      return { ...base, args: [...CODEX_CLEAN_ARGS, ...base.args] }
    },
    blockers: {
      find: repositoryEntries([".codex"]),
      effect:
        "loads repository MCP servers, instructions and hooks in every writable Codex sandbox. Run from a directory without it, or use claude or pi clean.",
    },
    resolveLaunch: async (input, planned) => {
      const skills = await codexEnabledSkills(input)
      if (skills.length === 0) return planned
      const entries = skills.map((skill) => `{path=${JSON.stringify(skill)},enabled=false}`)
      return afterCleanArgs(planned, CODEX_CLEAN_ARGS, ["-c", `skills.config=[${entries.join(",")}]`])
    },
  },
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

const claudePluginSettings = (plan: CompositionPlan | undefined): Record<string, unknown> => {
  if (!plan || plan.plugins.length === 0) return {}
  const enabledPlugins = Object.fromEntries(
    plan.plugins
      .filter((plugin) => plugin.plugin && plugin.marketplace)
      .map((plugin) => [`${plugin.plugin}@${plugin.marketplace}`, true]),
  )
  const pluginConfigs = Object.fromEntries(
    plan.plugins
      .filter((plugin) => plugin.plugin && plugin.marketplace && Object.keys(plugin.settings ?? {}).length > 0)
      .map((plugin) => [`${plugin.plugin}@${plugin.marketplace}`, { options: plugin.settings }]),
  )
  return { enabledPlugins, pluginConfigs }
}

const claudeInteractiveProfiles = new Set([
  "preset-claude-blog",
  "preset-claude-council",
  "preset-claude-ecc",
  "preset-claude-frontend-design",
  "preset-claude-research",
  "preset-claude-social-media",
])

// Skip first-run onboarding (theme picker) and the bypass-permissions confirmation in a fresh config directory.
const writeClaudeState = async (stage: string): Promise<void> => {
  await mkdir(stage, { recursive: true })
  await writeFile(
    path.join(stage, ".claude.json"),
    `${JSON.stringify({ hasCompletedOnboarding: true, shiftEnterKeyBindingInstalled: true }, null, 2)}\n`,
    { mode: 0o600 },
  )
}

const CLAUDE_MODEL_ALIASES: ReadonlySet<string> = new Set(["opusplan", "opus", "sonnet", "haiku", "default", "best"])

// Claude Code resolves its aliases itself; pinning an alias as the default model id sends it to the proxy verbatim.
const isClaudeAlias = (model: string): boolean => CLAUDE_MODEL_ALIASES.has(model.replace(/\[1m\]$/, ""))

const claudeLaunch = ({
  layout,
  plan,
  model,
  effort,
  forwardedArgs,
  resumeArgs,
  environment,
  planMode,
}: LaunchInput): LaunchCommand => {
  // Claude Code does not know proxy model ids, so state the window it should assume.
  const window = modelContextWindow(model, environment.HOME)
  return {
    command: binary(environment, "TRELLAGE_CLAUDE_BIN", "claude"),
    args: [
      ...plan.plugins.flatMap((plugin) => ["--plugin-dir", path.join(layout.generationPath, "plugins", plugin.name)]),
      ...(planMode
        ? ["--allow-dangerously-skip-permissions"]
        : ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions"]),
      ...(planMode && effort ? ["--effort", effort] : []),
      ...(plan.profiles.some((profile) => claudeInteractiveProfiles.has(profile))
        ? []
        : ["--disallowedTools", "AskUserQuestion"]),
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
      ...(model && !isClaudeAlias(model)
        ? { ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model }
        : {}),
      ...(window
        ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(window) }
        : { CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1" }),
    },
  }
}

const CLAUDE_CLEAN_ARGS: ReadonlyArray<string> = [
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--settings",
  JSON.stringify({ skipDangerousModePermissionPrompt: true }),
]

export const claudeAdapter: NativeAdapter = {
  id: "claude",
  sandbox: false,
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
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--settings",
    "--mcp-config",
  ],
  writeAdapterFiles: async (stage, _model, _layout, plan) => {
    await writeClaudeState(stage)
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
          ...claudePluginSettings(plan),
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
  launch: claudeLaunch,
  clean: {
    supported: true,
    evidence:
      "Claude Code 2.1.300: no setting sources, strict empty MCP config and disabled slash commands load no repository or host instructions, skills, agents, MCP servers or hooks",
    defaults: { model: "opusplan", effort: "medium" },
    writeAdapterFiles: (stage) => writeClaudeState(stage),
    launch: (input) => {
      const base = claudeLaunch(input)
      return {
        ...base,
        args: [...CLAUDE_CLEAN_ARGS, ...base.args],
        env: { ...base.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      }
    },
  },
  resolveLaunch: async (input, planned) => {
    const profile = lifecycleProfile(input.plan, "claude", "default")
    if (!["default", "office", "office-charts"].includes(profile)) return planned
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
  sandbox: true,
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
  clean: {
    supported: false,
    reason: "Grok 1.0.46 loads repository AGENTS.md, skills, agents and MCP servers in a trusted folder, and an untrusted folder blocks on a trust prompt",
  },
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

const ompDefaults = (plan: CompositionPlan | undefined): HostDefaults =>
  plan && selectedPreset(plan, "omp", "default") !== "default"
    ? { model: undefined, effort: undefined }
    : { model: "gpt-5.6-sol", effort: "medium" }

/** The model and effort a launch uses when the caller names none; read from the host's own harness settings. */
export const hostDefaults = (harness: string, home: string = os.homedir(), plan?: CompositionPlan): HostDefaults => {
  const adapter = adapterFor(harness)
  const valid = (effort: string | undefined) =>
    effort !== undefined && adapter.efforts.includes(effort) ? effort : undefined
  if (harness === "pi") return { model: PI_DEFAULT_MODEL, effort: "medium" }
  if (harness === "fx") return { model: FX_DEFAULT_MODEL, effort: FX_DEFAULT_EFFORT }
  if (harness === "agency") return { model: "gpt-6-astra", effort: "low" }
  if (harness === "jcode") return { model: "gpt-5.6-sol", effort: "medium" }
  if (harness === "omp") return ompDefaults(plan)
  if (harness === "prime") return { model: PRIME_DEFAULT_MODEL, effort: undefined }
  if (harness === "uji") return { model: `${UJI_PROXY_PROVIDER}/${UJI_PROXY_DEFAULT_MODEL}`, effort: undefined }
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

export const ujiAdapter: NativeAdapter = {
  id: "uji",
  sandbox: false,
  label: "Uji",
  isolation: unprovenEvidence(
    "Uji uses a generated config and selected skill roots; broader workspace and tool isolation has not been verified",
  ),
  skillsSubdirectory: "skills",
  instructionsFile: "TRELLAGE_INSTRUCTIONS.md",
  efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  policyVersion: UJI_TOOLS_POLICY,
  providerPolicy: (model) => ujiModelSelection(model),
  effectivePolicy: (model, effort) => ({
    normal: `${ujiModelSelection(model)}${effort ? ` · effort ${effort}` : ""}`,
    plan: "same model and effort · Trellage planning instructions",
  }),
  managedFlags: ["--model", "--effort", "--config-dir", "--data-dir", "--db"],
  clean: {
    supported: false,
    reason: "Uji workspace and tool isolation has not been verified",
  },
  writeAdapterFiles: async (stage, model, layout, plan) => {
    await mkdir(stage, { recursive: true })
    const pluginDirectory = path.join(stage, "plugin")
    await mkdir(pluginDirectory, { recursive: true })
    await writeFile(path.join(pluginDirectory, "trellage-tools.lua"), UJI_TOOLS_CONTENT, { mode: 0o600 })
    const instructions = plan?.instructions.map((instruction) => instruction.text.trim()).filter(Boolean) ?? []
    const manualSkills = plan?.skills.filter((skill) => skill.manualOnly).map((skill) => skill.name) ?? []
    const selectedModel = ujiModelSelection(model).slice(UJI_PROXY_PROVIDER.length + 1)
    const config = [
      'require("uji.builtin.defaults")',
      'uji.tool.policy({ default = "allow" })',
      'uji.pack.add({ "uji-labs/uji-plugins" })',
      `require("skills").setup({ roots = { ${luaStringLiteral(path.join(layout.generationPath, "skills"))} } })`,
      "uji.provider.add({",
      `  id = ${luaStringLiteral(UJI_PROXY_PROVIDER)},`,
      `  name = ${luaStringLiteral(UJI_PROXY_PROVIDER)},`,
      "  api = uji.api.responses(),",
      `  base_url = ${luaStringLiteral(UJI_PROXY_BASE_URL)},`,
      '  auth_env = { "OPENAI_API_KEY" },',
      `  models = { { id = ${luaStringLiteral(selectedModel)} } },`,
      "})",
      ...(instructions.length > 0
        ? [
            `uji.context.add("trellage-instructions", function() return ${luaStringLiteral(instructions.join("\n\n"))} end, { priority = 10 })`,
          ]
        : []),
      ...(manualSkills.length > 0
        ? [
            `uji.context.add("trellage-manual-skills", function() return ${luaStringLiteral(
              `Only use these Trellage skills when the user explicitly asks to activate them: ${manualSkills.join(", ")}.`,
            )} end, { priority = 30 })`,
          ]
        : []),
      'local model = os.getenv("TRX_UJI_MODEL")',
      'local effort = os.getenv("TRX_UJI_EFFORT")',
      `model = model or ${luaStringLiteral(`${UJI_PROXY_PROVIDER}/${UJI_PROXY_DEFAULT_MODEL}`)}`,
      'local provider, id = model:match("^([^/]+)/(.+)$")',
      `if provider ~= ${luaStringLiteral(UJI_PROXY_PROVIDER)} or not id then error("TRX_UJI_MODEL must use ${UJI_PROXY_PROVIDER}/ID format") end`,
      "uji.model.use({ provider = provider, model = id, effort = effort })",
      'if os.getenv("TRX_UJI_PLAN") == "1" then',
      '  uji.context.add("trellage-plan-mode", function() return "Planning mode: analyze the request and produce a plan. Do not modify files or run commands that change state." end, { priority = 90 })',
      "end",
      "",
    ].join("\n")
    await writeFile(path.join(stage, "init.lua"), config, { mode: 0o600 })
  },
  persistentState: [],
  resumeArgs: (resume) =>
    resume.kind === "continue" ? ["resume"] : resume.id ? ["resume", "--id", resume.id] : ["resume"],
  launch: ({ layout, model, effort, forwardedArgs, resumeArgs, environment, planMode }) => ({
    command: binary(environment, "TRELLAGE_UJI_BIN", "uji"),
    args: [...(resumeArgs.length > 0 ? resumeArgs : ["new"]), ...forwardedArgs],
    env: {
      UJI_CONFIG_DIR: layout.generationPath,
      UJI_DB: path.join(layout.sessionsPath, "uji.db"),
      OPENAI_API_KEY: UJI_PROXY_API_KEY,
      OPENAI_BASE_URL: null,
      TRX_UJI_MODEL: model ?? null,
      TRX_UJI_EFFORT: effort ?? null,
      TRX_UJI_PLAN: planMode === true ? "1" : null,
    },
  }),
}

export const adapters: Readonly<Record<string, NativeAdapter>> = {
  agency: agencyAdapter,
  pi: piAdapter,
  copilot: copilotAdapter,
  claude: claudeAdapter,
  codex: codexAdapter,
  jcode: jcodeAdapter,
  omp: ompAdapter,
  prime: primeAdapter,
  grok: grokAdapter,
  fx: fxAdapter,
  headlong: headlongAdapter,
  uji: ujiAdapter,
}

export const adapterFor = (harness: string): NativeAdapter => {
  const adapter = Object.hasOwn(adapters, harness) ? adapters[harness] : undefined
  if (!adapter)
    throw new NativeRunError("usage", `unknown harness ${harness}; supported: ${Object.keys(adapters).join(", ")}`)
  return adapter
}
