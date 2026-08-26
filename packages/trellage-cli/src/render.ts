import {
  claudeGithubReleaseTools,
  claudeHasBeads,
  claudeHasCodexReviewer,
  claudeHasLefthook,
  claudeHasSerena,
  claudeHasWorktreeCli,
  claudePypiToolNames,
  isClaudeProfile,
  isCodexProfile,
  isPiProfile,
  isPrimeProfile,
  type ClaudeProfile,
  type CodexProfile,
  type Mcp,
  type PrimeProfile,
  type Profile,
} from "./profile.js"
import type { ProfileLock } from "./lock.js"
import type { RuntimeSupportSnapshot } from "./runtime-support.js"

const quote = (value: string): string => JSON.stringify(value)
const array = (values: ReadonlyArray<string>): string => `[${values.map(quote).join(", ")}]`
const inline = (values: Readonly<Record<string, string>>): string =>
  `{ ${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${quoteKey(key)} = ${quote(value)}`)
    .join(", ")} }`
const quoteKey = (key: string): string => (/^[A-Za-z0-9_]+$/.test(key) ? key : quote(key))

function assertCodexProfile(profile: Profile): asserts profile is CodexProfile {
  if (!isCodexProfile(profile)) throw new Error("Codex rendering does not support Copilot profiles")
}

const renderStdioMcp = (mcp: Mcp): ReadonlyArray<string> => {
  if (mcp.transport !== "stdio") return []
  const lines = [`command = ${quote(mcp.command)}`]
  if (mcp.args) lines.push(`args = ${array(mcp.args)}`)
  if (mcp.required !== undefined) lines.push(`required = ${String(mcp.required)}`)
  if (mcp.env) lines.push(`env = ${inline(mcp.env)}`)
  const forwarded = Object.keys(mcp.env_from_secret ?? {}).sort()
  if (forwarded.length > 0) lines.push(`env_vars = ${array(forwarded)}`)
  return lines
}

const renderHttpMcp = (mcp: Mcp): ReadonlyArray<string> => {
  if (mcp.transport !== "http") return []
  const lines = [`url = ${quote(mcp.url)}`]
  if (mcp.required !== undefined) lines.push(`required = ${String(mcp.required)}`)
  if (mcp.bearer_token_env) lines.push(`bearer_token_env_var = ${quote(mcp.bearer_token_env)}`)
  if (mcp.headers) lines.push(`http_headers = ${inline(mcp.headers)}`)
  if (mcp.headers_from_secret) lines.push(`env_http_headers = ${inline(mcp.headers_from_secret)}`)
  return lines
}

const renderMcpTools = (mcp: Mcp): ReadonlyArray<string> => {
  const lines: Array<string> = []
  if (mcp.tools?.allow) lines.push(`enabled_tools = ${array(mcp.tools.allow)}`)
  if (mcp.tools?.deny) lines.push(`disabled_tools = ${array(mcp.tools.deny)}`)
  return lines
}

const renderMcp = (mcp: Mcp): ReadonlyArray<string> => [
  `[mcp_servers.${quoteKey(mcp.name)}]`,
  ...renderStdioMcp(mcp),
  ...renderHttpMcp(mcp),
  ...renderMcpTools(mcp),
]

export const renderCodexConfig = (profile: Profile): string => {
  assertCodexProfile(profile)
  return renderCodexConfiguration(profile.harness.codex, profile.mcps)
}

export const renderCodexConfiguration = (codex: CodexProfile["harness"]["codex"], mcps: ReadonlyArray<Mcp>): string => {
  const lines = [
    `model = ${quote(codex.model)}`,
    `model_provider = ${quote(codex.model_provider)}`,
    `model_reasoning_effort = ${quote(codex.reasoning_effort)}`,
  ]
  for (const [providerName, provider] of Object.entries(codex.providers)) {
    lines.push("", `[model_providers.${quoteKey(providerName)}]`)
    if (provider.name) lines.push(`name = ${quote(provider.name)}`)
    lines.push(`base_url = ${quote(provider.base_url)}`, `wire_api = ${quote(provider.wire_api)}`)
    if (provider.request_max_retries !== undefined) lines.push(`request_max_retries = ${provider.request_max_retries}`)
    if (provider.stream_max_retries !== undefined) lines.push(`stream_max_retries = ${provider.stream_max_retries}`)
    if (provider.stream_idle_timeout_ms !== undefined)
      lines.push(`stream_idle_timeout_ms = ${provider.stream_idle_timeout_ms}`)
  }
  for (const mcp of mcps) lines.push("", ...renderMcp(mcp))
  return `${lines.join("\n")}\n`
}

export interface MiseRenderOptions {
  readonly baseReference: string
  readonly imageTag: string
  readonly runtimeSupport: RuntimeSupportSnapshot
  readonly packageVersions?: Readonly<Record<string, string>>
}

const renderRuntimeDotfile = (options: MiseRenderOptions, role: string): string => {
  const file = options.runtimeSupport.files.find((candidate) => candidate.role === role)
  if (file === undefined || file.mode !== 0o755) throw new Error(`runtime support is missing executable ${role}`)
  return `${quote(file.destination)} = { source = ${quote(file.buildContextPath)}, mode = "copy" }`
}

const renderPackages = (profile: Profile, options: MiseRenderOptions): string =>
  profile.image.packages
    .map((name) => `${quote(`apt:${name}`)} = ${quote(options.packageVersions?.[name] ?? "*")}`)
    .join("\n")

const renderBootstrap = (profile: Profile, options: MiseRenderOptions): string => `[bootstrap.packages]
${renderPackages(profile, options)}`

const renderOci = (
  profile: Profile,
  lock: ProfileLock,
  options: MiseRenderOptions,
  environment: ReadonlyArray<string>,
  labels: ReadonlyArray<string>,
  cacheHome = "/tmp/.cache",
): string => `[oci]
from = ${quote(options.baseReference)}
tag = ${quote(options.imageTag)}
workdir = "/workspace"
cmd = [${quote(profile.image.shell)}, "-l"]
user = "10001:10001"
user_id = 10001
group_id = 10001

