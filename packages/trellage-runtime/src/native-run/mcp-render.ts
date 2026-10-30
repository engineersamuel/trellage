import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseToml, stringify as stringifyToml } from "smol-toml"
import type { McpServer } from "../mcp-config.ts"
import { expandMcpEnvironment } from "./mcp-stdio.ts"

type Servers = Readonly<Record<string, McpServer>>
type NativeEntry = Record<string, unknown>
const references = (value: string): string[] =>
  [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!)
const active = (servers: Servers) => Object.entries(servers).filter(([, server]) => server.enabled)
const standard = new Set(["claude", "copilot", "codex", "jcode", "grok", "pi", "nodecode"])
const alias = (name: string, header: string): string =>
  `TRX_MCP_HEADER_${createHash("sha256")
    .update(JSON.stringify([name, header]))
    .digest("hex")
    .slice(0, 24)
    .toUpperCase()}`

/** No fallback to a host configuration: an unverified route is an explicit launch warning. */
export const nativeMcpSupport = (harness: string, server: McpServer): string | undefined => {
  if (!standard.has(harness)) return "no isolated MCP configuration route has been verified for this harness"
  if (server.type === "sse" && ["codex", "pi", "nodecode"].includes(harness))
    return "legacy SSE transport is not supported; use a streamable HTTP endpoint"
  if (harness === "nodecode" && server.type === "http" && Object.keys(server.headers).length > 0)
    return "HTTP headers require gateway-scoped authentication support; use a stdio MCP server instead"
  if (server.type !== "stdio" && references(server.url).length > 0)
    return "environment references in MCP URLs are not supported; use an authentication header instead"
  return undefined
}

/** Preserve the operator's environment through harness-specific authentication sanitization. */
export const nativeMcpStdioAlias = (variable: string): string => `TRX_MCP_ENV_${variable}`

const referencedEnvironment = (server: Extract<McpServer, { type: "stdio" }>): string[] =>
  [...new Set([server.command, ...server.args, ...Object.values(server.env)].flatMap(references))].sort()

const stdioEntry = (
  generationPath: string,
  name: string,
  server: Extract<McpServer, { type: "stdio" }>,
  harness: string,
): NativeEntry => {
  const variables = referencedEnvironment(server).map(nativeMcpStdioAlias)
  return {
    ...(harness === "copilot" ? { type: "local", tools: ["*"] } : {}),
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./mcp-stdio.ts", import.meta.url)),
      path.join(generationPath, "mcp-specs", `${name}.json`),
    ],
    ...(harness === "codex"
      ? variables.length > 0
        ? { env_vars: variables }
        : {}
      : variables.length > 0
        ? { env: Object.fromEntries(variables.map((variable) => [variable, `\${${variable}}`])) }
        : {}),
  }
}

const headerNeedsAlias = (harness: string, value: string): boolean =>
  references(value).length > 0 || (harness === "pi" && (value.includes("$") || value.startsWith("!")))

const remoteEntry = (name: string, server: Exclude<McpServer, { type: "stdio" }>, harness: string): NativeEntry => {
  if (harness === "codex") {
    const literals = Object.fromEntries(
      Object.entries(server.headers).filter(([, value]) => !headerNeedsAlias(harness, value)),
    )
    const variables = Object.fromEntries(
      Object.entries(server.headers)
        .filter(([, value]) => headerNeedsAlias(harness, value))
        .map(([header]) => [header, alias(name, header)]),
    )
    return {
      url: server.url,
      ...(Object.keys(literals).length > 0 ? { http_headers: literals } : {}),
      ...(Object.keys(variables).length > 0 ? { env_http_headers: variables } : {}),
    }
  }
  return {
    type: server.type,
    url: server.url,
    ...(harness === "copilot" ? { tools: ["*"] } : {}),
    ...(Object.keys(server.headers).length === 0
      ? {}
      : {
          headers: Object.fromEntries(
            Object.entries(server.headers).map(([header, value]) => [
              header,
              headerNeedsAlias(harness, value) ? `\${${alias(name, header)}}` : value,
            ]),
          ),
        }),
  }
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)

