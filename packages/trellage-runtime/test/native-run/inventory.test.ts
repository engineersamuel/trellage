import { afterEach, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { agencyAdapter, codexAdapter, copilotAdapter, type NativeAdapter } from "../../src/native-run/adapters.ts"
import {
  aggregateInventoryReadiness,
  inventoryCodexGoalFeatures,
  inventoryComposition,
  type InventoryCheck,
  type InventoryReadiness,
} from "../../src/native-run/inventory.ts"
import type { PreparedRun } from "../../src/native-run/run.ts"
import { cleanupFixtures, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)

const dependency = (
  status: InventoryCheck["status"],
  readiness?: Exclude<InventoryReadiness, "healthy">,
) => ({ id: "fixture", status, detail: "fixture", ...(readiness ? { readiness } : {}) })

test("readiness aggregation preserves actionable dependency states", () => {
  expect(aggregateInventoryReadiness([dependency("ok"), dependency("skipped")])).toBe("healthy")
  expect(aggregateInventoryReadiness([dependency("failed", "unhealthy")])).toBe("unhealthy")
  expect(
    aggregateInventoryReadiness([dependency("failed", "unhealthy"), dependency("failed", "not-setup")]),
  ).toBe("not-setup")
  expect(
    aggregateInventoryReadiness([dependency("failed", "not-setup"), dependency("failed", "busy")]),
  ).toBe("busy")
})

const preparedRun = async (adapter: NativeAdapter): Promise<PreparedRun> => {
  const root = await tempRoot(`inventory-${adapter.id}`)
  const plugin = path.join(root, "plugin")
  const skill = path.join(root, "skill")
  await mkdir(plugin)
  await mkdir(skill)
  await writeFile(path.join(plugin, ".mcp.json"), '{"mcpServers":{"documents":{"command":"fixture"}}}\n')
  return {
    adapter,
    plan: {
      compositionId: `${adapter.id}-fixture`,
      harness: adapter.id,
      profiles: [`preset-${adapter.id}-${adapter.id === "agency" ? "azure" : "hve"}`],
      alwaysProfiles: ["base"],
      instructions: [],
      skills: [
        {
          name: "brainstorming",
          sourceId: "fixture",
          commit: "1".repeat(40),
          digest: "skill-digest",
          directory: skill,
        },
      ],
      plugins: [
        {
          source: "fixture",
          harness: adapter.id,
          path: "plugin",
          name: "fixture-plugin",
          plugin: "fixture-plugin",
          includeMcp: true,
          settings: {},
          sourceId: "fixture",
          commit: "2".repeat(40),
          digest: "plugin-digest",
          directory: plugin,
        },
      ],
      sources: [],
      warnings: [],
      generationId: "fixture-generation",
    },
    layout: {
      ownerHome: path.join(root, "owner"),
      generationPath: path.join(root, "generation"),
      sessionsPath: path.join(root, "sessions"),
    },
    launch: { command: adapter.id, args: [], env: {} },
    selection: { harness: adapter.id, profiles: [adapter.id === "agency" ? "azure" : "hve"] },
    defaults: { model: undefined, effort: undefined },
    isolation: adapter.isolation,
    clean: false,
    workspace: root,
    missing: [],
  }
}

test("composition inventory reports native resources and lifecycle admission", async () => {
  const prepared = await preparedRun(copilotAdapter)
  const calls: ReadonlyArray<string>[] = []
  const inventory = await inventoryComposition(
    { harness: "copilot", profiles: ["hve"] },
    {
      environment: { HOME: prepared.workspace, PATH: "/fixture" },
      prepare: async () => prepared,
      resolveBinary: async () => "/fixture/copilot",
      runProcess: async (_command, args) => {
        calls.push(args)
        return args[0] === "--version"
          ? { status: 0, stdout: "copilot 1.0.98\n", stderr: "", timedOut: false }
          : {
              status: 0,
              stdout:
                '{"schemaVersion":1,"readiness":"healthy","plugins":[{"name":"admitted","version":"3.2.2"}],"skills":{"packageCount":4,"visibleCount":7},"mcps":["admitted-mcp"]}\n',
              stderr: "",
              timedOut: false,
            }
      },
    },
  )

  expect(inventory).toMatchObject({
    schemaVersion: 2,
    harness: "copilot",
    profiles: ["hve"],
    effectiveProfiles: ["base", "hve"],
    readiness: "healthy",
    binary: { command: "copilot", path: "/fixture/copilot", version: "1.0.98" },
    skills: { packageCount: 4, visibleCount: 7, names: ["brainstorming"] },
    mcps: ["admitted-mcp", "documents"],
  })
  expect(inventory.plugins).toEqual([
    { name: "fixture-plugin", version: "2".repeat(40) },
    { name: "admitted", version: "3.2.2" },
  ])
  expect(calls).toContainEqual(["inventory", "hve", "--json"])
})

test("composition inventory reads a v-prefixed binary version", async () => {
  const prepared = await preparedRun(copilotAdapter)
  const inventory = await inventoryComposition(
    { harness: "copilot", profiles: ["hve"] },
    {
      environment: { HOME: prepared.workspace, PATH: "/fixture" },
      prepare: async () => prepared,
      resolveBinary: async () => "/fixture/copilot",
      runProcess: async (_command, args) =>
        args[0] === "--version"
          ? { status: 0, stdout: "copilot v0.90.0 (a7f005e8c)\n", stderr: "", timedOut: false }
          : { status: 0, stdout: '{"schemaVersion":1,"readiness":"healthy"}\n', stderr: "", timedOut: false },
    },
  )
  expect(inventory.binary.version).toBe("0.90.0")
})

test("Agency admission is unhealthy without its launch authentication method", async () => {
  const prepared = await preparedRun(agencyAdapter)
  const inventory = await inventoryComposition(
    { harness: "agency", profiles: ["azure"] },
    {
      environment: { HOME: prepared.workspace, PATH: "/fixture" },
      prepare: async () => prepared,
      resolveBinary: async () => "/fixture/agency",
      runProcess: async (_command, args) =>
        args[0] === "--version"
          ? { status: 0, stdout: "agency 1.2.3\n", stderr: "", timedOut: false }
          : {
              status: 0,
              stdout: '{"schemaVersion":1,"readiness":"healthy"}\n',
              stderr: "",
              timedOut: false,
            },
    },
  )
  expect(inventory.readiness).toBe("unhealthy")
  expect(inventory.checks).toContainEqual({
    id: "admission",
    status: "failed",
    detail: "Agency inventory did not report an authentication method",
  })
})

test("Codex goal features use the composed launch command, home, and workspace", async () => {
  const prepared = await preparedRun(codexAdapter)
  const calls: Array<{
    command: string
    args: ReadonlyArray<string>
    environment: NodeJS.ProcessEnv
    cwd: string | undefined
  }> = []
  const result = await inventoryCodexGoalFeatures(
    { harness: "codex", profiles: ["pstack"] },
    {
      environment: { HOME: prepared.workspace, PATH: "/fixture" },
      prepare: async (options) => {
        expect(options.forwardedArgs).toEqual(["features", "list"])
        return {
          ...prepared,
          workspace: "/worktree",
          launch: {
            command: "/fixture/codex",
            args: ["-c", "projects.\"/worktree\".trust_level=\"trusted\"", "features", "list"],
            env: { CODEX_HOME: "/fixture/generated", OPENAI_API_KEY: null },
          },
        }
      },
      runProcess: async (command, args, environment, _timeout, cwd) => {
        calls.push({ command, args, environment, cwd })
        return { status: 0, stdout: "goals stable true\n", stderr: "", timedOut: false }
      },
    },
  )
  expect(result.stdout).toBe("goals stable true\n")
  expect(calls).toEqual([{
    command: "/fixture/codex",
    args: ["-c", "projects.\"/worktree\".trust_level=\"trusted\"", "features", "list"],
    environment: { HOME: prepared.workspace, PATH: "/fixture", CODEX_HOME: "/fixture/generated" },
    cwd: "/worktree",
  }])
})

test("inventory includes common MCPs and reports skipped integrations", async () => {
  const prepared = await preparedRun(copilotAdapter)
  const withMcp = {
    ...prepared,
    plan: {
      ...prepared.plan,
      mcp: { servers: { context7: { type: "http" as const, enabled: true, url: "https://mcp.context7.com/mcp", headers: {} } } },
      mcpWarnings: ["MCP perplexity unavailable: set PERPLEXITY_API_KEY; launching without it"],
    },
  }
  const inventory = await inventoryComposition({ harness: "copilot", profiles: ["hve"] }, {
    environment: { HOME: prepared.workspace, PATH: "/fixture" },
    prepare: async () => withMcp,
    resolveBinary: async () => "/fixture/copilot",
    runProcess: async (_command, args) => args[0] === "--version"
      ? { status: 0, stdout: "copilot 1.0.98\n", stderr: "", timedOut: false }
      : { status: 0, stdout: '{"schemaVersion":1,"readiness":"healthy"}\n', stderr: "", timedOut: false },
  })
  expect(inventory.mcps).toEqual(["context7", "documents"])
  expect(inventory.checks).toContainEqual({ id: "mcp-0", status: "skipped", detail: withMcp.plan.mcpWarnings[0]! })
})
