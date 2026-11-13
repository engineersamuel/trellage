// MCP servers a step asks for (`mcp = [...]` in its front matter), rendered for each worker SDK.
// Keys come from the process environment, then the private Trellage env file; a server whose required key is
// missing is left out and named in the task, so the worker uses its fallback instead of failing.
import { lstatSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseEnv } from "node:util"

/** A server ready to start: every value resolved. */
export type McpServer =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { type: "http"; url: string; headers: Record<string, string> }

/** perplexity_research can run for minutes; one tool call may take up to this long. */
export const MCP_TIMEOUT_MS = 600_000

/** A value from the process environment, then from ~/.config/trellage/.env.local or .env (owner-only files). */
export const userEnv = (name: string, env = process.env): string | undefined => {
  if (env[name]?.trim()) return env[name]!.trim()
  const dir = env.XDG_CONFIG_HOME
    ? path.join(env.XDG_CONFIG_HOME, "trellage")
    : path.join(env.HOME ?? "", ".config", "trellage")
  for (const file of [".env.local", ".env"].map((f) => path.join(dir, f))) {
    try {
      const st = lstatSync(file)
      if (!st.isFile() || (st.mode & 0o077) !== 0) continue
      const v = parseEnv(readFileSync(file, "utf8"))[name]?.trim()
      if (v) return v
    } catch {}
  }
  return undefined
}

type Known = { required?: string; build: (key: (n: string) => string | undefined) => McpServer }

/** Servers a step may name. Exa's hosted endpoint needs no key: it is the web search fallback. */
const KNOWN: Record<string, Known> = {
  perplexity: {
    required: "PERPLEXITY_API_KEY",
    build: (key) => ({
      type: "stdio",
      command: "npx",
      // Pinned: the package fixes the Agent API preset behind each tool.
      args: ["-y", "@perplexity-ai/mcp-server@1.3.0"],
      env: {
        PERPLEXITY_API_KEY: key("PERPLEXITY_API_KEY")!,
        PERPLEXITY_TIMEOUT_MS: String(MCP_TIMEOUT_MS),
      },
    }),
  },
  context7: {
    build: (key): McpServer => {
      const k = key("CONTEXT7_API_KEY")
      return {
        type: "http",
        url: "https://mcp.context7.com/mcp",
        headers: k ? { CONTEXT7_API_KEY: k } : {},
      }
    },
  },
  exa: { build: () => ({ type: "http", url: "https://mcp.exa.ai/mcp", headers: {} }) },
}

export type StepMcp = {
  servers: Record<string, McpServer>
  missing: { name: string; reason: string }[]
}

/** Resolve the servers a step names. Unknown names fail loudly; a missing key only leaves that server out. */
export const stepMcp = (names: readonly string[], env = process.env): StepMcp => {
  const servers: Record<string, McpServer> = {}
  const missing: StepMcp["missing"] = []
  for (const name of names) {
    const known = KNOWN[name]
    if (!known) throw new Error(`unknown MCP server ${name}; one of ${Object.keys(KNOWN).join(", ")}`)
    if (known.required && !userEnv(known.required, env)) {
      missing.push({ name, reason: `no ${known.required}` })
      continue
    }
    servers[name] = known.build((n) => userEnv(n, env))
  }
  return { servers, missing }
}

/** The line added to the task, so the worker knows which tools it has before it plans. */
export const mcpNote = ({ servers, missing }: StepMcp): string =>
  [
    Object.keys(servers).length ? `MCP servers for this task: ${Object.keys(servers).join(", ")}.` : "",
    ...missing.map((m) => `MCP server ${m.name} is unavailable (${m.reason}); use the fallback.`),
  ]
    .filter(Boolean)
    .join(" ")

/** npx and the server need PATH and HOME; the SDKs do not all pass the parent's environment to stdio servers. */
const baseEnv = (): Record<string, string> =>
  Object.fromEntries(["PATH", "HOME"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])))

/** Copilot SDK `mcpServers`. */
export const copilotMcp = (servers: Record<string, McpServer>) =>
  Object.fromEntries(
    Object.entries(servers).map(([name, s]) => [
      name,
      s.type === "stdio"
        ? {
            type: "local" as const,
            command: s.command,
            args: s.args,
            env: { ...baseEnv(), ...s.env },
            tools: ["*"],
            timeout: MCP_TIMEOUT_MS,
          }
        : {
            type: "http" as const,
            url: s.url,
            headers: s.headers,
            tools: ["*"],
            timeout: MCP_TIMEOUT_MS,
          },
    ]),
  )

