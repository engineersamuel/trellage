import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

const artifactReadRace = vi.hoisted(() => ({
  artifactPath: "",
  replacementPath: "",
  action: "none" as "none" | "swap" | "grow",
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const [file] = args
      if (artifactReadRace.action === "swap" && file === artifactReadRace.artifactPath) {
        artifactReadRace.action = "none"
        await actual.rm(artifactReadRace.artifactPath)
        await actual.symlink(artifactReadRace.replacementPath, artifactReadRace.artifactPath)
      }
      const handle = await actual.open(...args)
      if (artifactReadRace.action !== "grow" || file !== artifactReadRace.artifactPath) return handle
      artifactReadRace.action = "none"
      return new Proxy(handle, {
        get(target, property) {
          if (property === "stat") {
            return async () => {
              const metadata = await target.stat()
              await actual.appendFile(artifactReadRace.artifactPath, "x".repeat(300_000))
              return metadata
            }
          }
          const value = Reflect.get(target, property, target) as unknown
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    },
  }
})

import { GuideArtifactCache, guidePromptSlug } from "../src/guide-match-cache.js"
import type { GuideGenerateCandidate, GuideMatchResult } from "../src/guide-provider.js"

const temporaryRoots: string[] = []
const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-guide-cache-test-"))
  temporaryRoots.push(root)
  return root
}
afterEach(async () => {
  artifactReadRace.action = "none"
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const routing = {
  match: { model: "match-model", effort: "medium" as const },
  generate: { model: "generate-model", effort: "medium" as const },
  optimize: { model: "optimize-model", effort: "high" as const },
  refine: { model: "refine-model", effort: "medium" as const },
  enrich: { model: "enrich-model", effort: "medium" as const },
}
const prompts = {
  match: "Match profiles.",
  generate: "Generate candidates.",
  optimize: "Optimize candidates.",
  refine: "Refine one candidate.",
  enrich: "Enrich a thin intent.",
}
const matchResult: GuideMatchResult = {
  candidates: ["one", "two", "three"].map((name, index) => ({
    profileRef: `native:cdx/${name}`,
    workflowId: "review",
    confidence: 0.9 - index * 0.1,
    reason: `${name} matches the request.`,
    tradeoff: `${name} has a tradeoff.`,
  })),
}
const candidates: readonly [GuideGenerateCandidate, GuideGenerateCandidate, GuideGenerateCandidate] = [
  { title: "Focused", prompt: "Review the changed code.", notes: "Small scope" },
  { title: "Broad", prompt: "Review the repository architecture.", notes: "Large scope" },
  { title: "Tests", prompt: "Review the test coverage.", notes: "Test focus" },
]
const cacheFor = (cwd: string, warnings: string[] = []) =>
  new GuideArtifactCache({ cwd, routing, prompts, onWarning: (message) => warnings.push(message) })
const matchInput = {
  intent: "Review the architecture",
  entries: [
    { ref: "native:cdx/one", guide: { workflows: [{ id: "review" }] } },
    { ref: "native:cdx/two", guide: { workflows: [{ id: "review" }] } },
    { ref: "native:cdx/three", guide: { workflows: [{ id: "review" }] } },
  ],
}

describe("guidePromptSlug", () => {
  it.each([
    ["Review the architecture", "review"],
    ["  HELLO, world!  ", "hello-w"],
    ["Crème brûlée", "creme-b"],
    ["a---b", "a-b"],
  ])("normalizes %j to the safe maximum-seven-character slug %j", (intent, expected) => {
    expect(guidePromptSlug(intent)).toBe(expected)
    expect(guidePromptSlug(intent)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    expect(guidePromptSlug(intent).length).toBeLessThanOrEqual(7)
  })
  it("uses a deterministic seven-character hash when the intent has no ASCII words", () => {
    expect(guidePromptSlug("日本語")).toMatch(/^[a-f0-9]{7}$/u)
    expect(guidePromptSlug("日本語")).toBe(guidePromptSlug("日本語"))
  })
})

describe("GuideArtifactCache", () => {
  it("round-trips readable match Markdown and reuses its UUID directory", async () => {
    const cwd = await temporaryRoot()
    let calls = 0
    const produce = async () => {
      calls += 1
      return matchResult
    }
    expect(await cacheFor(cwd).match(matchInput, produce)).toEqual(matchResult)
    expect(await cacheFor(cwd).match(matchInput, produce)).toEqual(matchResult)
    expect(calls).toBe(1)

    const guideRoot = path.join(cwd, ".trx-guide")
    const sessions = await readdir(guideRoot)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatch(/^review-[0-9a-f-]{36}$/u)
    const artifact = path.join(guideRoot, sessions[0]!, "1-profile-recommendations.md")
    const markdown = await readFile(artifact, "utf8")
    expect(markdown).toContain("# Profile recommendations")
    expect(markdown).toContain("Review the architecture")
    expect(markdown).toContain("native:cdx/one")
    expect(markdown).toContain("match-model")
    expect(markdown).not.toContain('"schemaVersion":1')
    expect((await lstat(path.join(guideRoot, sessions[0]!))).mode & 0o777).toBe(0o700)
    expect((await lstat(artifact)).mode & 0o777).toBe(0o600)
  })

  it("stores multiple generation selections and refinements without overwriting prior artifacts", async () => {
    const cwd = await temporaryRoot()
    const cache = cacheFor(cwd)
    await cache.match(matchInput, async () => matchResult)
    const generationBase = {
      intent: matchInput.intent,
      workflowId: "review",
      guide: { schemaVersion: 1, workflows: [{ id: "review", promptTemplate: "{{intent}}" }] },
      guideBody: "# Reviewer\nUse this guide.",
      targetTool: "codex",
      fixedFrame: { beforeBody: "/review ", afterBody: "" },
    }
    await cache.generation({ ...generationBase, profileRef: "native:cdx/one" }, async () => ({ candidates }))
    await cache.generation({ ...generationBase, profileRef: "native:cdx/two" }, async () => ({ candidates }))
    await cache.refinement(
      { ...generationBase, profileRef: "native:cdx/one", candidates, candidateIndex: 0, feedback: "Make it shorter" },
      async () => ({ candidate: { ...candidates[0], prompt: "Review the code." } }),
    )
    await cache.refinement(
      {
        ...generationBase,
        profileRef: "native:cdx/one",
        candidates,
        candidateIndex: 1,
        feedback: "Add security concerns",
      },
      async () => ({ candidate: { ...candidates[1], prompt: "Review architecture and security." } }),
    )
    const session = (await readdir(path.join(cwd, ".trx-guide")))[0]!
    const files = await readdir(path.join(cwd, ".trx-guide", session))
    expect(files).toHaveLength(5)
    expect(files.filter((file) => file.startsWith("2-prompt-candidates-"))).toHaveLength(2)
    expect(files.filter((file) => file.startsWith("2-refinement-"))).toHaveLength(2)
    const markdown = await Promise.all(
      files.map((file) => readFile(path.join(cwd, ".trx-guide", session, file), "utf8")),
    )
    expect(markdown.join("\n")).toContain("generate-model (medium) → optimize-model (high)")
    expect(markdown.join("\n")).toContain("Review the changed code.")
    expect(markdown.join("\n")).toContain("Feedback: Make it shorter")
    expect(markdown.join("\n")).toContain("Review architecture and security.")
  })

  it("keys generation and refinement by every model-backed workflow input", async () => {
    const cwd = await temporaryRoot()
    const base = {
      intent: matchInput.intent,
      profileRef: "native:cdx/one",
      workflowId: "review",
      guide: { schemaVersion: 1, workflows: [{ id: "review", promptTemplate: "{{intent}}" }] },
      guideBody: "# Reviewer\nUse this guide.",
      targetTool: "codex",
      fixedFrame: { beforeBody: "/review ", afterBody: "" },
    }
    let generationCalls = 0
    const generate = async () => {
      generationCalls += 1
      return { candidates }
    }
    const cache = cacheFor(cwd)
    await cache.generation(base, generate)
    await cache.generation(base, generate)
    await cache.generation({ ...base, guideBody: `${base.guideBody}\nChanged.` }, generate)
    await cache.generation({ ...base, targetTool: "copilot" }, generate)
    await cache.generation({ ...base, fixedFrame: { beforeBody: "/other ", afterBody: "" } }, generate)
    await new GuideArtifactCache({ cwd, routing, prompts: { ...prompts, generate: "Changed generation." } }).generation(
      base,
      generate,
    )
    await new GuideArtifactCache({
      cwd,
      routing: { ...routing, optimize: { ...routing.optimize, model: "other" } },
      prompts,
    }).generation(base, generate)
    expect(generationCalls).toBe(6)

    let refinementCalls = 0
    const refine = async () => {
      refinementCalls += 1
      return { candidate: candidates[0] }
    }
    const refinement = { ...base, candidates, candidateIndex: 0, feedback: "Shorter" }
    await cache.refinement(refinement, refine)
    await cache.refinement(refinement, refine)
    await cache.refinement({ ...refinement, candidateIndex: 1 }, refine)
    await cache.refinement({ ...refinement, feedback: "More detail" }, refine)
    await cache.refinement(
      { ...refinement, candidates: [{ ...candidates[0], prompt: "Edited" }, candidates[1], candidates[2]] },
      refine,
    )
    await new GuideArtifactCache({ cwd, routing, prompts: { ...prompts, refine: "Changed refinement." } }).refinement(
      refinement,
      refine,
    )
    expect(refinementCalls).toBe(5)
  })

  it("misses generation and refinement when Prompt Master skill content changes", async () => {
    const cwd = await temporaryRoot()
    const skillDirectory = path.join(cwd, "prompt-master")
    await mkdir(skillDirectory)
    await writeFile(path.join(skillDirectory, "SKILL.md"), "version one\n")
    const base = {
      intent: matchInput.intent,
      profileRef: "native:cdx/one",
      workflowId: "review",
      guide: { schemaVersion: 1, workflows: [{ id: "review", promptTemplate: "{{intent}}" }] },
      guideBody: "# Reviewer\nUse this guide.",
      targetTool: "codex",
    }
    let generationCalls = 0
    let refinementCalls = 0
    const refinement = { ...base, candidates, candidateIndex: 0, feedback: "Shorter" }
    const first = new GuideArtifactCache({ cwd, routing, prompts, promptMasterSkillDirectory: skillDirectory })
    await first.generation(base, async () => {
      generationCalls += 1
      return { candidates }
    })
    await first.refinement(refinement, async () => {
      refinementCalls += 1
      return { candidate: candidates[0] }
    })

    await writeFile(path.join(skillDirectory, "SKILL.md"), "version two\n")
    const second = new GuideArtifactCache({ cwd, routing, prompts, promptMasterSkillDirectory: skillDirectory })
    await second.generation(base, async () => {
      generationCalls += 1
      return { candidates }
    })
    await second.refinement(refinement, async () => {
      refinementCalls += 1
      return { candidate: candidates[0] }
    })

    expect(generationCalls).toBe(2)
    expect(refinementCalls).toBe(2)
  })

  it("misses independently when match key inputs change", async () => {
    const cwd = await temporaryRoot()
    let calls = 0
    const produce = async () => {
      calls += 1
      return matchResult
    }
    await cacheFor(cwd).match(matchInput, produce)
    await cacheFor(cwd).match({ ...matchInput, intent: "Review the tests" }, produce)
    await new GuideArtifactCache({
      cwd,
      routing: { ...routing, match: { ...routing.match, model: "other" } },
      prompts,
    }).match(matchInput, produce)
    await new GuideArtifactCache({ cwd, routing, prompts: { ...prompts, match: "Changed match prompt." } }).match(
      matchInput,
      produce,
    )
    await cacheFor(cwd).match(
      {
        ...matchInput,
        entries: [...matchInput.entries, { ref: "native:cdx/four", guide: { workflows: [{ id: "review" }] } }],
      },
      produce,
    )
    expect(calls).toBe(5)
  })

  it("creates a new UUID session when an edited prompt keeps the same slug", async () => {
    const cwd = await temporaryRoot()
    const cache = cacheFor(cwd)
    await cache.match(matchInput, async () => matchResult)
    await cache.match({ ...matchInput, intent: "Review another architecture" }, async () => matchResult)

    const sessions = await readdir(path.join(cwd, ".trx-guide"))
    expect(sessions).toHaveLength(2)
    expect(sessions.every((session) => session.startsWith("review-"))).toBe(true)
  })

  it("preserves the prior fixed-name recommendation artifact when the same session misses", async () => {
    const cwd = await temporaryRoot()
    const cache = cacheFor(cwd)
    await cache.match(matchInput, async () => matchResult)
    await cache.match(
      {
        ...matchInput,
        entries: [...matchInput.entries, { ref: "native:cdx/four", guide: { workflows: [{ id: "review" }] } }],
      },
      async () => matchResult,
    )

    const sessions = await readdir(path.join(cwd, ".trx-guide"))
    expect(sessions).toHaveLength(2)
    await Promise.all(
      sessions.map((session) =>
        readFile(path.join(cwd, ".trx-guide", session, "1-profile-recommendations.md"), "utf8"),
      ),
    )
  })

  it("warns and treats corrupt, oversized, symlinked, and schema-invalid artifacts as misses", async () => {
    const cwd = await temporaryRoot()
    const warnings: string[] = []
    await cacheFor(cwd, warnings).match(matchInput, async () => matchResult)
    const guideRoot = path.join(cwd, ".trx-guide")
    const session = (await readdir(guideRoot))[0]!
    const artifact = path.join(guideRoot, session, "1-profile-recommendations.md")
    await writeFile(artifact, "not an artifact", "utf8")
    await cacheFor(cwd, warnings).match(matchInput, async () => matchResult)
    await writeFile(artifact, "x".repeat(300_000), "utf8")
    await cacheFor(cwd, warnings).match(matchInput, async () => matchResult)
    await rm(artifact)
    await symlink(path.join(cwd, "elsewhere"), artifact)
    await cacheFor(cwd, warnings).match(matchInput, async () => matchResult)
    await rm(artifact)
    await writeFile(artifact, "<!-- trx-guide-artifact:v1:eyJzY2hlbWFWZXJzaW9uIjoyfQ -->\n", { mode: 0o600 })
    await chmod(artifact, 0o600)
    await cacheFor(cwd, warnings).match(matchInput, async () => matchResult)
    expect(warnings.some((warning) => warning.includes("malformed"))).toBe(true)
    expect(warnings.some((warning) => warning.includes("exceeds"))).toBe(true)
    expect(warnings.some((warning) => warning.includes("regular file"))).toBe(true)
    expect(warnings.some((warning) => warning.includes("schema"))).toBe(true)
  })

  it("rejects an artifact path swapped to a symlink immediately before open", async () => {
    const cwd = await temporaryRoot()
    await cacheFor(cwd).match(matchInput, async () => matchResult)
    const session = (await readdir(path.join(cwd, ".trx-guide")))[0]!
    const artifact = path.join(cwd, ".trx-guide", session, "1-profile-recommendations.md")
    const replacement = path.join(cwd, "replacement.md")
    const original = await readFile(artifact, "utf8")
    const [header, ...body] = original.split("\n")
    if (header === undefined) throw new Error("test artifact is empty")
    const encoded = header.match(/^<!-- trx-guide-artifact:v1:([A-Za-z0-9_-]+) -->$/u)?.[1]
    if (encoded === undefined) throw new Error("test artifact is missing its machine header")
    const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      result: GuideMatchResult
    }
    const swappedResult: GuideMatchResult = {
      candidates: [
        { ...envelope.result.candidates[0]!, reason: "Loaded through an unsafe swapped symlink." },
        envelope.result.candidates[1]!,
        envelope.result.candidates[2]!,
      ],
    }
    await writeFile(
      replacement,
      `<!-- trx-guide-artifact:v1:${Buffer.from(JSON.stringify({ ...envelope, result: swappedResult }), "utf8").toString("base64url")} -->\n${body.join("\n")}`,
    )
    artifactReadRace.artifactPath = artifact
    artifactReadRace.replacementPath = replacement
    artifactReadRace.action = "swap"

    const regenerated: GuideMatchResult = {
      candidates: [
        { ...matchResult.candidates[0]!, reason: "Regenerated after rejecting the unsafe artifact." },
        matchResult.candidates[1]!,
        matchResult.candidates[2]!,
      ],
    }
    const result = await cacheFor(cwd).match(matchInput, async () => regenerated)

    expect(result).toEqual(regenerated)
  })

  it("rejects an artifact that grows beyond the bound after its file descriptor is verified", async () => {
    const cwd = await temporaryRoot()
    await cacheFor(cwd).match(matchInput, async () => matchResult)
    const session = (await readdir(path.join(cwd, ".trx-guide")))[0]!
    artifactReadRace.artifactPath = path.join(cwd, ".trx-guide", session, "1-profile-recommendations.md")
    artifactReadRace.action = "grow"
    const regenerated: GuideMatchResult = {
      candidates: [
        { ...matchResult.candidates[0]!, reason: "Regenerated after rejecting the oversized artifact." },
        matchResult.candidates[1]!,
        matchResult.candidates[2]!,
      ],
    }

    expect(await cacheFor(cwd).match(matchInput, async () => regenerated)).toEqual(regenerated)
  })

  it("does not follow a symlinked artifact root", async () => {
    const cwd = await temporaryRoot()
    const outside = await temporaryRoot()
    const warnings: string[] = []
    await symlink(outside, path.join(cwd, ".trx-guide"))

    await expect(cacheFor(cwd, warnings).match(matchInput, async () => matchResult)).resolves.toEqual(matchResult)

    expect(await readdir(outside)).toEqual([])
    expect(warnings.some((warning) => warning.includes("artifact root") && warning.includes("directory"))).toBe(true)
  })
})
