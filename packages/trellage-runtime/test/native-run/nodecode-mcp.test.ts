import { afterEach, expect, test } from "bun:test"
import { lstat, mkdir, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { McpServer } from "../../src/mcp-config.ts"
import { prepareNodecodeMcp } from "../../src/native-run/nodecode-mcp.ts"
import { cleanupFixtures, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)
const fixture = async () => {
  const root = await tempRoot("nodecode-mcp")
  const owner = path.join(root, "owner")
  const home = path.join(owner, "state", "home")
  const installed = path.join(root, ".local/share/nodecode/current/src/cells/mcp")
  await mkdir(home, { recursive: true })
  await mkdir(installed, { recursive: true })
  await writeFile(path.join(installed, "nodecode-mcp.asd"), '(defsystem "nodecode-mcp")')
  const config = path.join(home, "config.jsonc")
  const receipt = path.join(owner, "managed", "nodecode-mcp", "ownership.json")
  const environment = {
    HOME: root,
    PATH: "",
    PERPLEXITY_API_KEY: "perplexity-test-secret",
    CONTEXT7_API_KEY: "context7-test-secret",
  }
  const read = async () => Bun.JSONC.parse(await readFile(config, "utf8")) as Record<string, any>
  return { root, owner, home, installed, config, receipt, environment, read }
}
const perplexity: McpServer = {
  type: "stdio",
  enabled: true,
  command: "npx",
  args: ["-y", "@perplexity-ai/mcp-server"],
  env: { PERPLEXITY_API_KEY: "${PERPLEXITY_API_KEY}" },
}
const wrapper = { perplexity: { command: "/pinned/bun", args: ["/runtime/mcp-stdio.ts", "/managed/perplexity.json"] } }

test("Nodecode preserves unrelated JSONC bytes and learns only credential reference names", async () => {
  const f = await fixture()
  const text =
    '{\n  // user comment must remain\n  "update": { "mode": "off" },\n  "mcp": {"custom": true,"servers":{"user":{"command":"user-server"}}},\n  "general": {"theme":"mine"}, // trailing comma\n}\n'
  await writeFile(f.config, text)
  const run = await prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)
  try {
    const config = await f.read()
    const next = await readFile(f.config, "utf8")
    expect(next.slice(0, next.indexOf('"mcp"'))).toBe(text.slice(0, text.indexOf('"mcp"')))
    expect(next.slice(next.indexOf('  "general"'))).toBe(text.slice(text.indexOf('  "general"')))
    expect(config.update).toEqual({ mode: "off" })
    expect(config.mcp.custom).toBe(true)
    expect(config.mcp.servers.user).toEqual({ command: "user-server" })
    expect(config.mcp.servers.perplexity).toEqual(wrapper.perplexity)
    expect(config.mcp.inherit_env_allowlist).toContain("TRX_MCP_ENV_PERPLEXITY_API_KEY")
    expect(config.mcp.inherit_env_allowlist).not.toContain("PERPLEXITY_API_KEY")
    expect(config.mcp.inherit_env_allowlist).toContain("PATH")
    expect(next).not.toContain(f.environment.PERPLEXITY_API_KEY)
    expect(await readFile(f.receipt, "utf8")).not.toContain(f.environment.PERPLEXITY_API_KEY)
    expect((await lstat(f.config)).mode & 0o777).toBe(0o600)
    expect(await readlink(path.join(f.home, "cells", "nodecode-mcp"))).toBe(await realpath(f.installed))
  } finally {
    await run.cleanup()
  }
})

test.each([
  "{}\n",
  "{ // empty\n}\n",
  '{"general":{"theme":"blue"}} // after root\n',
  '{"general":{"theme":"blue"}, /* trailing */ }\n',
])("Nodecode appends MCP without destroying JSONC syntax: %s", async (original) => {
  const f = await fixture()
  await writeFile(f.config, original)
  const run = await prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)
  try {
    expect((await f.read()).mcp.servers.perplexity.command).toBe("/pinned/bun")
  } finally {
    await run.cleanup()
  }
})

