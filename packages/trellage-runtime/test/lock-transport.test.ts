import { afterEach, expect, test } from "bun:test"
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { registryTransportLock, withRegistryTransport } from "../src/lock-transport.ts"

const canonical =
  '{\n  "packages": {\n    "@scope/tool": ["@scope/tool@1.2.3", "", {}, "sha512-fixed"],\n    "other": ["other@1.0.0", "https://other.example/tool.tgz", {}, "sha512-other"]\n  }\n}\n'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "source-lock-")))
  roots.push(root)
  writeFileSync(path.join(root, "bun.lock"), canonical)
  return root
}

test("changes only empty package transport URLs, preserving graph and integrity", () => {
  expect(registryTransportLock(canonical, "https://registry.example/npm")).toBe(
    canonical.replace(
      '["@scope/tool@1.2.3", ""',
      '["@scope/tool@1.2.3", "https://registry.example/npm/@scope/tool/-/tool-1.2.3.tgz"',
    ),
  )
})

test.each([
  "http://registry.example/",
  "https://user:pass@registry.example/",
  "https://registry.example/?key=value",
  "https://registry.example/#fragment",
])("rejects unsafe registry transport %s", (registry) => {
  expect(() => registryTransportLock(canonical, registry)).toThrow()
})

for (const fail of [false, true]) {
  test(`restores exact canonical bytes after ${fail ? "failed" : "successful"} installation`, async () => {
    const root = fixture()
    const install = withRegistryTransport(root, "https://registry.example/", async () => {
      expect(readFileSync(path.join(root, "bun.lock"), "utf8")).toContain("https://registry.example/@scope/tool/")
      if (fail) throw new Error("installation cancelled")
    })
    if (fail) await expect(install).rejects.toThrow("installation cancelled")
    else await install
    expect(readFileSync(path.join(root, "bun.lock"), "utf8")).toBe(canonical)
    expect(existsSync(path.join(root, ".trellage-install-lock"))).toBe(false)
  })
}

test("refuses concurrent preparation and hard-linked locks", async () => {
  const root = fixture()
  mkdirSync(path.join(root, ".trellage-install-lock"))
  await expect(withRegistryTransport(root, undefined, async () => {})).rejects.toThrow()
  rmSync(path.join(root, ".trellage-install-lock"), { recursive: true })
  linkSync(path.join(root, "bun.lock"), path.join(root, "linked"))
  await expect(withRegistryTransport(root, "https://registry.example/", async () => {})).rejects.toThrow("hard-linked")
  expect(readFileSync(path.join(root, "bun.lock"), "utf8")).toBe(canonical)
})

test("retains canonical recovery bytes when the lock inode is replaced", async () => {
  const root = fixture()
  await expect(
    withRegistryTransport(root, "https://registry.example/", async () => {
      renameSync(path.join(root, "bun.lock"), path.join(root, "moved.lock"))
      writeFileSync(path.join(root, "bun.lock"), "replacement")
    }),
  ).rejects.toThrow("canonical backup retained")
  expect(readFileSync(path.join(root, "bun.lock"), "utf8")).toBe("replacement")
  expect(readFileSync(path.join(root, ".trellage-install-lock/bun.lock"), "utf8")).toBe(canonical)
})
