// A coordinator in the Claude Agent SDK: the factory's coordinator tools (Copilot SDK tool objects) are served to it
// by an in-process MCP server, and its Copilot permission handler gates Claude's built-in tools.
import { createSdkMcpServer, type CanUseTool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk"
import type { PermissionHandler, Tool } from "@github/copilot-sdk"
import { z } from "zod"

export const MCP_SERVER = "factory"
/** Prefix of the MCP server that carries a run's AG-UI client tools (its name changes with the tool set). */
export const CLIENT_SERVER = "ui"

/** The factory's or a client tool server's prefix, so the feed and UIs see the plain tool name. */
export const stripMcp = (name: string): string =>
  name.replace(new RegExp(`^mcp__(${MCP_SERVER}|${CLIENT_SERVER}-[0-9a-f]+)__`), "")

/** Copilot tool parameters (JSON Schema) as a Zod object the MCP server can serve. Unconvertible: any object. */
const toZod = (parameters: unknown): z.ZodObject => {
  try {
    const s = z.fromJSONSchema((parameters ?? { type: "object", properties: {} }) as never)
    return s instanceof z.ZodObject ? s : z.object({}).passthrough()
  } catch {
    return z.object({}).passthrough()
  }
}

/** The result of a Copilot tool handler as MCP tool content. */
const content = (v: unknown) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v ?? null) }],
})

/** Factory tools as one in-process MCP server; tool calls reach the same handlers a Copilot coordinator uses. */
/** What the MCP server needs from a Copilot tool; any Tool<T> fits. */
type ServedTool = Pick<Tool<never>, "name" | "description"> & {
  parameters?: unknown
  handler?: (args: never, invocation: never) => unknown
}

export const factoryMcpServer = (tools: readonly ServedTool[], name = MCP_SERVER) =>
  createSdkMcpServer({
    name,
    version: "1.0.0",
    tools: tools.map((t): SdkMcpToolDefinition => ({
      name: t.name,
      description: t.description ?? t.name,
      // The SDK accepts a Zod object here, though its type names a raw shape.
      inputSchema: toZod(t.parameters) as unknown as SdkMcpToolDefinition["inputSchema"],
      // Loaded up front, not behind ToolSearch: these are the coordinator's main tools.
      _meta: { "anthropic/alwaysLoad": true },
      handler: async (args: unknown, extra: unknown) => {
        // The tool_use id: a client tool waits for the browser's result under this id (see main.ts clientCalls).
        const meta = (extra as Record<string, Record<string, unknown> | undefined> | undefined)?.["_meta"]
        const toolCallId = String(meta?.["claudecode/toolUseId"] ?? "")
        try {
          return content(
            await t.handler?.(
              args as never,
              { sessionId: "claude", toolCallId, toolName: t.name, arguments: args } as never,
            ),
          )
        } catch (e) {
          return { ...content(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })), isError: true }
        }
      },
    })),
  })

/** Tool names as Claude sees them: mcp__factory__<name>. */
export const mcpToolNames = (tools: readonly ServedTool[]): string[] =>
  tools.map((t) => `mcp__${MCP_SERVER}__${t.name}`)

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

/**
 * A Copilot permission handler as Claude's canUseTool: Bash is a shell request, file edits are write requests,
 * the factory's own and the client tool MCP tools are always allowed (they hold their own gates), everything else is a read.
 */
export const gateFromPermissions =
  (permissions: PermissionHandler): CanUseTool =>
  async (toolName, input) => {
    if (stripMcp(toolName) !== toolName) return { behavior: "allow", updatedInput: input }
    const request =
      toolName === "Bash"
        ? { kind: "shell", fullCommandText: String(input.command ?? "") }
        : WRITE_TOOLS.has(toolName)
          ? { kind: "write", fileName: String(input.file_path ?? input.notebook_path ?? "") }
          : { kind: "read" }
    const r = (await permissions(request as never, { sessionId: "claude" } as never)) as
      | { kind?: string; feedback?: unknown; message?: unknown }
      | undefined
    return r?.kind === "reject" || r?.kind === "denied-by-rules" || r?.kind === "denied-interactively-by-user"
      ? { behavior: "deny", message: String(r.feedback ?? r.message ?? "Refused by the factory.") }
      : { behavior: "allow", updatedInput: input }
  }