test("Nodecode removes omitted or disabled common servers and only its added allowlist entries", async () => {
  const f = await fixture()
  await writeFile(
    f.config,
    '{"mcp":{"servers":{"user":{"command":"user"}},"inherit_env_allowlist":["PATH","USER_KEY"]}}',
  )
  await (await prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)).cleanup()
  await (
    await prepareNodecodeMcp(f.owner, { perplexity: { ...perplexity, enabled: false } }, wrapper, f.environment)
  ).cleanup()
  expect((await f.read()).mcp.servers).toEqual({ user: { command: "user" } })
  expect((await f.read()).mcp.inherit_env_allowlist).toEqual(["PATH", "USER_KEY"])
  await (await prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)).cleanup()
  await (await prepareNodecodeMcp(f.owner, {}, {}, f.environment)).cleanup()
  expect((await f.read()).mcp.servers).toEqual({ user: { command: "user" } })
})

test("Nodecode refuses server collisions and edits without replacing user configuration", async () => {
  const f = await fixture()
  const original = '{"mcp":{"servers":{"perplexity":{"command":"user"}}}}'
  await writeFile(f.config, original)
  await expect(prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)).rejects.toThrow("unowned")
  expect(await readFile(f.config, "utf8")).toBe(original)
  await writeFile(f.config, "{}")
  await (await prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)).cleanup()
  const changed = (await readFile(f.config, "utf8")).replace("/pinned/bun", "/user/bun")
  await writeFile(f.config, changed)
  await expect(prepareNodecodeMcp(f.owner, {}, {}, f.environment)).rejects.toThrow("was edited")
  expect(await readFile(f.config, "utf8")).toBe(changed)
})

test("Nodecode does not touch malformed or symlink configuration and safe errors hide values", async () => {
  const f = await fixture()
  await writeFile(f.config, '{"secret":"DO-NOT-PRINT",')
  await expect(prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)).rejects.toThrow(
    "invalid configuration",
  )
  expect(await readFile(f.config, "utf8")).toContain("DO-NOT-PRINT")
  await rm(f.config)
  const outside = path.join(f.root, "outside")
  await writeFile(outside, "{}")
  await symlink(outside, f.config)
  await expect(prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)).rejects.toThrow("non-regular")
  expect(await readFile(outside, "utf8")).toBe("{}")
})

test("Nodecode rejects duplicate MCP members and refuses symlink managed directories", async () => {
  const f = await fixture()
  await writeFile(f.config, '{"mcp":{},"mcp":{}}')
  await expect(prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)).rejects.toThrow("could not prepare")
  expect(await readFile(f.config, "utf8")).toBe('{"mcp":{},"mcp":{}}')
  await mkdir(path.join(f.owner, "managed"), { recursive: true })
  await rm(path.join(f.owner, "managed", "nodecode-mcp"), { recursive: true })
  const outside = path.join(f.root, "outside")
  await mkdir(outside)
  await symlink(outside, path.join(f.owner, "managed", "nodecode-mcp"))
  await expect(prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)).rejects.toThrow("symlink")
  expect(await readdir(outside)).toEqual([])
})

test("Nodecode leaves an absent common configuration completely unconfigured", async () => {
  const f = await fixture()
  await (await prepareNodecodeMcp(f.owner, {}, {}, f.environment)).cleanup()
  expect(await Bun.file(f.config).exists()).toBe(false)
  expect(await Bun.file(f.receipt).exists()).toBe(false)
})

test("Nodecode uses an already installed MCP cell without assuming ownership", async () => {
  const f = await fixture()
  await mkdir(path.join(f.home, "cells"))
  await symlink(f.installed, path.join(f.home, "cells", "my-mcp"))
  await (await prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)).cleanup()
  expect(await readdir(path.join(f.home, "cells"))).toEqual(["my-mcp"])
  expect(JSON.parse(await readFile(f.receipt, "utf8")).cell).toBeUndefined()
})

