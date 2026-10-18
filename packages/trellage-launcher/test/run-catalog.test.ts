import { afterEach, expect, test } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, readdir, unlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { loadRunCatalog, toGuideCatalog, assertRunSelectionCurrent } from "../src/run-catalog.ts"
import { parseGuideCatalog, guideMatchCatalogEntries } from "../src/guide-catalog.ts"
import { assertGuideMatchInput, validateGuideMatchResult } from "../src/guide-provider.ts"
import { literalGuideMatch, runGuideMatch, GuideEffort } from "../src/guide-api.ts"
import type { GuideProvider } from "../src/guide-provider.ts"
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(extra = "") {
  const root = await mkdtemp(path.join(os.tmpdir(), "run-catalog-"))
  roots.push(root)
  await mkdir(path.join(root, "bin"))
  await mkdir(path.join(root, "profile-guides"))
  await writeFile(path.join(root, "bin/pi"), "#!/bin/sh\nexit 99\n", { mode: 0o755 })
  const source = `[native.harnesses.pi.selection]\ndescription = "Extension-friendly coding"\nbest_for = ["Custom workflows"]\n[native.profiles.review.selection]\ndescription = "Review local changes"\nbest_for = ["Patch review"]\n${extra}`
  await writeFile(path.join(root, "config.toml"), source)
  return {
    root,
    source,
    options: {
      shippedRoot: root,
      guideRoot: path.join(root, "profile-guides"),
      routerCommandPath: path.join(root, "trx"),
      cwd: root,
      environment: { HOME: root, PATH: path.join(root, "bin"), TRELLAGE_CONFIG: path.join(root, "config.toml") },
    },
  }
}
test("a complete custom profile is shared with Guide without requiring Markdown", async () => {
  const f = await fixture()
  const before = await readdir(f.root)
  const snapshot = await loadRunCatalog(f.options)
  const pi = snapshot.catalog.harnesses.find((x) => x.id === "pi")!
  const profile = pi.profiles.find((x) => x.name === "review")!
  expect(snapshot.catalog.schemaVersion).toBe(2)
  expect(profile.command).toEqual(["trx", "run", "pi", "review"])
  expect(profile.selection.description).toBe("Review local changes")
  expect(profile.selection.weaknesses).toBeNull()
  expect(profile.headless).toBeNull()
  expect(profile.guideEligibility.eligible).toBe(true)
  expect(toGuideCatalog(snapshot).native.map((x) => x.name)).toEqual(["review"])
  const parsed = parseGuideCatalog(JSON.stringify(toGuideCatalog(snapshot)))
  const matching = guideMatchCatalogEntries(parsed)
  expect(matching[0]?.harnessSelection?.description).toBe("Extension-friendly coding")
  expect(matching[0]?.profileSelection?.description).toBe("Review local changes")
  expect(JSON.stringify(matching)).not.toContain("promptTemplate")
  expect(assertGuideMatchInput({ intent: "review my patch", entries: matching }).entries).toHaveLength(1)
  expect(literalGuideMatch(parsed, "review my patch")).toHaveLength(1)
  expect(
    validateGuideMatchResult(
      {
        candidates: [
          {
            profileRef: "native:pi/review",
            workflowId: "task",
            confidence: 0.9,
            reason: "Review workflow",
            tradeoff: "No specialist instructions",
          },
        ],
      },
      new Map([["native:pi/review", new Set(["task"])]]),
    ).candidates,
  ).toHaveLength(1)
  expect(await readdir(f.root)).toEqual(before)
})
test("an incomplete profile stays visible but cannot be recommended", async () => {
  const f = await fixture("[native.profiles.undocumented]\n")
  const snapshot = await loadRunCatalog(f.options)
  const profile = snapshot.catalog.harnesses
    .find((x) => x.id === "pi")!
    .profiles.find((x) => x.name === "undocumented")!
  expect(profile.readiness.status).toBe("ready")
  expect(profile.metadataStatus).toBe("incomplete")
  expect(profile.guideEligibility.reasons).toContain("profile-metadata-incomplete")
  expect(toGuideCatalog(snapshot).native.some((x) => x.name === "undocumented")).toBe(false)
})
test("unavailable profiles are separate from unavailable harnesses and remain explainable", async () => {
  const f = await fixture(
    '[native.profiles.needs-tool]\nprerequisites = [{command="missing-tool",install="never run this"}]\n',
  )
  const snapshot = await loadRunCatalog(f.options)
  expect(
    snapshot.catalog.unavailable.profiles.find((x) => x.harnessId === "pi" && x.name === "needs-tool")?.readiness
      .reasons[0]?.code,
  ).toBe("missing-executable")
  await unlink(path.join(f.root, "bin/pi"))
  const unavailable = await loadRunCatalog(f.options)
  expect(unavailable.catalog.harnesses).toEqual([])
  expect(
    unavailable.catalog.unavailable.harnesses.find((x) => x.id === "pi")?.profiles.some((x) => x.name === "review"),
  ).toBe(true)
  expect(toGuideCatalog(unavailable).native).toEqual([])
  const provider = {
    match: async () => {
      throw new Error("model must not be called")
    },
  } as unknown as GuideProvider
  await expect(
    runGuideMatch(provider, toGuideCatalog(unavailable), {
      intent: "review",
      model: "fixture",
      effort: GuideEffort.Medium,
    }),
  ).rejects.toThrow("No locally ready profiles")
  await expect(assertRunSelectionCurrent(snapshot, "native:pi/review", f.options)).rejects.toThrow("no longer eligible")
})
test("explicit broken instructions exclude Guide without blocking direct runtime", async () => {
  const f = await fixture(
    '[native.profiles.review.guide]\ndocument="missing.md"\nworkflows=[{id="review",description="Review a patch",examples=["Check a patch","Review changes"]}]\n',
  )
  const snapshot = await loadRunCatalog(f.options)
  const profile = snapshot.catalog.harnesses.find((x) => x.id === "pi")!.profiles.find((x) => x.name === "review")!
  expect(profile.readiness.status).toBe("ready")
  expect(profile.guideEligibility.reasons).toContain("workflow-unavailable")
})
test("metadata changes invalidate the shared catalog revision", async () => {
  const f = await fixture()
  const first = await loadRunCatalog(f.options)
  await writeFile(
    path.join(f.root, "config.toml"),
    f.source.replace("Review local changes", "Investigate local changes"),
  )
  const next = await loadRunCatalog(f.options)
  expect(next.revision).not.toBe(first.revision)
  expect(toGuideCatalog(next).native[0]?.description).toBe("Investigate local changes")
  await expect(assertRunSelectionCurrent(first, "native:pi/review", f.options)).rejects.toThrow("guidance changed")
})
