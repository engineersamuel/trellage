import path from "node:path"
import { fileURLToPath } from "node:url"
import type { McpConfig, McpServer } from "../mcp-config.ts"
import type { LaunchCommand, LaunchInput } from "./adapters.ts"
import { nativeMcpEnvironment, nativeMcpSupport } from "./mcp-render.ts"
import { prepareNodecodeMcp } from "./nodecode-mcp.ts"
import { expandMcpEnvironment } from "./mcp-stdio.ts"

export const mcpEnvironmentNames = (server: McpServer): string[] => {
  const values =
    server.type === "stdio"
      ? [server.command, ...server.args, ...Object.values(server.env)]
      : [server.url, ...Object.values(server.headers)]
  return [
    ...new Set(
      values.flatMap((value) => [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!)),
    ),
  ].sort()
}

/** Missing credentials and unsupported adapters omit just that server, never the harness launch. */
export const selectCommonMcp = (
  harness: string,
  config: McpConfig | undefined,
  environment: NodeJS.ProcessEnv,
): {
  mcp?: McpConfig
  warnings: string[]
} => {
  if (config === undefined) return { warnings: [] }
  const servers: Record<string, McpServer> = {}
  const warnings: string[] = []
  for (const [name, server] of Object.entries(config.servers).sort(([a], [b]) => a.localeCompare(b))) {
    if (!server.enabled) continue
    const unsupported =
      harness === "grok" && !/^[A-Za-z]/.test(name)
        ? "server names must begin with a letter"
        : nativeMcpSupport(harness, server)
    const missing = mcpEnvironmentNames(server).filter((variable) => !environment[variable])
    if (unsupported) warnings.push(`MCP ${name} unavailable for ${harness}: ${unsupported}; launching without it`)
    else if (missing.length) warnings.push(`MCP ${name} unavailable: set ${missing.join(", ")}; launching without it`)
    else {
      try {
        if (server.type !== "stdio") {
          const url = new URL(expandMcpEnvironment(server.url, environment))
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error()
          new Headers(
            Object.fromEntries(
              Object.entries(server.headers).map(([key, value]) => [key, expandMcpEnvironment(value, environment)]),
            ),
          )
        }
        servers[name] = server
      } catch {
        warnings.push(`MCP ${name} unavailable: invalid resolved URL or headers; launching without it`)
      }
    }
  }
  return { mcp: { servers }, warnings }
}

/** Nodecode shared configuration is reconciled inside the short preparation transaction. */
export const prepareMcpLaunch = async (input: LaunchInput, launch: LaunchCommand): Promise<LaunchCommand> => {
  const servers = input.plan.mcp?.servers ?? {}
  const env = nativeMcpEnvironment(input.plan.harness, servers, input.environment)
  if (input.plan.harness !== "nodecode") return { ...launch, env: { ...launch.env, ...env } }
  const stdio = Object.fromEntries(
    Object.entries(servers)
      .filter(([, server]) => server.type === "stdio")
      .map(([name]) => [
        name,
        {
          command: process.execPath,
          args: [
            fileURLToPath(new URL("./mcp-stdio.ts", import.meta.url)),
            path.join(input.layout.generationPath, "mcp-specs", `${name}.json`),
          ],
        },
      ]),
  )
  const prepared = await prepareNodecodeMcp(input.layout.ownerHome, servers, stdio, input.environment)
  return {
    ...launch,
    env: { ...launch.env, ...env },
    cleanup: async () => {
      try {
        await prepared.cleanup()
      } finally {
        await launch.cleanup?.()
      }
    },
  }
}