[oci.env]
HOME = "/home/agent"
${environment.join("\n")}
XDG_CACHE_HOME = ${quote(cacheHome)}
TMPDIR = "/tmp"

[oci.labels]
"dev.trellage.prototype" = "trellage"
"dev.trellage.profile" = ${quote(profile.name)}
"dev.trellage.profile.hash" = ${quote(lock.profile_hash)}
"dev.trellage.platform" = ${quote(lock.platform)}
"dev.trellage.runtime.hash" = ${quote(options.runtimeSupport.hash)}
${labels.join("\n")}
`

const renderCodexMiseConfig = (profile: CodexProfile, lock: ProfileLock, options: MiseRenderOptions): string => {
  const harness = lock.packages.harness
  if (harness.kind !== "codex") throw new Error("profile and lock harness kinds do not match")
  return `min_version = "2026.6.14"

[tools."http:codex"]
version = ${quote(harness.version)}
url = ${quote(harness.url)}
checksum = ${quote(harness.integrity)}
size = ${quote(String(harness.size))}
rename_exe = "codex"

${renderBootstrap(profile, options)}

[dotfiles]
"/home/agent/.codex/config.toml" = { source = "codex-config.toml", mode = "copy" }
"/home/agent/.codex/skills" = { source = "assets/skills", mode = "copy" }
"/home/agent/.codex/agents" = { source = "assets/agents", mode = "copy" }
${profile.skill_bundles.length > 0 ? '"/home/agent/.codex/AGENTS.md" = { source = "assets/AGENTS.md", mode = "copy" }' : ""}
${renderRuntimeDotfile(options, "runtime-entry")}
"/workspace/.keep" = { source = "workspace.keep", mode = "copy" }
${profile.harness.initial_prompt ? '"/usr/local/share/trellage/initial-prompt.md" = { source = "initial-prompt.md", mode = "copy" }' : ""}

${renderOci(
  profile,
  lock,
  options,
  ['CODEX_HOME = "/home/agent/.codex"'],
  [`"dev.trellage.codex.version" = ${quote(harness.version)}`],
)}`
}

const renderCopilotMiseConfig = (profile: Profile, lock: ProfileLock, options: MiseRenderOptions): string => {
  const harness = lock.packages.harness
  if (profile.harness.kind !== "copilot" || harness.kind !== "copilot") {
    throw new Error("profile and lock harness kinds do not match")
  }
  return `min_version = "2026.6.14"

[tools."http:copilot"]
version = ${quote(harness.version)}
url = ${quote(harness.url)}
checksum = ${quote(harness.integrity)}
size = ${quote(String(harness.size))}
rename_exe = "copilot"