test.each([
  { url: "https://example.test/mcp", headers: { Authorization: "Bearer ${CONTEXT7_API_KEY}" } },
  { url: "https://example.test/mcp", headers: { "X-Literal": "public" } },
  { url: "https://example.test/${CONTEXT7_API_KEY}", headers: {} },
])("Nodecode refuses client-scoped HTTP authentication before changing shared state: %j", async (remote) => {
  const f = await fixture()
  const original = '{"general":{"theme":"mine"}}'
  await writeFile(f.config, original)
  await expect(
    prepareNodecodeMcp(
      f.owner,
      {
        remote: { type: "http", enabled: true, ...remote },
      },
      {},
      f.environment,
    ),
  ).rejects.toThrow(/gateway-scoped|environment references/)
  expect(await readFile(f.config, "utf8")).toBe(original)
  expect(await Bun.file(f.receipt).exists()).toBe(false)
})

test("Nodecode HTTP endpoint survives concurrent client cleanup and sequential reattachment", async () => {
  const f = await fixture()
  const remote = { type: "http", enabled: true, url: "https://example.test/mcp", headers: {} } as const
  const first = await prepareNodecodeMcp(f.owner, { remote }, {}, f.environment)
  const initial = await readFile(f.config, "utf8")
  const second = await prepareNodecodeMcp(f.owner, { remote }, {}, f.environment)
  await first.cleanup()
  expect(await readFile(f.config, "utf8")).toBe(initial)
  expect((await f.read()).mcp.servers.remote).toEqual({ transport: "http", url: remote.url })
  await second.cleanup()
  const next = await prepareNodecodeMcp(f.owner, { remote }, {}, f.environment)
  expect(await readFile(f.config, "utf8")).toBe(initial)
  expect((await f.read()).mcp.servers.remote.url).toBe(remote.url)
  await next.cleanup()
})

test("Nodecode resolves missing references before committing configuration", async () => {
  const f = await fixture()
  await writeFile(f.config, '{"general":{"theme":"mine"}}')
  await expect(prepareNodecodeMcp(f.owner, { perplexity }, wrapper, { HOME: f.root, PATH: "" })).rejects.toThrow(
    "could not prepare",
  )
  expect(await readFile(f.config, "utf8")).toBe('{"general":{"theme":"mine"}}')
  expect(await Bun.file(f.receipt).exists()).toBe(false)
})

test("Nodecode retains comments inside custom MCP fields and unowned servers", async () => {
  const f = await fixture()
  const custom = '"custom": { /* custom note */ "enabled": true }'
  const user = '"user": { /* user-owned command */ "command": "user" }'
  await writeFile(
    f.config,
    `{ "mcp": { // MCP notes
 ${custom}, "servers": { ${user} } } }`,
  )
  await (await prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)).cleanup()
  expect(await readFile(f.config, "utf8")).toContain(custom)
  expect(await readFile(f.config, "utf8")).toContain(user)
  expect(await readFile(f.config, "utf8")).toContain("// MCP notes")
  await (await prepareNodecodeMcp(f.owner, {}, {}, f.environment)).cleanup()
  const text = await readFile(f.config, "utf8")
  expect(text).toContain(custom)
  expect(text).toContain(user)
  expect(text).toContain("// MCP notes")
  expect((await f.read()).mcp.servers).toEqual({ user: { command: "user" } })
})

test("Nodecode removes multiple managed members while preserving valid trailing commas", async () => {
  const f = await fixture()
  const one = { type: "http", enabled: true, url: "https://one.test/mcp", headers: {} } as const
  const two = { ...one, url: "https://two.test/mcp" }
  await writeFile(f.config, '{ "mcp": { "servers": { "user": {"command":"user"}, }, }, }')
  await (await prepareNodecodeMcp(f.owner, { one, two }, {}, f.environment)).cleanup()
  await (await prepareNodecodeMcp(f.owner, {}, {}, f.environment)).cleanup()
  expect((await f.read()).mcp.servers).toEqual({ user: { command: "user" } })
})

