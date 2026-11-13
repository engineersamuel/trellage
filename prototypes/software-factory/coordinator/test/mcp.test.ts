import { expect, test } from "bun:test"
import * as fs from "node:fs"
import { takeFromFile } from "../src/pi-budget.ts"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { claudeMcp, copilotMcp, mcpNote, perplexityBudget, piLiteral, piMcp, stepMcp, userEnv } from "../src/mcp.ts"

const noKeys = { HOME: "/nowhere", XDG_CONFIG_HOME: "/nowhere" }

test("a missing Perplexity key leaves Perplexity out and tells the worker to use the fallback", () => {
  const m = stepMcp(["perplexity", "context7", "exa"], noKeys)
  expect(Object.keys(m.servers)).toEqual(["context7", "exa"])
  expect(m.missing).toEqual([{ name: "perplexity", reason: "no PERPLEXITY_API_KEY" }])
  expect(mcpNote(m)).toBe(
    "MCP servers for this task: context7, exa. MCP server perplexity is unavailable (no PERPLEXITY_API_KEY); use the fallback.",
  )
})

test("keys come from the env, else the owner-only Trellage env file; an unknown server fails loudly", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-mcp-"))
  const cfg = path.join(dir, "trellage")
  mkdirSync(cfg)
  writeFileSync(path.join(cfg, ".env.local"), "PERPLEXITY_API_KEY=pk\nCONTEXT7_API_KEY=ck\n", {
    mode: 0o600,
  })
  const env = { HOME: "/nowhere", XDG_CONFIG_HOME: dir }
  expect(userEnv("PERPLEXITY_API_KEY", env)).toBe("pk")
  expect(userEnv("PERPLEXITY_API_KEY", { ...env, PERPLEXITY_API_KEY: "envwins" })).toBe("envwins")
  const m = stepMcp(["perplexity", "context7"], env)
  expect(m.servers.perplexity).toMatchObject({ type: "stdio", env: { PERPLEXITY_API_KEY: "pk" } })
  expect(m.servers.context7).toMatchObject({ type: "http", headers: { CONTEXT7_API_KEY: "ck" } })
  chmodSync(path.join(cfg, ".env.local"), 0o644)
  expect(userEnv("PERPLEXITY_API_KEY", env)).toBeUndefined()
  expect(() => stepMcp(["nope"], env)).toThrow("unknown MCP server nope")
})

test("each SDK gets its own config shape", () => {
  const { servers } = stepMcp(["perplexity", "exa"], { ...noKeys, PERPLEXITY_API_KEY: "pk" })
  const c = copilotMcp(servers)
  expect(c.perplexity).toMatchObject({
    type: "local",
    command: "npx",
    tools: ["*"],
    timeout: 600000,
  })
  expect(c.exa).toMatchObject({ type: "http", url: "https://mcp.exa.ai/mcp", tools: ["*"] })
  const cl = claudeMcp(servers)
  // The Claude config goes on the CLI command line: references only, values in the env.
  expect(cl.config.perplexity).toMatchObject({
    type: "stdio",
    env: { PERPLEXITY_API_KEY: "${SF_MCP_PERPLEXITY_PERPLEXITY_API_KEY}" },
  })
  expect(JSON.stringify(cl.config)).not.toContain('"pk"')
  expect(cl.env.SF_MCP_PERPLEXITY_PERPLEXITY_API_KEY).toBe("pk")
  expect(cl.config.exa).toEqual({
    type: "http",
    url: "https://mcp.exa.ai/mcp",
    headers: {},
    timeout: 600000,
  })
  const p = piMcp(servers)
  expect(p.map((e) => [e.name, e.config.exposure, e.config.timeout])).toEqual([
    ["perplexity", "direct", 600],
    ["exa", "direct", 600],
  ])
})

test("Pi values stay literal: no variable, $$ or leading-! expansion", () => {
  expect(piLiteral("a$b")).toBe("a$$b")
  expect(piLiteral("!cmd")).toBe("$!cmd")
  expect(piLiteral("${X}")).toBe("$${X}")
})

test("the Perplexity budget refuses calls over the limits, in every SDK's tool naming", () => {
  const allow = perplexityBudget(3, 1)
  expect(allow("Bash")).toBeNull()
  expect(allow("exa-web_search_exa")).toBeNull()
  expect(allow("perplexity-perplexity_search")).toBeNull()
  expect(allow("mcp__perplexity__perplexity_research")).toBeNull()
  expect(allow("mcp__perplexity__perplexity_research")).toContain("1/1 perplexity_research")
  expect(allow("mcp__perplexity__perplexity_ask")).toBeNull()
  expect(allow("perplexity-perplexity_reason")).toContain("Perplexity budget used (3/3 calls")
})

test("Pi workers and their subagent children share one Perplexity budget file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-budget-"))
  const file = path.join(dir, "b.json")
  writeFileSync(file, JSON.stringify({ max: 2, maxResearch: 1, calls: 0, research: 0 }))
  const take = (n: string) => takeFromFile(file, n, fs)
  expect(take("read")).toBeNull()
  expect(take("mcp__perplexity__perplexity_research")).toBeNull()
  expect(take("mcp__perplexity__perplexity_research")).toContain("1/1 perplexity_research")
  expect(take("mcp__perplexity__perplexity_search")).toBeNull()
  expect(take("mcp__perplexity__perplexity_search")).toContain("2/2 calls")
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ calls: 2, research: 1 })
})