${renderBootstrap(profile, options)}

[dotfiles]
"/home/agent/.keep" = { source = "workspace.keep", mode = "copy" }
"/usr/local/share/trellage/copilot-seed" = { source = "copilot-seed", mode = "copy" }
${renderRuntimeDotfile(options, "runtime-copilot-entry")}
"/workspace/.keep" = { source = "workspace.keep", mode = "copy" }
${profile.harness.initial_prompt ? '"/usr/local/share/trellage/initial-prompt.md" = { source = "initial-prompt.md", mode = "copy" }' : ""}

${renderOci(
  profile,
  lock,
  options,
  ['COPILOT_HOME = "/home/agent/.copilot"', 'COPILOT_AUTO_UPDATE = "false"'],
  ['"dev.trellage.harness.kind" = "copilot"', `"dev.trellage.copilot.version" = ${quote(harness.version)}`],
  "/home/agent/.cache",
)}`
}

const optionalMiseLines = (lines: ReadonlyArray<string>): string => (lines.length === 0 ? "" : `${lines.join("\n")}\n`)

const claudeMiseTools = (profile: ClaudeProfile, hyperresearch: boolean, extraPython: boolean): string => {
  const tools: Array<string> = []
  if (hyperresearch || extraPython) tools.push('python = "3.13.14"')
  if (hyperresearch) tools.push('"npm:@playwright/mcp" = "0.0.78"')
  if (claudeHasSerena(profile)) tools.push('uv = "0.11.21"')
  return tools.join("\n")
}

const claudePypiBinDotfiles = (profile: ClaudeProfile): ReadonlyArray<string> =>
  claudePypiToolNames(profile).flatMap((name) => {
    const aliases =
      name === "serena-agent" ? ["serena-agent", "serena"] : name === "waku-agent" ? ["waku-agent", "waku"] : [name]
    return aliases.map(
      (alias) => `"${`/usr/local/bin/${alias}`}" = { source = "graph-tool-wrapper.sh", mode = "copy" }`,
    )
  })

const claudeDotfilesBeforeSeed = (profile: ClaudeProfile): ReadonlyArray<string> => {
  const hyperresearch = profile.plugins[0]?.adapter === "hyperresearch"
  const lines: Array<string> = []
  if (hyperresearch) {
    lines.push(
      '"/opt/trellage/hyperresearch-site" = { source = "hyperresearch-site", mode = "copy" }',
      '"/usr/local/bin/hyperresearch" = { source = "hyperresearch-wrapper.sh", mode = "copy" }',
      '"/usr/local/bin/hpr" = { source = "hyperresearch-wrapper.sh", mode = "copy" }',
    )
  }
  if (claudePypiToolNames(profile).length > 0) {
    lines.push('"/opt/trellage/graph-tools" = { source = "graph-tools-site", mode = "copy" }')
  }
  lines.push(...claudePypiBinDotfiles(profile))
  for (const tool of claudeGithubReleaseTools(profile)) {
    if (tool.name === "lefthook-linux-arm64") {
      lines.push(
        '"/usr/local/lib/trellage/node_modules/lefthook-linux-arm64" = { source = "lefthook-linux-arm64", mode = "copy" }',
      )
    } else {
      lines.push(`"${`/usr/local/bin/${tool.name}`}" = { source = ${quote(`binaries/${tool.name}`)}, mode = "copy" }`)
    }
  }
  if (claudeHasWorktreeCli(profile)) lines.push('"/usr/local/bin/wt" = { source = "wt-wrapper.sh", mode = "copy" }')
  if (claudeHasCodexReviewer(profile)) {
    lines.push(
      '"/home/agent/.codex/config.toml" = { source = "codex-reviewer-config.toml", mode = "copy" }',
      '"/usr/local/share/trellage/codex-reviewer-config.toml" = { source = "codex-reviewer-config.toml", mode = "copy" }',
      '"/usr/local/bin/codex-code-mode-host" = { source = "binaries/codex-code-mode-host", mode = "copy" }',
    )
    if (claudeHasBeads(profile)) {
      lines.push(
        '"/etc/codex/skills/graph-of-loops/SKILL.md" = { source = "codex-graph-of-loops-skill.md", mode = "copy" }',
        '"/etc/codex/skills/graph-of-loops/agents/openai.yaml" = { source = "codex-graph-of-loops-skill.yaml", mode = "copy" }',
      )
    }
  }
  if (profile.mcps.length > 0) {
    lines.push('"/usr/local/share/trellage/claude-mcp.json" = { source = "claude-mcp.json", mode = "copy" }')
  }
  return lines
}

const claudeDotfilesAfterSeed = (profile: ClaudeProfile): ReadonlyArray<string> =>
  profile.plugins[0]?.adapter === "hyperresearch"
    ? [
        '"/ms-playwright/chromium-1228" = { source = "chromium-1228", mode = "copy" }',
        '"/ms-playwright/chromium_headless_shell-1228" = { source = "chromium-headless-shell-1228", mode = "copy" }',
        '"/usr/local/bin/obscura" = { source = "obscura/obscura", mode = "copy" }',
        '"/usr/local/bin/obscura-worker" = { source = "obscura/obscura-worker", mode = "copy" }',
      ]
    : []

const claudeMiseEnvironment = (profile: ClaudeProfile): ReadonlyArray<string> => {
  const hyperresearch = profile.plugins[0]?.adapter === "hyperresearch"
  const extraPython = claudePypiToolNames(profile).length > 0
  if (hyperresearch) {
    return [
      'CLAUDE_CONFIG_DIR = "/home/agent/.claude"',
      'TRELLAGE_CLAUDE_RUNTIME_MODE = "hyperresearch"',
      'PYTHONPATH = "/opt/trellage/hyperresearch-site"',
      'PLAYWRIGHT_BROWSERS_PATH = "/ms-playwright"',
    ]
  }
  return [
    'CLAUDE_CONFIG_DIR = "/home/agent/.claude"',
    'TRELLAGE_CLAUDE_RUNTIME_MODE = "native-plugin"',
    ...(claudeHasCodexReviewer(profile)
      ? [
          'CODEX_HOME = "/home/agent/.codex"',
          'TRELLAGE_CODEX_REVIEWER_CONFIG = "/usr/local/share/trellage/codex-reviewer-config.toml"',
        ]
      : []),
    ...(claudeHasBeads(profile) ? ['BD_DISABLE_METRICS = "1"', 'BD_DISABLE_EVENT_FLUSH = "1"'] : []),
    ...(claudeHasLefthook(profile) ? ['NODE_PATH = "/usr/local/lib/trellage/node_modules"'] : []),
    ...(extraPython ? ['PYTHONPATH = "/opt/trellage/graph-tools"'] : []),
  ]
}

const claudeMiseLabels = (profile: ClaudeProfile, version: string): ReadonlyArray<string> => [
  '"dev.trellage.harness.kind" = "claude"',
  `"dev.trellage.claude.version" = ${quote(version)}`,
  ...(profile.plugins[0]?.adapter === "hyperresearch" ? ['"dev.trellage.hyperresearch.version" = "0.9.1"'] : []),
]

const renderClaudeMiseConfig = (profile: ClaudeProfile, lock: ProfileLock, options: MiseRenderOptions): string => {
  const harness = lock.packages.harness
  if (harness.kind !== "claude") throw new Error("profile and lock harness kinds do not match")
  const hyperresearch = profile.plugins[0]?.adapter === "hyperresearch"
  const extraPython = claudePypiToolNames(profile).length > 0
  return `min_version = "2026.6.14"

