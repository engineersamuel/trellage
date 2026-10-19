import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { captureSourceIdentity } from "./source-identity.ts"

test("source guard detects edits, additions, deletions and modes but ignores generated output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trx-source-identity-"))
  try {
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0)
    await writeFile(path.join(root, ".gitignore"), "output/\n")
    await writeFile(path.join(root, "input.ts"), "original")
    const identity = captureSourceIdentity(root)
    await mkdir(path.join(root, "output"))
    await writeFile(path.join(root, "output/result.json"), "generated")
    await writeFile(path.join(root, "test-performance.json"), "updated evidence")
    identity.assertUnchanged()
    await writeFile(path.join(root, "input.ts"), "edited")
    expect(() => identity.assertUnchanged()).toThrow("results are invalid: input.ts")
    await writeFile(path.join(root, "input.ts"), "original")
    identity.assertUnchanged()
    await chmod(path.join(root, "input.ts"), 0o755)
    expect(() => identity.assertUnchanged()).toThrow("Source changed")
    await chmod(path.join(root, "input.ts"), 0o644)
    await writeFile(path.join(root, "added.ts"), "new")
    expect(() => identity.assertUnchanged()).toThrow("Source changed")
    await rm(path.join(root, "added.ts"))
    await rm(path.join(root, "input.ts"))
    expect(() => identity.assertUnchanged()).toThrow("Source changed")
    await symlink("/etc/passwd", path.join(root, "input.ts"))
    expect(() => captureSourceIdentity(root)).toThrow("symbolic link")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("repository source identity ignores generated native contract fixtures while retaining adjacent source", async () => {
  for (const [parentPath, fixturePath] of [
    ["prototypes/trellage-copilot-profiles", ".contract-fixture.123/bin"],
    ["prototypes/trellage-agency-profiles", ".contract-fixture.123/bin"],
    ["prototypes/trellage-prime-profiles", ".contract-work/fixture/bin"],
    ["tests", ".evidence-contract.123/bin"],
    ["tests", ".harness-runner.123/bin"],
    ["packages/trellage-launcher/test", ".continuation-state-fixture/state"],
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "trx-copilot-fixture-identity-"))
    try {
      expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0)
      await writeFile(
        path.join(root, ".gitignore"),
        await Bun.file(new URL("../../.gitignore", import.meta.url)).text(),
      )
      const parent = path.join(root, parentPath!)
      await mkdir(parent, { recursive: true })
      const source = path.join(parent, "install.sh")
      await writeFile(source, "source")
      const identity = captureSourceIdentity(root)
      const fixture = path.join(parent, fixturePath!)
      await mkdir(fixture, { recursive: true })
      await symlink("/bin/bash", path.join(fixture, "bash"))
      identity.assertUnchanged()
      await writeFile(source, "changed")
      expect(() => identity.assertUnchanged()).toThrow("Source changed")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
