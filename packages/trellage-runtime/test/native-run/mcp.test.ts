import { afterEach, expect, test, spyOn } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  CentralEnvironmentError,
  type CentralEnvironment,
  type CentralEnvironmentRequest,
} from "../../src/native-environment.ts"
import { NativeRunError } from "../../src/native-run/paths.ts"
import type { LaunchCommand } from "../../src/native-run/adapters.ts"
import { describePreparedRun, prepareRun, runNative, type RunDependencies } from "../../src/native-run/run.ts"
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

const withoutCredentials = ({
  CONTEXT7_API_KEY: _context,
  PERPLEXITY_API_KEY: _perplexity,
  ...rest
}: NodeJS.ProcessEnv) => rest

/** Stands in for Varlock: answers exactly the requested names it knows and records every request. */
const centralStub = (values: Record<string, string>, warnings: string[] = []) => {
  const requests: CentralEnvironmentRequest[] = []
  const centralEnvironment = async (request: CentralEnvironmentRequest): Promise<CentralEnvironment> => {
    requests.push(request)
    return {
      values: Object.fromEntries(request.names.filter((name) => name in values).map((name) => [name, values[name]!])),
      warnings,
    }
  }
  return { requests, centralEnvironment }
}

test("the central environment is asked only for MCP variables and allowlisted names the process lacks", async () => {
  const fixture = await world(`[environment]\ninject = ["EXTRA_TOKEN", "AMBIENT_TOKEN"]\n${definitions}`)
  const central = centralStub({ CONTEXT7_API_KEY: "central-context-secret", EXTRA_TOKEN: "central-extra-secret" })
  const prepared = await prepareRun(base, {
    ...fixture.dependencies,
    environment: {
      ...withoutCredentials(fixture.environment),
      CONTEXT7_API_KEY: "",
      PERPLEXITY_API_KEY: "ambient-perplexity-secret",
      AMBIENT_TOKEN: "ambient-token",
    },
    centralEnvironment: central.centralEnvironment,
  })
  expect(central.requests).toHaveLength(1)
  expect(central.requests[0]).toMatchObject({
    names: ["CONTEXT7_API_KEY", "EXTRA_TOKEN"],
    configPath: fixture.configPath,
  })
  expect(Object.keys(prepared.plan.mcp!.servers)).toEqual(["context7", "perplexity"])
  expect(prepared.plan.mcpWarnings ?? []).toEqual([])
  const description = describePreparedRun(prepared).join("\n")
  expect(description).toContain("Central env CONTEXT7_API_KEY, EXTRA_TOKEN")
  const published = [
    description,
    JSON.stringify(prepared.plan),
    JSON.stringify(prepared.launch),
    await readFile(path.join(prepared.layout.generationPath, "manifest.json"), "utf8"),
  ].join("\n")
  expect(published).not.toContain("central-")
})

test("central values reach the MCP aliases and the harness but never the adapters or the refresh", async () => {
  const fixture = await world()
  const central = centralStub({ CONTEXT7_API_KEY: "central-context-secret" })
  let refreshed: NodeJS.ProcessEnv | undefined
  let spawned: { launchEnvironment: LaunchCommand["env"]; environment: NodeJS.ProcessEnv } | undefined
  const status = await runNative(
    { ...base, dryRun: false },
    {
      ...fixture.dependencies,
      environment: { ...withoutCredentials(fixture.environment), PERPLEXITY_API_KEY: "ambient-perplexity-secret" },
      centralEnvironment: central.centralEnvironment,
      refreshHarness: async (_harness, environment) => {
        refreshed = environment
        return undefined
      },
      spawner: async (launch, environment, _cwd, onSpawn) => {
        spawned = { launchEnvironment: launch.env, environment }
        onSpawn()
        return 0
      },
    },
  )
  expect(status).toBe(0)
  expect(refreshed).not.toHaveProperty("CONTEXT7_API_KEY")
  expect(spawned?.environment.CONTEXT7_API_KEY).toBe("central-context-secret")
  expect(spawned?.environment.PERPLEXITY_API_KEY).toBe("ambient-perplexity-secret")
  expect(Object.entries(spawned!.launchEnvironment).filter(([name]) => name.startsWith("TRX_MCP_HEADER_"))).toEqual([
    [expect.any(String), "central-context-secret"],
  ])
  expect(fixture.lines.join("\n")).toContain("Central env CONTEXT7_API_KEY")
  expect(fixture.lines.join("\n")).not.toContain("central-context-secret")
})