/** Name of the env variable that carries one secret value of a server to the Claude CLI. */
const claudeVar = (server: string, key: string) => `SF_MCP_${server}_${key}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_")

/**
 * Claude Agent SDK `mcpServers`, and the env that carries the values. The SDK passes `mcpServers` to the CLI as
 * `--mcp-config <json>` on the command line, which `ps` shows; so the config holds only `${VAR}` references
 * (Claude Code expands them) and the values travel in the CLI's environment.
 */
export const claudeMcp = (servers: Record<string, McpServer>) => {
  const env: Record<string, string> = {}
  const refs = (server: string, values: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(values).map(([k, v]) => {
        const name = claudeVar(server, k)
        env[name] = v
        return [k, `\${${name}}`]
      }),
    )
  const config = Object.fromEntries(
    Object.entries(servers).map(([name, s]) => [
      name,
      s.type === "stdio"
        ? {
            type: "stdio" as const,
            command: s.command,
            args: s.args,
            env: { ...baseEnv(), ...refs(name, s.env) },
            timeout: MCP_TIMEOUT_MS,
          }
        : { type: "http" as const, url: s.url, headers: refs(name, s.headers), timeout: MCP_TIMEOUT_MS },
    ]),
  )
  return { config, env }
}

/** Pi reads `${NAME}`, `$$`, `$!` and a leading `!` in config values; keep resolved values literal. */
export const piLiteral = (v: string): string => {
  const escaped = v.replaceAll("$", "$$$$")
  return escaped.startsWith("!") ? `$${escaped}` : escaped
}
const piValues = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, piLiteral(v)]))

/** Pi MCP extension entries. `direct`: the model sees the tools, as in the other SDKs (Pi's default hides them in codemode). */
export const piMcp = (servers: Record<string, McpServer>) =>
  Object.entries(servers).map(([name, s]) => ({
    name,
    source: "factory",
    scope: "extension" as const,
    config: {
      exposure: "direct" as const,
      timeout: MCP_TIMEOUT_MS / 1000,
      ...(s.type === "stdio"
        ? {
            type: "stdio" as const,
            command: s.command,
            args: s.args,
            env: piValues({ ...baseEnv(), ...s.env }),
          }
        : { type: "http" as const, url: s.url, headers: piValues(s.headers) }),
    },
  }))

/** A Perplexity tool, in each SDK's naming: perplexity-perplexity_search, mcp__perplexity__perplexity_research, ... */
const PERPLEXITY_TOOL = /perplexity[_-]+perplexity_(search|ask|reason|research)$/

/** "research" for perplexity_research, "other" for the other Perplexity tools, null for any other tool. */
export const perplexityTool = (toolName: string): "research" | "other" | null => {
  const m = PERPLEXITY_TOOL.exec(toolName)
  return m ? (m[1] === "research" ? "research" : "other") : null
}

/** Why one more call of this kind is over the budget, or null. */
export const mcpBudgetReason = (
  s: { max: number; maxResearch: number; calls: number; research: number },
  kind: "research" | "other",
): string | null =>
  s.calls >= s.max || (kind === "research" && s.research >= s.maxResearch)
    ? `Perplexity budget used (${s.calls}/${s.max} calls, ${s.research}/${s.maxResearch} perplexity_research). Use the fallback: Exa or built-in web search.`
    : null

/**
 * Per-worker hard limit on Perplexity calls, subagents included. Returns why a call is refused, or null and counts it.
 * The skill's fallback table treats a refusal as a failed tool, so the worker moves to Exa or built-in search.
 */
export const perplexityBudget = (max: number, maxResearch: number) => {
  const s = { max, maxResearch, calls: 0, research: 0 }
  return (toolName: string): string | null => {
    const kind = perplexityTool(toolName)
    if (!kind) return null
    const reason = mcpBudgetReason(s, kind)
    if (reason) return reason
    s.calls++
    if (kind === "research") s.research++
    return null
  }
}
