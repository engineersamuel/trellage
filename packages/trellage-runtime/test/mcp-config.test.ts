import { expect, test } from "bun:test"
import { Effect } from "effect"
import { stringify } from "smol-toml"
import { parseTrellageConfig } from "../src/native-config.ts"

const parse = (mcp: Record<string, unknown>) => Effect.runPromise(parseTrellageConfig(stringify({ mcp })))

test("MCP configuration is absent unless declared", async () => {
  const config = await Effect.runPromise(parseTrellageConfig("schema_version = 1\n"))
  expect(Object.hasOwn(config, "mcp")).toBe(false)
  expect((await parse({})).mcp).toEqual({ servers: {} })
})

test("common stdio servers retain environment references and default optional fields", async () => {
  const config = await parse({
    servers: {
      perplexity: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@perplexity-ai/mcp-server"],
        env: { PERPLEXITY_API_KEY: "${PERPLEXITY_API_KEY}" },
      },
      local: { type: "stdio", command: "/path with spaces/server" },
    },
  })
  expect(config.mcp).toEqual({
    servers: {
      perplexity: {
        type: "stdio",
        enabled: true,
        command: "npx",
        args: ["-y", "@perplexity-ai/mcp-server"],
        env: { PERPLEXITY_API_KEY: "${PERPLEXITY_API_KEY}" },
      },
      local: {
        type: "stdio",
        enabled: true,
        command: "/path with spaces/server",
        args: [],
        env: {},
      },
    },
  })
})

test.each(["http", "sse"])("common %s servers retain header references and explicit enabled state", async (type) => {
  const config = await parse({
    servers: {
      context7: {
        type,
        url: "https://mcp.context7.com/mcp",
        headers: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}", Authorization: "Bearer ${TOKEN}" },
      },
      disabled: { type, url: "http://localhost:8080/mcp", enabled: false },
    },
  })
  expect(config.mcp).toEqual({
    servers: {
      context7: {
        type,
        enabled: true,
        url: "https://mcp.context7.com/mcp",
        headers: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}", Authorization: "Bearer ${TOKEN}" },
      },
      disabled: { type, enabled: false, url: "http://localhost:8080/mcp", headers: {} },
    },
  })
})

test.each([
  {},
  { command: "server" },
  { type: "stdio" },
  { type: "stdio", command: "" },
  { type: "stdio", command: "  " },
  { type: "stdio", command: "server\n" },
  { type: "stdio", command: "server", args: "--argument" },
  { type: "stdio", command: "server", args: ["\0"] },
  { type: "stdio", command: "server", env: { "NOT-A-VAR": "value" } },
  { type: "stdio", command: "server", url: "https://example.com/mcp" },
  { type: "stdio", command: "server", headers: {} },
  { type: "http", url: "https://example.com/mcp", command: "server" },
  { type: "http", url: "https://example.com/mcp", args: [] },
  { type: "http", url: "https://example.com/mcp", env: {} },
  { type: "sse", url: "https://example.com/mcp", transport: "sse" },
  { type: "http" },
  { type: "http", url: "https://example.com/mcp", headers: { "Bad Header": "value" } },
  {
    type: "http",
    url: "https://example.com/mcp",
    headers: { Authorization: "value\r\nInjected: yes" },
  },
  { type: "http", url: "https://example.com/mcp", headers: { Authorization: 42 } },
  { type: "http", url: "https://example.com/mcp", enabled: "true" },
  { type: "unknown", url: "https://example.com/mcp" },
])("rejects malformed MCP server definitions %#", async (server) => {
  await expect(parse({ servers: { example: server } })).rejects.toThrow("invalid [mcp] configuration")
})

test.each([
  "ftp://example.com/mcp",
  "file:///tmp/mcp",
  "not-a-url",
  "https://",
  "https:example.com",
  "https://example.com/has space",
  "https://example.com/\u001f",
  "",
])("rejects invalid remote URL %#", async (url) => {
  await expect(parse({ servers: { example: { type: "http", url } } })).rejects.toThrow("invalid [mcp] configuration")
})

test.each(["../outside", "/absolute", "Uppercase", "has space", "has.dot", "has_under", "", "server\n", "__proto__"])(
  "rejects invalid MCP server name %#",
  async (name) => {
    await expect(parse({ servers: { [name]: { type: "stdio", command: "server" } } })).rejects.toThrow(
      "invalid [mcp] configuration",
    )
  },
)

test("rejects unimplemented per-harness options and unknown common settings", async () => {
  await expect(parse({ harnesses: { claude: { exclude: ["context7"] } } })).rejects.toThrow(
    "invalid [mcp] configuration",
  )
  await expect(parse({ servers: {}, unknown: true })).rejects.toThrow("invalid [mcp] configuration")
})

test("MCP validation errors identify locations without exposing values", async () => {
  const result = await Effect.runPromise(
    Effect.either(
      parseTrellageConfig(
        stringify({
          mcp: {
            servers: {
              private: {
                type: "http",
                url: "secret-value-not-a-url",
                headers: { Authorization: "secret-header" },
              },
            },
          },
        }),
      ),
    ),
  )
  expect(result._tag).toBe("Left")
  if (result._tag !== "Left") throw new Error("Expected validation failure")
  expect(result.left.message).toContain("servers.private.url")
  expect(result.left.message).not.toContain("secret-value-not-a-url")
  expect(result.left.message).not.toContain("secret-header")
})
