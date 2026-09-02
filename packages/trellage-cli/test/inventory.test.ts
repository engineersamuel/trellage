import { chmod, mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { inventoryDirectory, verifyInventory } from "../src/inventory.js"

const temporaryRoots = new Set<string>()

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryRoots.add(root)
  return root
}

afterEach(async () => {
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true })
  temporaryRoots.clear()
})

const fixture = async () => {
  const root = await temporaryDirectory("harness-inventory-")
  await mkdir(path.join(root, "nested"))
  await writeFile(path.join(root, "nested", "asset.txt"), "locked\n")
  const inventory = await Effect.runPromise(inventoryDirectory(root))
  return { root, inventory }
}

const symlinkFixture = async () => {
  const root = await temporaryDirectory("harness-symlink-inventory-")
  await mkdir(path.join(root, "shared", "templates"), { recursive: true })
  await mkdir(path.join(root, "plugins", "hve"), { recursive: true })
  await writeFile(path.join(root, "shared", "file.md"), "shared\n")
  await writeFile(path.join(root, "shared", "templates", "template.md"), "template\n")
  await symlink("../../shared/file.md", path.join(root, "plugins", "hve", "file.md"))
  await symlink("../../shared/templates", path.join(root, "plugins", "hve", "templates"))
  return root
}

const replaceLink = async (link: string, target: string) => {
  await rm(link)
  await symlink(target, link)
}

const maliciousSymlinkFixture = async (kind: string) => {
  const root = await symlinkFixture()
  const inventory = await Effect.runPromise(inventoryDirectory(root, { allowSymlinks: true }))
  const link = path.join(root, "plugins", "hve", "file.md")

  if (kind === "absolute") await replaceLink(link, path.join(root, "shared", "file.md"))
  if (kind === "escape") {
    const outside = await temporaryDirectory("harness-symlink-outside-")
    await writeFile(path.join(outside, "outside.md"), "outside\n")
    await replaceLink(link, path.relative(path.dirname(link), path.join(outside, "outside.md")))
  }
  if (kind === "broken") await replaceLink(link, "../../shared/missing.md")
  if (kind === "cycle") {
    await replaceLink(link, "cycle.md")
    await symlink("file.md", path.join(root, "plugins", "hve", "cycle.md"))
  }
  if (kind === "changed") await replaceLink(link, "../../shared/templates/template.md")
  if (kind === "extra") {
    await symlink("../../shared/file.md", path.join(root, "plugins", "hve", "extra.md"))
  }
  if (kind === "type-changed") {
    await rm(link)
    await writeFile(link, "shared\n")
  }

  return { root, inventory }
}

