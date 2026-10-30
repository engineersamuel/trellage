import { afterEach, expect, test } from "bun:test"
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { parse as parseToml } from "smol-toml"
import type { McpServer } from "../../src/mcp-config.ts"
import {
  nativeMcpArgs,
  nativeMcpEnvironment,
  nativeMcpSupport,
  nativeMcpStdioAlias,
  writeNativeMcpFiles,
} from "../../src/native-run/mcp-render.ts"
import { cleanupFixtures, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)
const local: McpServer = {
  type: "stdio",
  enabled: true,
  command: "npx",
  args: ["-y", "@perplexity-ai/mcp-server"],
  env: { PERPLEXITY_API_KEY: "${PERPLEXITY_API_KEY}" },
}
const remote: McpServer = {
  type: "http",
  enabled: true,
  url: "https://mcp.context7.com/mcp",
  headers: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}", "X-Literal": "public" },
}
const common = { perplexity: local, context7: remote }
const json = async (root: string, filename: string) => JSON.parse(await readFile(path.join(root, filename), "utf8"))

test.each(["claude", "copilot", "codex", "jcode", "grok", "pi", "nodecode"])(
  "%s supports stdio and streamable HTTP",
  (harness) => {
    expect(nativeMcpSupport(harness, local)).toBeUndefined()
    expect(nativeMcpSupport(harness, { ...remote, headers: {} })).toBeUndefined()
  },
)

test.each(["agency", "omp", "prime", "uji", "fx", "headlong", "unknown"])(
  "%s reports an unverified isolated MCP route",
  async (harness) => {
    expect(nativeMcpSupport(harness, local)).toContain("no isolated MCP")
    const root = await tempRoot("mcp-unsupported")
    await writeNativeMcpFiles(root, "/published", harness, common)
    expect(await readdir(root)).toEqual([])
    expect(nativeMcpArgs(harness, root, common)).toEqual([])
    expect(nativeMcpEnvironment(harness, common, {})).toEqual({})
  },
)

test.each(["codex", "pi", "nodecode"])("%s refuses legacy SSE rather than silently treating it as HTTP", (harness) => {
  expect(nativeMcpSupport(harness, { ...remote, type: "sse" })).toContain("legacy SSE")
})

test.each(["claude", "copilot", "jcode", "grok"])("%s renders legacy SSE explicitly", async (harness) => {
  const root = await tempRoot("mcp-sse")
  await writeNativeMcpFiles(root, root, harness, { legacy: { ...remote, type: "sse" } })
  const entries =
    harness === "grok"
      ? parseToml(await readFile(path.join(root, "config.toml"), "utf8")).mcp_servers
      : (await json(root, harness === "jcode" ? "mcp.json" : "mcp-config.json")).mcpServers
  expect(entries).toMatchObject({ legacy: { type: "sse", url: remote.url } })
})

test.each(["claude", "copilot", "jcode", "pi"])(
  "%s generates isolated JSON and a symbolic stdio specification",
  async (harness) => {
    const root = await tempRoot("mcp-json")
    const generation = "/published generation"
    await writeNativeMcpFiles(root, generation, harness, common)
    const filename = ["claude", "copilot"].includes(harness) ? "mcp-config.json" : "mcp.json"
    const config = await json(root, filename)
    expect(config.mcpServers.perplexity).toMatchObject({
      command: process.execPath,
      env: { TRX_MCP_ENV_PERPLEXITY_API_KEY: "${TRX_MCP_ENV_PERPLEXITY_API_KEY}" },
    })
    expect(config.mcpServers.perplexity.args[0]).toEndWith("/native-run/mcp-stdio.ts")
    expect(config.mcpServers.perplexity.args[1]).toBe(path.join(generation, "mcp-specs", "perplexity.json"))
    expect(config.mcpServers.context7).toMatchObject({
      type: "http",
      url: remote.url,
      headers: { "X-Literal": "public" },
    })
    if (harness === "copilot") {
      expect(config.mcpServers.perplexity.type).toBe("local")
      expect(config.mcpServers.perplexity.tools).toEqual(["*"])
      expect(config.mcpServers.context7.tools).toEqual(["*"])
    }
    expect(await json(root, "mcp-specs/perplexity.json")).toEqual(local)
    expect((await stat(path.join(root, filename))).mode & 0o777).toBe(0o600)
    const token = "secret-do-not-persist"
    const environment = nativeMcpEnvironment(harness, common, {
      CONTEXT7_API_KEY: token,
      PERPLEXITY_API_KEY: "local-token",
    })
    const placeholder = config.mcpServers.context7.headers.CONTEXT7_API_KEY
    expect(environment[placeholder.slice(2, -1)]).toBe(token)
    expect(await readFile(path.join(root, filename), "utf8")).not.toContain(token)
  },
)

