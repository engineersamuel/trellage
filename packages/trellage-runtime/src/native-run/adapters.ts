import { readFileSync } from "node:fs"
import { chmod, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseToml } from "smol-toml"
import { NativeRunError } from "./paths.ts"
import type { GenerationLayout, CompositionPlan } from "./compose.ts"

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
}

export interface NativeAdapter {
  readonly id: string
  readonly label: string
  readonly isolation: IsolationStatus
  readonly skillsSubdirectory: string
  readonly instructionsFile: string
  readonly efforts: ReadonlyArray<string>
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
  /** Flags the adapter owns; forwarding them would undo the prepared boundary. */
  readonly managedFlags: ReadonlyArray<string>
}

const mergeJson = async (file: string, update: (current: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
  let current: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>
  } catch {
    // A missing or unreadable file starts from an empty object.
  }
  await writeFile(file, `${JSON.stringify(update(current), null, 2)}\n`, { mode: 0o600 })
}

const flagName = (argument: string): string => argument.split("=", 1)[0]!

export const assertForwardedArgs = (adapter: NativeAdapter, args: ReadonlyArray<string>): void => {
  for (const argument of args) {
    if (adapter.managedFlags.includes(flagName(argument)))
      throw new NativeRunError("usage", `${flagName(argument)} is managed by the ${adapter.label} adapter and cannot be forwarded`)
  }
}

export const assertEffort = (adapter: NativeAdapter, effort: string | undefined): void => {
  if (effort !== undefined && !adapter.efforts.includes(effort))
    throw new NativeRunError("usage", `${adapter.label} does not support effort ${effort}; supported: ${adapter.efforts.join(", ")}`)
}

const binary = (environment: NodeJS.ProcessEnv, variable: string, fallback: string): string =>
  environment[variable] && path.isAbsolute(environment[variable]!) ? environment[variable]! : fallback

/** Always-available Pi extensions, installed unpinned (latest) into a shared directory outside any generation. */
export const PI_EXTENSION_PACKAGES: ReadonlyArray<string> = ["@narumitw/pi-plan-mode"]

export const piExtensionsHome = (environment: NodeJS.ProcessEnv): string =>
  environment.TRELLAGE_PI_EXTENSIONS_HOME ?? path.join(environment.HOME ?? os.homedir(), ".local/share/trellage/pi-extensions")

/** Entry files declared by each installed extension package's `pi.extensions` manifest. */
export const piExtensionEntries = (environment: NodeJS.ProcessEnv): string[] =>
  PI_EXTENSION_PACKAGES.flatMap((name) => {
    const root = path.join(piExtensionsHome(environment), "node_modules", name)
    try {
      const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { pi?: { extensions?: string[] } }
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
const piProviderFor = (model: string | undefined): string => (model?.startsWith("claude-") ? PI_CLAUDE_PROVIDER : PI_PROVIDER)

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
    evidence: "Pi 1.0.4 resource loader: --no-skills plus explicit --skill kept only selected skills and retained AGENTS.md",
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
  resumeArgs: (resume) => (resume.kind === "continue" ? ["--continue"] : resume.id ? ["--resume", resume.id] : ["--resume"]),
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

const unprovenEvidence = (detail: string): IsolationStatus => ({
  status: "unproven",
  evidence: detail,
})

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
    normal: `${model ?? "harness default"} · effort ${effort ?? "harness default"}`,
    plan: "harness default planModel",
  }),
  managedFlags: ["--config-dir", "--no-custom-instructions", "--allow-all", "--no-ask-user"],
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
  resumeArgs: (resume) => (resume.kind === "continue" ? ["--continue"] : resume.id ? [`--resume=${resume.id}`] : ["--resume"]),
  launch: ({ layout, model, effort, forwardedArgs, resumeArgs, environment }) => ({
    command: binary(environment, "TRELLAGE_COPILOT_BIN", "copilot"),
    args: [
      "--allow-all",
      "--no-ask-user",
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--reasoning-effort", effort] : []),
      ...resumeArgs,
      ...forwardedArgs,
    ],
    env: { COPILOT_HOME: layout.generationPath },
  }),
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
  resumeArgs: (resume) => (resume.kind === "continue" ? ["resume", "--last"] : resume.id ? ["resume", resume.id] : ["resume"]),
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
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ].map((name) => [name, null]),
)

/** Context window of a model from the host Copilot model list, if it is listed. */
export const modelContextWindow = (model: string | undefined, home: string | undefined): number | undefined => {
  if (!model || !home) return undefined
  const models = readStructured(path.join(home, ".copilot", "models.json"), "json").models
  if (!Array.isArray(models)) return undefined
  const entry = models.find((candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === model) as
    | { context_window?: unknown }
    | undefined
  return typeof entry?.context_window === "number" && entry.context_window > 0 ? entry.context_window : undefined
}

export const claudeAdapter: NativeAdapter = {
  id: "claude",
  label: "Claude",
  isolation: unprovenEvidence("no model-free native proof exists for Claude Code discovery yet"),
  skillsSubdirectory: "skills",
  instructionsFile: "CLAUDE.md",
  efforts: ["low", "medium", "high", "xhigh", "max"],
  policyVersion: "claude-7",
  providerPolicy: () => "claude-native",
  effectivePolicy: (model, effort) => ({
    normal: `${model ?? "harness default"} · effort ${effort ?? "harness default"}`,
    plan: "harness default (opusplan alias is not applied by this adapter)",
  }),
  managedFlags: ["--setting-sources", "--plugin-dir", "--bare", "--dangerously-skip-permissions", "--permission-mode", "--disallowedTools"],
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
      const projects = (current.projects && typeof current.projects === "object" ? current.projects : {}) as Record<string, object>
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
  resumeArgs: (resume) => (resume.kind === "continue" ? ["--continue"] : resume.id ? ["--resume", resume.id] : ["--resume"]),
  launch: ({ layout, model, effort, forwardedArgs, resumeArgs, environment }) => {
    // Claude Code does not know proxy model ids, so state the window it should assume.
    const window = modelContextWindow(model, environment.HOME)
    return {
      command: binary(environment, "TRELLAGE_CLAUDE_BIN", "claude"),
      args: [
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions",
        "--disallowedTools",
        "AskUserQuestion",
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--effort", effort] : []),
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
        ...(window ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(window) } : { CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1" }),
      },
    }
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
      resumeArgs: (resume) => (resume.kind === "continue" ? ["--continue"] : resume.id ? ["--resume", resume.id] : ["--resume"]),
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
  const valid = (effort: string | undefined) => (effort !== undefined && adapter.efforts.includes(effort) ? effort : undefined)
  if (harness === "pi") return { model: PI_DEFAULT_MODEL, effort: "medium" }
  if (harness === "copilot") {
    const settings = readStructured(path.join(home, ".copilot", "settings.json"), "json")
    return { model: text(settings.model), effort: valid(text(settings.effortLevel)) }
  }
  if (harness === "claude") {
    const settings = readStructured(path.join(home, ".claude", "settings.json"), "json")
    return { model: text(settings.model), effort: valid(text(settings.effortLevel)) }
  }
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
  pi: piAdapter,
  copilot: copilotAdapter,
  claude: claudeAdapter,
  codex: codexAdapter,
  grok: grokAdapter,
}

export const adapterFor = (harness: string): NativeAdapter => {
  const adapter = Object.hasOwn(adapters, harness) ? adapters[harness] : undefined
  if (!adapter) throw new NativeRunError("usage", `unknown harness ${harness}; supported: ${Object.keys(adapters).join(", ")}`)
  return adapter
}
