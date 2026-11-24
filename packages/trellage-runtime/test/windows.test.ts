import { afterEach, expect, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { assertWindowsDescriptor, assertWindowsPermissions } from "../src/windows-permissions.ts"
import { windowsProcessStart } from "../src/windows-process.ts"
import { windowsRoute } from "../src/windows-router.ts"
import { executableOnPath } from "../src/native-run/requirements.ts"
import { admitWindowsClaude } from "../src/native-run/windows-claude.ts"
import { parseRunArguments, prepareRun } from "../src/native-run/run.ts"
import { acquireLease, hasLiveLease } from "../src/native-run/lease.ts"
import { formatStatusline } from "../../../scripts/trellage-statusline.ts"

const roots: string[] = []
const fixture = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "trellage-windows-test-"))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const sidBytes = (sid: string): Buffer => {
  const parts = sid.split("-").slice(2).map(Number)
  const bytes = Buffer.alloc(8 + (parts.length - 1) * 4)
  bytes[0] = 1
  bytes[1] = parts.length - 1
  bytes.writeUIntBE(parts[0]!, 2, 6)
  parts.slice(1).forEach((part, index) => bytes.writeUInt32LE(part, 8 + index * 4))
  return bytes
}
const owner = "S-1-5-21-1-2-3-1001"
const descriptor = (grants: Array<{ sid: string; mask: number }>): Uint8Array => {
  const ownerBytes = sidBytes(owner)
  const entries = grants.map(({ sid, mask }) => {
    const principal = sidBytes(sid)
    const entry = Buffer.alloc(8 + principal.length)
    entry.writeUInt16LE(entry.length, 2)
    entry.writeUInt32LE(mask, 4)
    principal.copy(entry, 8)
    return entry
  })
  const aclOffset = 20 + ownerBytes.length
  const bytes = Buffer.alloc(aclOffset + 8 + entries.reduce((sum, entry) => sum + entry.length, 0))
  bytes[0] = 1
  bytes.writeUInt16LE(0x8004, 2)
  bytes.writeUInt32LE(20, 4)
  bytes.writeUInt32LE(aclOffset, 16)
  ownerBytes.copy(bytes, 20)
  bytes[aclOffset] = 2
  bytes.writeUInt16LE(bytes.length - aclOffset, aclOffset + 2)
  bytes.writeUInt16LE(entries.length, aclOffset + 4)
  let offset = aclOffset + 8
  for (const entry of entries) {
    entry.copy(bytes, offset)
    offset += entry.length
  }
  return bytes
}

test("Windows ACLs reject broad writes and private reads without rejecting administrative access", () => {
  const own = { sid: owner, mask: 0x1f01ff }
  const admins = { sid: "S-1-5-32-544", mask: 0x1f01ff }
  const publicRead = { sid: "S-1-5-11", mask: 0x120089 }
  expect(() => assertWindowsDescriptor(descriptor([own, admins, publicRead]), owner)).not.toThrow()
  expect(() => assertWindowsDescriptor(descriptor([own, publicRead]), owner, true)).toThrow("accessible")
  for (const mask of [0x40000000, 0x10000000, 0x10000, 0x40000, 0x80000, 2, 4, 0x40])
    expect(() => assertWindowsDescriptor(descriptor([own, { sid: "S-1-5-11", mask }]), owner)).toThrow("writable")
  const nullAcl = descriptor([own])
  new DataView(nullAcl.buffer).setUint32(16, 0, true)
  expect(() => assertWindowsDescriptor(nullAcl, owner)).toThrow("null DACL")
  expect(() => assertWindowsDescriptor(nullAcl.subarray(0, 12), owner)).toThrow("invalid")
})

