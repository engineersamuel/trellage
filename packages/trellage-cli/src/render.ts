import {
  isClaudeProfile,
  isCodexProfile,
  type ClaudeProfile,
  type CodexProfile,
  type Mcp,
  type Profile,
} from "./profile.js"
import type { ProfileLock } from "./lock.js"

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

const renderMcp = (mcp: Mcp): ReadonlyArray<string> => {
  const lines = [`[mcp_servers.${quoteKey(mcp.name)}]`]
  if (mcp.transport === "stdio") {
    lines.push(`command = ${quote(mcp.command)}`)
    if (mcp.args) lines.push(`args = ${array(mcp.args)}`)
    if (mcp.required !== undefined) lines.push(`required = ${String(mcp.required)}`)
    if (mcp.env) lines.push(`env = ${inline(mcp.env)}`)
    const forwarded = Object.keys(mcp.env_from_secret ?? {}).sort()
    if (forwarded.length > 0) lines.push(`env_vars = ${array(forwarded)}`)
  } else {
    lines.push(`url = ${quote(mcp.url)}`)
    if (mcp.required !== undefined) lines.push(`required = ${String(mcp.required)}`)
    if (mcp.bearer_token_env) lines.push(`bearer_token_env_var = ${quote(mcp.bearer_token_env)}`)
    if (mcp.headers) lines.push(`http_headers = ${inline(mcp.headers)}`)
    if (mcp.headers_from_secret) lines.push(`env_http_headers = ${inline(mcp.headers_from_secret)}`)
  }
  if (mcp.tools?.allow) lines.push(`enabled_tools = ${array(mcp.tools.allow)}`)
  if (mcp.tools?.deny) lines.push(`disabled_tools = ${array(mcp.tools.deny)}`)
  return lines
}

export const renderCodexConfig = (profile: Profile): string => {
  assertCodexProfile(profile)
  const codex = profile.harness.codex
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
  for (const mcp of profile.mcps) lines.push("", ...renderMcp(mcp))
  return `${lines.join("\n")}\n`
}

export interface MiseRenderOptions {
  readonly baseReference: string
  readonly imageTag: string
  readonly packageVersions?: Readonly<Record<string, string>>
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
"/usr/local/bin/trellage-codex-entry" = { source = "runtime-entry.sh", mode = "copy" }
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
"/usr/local/bin/trellage-copilot-entry" = { source = "runtime-copilot-entry.sh", mode = "copy" }
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

const renderClaudeMiseConfig = (profile: ClaudeProfile, lock: ProfileLock, options: MiseRenderOptions): string => {
  const harness = lock.packages.harness
  if (harness.kind !== "claude") throw new Error("profile and lock harness kinds do not match")
  return `min_version = "2026.6.14"

[tools]
node = "22.17.0"
python = "3.13.14"
"npm:@anthropic-ai/claude-code" = { version = ${quote(harness.version)}, npm_args = "--ignore-scripts=false" }
"npm:@playwright/mcp" = "0.0.78"

${renderBootstrap(profile, options)}

[dotfiles]
"/home/agent/.keep" = { source = "workspace.keep", mode = "copy" }
"/opt/trellage/hyperresearch-site" = { source = "hyperresearch-site", mode = "copy" }
"/usr/local/bin/hyperresearch" = { source = "hyperresearch-wrapper.sh", mode = "copy" }
"/usr/local/bin/hpr" = { source = "hyperresearch-wrapper.sh", mode = "copy" }
"/usr/local/share/trellage/claude-seed" = { source = "claude-seed", mode = "copy" }
"/ms-playwright/chromium-1228" = { source = "chromium-1228", mode = "copy" }
"/ms-playwright/chromium_headless_shell-1228" = { source = "chromium-headless-shell-1228", mode = "copy" }
"/usr/local/bin/obscura" = { source = "obscura/obscura", mode = "copy" }
"/usr/local/bin/obscura-worker" = { source = "obscura/obscura-worker", mode = "copy" }
"/usr/local/bin/trellage-claude-entry" = { source = "runtime-claude-entry.sh", mode = "copy" }
"/workspace/.keep" = { source = "workspace.keep", mode = "copy" }
${profile.harness.initial_prompt ? '"/usr/local/share/trellage/initial-prompt.md" = { source = "initial-prompt.md", mode = "copy" }' : ""}

${renderOci(
  profile,
  lock,
  options,
  [
    'CLAUDE_CONFIG_DIR = "/home/agent/.claude"',
    'PYTHONPATH = "/opt/trellage/hyperresearch-site"',
    'PLAYWRIGHT_BROWSERS_PATH = "/ms-playwright"',
  ],
  [
    '"dev.trellage.harness.kind" = "claude"',
    `"dev.trellage.claude.version" = ${quote(harness.version)}`,
    '"dev.trellage.hyperresearch.version" = "0.9.1"',
  ],
  "/home/agent/.cache",
)}`
}

export const renderMiseConfig = (profile: Profile, lock: ProfileLock, options: MiseRenderOptions): string =>
  isCodexProfile(profile)
    ? renderCodexMiseConfig(profile, lock, options)
    : isClaudeProfile(profile)
      ? renderClaudeMiseConfig(profile, lock, options)
      : renderCopilotMiseConfig(profile, lock, options)