test("a variable the process already sets wins and is never requested", async () => {
  const fixture = await world()
  const central = centralStub({ CONTEXT7_API_KEY: "central-context-secret", PERPLEXITY_API_KEY: "central-perplexity" })
  let environment: NodeJS.ProcessEnv | undefined
  await runNative(
    { ...base, dryRun: false },
    {
      ...fixture.dependencies,
      centralEnvironment: central.centralEnvironment,
      spawner: async (_launch, spawnedEnvironment, _cwd, onSpawn) => {
        environment = spawnedEnvironment
        onSpawn()
        return 0
      },
    },
  )
  expect(central.requests.map(({ names }) => names)).toEqual([[]])
  expect(environment?.CONTEXT7_API_KEY).toBe("fixture-context-secret")
  expect(fixture.lines.join("\n")).not.toContain("Central env")
})

test("clean runs never read the central environment", async () => {
  const fixture = await world()
  const central = centralStub({ CONTEXT7_API_KEY: "central-context-secret" })
  const prepared = await prepareRun(
    { ...base, profiles: ["clean"] },
    { ...fixture.dependencies, centralEnvironment: central.centralEnvironment },
  )
  expect(prepared.clean).toBe(true)
  expect(prepared.centralEnvironment).toBeUndefined()
  expect(central.requests).toEqual([])
})

test("a harness that cannot use an MCP server does not request its variables", async () => {
  const fixture = await world(`[environment]\ninject = ["EXTRA_TOKEN"]\n${definitions}`)
  const environment = withoutCredentials(fixture.environment)
  const requested = async (harness: string) => {
    const central = centralStub({})
    await prepareRun(
      { ...base, harness },
      { ...fixture.dependencies, environment, centralEnvironment: central.centralEnvironment },
    )
    return central.requests.map(({ names }) => names)
  }
  expect(await requested("uji")).toEqual([["EXTRA_TOKEN"]])
  expect(await requested("nodecode")).toEqual([["EXTRA_TOKEN", "PERPLEXITY_API_KEY"]])
  expect(await requested("codex")).toEqual([["CONTEXT7_API_KEY", "EXTRA_TOKEN", "PERPLEXITY_API_KEY"]])
})

test("a central warning is reported once and does not block the launch", async () => {
  const fixture = await world()
  const warning = "Central environment unavailable: Varlock could not load the environment; launching without it"
  const central = centralStub({}, [warning])
  const status = await runNative(base, {
    ...fixture.dependencies,
    environment: withoutCredentials(fixture.environment),
    centralEnvironment: central.centralEnvironment,
  })
  expect(status).toBe(0)
  expect(fixture.lines.filter((line) => line === `Warning     ${warning}`)).toHaveLength(1)
  expect(fixture.lines).toContain("Warning     MCP context7 unavailable: set CONTEXT7_API_KEY; launching without it")
})

test("a required central environment that fails stops the run with a configuration error", async () => {
  const fixture = await world()
  const failure = await prepareRun(base, {
    ...fixture.dependencies,
    centralEnvironment: async () => {
      throw new CentralEnvironmentError({ message: "required Varlock environment path does not exist: /nowhere" })
    },
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(NativeRunError)
  expect(failure).toMatchObject({
    code: "config",
    message: "required Varlock environment path does not exist: /nowhere",
  })
})

test("the default central environment enables a credential only its file holds", async () => {
  const fixture = await world()
  await writeFile(
    path.join(fixture.root, ".env.local"),
    "CONTEXT7_API_KEY=file-context-secret\nUNRELATED=file-unrelated\n",
    {
      mode: 0o600,
    },
  )
  const environment = { ...withoutCredentials(fixture.environment), PERPLEXITY_API_KEY: "ambient-perplexity-secret" }
  const prepared = await prepareRun(base, { ...fixture.dependencies, environment })
  expect(prepared.centralEnvironment).toEqual({ values: { CONTEXT7_API_KEY: "file-context-secret" }, warnings: [] })
  expect(Object.keys(prepared.plan.mcp!.servers)).toEqual(["context7", "perplexity"])
  expect(describePreparedRun(prepared).join("\n")).not.toContain("file-context-secret")
})