test("Windows routing preserves argument vectors and rejects unsupported routes", () => {
  const args = ["run", "claude", "default", "--", "-p", 'spaces & "quotes"']
  expect(windowsRoute(args)?.args).toEqual(args.slice(1))
  expect(windowsRoute(["run", "--help"])).toBeUndefined()
  expect(windowsRoute(["doctor", "claude", "default"])?.args).toEqual(["doctor"])
  expect(() => windowsRoute(["run", "copilot"])).toThrow("native Windows")
  expect(() => windowsRoute(["doctor", "claude", "default", "--unexpected"])).toThrow()
})

test("native status line handles Windows paths, durations, context, and terminal-control input", () => {
  expect(
    formatStatusline({
      workspace: { current_dir: "C:\\projects\\repo" },
      cost: { total_duration_ms: 3_720_000 },
      context_window: { used_percentage: 12.9 },
      model: { display_name: "Opus\x1b" },
      effort: { level: "medium" },
    }),
  ).toBe("repo \u2502 1h2m \u2502 12% ctx \u2502 Opus medium")
  expect(formatStatusline({})).toBe("")
})

test.skipIf(process.platform !== "win32")("real Windows ACL inspection rejects an explicit broad write grant", () => {
  const file = path.join(fixture(), "owned.txt")
  writeFileSync(file, "fixture")
  expect(() => assertWindowsPermissions(file)).not.toThrow()
  const grant = spawnSync("icacls.exe", [file, "/grant", "*S-1-5-11:(M)"], { encoding: "utf8" })
  expect(grant.status, grant.stderr).toBe(0)
  expect(() => assertWindowsPermissions(file)).toThrow("writable")
})

test.skipIf(process.platform !== "win32")(
  "Windows executable lookup finds native exe files with spaces in PATH",
  async () => {
    const root = path.join(fixture(), "path with spaces")
    mkdirSync(root)
    writeFileSync(path.join(root, "tool.exe"), "")
    expect(await executableOnPath("tool", { PATH: root })).toBe(path.join(root, "tool.exe"))
    expect(await executableOnPath("tool", { Path: root })).toBe(path.join(root, "tool.exe"))
    expect(await executableOnPath("missing", { PATH: root })).toBeUndefined()
  },
)

test.skipIf(process.platform !== "win32")("Windows generation leases preserve a live process identity", async () => {
  const root = fixture()
  const paths = { cache: root, data: root, state: root }
  expect(windowsProcessStart(process.pid)).not.toBeNull()
  const lease = await acquireLease(paths, "generation")
  expect(await hasLiveLease(paths, "generation")).toBe(true)
  await lease.release()
  expect(await hasLiveLease(paths, "generation")).toBe(false)
})

test.skipIf(process.platform !== "win32")(
  "native Claude admission resolves the executable and fails closed on missing proxy models",
  async () => {
    const root = fixture()
    const config = path.join(root, "config.toml")
    writeFileSync(config, "schema_version = 1\n[environment]\nenabled = false\n")
    const environment = { ...process.env, TRELLAGE_CONFIG: config, TRELLAGE_CLAUDE_BIN: process.execPath }
    const prepared = await prepareRun(parseRunArguments(["claude", "--no-always", "--dry-run"]), {
      environment,
      paths: { cache: path.join(root, "cache"), data: path.join(root, "data"), state: path.join(root, "state") },
      cwd: root,
    })
    const input = {
      layout: prepared.layout,
      plan: prepared.plan,
      environment,
      workspace: root,
      forwardedArgs: [],
      resumeArgs: [],
    }
    let models = ["claude-sonnet-5.5", "claude-opus-5.5"]
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (url: Parameters<typeof fetch>[0]) =>
          Response.json(String(url).endsWith("/health") ? { status: "ok" } : { data: models.map((id) => ({ id })) }),
        { preconnect: fetch.preconnect },
      ),
    )
    try {
      expect((await admitWindowsClaude(input, prepared.launch)).command).toBe(process.execPath)
      models = ["claude-sonnet-5.5"]
      await expect(admitWindowsClaude(input, prepared.launch)).rejects.toThrow("claude-opus-5.5")
    } finally {
      fetchMock.mockRestore()
    }
  },
)
