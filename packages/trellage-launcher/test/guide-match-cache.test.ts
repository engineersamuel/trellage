import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { GuideMatchCatalogEntry } from "../src/guide-catalog.js"
import {
  CachedGuideProvider,
  defaultGuideMatchCachePath,
  type CachedGuideProviderOptions,
} from "../src/guide-match-cache.js"
import type {
  GuideGenerateResult,
  GuideMatchInput,
  GuideMatchResult,
  GuideOptimizeResult,
  GuideProvider,
  GuideRefineResult,
} from "../src/guide-provider.js"

const entries: ReadonlyArray<GuideMatchCatalogEntry> = ["one", "two", "three"].map((name) => ({
  ref: `sandbox:${name}`,
  surface: "sandbox",
  name,
  harness: "copilot",
  description: `${name} profile`,
  sandbox: true,
  guide: {
    schemaVersion: 1,
    capabilities: ["writing"],
    bestFor: ["Writing"],
    avoidFor: ["Coding"],
    prerequisites: [],
    workflows: [{ id: "write", description: "Write content.", examples: ["Write a post"] }],
  },
}))

const matchResult: GuideMatchResult = {
  candidates: entries.map((entry, index) => ({
    profileRef: entry.ref,
    workflowId: "write",
    confidence: 0.9 - index * 0.1,
    reason: `${entry.name} matches.`,
    tradeoff: `${entry.name} is specialized.`,
  })),
}

const generated: GuideGenerateResult = {
  candidates: [
    { title: "One", prompt: "First", notes: "First option" },
    { title: "Two", prompt: "Second", notes: "Second option" },
    { title: "Three", prompt: "Third", notes: "Third option" },
  ],
}

const refined: GuideRefineResult = {
  candidate: { title: "Refined", prompt: "Refined prompt", notes: "Refined option" },
}

const temporaryRoots: string[] = []

const temporaryCachePath = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-guide-cache-test-"))
  temporaryRoots.push(root)
  return path.join(root, "last-match.json")
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fakeProvider = (): {
  readonly provider: GuideProvider
  readonly matchCalls: () => number
  readonly generateCalls: () => number
  readonly optimizeCalls: () => number
} => {
  let matchCalls = 0
  let generateCalls = 0
  let optimizeCalls = 0
  return {
    provider: {
      match: async (): Promise<GuideMatchResult> => {
        matchCalls += 1
        return matchResult
      },
      generate: async (): Promise<GuideGenerateResult> => {
        generateCalls += 1
        return generated
      },
      refine: async (): Promise<GuideRefineResult> => refined,
      optimize: async (input): Promise<GuideOptimizeResult> => {
        optimizeCalls += 1
        return { candidates: input.candidates }
      },
    },
    matchCalls: () => matchCalls,
    generateCalls: () => generateCalls,
    optimizeCalls: () => optimizeCalls,
  }
}

const cacheOptions = (cachePath: string, overrides: Partial<CachedGuideProviderOptions> = {}) => ({
  cachePath,
  model: "mai-code-1.1-flash",
  effort: "medium",
  matchPrompt: "Match profiles.",
  generatePrompt: "Generate candidates.",
  optimizePrompt: "Optimize candidates.",
  ...overrides,
})

