import { afterEach, expect, test, spyOn } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { prepareRun, runNative, type RunDependencies } from "../../src/native-run/run.ts"
import { selectCommonMcp } from "../../src/native-run/mcp.ts"
import { expandMcpEnvironment } from "../../src/native-run/mcp-stdio.ts"
import { cleanupFixtures, fixturePaths, git, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)
const base = {
  harness: "codex",
  profiles: ["empty"],
  dryRun: true,
  allowUnprovenIsolation: true,
  forwardedArgs: [] as string[],
}
const config = (tail: string) => `schema_version = 1\n[native.profiles.empty]\n${tail}`
const definitions = `
[mcp.servers.context7]
type = "http"
url = "https://mcp.context7.com/mcp"
headers = { CONTEXT7_API_KEY = "\${CONTEXT7_API_KEY}" }
[mcp.servers.perplexity]
type = "stdio"
command = "npx"
args = ["-y", "@perplexity-ai/mcp-server"]
env = { PERPLEXITY_API_KEY = "\${PERPLEXITY_API_KEY}" }
`
const world = async (tail = definitions) => {
  const root = await tempRoot("mcp")
  const configPath = path.join(root, "config.toml")
  await writeFile(configPath, config(tail), { mode: 0o600 })
  const cwd = path.join(root, "work")
  await mkdir(cwd)
  await git(cwd, "init", "-q")
  const paths = await fixturePaths(root)
  const lines: string[] = []
  const environment = {
    HOME: root,
    PATH: process.env.PATH ?? "",
    TRELLAGE_CONFIG: configPath,
    CONTEXT7_API_KEY: "fixture-context-secret",
    PERPLEXITY_API_KEY: "fixture-perplexity-secret",
  }
  const dependencies: RunDependencies = {
    environment,
    paths,
    cwd,
    refreshHarness: async () => undefined,
    write: (line) => lines.push(line),
  }
  return { root, configPath, lines, environment, dependencies }
}

test("common MCPs are profile-independent, declarative, and generation-sensitive", async () => {
  const fixture = await world()
  const first = await prepareRun(base, fixture.dependencies)
  expect(Object.keys(first.plan.mcp!.servers)).toEqual(["context7", "perplexity"])
  const manifest = await readFile(path.join(first.layout.generationPath, "manifest.json"), "utf8")
  expect(JSON.stringify(first.plan.mcp)).toContain("${PERPLEXITY_API_KEY}")
  expect(manifest).not.toContain("fixture-perplexity-secret")
  expect(JSON.stringify(first.launch)).not.toContain("fixture-context-secret")
  const rotated = await prepareRun(base, {
    ...fixture.dependencies,
    environment: { ...fixture.environment, CONTEXT7_API_KEY: "rotated-secret" },
  })
  expect(rotated.plan.generationId).toBe(first.plan.generationId)
  await writeFile(
    fixture.configPath,
    config(definitions.replace("@perplexity-ai/mcp-server", "@perplexity-ai/mcp-server@1.2.0")),
  )
  const changed = await prepareRun(base, fixture.dependencies)
  expect(changed.plan.generationId).not.toBe(first.plan.generationId)
  await writeFile(fixture.configPath, config(""))
  const removed = await prepareRun(base, fixture.dependencies)
  expect(removed.plan.generationId).not.toBe(changed.plan.generationId)
  expect(removed.plan.mcp).toBeUndefined()
})

test.each(["claude", "copilot", "codex", "pi"])("%s clean never reads common MCP configuration", async (harness) => {
  const fixture = await world()
  await writeFile(fixture.configPath, "intentionally invalid TOML {{{")
  const prepared = await prepareRun({ ...base, harness, profiles: ["clean"] }, fixture.dependencies)
  expect(prepared.clean).toBe(true)
  expect(prepared.plan.mcp).toBeUndefined()
  expect(JSON.stringify(prepared.launch)).not.toContain("mcp-specs")
})

test("missing credential omits only the affected server and exposes no values", async () => {
  const fixture = await world()
  const prepared = await prepareRun(base, {
    ...fixture.dependencies,
    environment: { ...fixture.environment, PERPLEXITY_API_KEY: "" },
  })
  expect(Object.keys(prepared.plan.mcp!.servers)).toEqual(["context7"])
  expect(prepared.plan.mcpWarnings).toEqual([
    "MCP perplexity unavailable: set PERPLEXITY_API_KEY; launching without it",
  ])
})

test("unsupported common MCPs warn on stderr even with quiet/machine output", async () => {
  const fixture = await world()
  const { write: _write, ...dependencies } = fixture.dependencies
  const messages: string[] = []
  const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    messages.push(String(chunk))
    return true
  }) as typeof process.stderr.write)
  try {
    await runNative({ ...base, harness: "uji", forwardedArgs: ["--output-format", "json"] }, dependencies)
    expect(messages.join("\n")).toContain("MCP context7 unavailable for uji")
    expect(messages.join("\n")).toContain("MCP perplexity unavailable for uji")
    expect(messages.join("\n")).not.toContain("fixture-context-secret")
  } finally {
    stderr.mockRestore()
  }
})