const readOptional = async (file: string): Promise<string | undefined> =>
  readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })

/** Merge only the generated destination. Do not replace a plugin/unowned MCP with the same name. */
const mergeServers = (
  config: Record<string, unknown>,
  key: string,
  servers: Record<string, NativeEntry>,
): Record<string, unknown> => {
  const previous = config[key] ?? {}
  if (!plainObject(previous)) throw new Error("invalid generated MCP configuration")
  for (const name of Object.keys(servers)) {
    if (Object.hasOwn(previous, name) && JSON.stringify(previous[name]) !== JSON.stringify(servers[name]))
      throw new Error(`MCP configuration collision: ${name}`)
  }
  return { ...config, [key]: { ...previous, ...servers } }
}

/** Render only declarative definitions. Credential values are supplied in the child environment at launch. */
export const writeNativeMcpFiles = async (
  stage: string,
  generationPath: string,
  harness: string,
  servers: Servers,
): Promise<void> => {
  const selected = active(servers).filter(([, server]) => nativeMcpSupport(harness, server) === undefined)
  if (selected.length === 0) return
  await mkdir(stage, { recursive: true, mode: 0o700 })
  const entries: Record<string, NativeEntry> = {}
  for (const [name, server] of selected) {
    // Server names are validated by the common config schema; keep this exported file boundary safe too.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("invalid MCP server name")
    if (server.type === "stdio") {
      const directory = path.join(stage, "mcp-specs")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(path.join(directory, `${name}.json`), `${JSON.stringify(server, null, 2)}\n`, { mode: 0o600 })
      entries[name] = stdioEntry(generationPath, name, server, harness)
    } else entries[name] = remoteEntry(name, server, harness)
  }
  // Nodecode's persistent config is reconciled behind its composition guard; the specs above are immutable.
  if (harness === "nodecode") return
  if (harness === "codex" || harness === "grok") {
    const file = path.join(stage, "config.toml")
    const previous = parseToml((await readOptional(file)) ?? "")
    const merged = mergeServers(previous, "mcp_servers", entries)
    await writeFile(file, stringifyToml(merged as Parameters<typeof stringifyToml>[0]), {
      mode: 0o600,
    })
    await chmod(file, 0o600)
    return
  }
  const file = path.join(stage, harness === "claude" || harness === "copilot" ? "mcp-config.json" : "mcp.json")
  const text = await readOptional(file)
  const previous: unknown = text === undefined ? {} : JSON.parse(text)
  if (!plainObject(previous)) throw new Error("invalid generated MCP configuration")
  await writeFile(file, `${JSON.stringify(mergeServers(previous, "mcpServers", entries), null, 2)}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
}

/** Prepend these before forwarded arguments, never pass a credential-bearing JSON string on the command line. */
export const nativeMcpArgs = (harness: string, generationPath: string, servers: Servers): string[] => {
  if (!active(servers).some(([, server]) => nativeMcpSupport(harness, server) === undefined)) return []
  if (harness === "claude") return ["--mcp-config", path.join(generationPath, "mcp-config.json")]
  if (harness === "pi") return ["--extension", "builtin:mcp"]
  return []
}

/** Values exist only in the launch environment; aliases make compound headers work in Codex too. */
export const nativeMcpEnvironment = (
  harness: string,
  servers: Servers,
  environment: NodeJS.ProcessEnv,
): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [name, server] of active(servers)) {
    if (nativeMcpSupport(harness, server) !== undefined) continue
    if (server.type === "stdio") {
      for (const variable of referencedEnvironment(server)) {
        const value = environment[variable]
        if (!value) throw new Error(`missing MCP environment variable ${variable}`)
        result[nativeMcpStdioAlias(variable)] = value
      }
      continue
    }
    if (harness === "nodecode") continue
    for (const [header, template] of Object.entries(server.headers)) {
      if (!headerNeedsAlias(harness, template)) continue
      const value = expandMcpEnvironment(template, environment)
      if (/[\r\n\0]/.test(value)) throw new Error("invalid MCP authentication header environment value")
      result[alias(name, header)] = value
    }
  }
  return result
}
