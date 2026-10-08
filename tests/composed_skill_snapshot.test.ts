import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { syncSnapshot, verifyTarget, isComposedSkillSnapshot } from "../scripts/floating-skills.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

test("an explicit empty composition removes managed skills and preserves user skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trx-overlay-"))
  roots.push(root)
  const snapshot = path.join(root, "snapshot")
  const target = path.join(root, "target")
  await mkdir(path.join(snapshot, "skills"), { recursive: true })
  await writeFile(path.join(snapshot, "managed-skills.txt"), "")
  await writeFile(path.join(snapshot, "always-on.md"), "")
  await mkdir(path.join(target, "old"), { recursive: true })
  await mkdir(path.join(target, "custom"))
  await writeFile(path.join(target, "old", "SKILL.md"), "old")
  await writeFile(path.join(target, "custom", "SKILL.md"), "custom")
  await writeFile(path.join(target, ".trellage-managed-skills"), "old\n")
  await expect(syncSnapshot(snapshot, target)).rejects.toThrow("snapshot is empty")
  await writeFile(path.join(snapshot, ".trellage-composition-snapshot"), "1\n", { mode: 0o600 })
  expect(await syncSnapshot(snapshot, target)).toEqual([])
  expect(await verifyTarget(snapshot, target)).toEqual([])
  expect(await readFile(path.join(target, "custom", "SKILL.md"), "utf8")).toBe("custom")
  expect(await readFile(path.join(target, "old", "SKILL.md")).catch(() => undefined)).toBeUndefined()
  await writeFile(path.join(snapshot, ".trellage-composition-snapshot"), "invalid\n")
  await expect(isComposedSkillSnapshot(snapshot)).rejects.toThrow("invalid composed")
})
