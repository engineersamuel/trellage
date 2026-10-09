import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it } from "vitest"
import { captureIntermediateReviewArtifacts } from "../src/review-artifacts.ts"

const roots: string[] = []
const workspace = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-artifacts-"))
  roots.push(root)
  const reports = path.join(root, "docs", "review")
  await mkdir(reports, { recursive: true, mode: 0o700 })
  return { root, reports }
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it("retains more than 64 batch artifacts with distinct reviewer attribution", async () => {
  const { root, reports } = await workspace()
  for (let index = 1; index <= 96; index++)
    await writeFile(path.join(reports, `fleet-batch-${index}-worker.txt`), "Worker result.", { mode: 0o600 })
  const artifacts = await captureIntermediateReviewArtifacts(root, "fleet")
  expect(artifacts).toHaveLength(96)
  expect(new Set(artifacts.map((artifact) => artifact.id)).size).toBe(96)
  expect(artifacts.every((artifact) => artifact.checkId === "fleet")).toBe(true)
})

it("bounds aggregate artifact bytes without dropping files", async () => {
  const { root, reports } = await workspace()
  const content = "x".repeat(1_000_000)
  for (let index = 0; index < 32; index++)
    await writeFile(path.join(reports, `ponytail-batch-${index}-report.md`), content, { mode: 0o600 })
  expect(await captureIntermediateReviewArtifacts(root, "ponytail")).toHaveLength(32)
  await writeFile(path.join(reports, "overflow.txt"), "x", { mode: 0o600 })
  await expect(captureIntermediateReviewArtifacts(root, "ponytail")).rejects.toThrow("32 MB")
})

it("does not follow a batched report symlink", async () => {
  const { root, reports } = await workspace()
  const outside = path.join(root, "outside")
  await writeFile(outside, "Not a report.", { mode: 0o600 })
  await symlink(outside, path.join(reports, "fleet-batch-1-worker.txt"))
  await expect(captureIntermediateReviewArtifacts(root, "fleet")).rejects.toMatchObject({ code: "ELOOP" })
})

it("attributes identical arbitrary filenames to their explicit check, never their spelling", async () => {
  for (const checkId of ["fleet", "ponytail", "matt-code-review"] as const) {
    const { root, reports } = await workspace()
    await writeFile(path.join(reports, "fleet-worker-1.json"), "{}", { mode: 0o600 })
    const [artifact] = await captureIntermediateReviewArtifacts(root, checkId)
    expect(artifact).toMatchObject({ id: `${checkId}:fleet-worker-1.json`, checkId, name: "fleet-worker-1.json" })
  }
})

it("fails closed on an unregistered artifact in a mixed-check workspace", async () => {
  const { root, reports } = await workspace()
  await writeFile(path.join(reports, "unknown.md"), "Report", { mode: 0o600 })
  await expect(captureIntermediateReviewArtifacts(root, new Map())).rejects.toThrow("explicit check owner")
})

it("rejects a linked report directory before listing its contents", async () => {
  const { root, reports } = await workspace()
  const outside = path.join(root, "outside")
  await mkdir(outside, { mode: 0o700 })
  await writeFile(path.join(outside, "report.md"), "Not owned evidence", { mode: 0o600 })
  await rm(reports, { recursive: true })
  await symlink(outside, reports)
  await expect(captureIntermediateReviewArtifacts(root, "fleet")).rejects.toThrow("Unsafe report artifact directory")
})

it(
  "retains 4096 files and rejects the next artifact rather than truncating",
  async () => {
    const { root, reports } = await workspace()
    for (let index = 0; index < 4096; index++)
      await writeFile(path.join(reports, `${index}.txt`), "", { mode: 0o600 })
    expect(await captureIntermediateReviewArtifacts(root, "matt-code-review")).toHaveLength(4096)
    await writeFile(path.join(reports, "overflow.txt"), "", { mode: 0o600 })
    await expect(captureIntermediateReviewArtifacts(root, "matt-code-review")).rejects.toThrow("4096")
  },
  15_000,
)
