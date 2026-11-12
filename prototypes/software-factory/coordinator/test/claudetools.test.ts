import { expect, test } from "bun:test"
import { defineTool } from "@github/copilot-sdk"
import { factoryMcpServer, gateFromPermissions, mcpToolNames } from "../src/claudetools.ts"
import { claudeSessionId, workerHarness } from "../src/factory.ts"
import { toEvents } from "../src/claude.ts"

const echo = defineTool("sdlc_plan", {
  description: "d",
  parameters: {
    type: "object",
    properties: { request: { type: "string" }, criteria: { type: "array", items: { type: "string" } } },
    required: ["request"],
  },
  handler: async (a: unknown) => JSON.stringify({ got: a }),
})

test("factory tools are served over MCP with their JSON Schema and handlers", async () => {
  const server = factoryMcpServer([echo])
  expect(server.type).toBe("sdk")
  expect(mcpToolNames([echo])).toEqual(["mcp__factory__sdlc_plan"])
})

test("a Copilot permission handler gates Claude tools; factory MCP tools pass", async () => {
  const gate = gateFromPermissions(
    (r: { kind: string; fullCommandText?: string }) =>
      (r.kind === "write" || (r.kind === "shell" && r.fullCommandText?.includes("rm"))
        ? { kind: "reject", feedback: "no" }
        : { kind: "approve-once" }) as never,
  )
  const ask = (name: string, input: Record<string, unknown>) =>
    gate(name, input, { signal: new AbortController().signal } as Parameters<typeof gate>[2])
  expect(await ask("Write", { file_path: "a" })).toEqual({ behavior: "deny", message: "no" })
  expect(await ask("Bash", { command: "rm -rf x" })).toEqual({ behavior: "deny", message: "no" })
  expect(await ask("Bash", { command: "ls" })).toMatchObject({ behavior: "allow" })
  expect(await ask("mcp__factory__spawn_worker", { name: "x" })).toMatchObject({ behavior: "allow" })
})

test("forced Claude moves the sub-coordinator too; session ids are stable UUIDs; MCP prefix is stripped", () => {
  expect(workerHarness("claude", "coordinator", undefined, false, true)).toEqual({
    kind: "claude",
    profiles: ["default"],
  })
  expect(workerHarness("pi", "coordinator", undefined, false, true)).toBeUndefined()
  expect(workerHarness("auto", "coordinator", undefined, false, true)).toBeUndefined()
  expect(claudeSessionId("sf-sub-1")).toBe(claudeSessionId("sf-sub-1"))
  expect(claudeSessionId("sf-sub-1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  const m = {
    type: "assistant",
    uuid: "u",
    parent_tool_use_id: null,
    message: { id: "m", content: [{ type: "tool_use", id: "t", name: "mcp__factory__next_step", input: {} }] },
  } as unknown as Parameters<typeof toEvents>[0]
  expect(toEvents(m, "t")[0]!.data.toolName).toBe("next_step")
})

test("stripMcp removes the factory and client tool server prefixes only", async () => {
  const { stripMcp } = await import("../src/claudetools.ts")
  expect(stripMcp("mcp__factory__spawn_worker")).toBe("spawn_worker")
  expect(stripMcp("mcp__ui-1a2b3c4d__open_panel")).toBe("open_panel")
  expect(stripMcp("mcp__other__x")).toBe("mcp__other__x")
  expect(stripMcp("Bash")).toBe("Bash")
})