describe("CachedGuideProvider", () => {
  it("reuses recent identical matches without storing the raw intent", async () => {
    const cachePath = await temporaryCachePath()
    const fake = fakeProvider()
    const options = cacheOptions(cachePath)
    const provider = new CachedGuideProvider(fake.provider, options)
    const input: GuideMatchInput = { intent: "Write a LinkedIn post about AI agents", entries }

    expect(await provider.match(input)).toEqual(matchResult)
    expect(await new CachedGuideProvider(fake.provider, options).match(input)).toEqual(matchResult)
    expect(fake.matchCalls()).toBe(1)
    expect(await readFile(cachePath, "utf8")).not.toContain('"intent"')

    await provider.match({ ...input, intent: "Write a technical blog post" })
    expect(fake.matchCalls()).toBe(2)
    await provider.match(input)
    expect(fake.matchCalls()).toBe(2)
  })

  it("invalidates the cache when model or catalog metadata changes", async () => {
    const cachePath = await temporaryCachePath()
    const fake = fakeProvider()
    const input: GuideMatchInput = { intent: "Write a post", entries }
    const first = new CachedGuideProvider(fake.provider, cacheOptions(cachePath, { model: "model-a" }))
    const second = new CachedGuideProvider(fake.provider, cacheOptions(cachePath, { model: "model-b" }))
    const changedPrompt = new CachedGuideProvider(
      fake.provider,
      cacheOptions(cachePath, { model: "model-b", matchPrompt: "Match profiles with revised instructions." }),
    )

    await first.match(input)
    await second.match(input)
    await changedPrompt.match(input)
    await second.match({
      ...input,
      entries: entries.map((entry, index) => (index === 0 ? { ...entry, ref: "sandbox:replacement" } : entry)),
    })

    expect(fake.matchCalls()).toBe(4)
  })

  it("reuses generated and optimized prompt candidates while refinement remains uncached", async () => {
    const fake = fakeProvider()
    const cachePath = await temporaryCachePath()
    const provider = new CachedGuideProvider(fake.provider, cacheOptions(cachePath, { model: "model-a" }))
    const generationInput = {
      intent: "Write a post",
      profileRef: "sandbox:one",
      workflowId: "write",
      guide: {
        schemaVersion: 1 as const,
        capabilities: ["writing"],
        bestFor: ["Writing"],
        avoidFor: ["Coding"],
        prerequisites: [],
        workflows: [
          {
            id: "write",
            description: "Write content.",
            examples: ["Write a post"],
            promptTemplate: "Write {{intent}}",
          },
        ],
      },
      guideBody: "# One",
    }

    await expect(provider.generate(generationInput)).resolves.toEqual(generated)
    await expect(new CachedGuideProvider(fake.provider, cacheOptions(cachePath, { model: "model-a" })).generate(
      generationInput,
    )).resolves.toEqual(generated)
    await expect(provider.optimize({
      targetTool: "copilot",
      profileRef: generationInput.profileRef,
      candidates: generated.candidates,
    })).resolves.toEqual({ candidates: generated.candidates })
    await expect(new CachedGuideProvider(fake.provider, cacheOptions(cachePath, { model: "model-a" })).optimize({
      targetTool: "copilot",
      profileRef: generationInput.profileRef,
      candidates: generated.candidates,
    })).resolves.toEqual({ candidates: generated.candidates })
    await expect(
      provider.refine({
        ...generationInput,
        candidate: generated.candidates[0]!,
        feedback: "Make it shorter",
      }),
    ).resolves.toEqual(refined)
    expect(fake.generateCalls()).toBe(1)
    expect(fake.optimizeCalls()).toBe(1)
    expect(await readFile(cachePath, "utf8")).not.toContain("Write a post")
  })

  it("uses XDG_CACHE_HOME for the default cache location", () => {
    expect(defaultGuideMatchCachePath({ XDG_CACHE_HOME: "/tmp/custom-cache" })).toBe(
      "/tmp/custom-cache/trellage/trx-guide/last-match.json",
    )
  })

  it("treats a corrupt cache as a visible miss", async () => {
    const cachePath = await temporaryCachePath()
    await writeFile(cachePath, "{invalid", "utf8")
    const fake = fakeProvider()
    const warnings: string[] = []
    const provider = new CachedGuideProvider(
      fake.provider,
      cacheOptions(cachePath, { model: "model-a", onWarning: (message) => warnings.push(message) }),
    )

    await expect(provider.match({ intent: "Write a post", entries })).resolves.toEqual(matchResult)
    expect(fake.matchCalls()).toBe(1)
    expect(warnings).toHaveLength(1)
  })
})