test("Nodecode rolls back interrupted publication before reconciling selected servers", async () => {
  const f = await fixture()
  const beforeConfig = `{ // keep me
 "general": {"theme":"mine"} }`
  await writeFile(f.config, beforeConfig)
  await (await prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)).cleanup()
  const afterConfig = await readFile(f.config, "utf8")
  const afterReceipt = await readFile(f.receipt, "utf8")
  await rm(f.receipt)
  const journal = path.join(path.dirname(f.receipt), "journal.json")
  await writeFile(journal, JSON.stringify({ schema: 1, beforeConfig, afterConfig, beforeReceipt: null, afterReceipt }))
  await (await prepareNodecodeMcp(f.owner, {}, {}, f.environment)).cleanup()
  expect(await readFile(f.config, "utf8")).toBe(beforeConfig)
  expect(await Bun.file(f.receipt).exists()).toBe(false)
  expect(await Bun.file(journal).exists()).toBe(false)
})

test("Nodecode leaves conflicting recovery state untouched", async () => {
  const f = await fixture()
  await writeFile(f.config, "{}")
  await (await prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)).cleanup()
  const afterConfig = await readFile(f.config, "utf8")
  const afterReceipt = await readFile(f.receipt, "utf8")
  const journal = path.join(path.dirname(f.receipt), "journal.json")
  await writeFile(
    journal,
    JSON.stringify({ schema: 1, beforeConfig: "{}", afterConfig, beforeReceipt: null, afterReceipt }),
  )
  const changed = afterConfig.replace("/pinned/bun", "/operator/bun")
  await writeFile(f.config, changed)
  await expect(prepareNodecodeMcp(f.owner, {}, {}, f.environment)).rejects.toThrow("recovery conflict")
  expect(await readFile(f.config, "utf8")).toBe(changed)
  expect(await Bun.file(journal).exists()).toBe(true)
})

test("Nodecode refuses URL credentials rather than exposing them in native status", async () => {
  const f = await fixture()
  const server = { type: "http", enabled: true, url: "https://user:do-not-log@example.test/mcp", headers: {} } as const
  await expect(prepareNodecodeMcp(f.owner, { remote: server }, {}, f.environment)).rejects.toThrow("could not prepare")
  expect(await Bun.file(f.config).exists()).toBe(false)
})

test("Nodecode managed MCP cell follows the native current-release pointer", async () => {
  const f = await fixture()
  const current = path.join(f.root, ".local/share/nodecode/current")
  const old = path.join(f.root, "native-release-one")
  const next = path.join(f.root, "native-release-two")
  await rm(current, { recursive: true })
  for (const release of [old, next]) {
    await mkdir(path.join(release, "src/cells/mcp"), { recursive: true })
    await writeFile(path.join(release, "src/cells/mcp/nodecode-mcp.asd"), '(defsystem "nodecode-mcp")')
  }
  await symlink(old, current)
  await (await prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)).cleanup()
  const link = path.join(f.home, "cells/nodecode-mcp")
  expect(await readlink(link)).toContain("/current/src/cells/mcp")
  expect(await realpath(link)).toBe(await realpath(path.join(old, "src/cells/mcp")))
  await rm(current)
  await symlink(next, current)
  expect(await realpath(link)).toBe(await realpath(path.join(next, "src/cells/mcp")))
})

test("Nodecode does not adopt a cell-name collision or rewrite configuration for it", async () => {
  const f = await fixture()
  await mkdir(path.join(f.home, "cells/nodecode-mcp"), { recursive: true })
  await writeFile(f.config, '{ "update": {"mode":"off"} }')
  await expect(prepareNodecodeMcp(f.owner, { perplexity }, wrapper, f.environment)).rejects.toThrow(
    "unowned MCP cell collision",
  )
  expect(await readFile(f.config, "utf8")).toBe('{ "update": {"mode":"off"} }')
})
