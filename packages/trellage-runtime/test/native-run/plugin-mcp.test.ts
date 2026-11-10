import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { prepareRun } from "../../src/native-run/run.ts"
import { gitSourceTransport } from "../../src/native-run/source.ts"
import { cleanupFixtures, createSourceRepo, fixturePaths, git, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)

const pluginContext7 = { type: "http", url: "https://mcp.context7.com/mcp?client=claude-code-plugin" }
const pluginDevtools = { command: "npx", args: ["-y", "@foldkit/devtools-mcp@0.26.0"] }

/** A Claude plugin that ships `mcpFile`, next to a common Context7 server that needs CONTEXT7_API_KEY. */
const world = async (mcpFile: unknown) => {
  const root = await tempRoot("plugin-mcp")
  const source = await createSourceRepo(root, "plugins")
  await source.write({
    "plugins/sample/.claude-plugin/plugin.json": JSON.stringify({ name: "sample" }),
    "plugins/sample/.mcp.json": JSON.stringify(mcpFile),
  })
  const configPath = path.join(root, "config.toml")
  await writeFile(
    configPath,
    `schema_version = 1
[native.sources.plugins]
repository = "example/plugins"
[native.profiles.sample]
plugins = [{ source = "plugins", harness = "claude", path = "plugins/sample", name = "sample", plugin = "sample", marketplace = "fixture-market", includeMcp = true }]
[mcp.servers.context7]
type = "http"
url = "https://mcp.context7.com/mcp"
headers = { CONTEXT7_API_KEY = "\${CONTEXT7_API_KEY}" }
`,
    { mode: 0o600 },
  )
  const work = path.join(root, "work")
  await mkdir(work)
  await git(work, "init", "-q")
  const paths = await fixturePaths(root)
  const stage = async (credential: boolean) => {
    const prepared = await prepareRun(
      { harness: "claude", profiles: ["sample"], dryRun: true, allowUnprovenIsolation: true, forwardedArgs: [] },
      {
        environment: {
          HOME: root,
          PATH: process.env.PATH ?? "",
          TRELLAGE_CONFIG: configPath,
          ...(credential ? { CONTEXT7_API_KEY: "fixture-context-secret" } : {}),
        },
        paths,
        cwd: work,
        transport: gitSourceTransport(() => source.directory),
        refreshHarness: async () => undefined,
        write: () => undefined,
      },
    )
    return {
      prepared,
      staged: path.join(prepared.layout.generationPath, "plugins", "sample", ".mcp.json"),
      original: path.join(prepared.plan.plugins[0]!.directory, ".mcp.json"),
    }
  }
  return { stage }
}

test("an authenticated common MCP server replaces the staged plugin server of the same name", async () => {
  const { stage } = await world({ mcpServers: { context7: pluginContext7, "foldkit-devtools": pluginDevtools } })
  const { prepared, staged, original } = await stage(true)
  expect(Object.keys(prepared.plan.mcp!.servers)).toEqual(["context7"])
  expect(JSON.parse(await readFile(staged, "utf8"))).toEqual({ mcpServers: { "foldkit-devtools": pluginDevtools } })
  // The cached plugin source is never edited.
  expect(Object.keys(JSON.parse(await readFile(original, "utf8")).mcpServers)).toEqual(["context7", "foldkit-devtools"])
})

test("the plugin keeps its own server while the common one is unavailable, in a different generation", async () => {
  const servers = { context7: pluginContext7, "foldkit-devtools": pluginDevtools }
  const { stage } = await world({ mcpServers: servers })
  const authenticated = await stage(true)
  const anonymous = await stage(false)
  expect(anonymous.prepared.plan.mcp?.servers).toEqual({})
  expect(JSON.parse(await readFile(anonymous.staged, "utf8"))).toEqual({ mcpServers: servers })
  expect(anonymous.prepared.plan.generationId).not.toBe(authenticated.prepared.plan.generationId)
})

test("a plugin whose servers are all replaced stages no MCP file", async () => {
  const { stage } = await world({ mcpServers: { context7: pluginContext7 } })
  expect(existsSync((await stage(true)).staged)).toBe(false)
  expect(existsSync((await stage(false)).staged)).toBe(true)
})

test("a plugin MCP file without an mcpServers object is staged unchanged", async () => {
  const flat = { context7: pluginContext7 }
  const { stage } = await world(flat)
  expect(JSON.parse(await readFile((await stage(true)).staged, "utf8"))).toEqual(flat)
})