test("enabled=false is silent and interpolation never uses a shell", () => {
  const server = { type: "stdio" as const, command: "node", args: [], env: { KEY: "${KEY}" }, enabled: false }
  expect(selectCommonMcp("codex", { servers: { disabled: server } }, {})).toEqual({
    mcp: { servers: {} },
    warnings: [],
  })
  expect(expandMcpEnvironment("Bearer ${KEY}", { KEY: "$(touch /never)" })).toBe("Bearer $(touch /never)")
  expect(() => expandMcpEnvironment("${MISSING}", {})).toThrow("missing MCP environment variable MISSING")
})

test("stdio wrapper passes resolved env to its child without writing it in the specification", async () => {
  const fixture = await world()
  const prepared = await prepareRun(base, fixture.dependencies)
  const specification = path.join(prepared.layout.generationPath, "mcp-specs", "perplexity.json")
  const original = await readFile(specification, "utf8")
  expect(original).not.toContain("fixture-perplexity-secret")
  const server = JSON.parse(original)
  // Offline protocol fixture instead of npx/network.
  await writeFile(
    specification,
    JSON.stringify({
      ...server,
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.PERPLEXITY_API_KEY)"],
    }),
  )
  const child = Bun.spawn(
    [process.execPath, path.resolve(import.meta.dir, "../../src/native-run/mcp-stdio.ts"), specification],
    { env: fixture.environment, stdout: "pipe", stderr: "pipe" },
  )
  expect(await new Response(child.stdout).text()).toBe("fixture-perplexity-secret")
  expect(await child.exited).toBe(0)
})

test("launch resolves header aliases only in the child environment", async () => {
  const fixture = await world()
  let called = false
  const status = await runNative(
    { ...base, dryRun: false },
    {
      ...fixture.dependencies,
      spawner: async (launch, _env, _cwd, onSpawn) => {
        called = true
        expect(Object.entries(launch.env).filter(([name]) => name.startsWith("TRX_MCP_HEADER_"))).toEqual([
          [expect.any(String), "fixture-context-secret"],
        ])
        expect(launch.args.join(" ")).not.toContain("fixture-context-secret")
        onSpawn()
        return 0
      },
    },
  )
  expect(status).toBe(0)
  expect(called).toBe(true)
  expect(fixture.lines.join("\n")).not.toContain("fixture-context-secret")
})

test("unsupported MCP warnings do not block a noninteractive launch", async () => {
  const fixture = await world()
  const { write: _write, ...dependencies } = fixture.dependencies
  const messages: string[] = []
  let called = false
  const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    messages.push(String(chunk))
    return true
  }) as typeof process.stderr.write)
  try {
    const status = await runNative(
      { ...base, harness: "uji", dryRun: false, forwardedArgs: ["--output-format", "json"] },
      {
        ...dependencies,
        spawner: async (_launch, _env, _cwd, onSpawn) => {
          called = true
          onSpawn()
          return 0
        },
      },
    )
    expect(status).toBe(0)
    expect(called).toBe(true)
    expect(messages.join("\n")).toContain("MCP context7 unavailable for uji")
    expect(messages.join("\n")).toContain("MCP perplexity unavailable for uji")
  } finally {
    stderr.mockRestore()
  }
})

test("invalid resolved headers omit only that MCP from native config and still launch", async () => {
  const fixture = await world()
  const dependencies = {
    ...fixture.dependencies,
    environment: { ...fixture.environment, CONTEXT7_API_KEY: "secret\r\ninjected" },
  }
  const prepared = await prepareRun(base, dependencies)
  expect(Object.keys(prepared.plan.mcp!.servers)).toEqual(["perplexity"])
  expect(prepared.plan.mcpWarnings).toEqual([
    "MCP context7 unavailable: invalid resolved URL or headers; launching without it",
  ])
  const native = await readFile(path.join(prepared.layout.generationPath, "config.toml"), "utf8")
  expect(native).not.toContain("context7")
  expect(native).toContain("perplexity")
  let called = false
  expect(
    await runNative(
      { ...base, dryRun: false },
      {
        ...dependencies,
        spawner: async (_launch, _env, _cwd, onSpawn) => {
          called = true
          onSpawn()
          return 0
        },
      },
    ),
  ).toBe(0)
  expect(called).toBe(true)
  expect(fixture.lines.join("\n")).not.toContain("injected")
})

test("Grok-incompatible names warn and omit instead of breaking the launch", () => {
  const result = selectCommonMcp(
    "grok",
    { servers: { "1-server": { type: "stdio", command: "node", args: [], env: {}, enabled: true } } },
    {},
  )
  expect(result.mcp!.servers).toEqual({})
  expect(result.warnings[0]).toContain("server names must begin with a letter")
})

test("Nodecode warns and omits HTTP headers while retaining ordinary stdio MCP", async () => {
  const fixture = await world()
  const prepared = await prepareRun({ ...base, harness: "nodecode" }, fixture.dependencies)
  expect(Object.keys(prepared.plan.mcp!.servers)).toEqual(["perplexity"])
  expect(prepared.plan.mcpWarnings).toEqual([
    "MCP context7 unavailable for nodecode: HTTP headers require gateway-scoped authentication support; use a stdio MCP server instead; launching without it",
  ])
  expect(JSON.stringify(prepared)).not.toContain("fixture-context-secret")
})