describe("verified inventories", () => {
  it("accepts an exact regular-file inventory", async () => {
    const { root, inventory } = await fixture()
    await expect(Effect.runPromise(verifyInventory(root, inventory))).resolves.toBeUndefined()
  })

  it("rejects an executable file changed to non-executable", async () => {
    const { root } = await fixture()
    const asset = path.join(root, "nested", "asset.txt")
    await chmod(asset, 0o755)
    const inventory = await Effect.runPromise(inventoryDirectory(root))

    expect(inventory).toContainEqual({
      kind: "file",
      path: "nested/asset.txt",
      sha256: expect.stringMatching(/^sha256:/),
      executable: true,
    })
    await chmod(asset, 0o644)

    await expect(Effect.runPromise(verifyInventory(root, inventory))).rejects.toThrow(/executable/)
  })

  it("rejects a non-executable file changed to executable", async () => {
    const { root, inventory } = await fixture()
    const asset = path.join(root, "nested", "asset.txt")
    await chmod(asset, 0o755)

    await expect(Effect.runPromise(verifyInventory(root, inventory))).rejects.toThrow(/executable/)
  })

  it("can skip executable-bit verification", async () => {
    const { root, inventory } = await fixture()
    await chmod(path.join(root, "nested", "asset.txt"), 0o755)

    await expect(
      Effect.runPromise(verifyInventory(root, inventory, { verifyExecutableBits: false })),
    ).resolves.toBeUndefined()
  })

  it.each(["missing", "extra", "renamed", "hash-mismatched"])("rejects a %s file", async (kind) => {
    const { root, inventory } = await fixture()
    if (kind === "missing") await rm(path.join(root, "nested", "asset.txt"))
    if (kind === "extra") await writeFile(path.join(root, "extra.txt"), "extra")
    if (kind === "renamed")
      await rename(path.join(root, "nested", "asset.txt"), path.join(root, "nested", "renamed.txt"))
    if (kind === "hash-mismatched") await writeFile(path.join(root, "nested", "asset.txt"), "changed")

    await expect(Effect.runPromise(verifyInventory(root, inventory))).rejects.toThrow(/inventory|hash|missing|extra/)
  })

  it("locks and verifies contained Copilot marketplace symlinks", async () => {
    const root = await symlinkFixture()
    const inventory = await Effect.runPromise(inventoryDirectory(root, { allowSymlinks: true }))

    expect(inventory).toContainEqual({
      kind: "symlink",
      path: "plugins/hve/file.md",
      target: "../../shared/file.md",
    })
    expect(inventory.map((entry) => entry.path)).toEqual([
      "plugins/hve/file.md",
      "plugins/hve/templates",
      "shared/file.md",
      "shared/templates/template.md",
    ])
    await expect(Effect.runPromise(verifyInventory(root, inventory, { allowSymlinks: true }))).resolves.toBeUndefined()
  })

  it("accepts a directory target represented only by symlink descendants", async () => {
    const root = await symlinkFixture()
    await mkdir(path.join(root, "shared", "links"))
    await symlink("../file.md", path.join(root, "shared", "links", "file.md"))
    await symlink("../../shared/links", path.join(root, "plugins", "hve", "links"))

    const inventory = await Effect.runPromise(inventoryDirectory(root, { allowSymlinks: true }))

    expect(inventory).toContainEqual({
      kind: "symlink",
      path: "plugins/hve/links",
      target: "../../shared/links",
    })
    expect(inventory).toContainEqual({
      kind: "symlink",
      path: "shared/links/file.md",
      target: "../file.md",
    })
    await expect(Effect.runPromise(verifyInventory(root, inventory, { allowSymlinks: true }))).resolves.toBeUndefined()
  })

  it("accepts a contained symlink chain represented by its real target", async () => {
    const root = await temporaryDirectory("harness-symlink-chain-")
    await mkdir(path.join(root, "links"))
    await mkdir(path.join(root, "shared"))
    await writeFile(path.join(root, "shared", "file.md"), "shared\n")
    await symlink("b", path.join(root, "links", "a"))
    await symlink("../shared/file.md", path.join(root, "links", "b"))

    const inventory = await Effect.runPromise(inventoryDirectory(root, { allowSymlinks: true }))

    expect(inventory).toContainEqual({ kind: "symlink", path: "links/a", target: "b" })
    expect(inventory).toContainEqual({ kind: "symlink", path: "links/b", target: "../shared/file.md" })
    await expect(Effect.runPromise(verifyInventory(root, inventory, { allowSymlinks: true }))).resolves.toBeUndefined()
  })

  it("rejects a symlink chain that escapes the inventory root", async () => {
    const root = await temporaryDirectory("harness-symlink-chain-escape-")
    const outside = await temporaryDirectory("harness-symlink-chain-outside-")
    await mkdir(path.join(root, "links"))
    await writeFile(path.join(outside, "file.md"), "outside\n")
    await symlink("b", path.join(root, "links", "a"))
    await symlink(path.relative(path.join(root, "links"), path.join(outside, "file.md")), path.join(root, "links", "b"))

    await expect(Effect.runPromise(inventoryDirectory(root, { allowSymlinks: true }))).rejects.toThrow(
      /symlink|target|escape/,
    )
  })

  it.each(["absolute", "escape", "broken", "cycle", "changed", "extra", "type-changed"])(
    "rejects a %s marketplace symlink",
    async (kind) => {
      const { root, inventory } = await maliciousSymlinkFixture(kind)

      await expect(Effect.runPromise(verifyInventory(root, inventory, { allowSymlinks: true }))).rejects.toThrow(
        /symlink|inventory|target|cycle|escape/,
      )
    },
  )

  it("rejects a symlink whose lexical target is contained but real target escapes", async () => {
    const { root, inventory } = await maliciousSymlinkFixture("changed")
    const outside = await temporaryDirectory("harness-symlink-realpath-outside-")
    await writeFile(path.join(outside, "outside.md"), "outside\n")
    await symlink(path.relative(path.join(root, "shared"), outside), path.join(root, "shared", "portal"))
    await replaceLink(path.join(root, "plugins", "hve", "file.md"), "../../shared/portal/outside.md")

    await expect(Effect.runPromise(verifyInventory(root, inventory, { allowSymlinks: true }))).rejects.toThrow(
      /symlink|target|escape/,
    )
  })

  it("rejects a symlink when verification policy does not allow it", async () => {
    const root = await symlinkFixture()
    const inventory = await Effect.runPromise(inventoryDirectory(root, { allowSymlinks: true }))

    await expect(Effect.runPromise(verifyInventory(root, inventory))).rejects.toThrow(/symlink rejected/)
  })

  it("still rejects every symlink by default", async () => {
    const root = await symlinkFixture()

    await expect(Effect.runPromise(inventoryDirectory(root))).rejects.toThrow(/symlink rejected/)
  })

  it("rejects duplicate inventory paths", async () => {
    const { root, inventory } = await fixture()

    await expect(Effect.runPromise(verifyInventory(root, [...inventory, inventory[0]!]))).rejects.toThrow(/duplicate/)
  })

  it("rejects a reordered inventory", async () => {
    const root = await symlinkFixture()
    const inventory = await Effect.runPromise(inventoryDirectory(root, { allowSymlinks: true }))

    await expect(
      Effect.runPromise(verifyInventory(root, [...inventory].reverse(), { allowSymlinks: true })),
    ).rejects.toThrow(/inventory path mismatch/)
  })
})