test.each(["codex", "grok"])("%s preserves provider settings and translates native TOML fields", async (harness) => {
  const root = await tempRoot("mcp-toml")
  const file = path.join(root, "config.toml")
  await writeFile(
    file,
    'model = "existing"\n[model_providers.proxy]\nbase_url = "http://localhost:8080"\n[mcp_servers.plugin]\ncommand = "existing-plugin"\n',
  )
  await chmod(file, 0o644)
  await writeNativeMcpFiles(root, "/published", harness, common)
  const config = parseToml(await readFile(file, "utf8"))
  expect(config).toMatchObject({
    model: "existing",
    model_providers: { proxy: { base_url: "http://localhost:8080" } },
    mcp_servers: {
      plugin: { command: "existing-plugin" },
      perplexity: { command: process.execPath },
    },
  })
  const entries = config.mcp_servers as Record<string, Record<string, unknown>>
  if (harness === "codex") {
    expect(entries.perplexity!.env_vars).toEqual(["TRX_MCP_ENV_PERPLEXITY_API_KEY"])
    expect(entries.context7!.http_headers).toEqual({ "X-Literal": "public" })
    const names = entries.context7!.env_http_headers as Record<string, string>
    expect(
      nativeMcpEnvironment(harness, common, {
        CONTEXT7_API_KEY: "secret",
        PERPLEXITY_API_KEY: "local-token",
      })[names.CONTEXT7_API_KEY!],
    ).toBe("secret")
  } else {
    expect(entries.context7).toMatchObject({ type: "http", headers: { "X-Literal": "public" } })
  }
  expect((await stat(file)).mode & 0o777).toBe(0o600)
})

test("Nodecode stages only immutable stdio specifications, never persistent home configuration", async () => {
  const root = await tempRoot("mcp-nodecode-render")
  await writeNativeMcpFiles(root, "/published", "nodecode", common)
  expect(await readdir(root)).toEqual(["mcp-specs"])
  expect(await json(root, "mcp-specs/perplexity.json")).toEqual(local)
  expect(nativeMcpArgs("nodecode", root, common)).toEqual([])
  expect(nativeMcpEnvironment("nodecode", common, { PERPLEXITY_API_KEY: "local-token" })).toEqual({
    TRX_MCP_ENV_PERPLEXITY_API_KEY: "local-token",
  })
})

test("Claude uses a filename and Pi explicitly reenables builtin MCP; disabled servers add nothing", () => {
  expect(nativeMcpArgs("claude", "/generation", common)).toEqual(["--mcp-config", "/generation/mcp-config.json"])
  expect(nativeMcpArgs("pi", "/generation", common)).toEqual(["--extension", "builtin:mcp"])
  expect(nativeMcpArgs("pi", "/generation", { context7: { ...remote, enabled: false } })).toEqual([])
})

test("compound HTTP auth is resolved only in each launch environment", () => {
  const servers = { api: { ...remote, headers: { Authorization: "Bearer ${TOKEN}" } } }
  const one = nativeMcpEnvironment("codex", servers, { TOKEN: "first" })
  const two = nativeMcpEnvironment("codex", servers, { TOKEN: "second" })
  expect(Object.keys(one)).toEqual(Object.keys(two))
  expect(Object.values(one)).toEqual(["Bearer first"])
  expect(Object.values(two)).toEqual(["Bearer second"])
  expect(() => nativeMcpEnvironment("codex", servers, {})).toThrow("missing MCP environment variable TOKEN")
  expect(() => nativeMcpEnvironment("codex", servers, { TOKEN: "secret\r\nHeader: inject" })).toThrow(
    "invalid MCP authentication header",
  )
})