[tools]
node = "22.17.0"
${claudeMiseTools(profile, hyperresearch, extraPython)}

[tools."http:claude"]
version = ${quote(harness.version)}
url = ${quote(harness.url)}
checksum = ${quote(harness.integrity)}
size = ${quote(String(harness.size))}
rename_exe = "claude"

${renderBootstrap(profile, options)}

[dotfiles]
"/home/agent/.keep" = { source = "workspace.keep", mode = "copy" }
${optionalMiseLines(claudeDotfilesBeforeSeed(profile))}"/usr/local/share/trellage/claude-seed" = { source = "claude-seed", mode = "copy" }
${optionalMiseLines(claudeDotfilesAfterSeed(profile))}${renderRuntimeDotfile(options, "runtime-claude-entry")}
"/workspace/.keep" = { source = "workspace.keep", mode = "copy" }
${profile.harness.initial_prompt ? '"/usr/local/share/trellage/initial-prompt.md" = { source = "initial-prompt.md", mode = "copy" }' : ""}

${renderOci(profile, lock, options, claudeMiseEnvironment(profile), claudeMiseLabels(profile, harness.version), "/home/agent/.cache")}
`
}

const renderPiMiseConfig = (profile: Profile, lock: ProfileLock, options: MiseRenderOptions): string => {
  const harness = lock.packages.harness
  if (profile.harness.kind !== "pi" || harness.kind !== "pi") {
    throw new Error("profile and lock harness kinds do not match")
  }
  return `min_version = "2026.6.14"

[tools."http:pi"]
version = ${quote(harness.version)}
url = ${quote(harness.url)}
checksum = ${quote(harness.integrity)}
size = ${quote(String(harness.size))}
rename_exe = "omp"

${renderBootstrap(profile, options)}

[dotfiles]
"/home/agent/.keep" = { source = "workspace.keep", mode = "copy" }
"/usr/local/share/trellage/pi-config.yml" = { source = "pi-config.yml", mode = "copy" }
"/usr/local/share/trellage/pi-seed" = { source = "pi-seed", mode = "copy" }
${renderRuntimeDotfile(options, "runtime-pi-entry")}
"/workspace/.keep" = { source = "workspace.keep", mode = "copy" }
${profile.harness.initial_prompt ? '"/usr/local/share/trellage/initial-prompt.md" = { source = "initial-prompt.md", mode = "copy" }' : ""}

${renderOci(
  profile,
  lock,
  options,
  ['PI_CODING_AGENT_DIR = "/home/agent/.omp/agent"', 'OMP_SKIP_SETUP = "1"'],
  [
    '"dev.trellage.harness.kind" = "pi"',
    '"dev.trellage.pi.implementation" = "oh-my-pi"',
    `"dev.trellage.pi.version" = ${quote(harness.version)}`,
  ],
  "/home/agent/.cache",
)}`
}

const renderPrimeMiseConfig = (profile: PrimeProfile, lock: ProfileLock, options: MiseRenderOptions): string => {
  const harness = lock.packages.harness
  if (harness.kind !== "prime") throw new Error("profile and lock harness kinds do not match")
  return `min_version = "2026.6.14"

[tools]
node = "22.17.0"

${renderBootstrap(profile, options)}

[dotfiles]
"/home/agent/.keep" = { source = "workspace.keep", mode = "copy" }
"/usr/local/lib/node_modules" = { source = "prime-agent-prefix/lib/node_modules", mode = "copy" }
"/usr/local/bin/prime-agent" = { source = "prime-agent-wrapper.sh", mode = "copy" }
"/usr/local/share/trellage/prime-kernel-seed.tar.gz" = { source = "prime-kernel-seed.tar.gz", mode = "copy" }
"/usr/local/share/trellage/prime-seed" = { source = "prime-seed", mode = "copy" }
${renderRuntimeDotfile(options, "runtime-prime-entry")}
"/workspace/.keep" = { source = "workspace.keep", mode = "copy" }
${profile.harness.initial_prompt ? '"/usr/local/share/trellage/initial-prompt.md" = { source = "initial-prompt.md", mode = "copy" }' : ""}

${renderOci(
  profile,
  lock,
  options,
  [
    'PRIME_AGENT_CODING_AGENT_DIR = "/home/agent/.prime/agent"',
    'PI_OFFLINE = "1"',
    'PI_SKIP_VERSION_CHECK = "1"',
    'PRIME_AGENT_INSTALL_UV = "0"',
    'PRIME_AGENT_KERNEL_PYTHON = "/home/agent/.trellage/prime-kernel/.prime/agent/kernel-venv/bin/python"',
  ],
  ['"dev.trellage.harness.kind" = "prime"', `"dev.trellage.prime.version" = ${quote(harness.version)}`],
  "/home/agent/.cache",
)}`
}

export const renderMiseConfig = (profile: Profile, lock: ProfileLock, options: MiseRenderOptions): string =>
  isCodexProfile(profile)
    ? renderCodexMiseConfig(profile, lock, options)
    : isClaudeProfile(profile)
      ? renderClaudeMiseConfig(profile, lock, options)
      : isPiProfile(profile)
        ? renderPiMiseConfig(profile, lock, options)
        : isPrimeProfile(profile)
          ? renderPrimeMiseConfig(profile, lock, options)
          : renderCopilotMiseConfig(profile, lock, options)