test("empty and disabled selections leave existing generation resources alone", async () => {
  const root = await tempRoot("mcp-empty")
  await writeFile(path.join(root, "mcp.json"), "unchanged")
  await writeNativeMcpFiles(root, root, "pi", { context7: { ...remote, enabled: false } })
  expect(await readFile(path.join(root, "mcp.json"), "utf8")).toBe("unchanged")
})

test("unowned server name collisions are not overwritten", async () => {
  const root = await tempRoot("mcp-collision")
  const previous = JSON.stringify({
    theme: "retained",
    mcpServers: { context7: { command: "plugin" } },
  })
  await writeFile(path.join(root, "mcp-config.json"), previous)
  await expect(writeNativeMcpFiles(root, root, "copilot", { context7: remote })).rejects.toThrow(
    "MCP configuration collision: context7",
  )
  expect(await readFile(path.join(root, "mcp-config.json"), "utf8")).toBe(previous)
})

test("exported renderer refuses unsafe server paths and unsupported URL references", async () => {
  const root = await tempRoot("mcp-path")
  await expect(writeNativeMcpFiles(root, root, "claude", { "../outside": local })).rejects.toThrow(
    "invalid MCP server name",
  )
  expect(nativeMcpSupport("codex", { ...remote, url: "https://example.test/${TOKEN}" })).toContain(
    "authentication header",
  )
})

test.each(["Bearer literal$$suffix", "Bearer $FAKE_TOKEN", "literal$!suffix", "!echo must-not-run"])(
  "Pi aliases special literal header %s without recursive native interpretation",
  async (literal) => {
    const root = await tempRoot("mcp-pi-literal")
    const servers = { api: { ...remote, headers: { Authorization: literal } } }
    await writeNativeMcpFiles(root, root, "pi", servers)
    const config = await json(root, "mcp.json")
    const template = config.mcpServers.api.headers.Authorization
    expect(template).toStartWith("${TRX_MCP_HEADER_")
    expect(nativeMcpEnvironment("pi", servers, { FAKE_TOKEN: "must-not-substitute" })[template.slice(2, -1)]).toBe(
      literal,
    )
  },
)

test.each(["claude", "copilot", "codex", "jcode", "grok", "pi", "nodecode"])(
  "%s captures all stdio references before harness environment rewriting",
  async (harness) => {
    const root = await tempRoot("mcp-stdio-alias")
    const server: McpServer = {
      ...local,
      command: "${HOME}/bin/tool",
      args: ["--path", "${PATH}", "--token", "${GH_TOKEN}"],
      env: { TOKEN: "Bearer ${GH_TOKEN}", AWS_TOKEN: "${AWS_SESSION_TOKEN}" },
    }
    const original = {
      HOME: "/original",
      PATH: "/original/bin",
      GH_TOKEN: "original-token",
      AWS_SESSION_TOKEN: "original-aws",
    }
    const aliases = nativeMcpEnvironment(harness, { tool: server }, original)
    expect(aliases).toEqual(
      Object.fromEntries(Object.entries(original).map(([name, value]) => [nativeMcpStdioAlias(name), value])),
    )
    expect(aliases.GH_TOKEN).toBeUndefined()
    expect(aliases.AWS_SESSION_TOKEN).toBeUndefined()
    await writeNativeMcpFiles(root, root, harness, { tool: server })
    const spec = await json(root, "mcp-specs/tool.json")
    expect(spec).toEqual(server)
    if (harness !== "nodecode") {
      const entries = ["codex", "grok"].includes(harness)
        ? (parseToml(await readFile(path.join(root, "config.toml"), "utf8")).mcp_servers as Record<
            string,
            Record<string, unknown>
          >)
        : (await json(root, ["claude", "copilot"].includes(harness) ? "mcp-config.json" : "mcp.json")).mcpServers
      const variables = Object.keys(original).map(nativeMcpStdioAlias).sort()
      if (harness === "codex") expect(entries.tool.env_vars).toEqual(variables)
      else expect(entries.tool.env).toEqual(Object.fromEntries(variables.map((name) => [name, `${"${"}${name}}`])))
    }
  },
)

test("Nodecode rejects HTTP headers and URL references rather than using a client-scoped bridge", () => {
  expect(nativeMcpSupport("nodecode", remote)).toContain("gateway-scoped")
  expect(nativeMcpSupport("nodecode", { ...remote, headers: {}, url: "https://example.test/${TOKEN}" })).toContain(
    "environment references",
  )
})
