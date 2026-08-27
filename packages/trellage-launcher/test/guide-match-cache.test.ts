import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { GuideMatchCatalogEntry } from "../src/guide-catalog.js"
import { CachedGuideProvider, defaultGuideMatchCachePath } from "../src/guide-match-cache.js"
import type {
  GuideGenerateResult,
  GuideMatchInput,
  GuideMatchResult,
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

const fakeProvider = (): { readonly provider: GuideProvider; readonly matchCalls: () => number } => {
  let calls = 0
  return {
    provider: {
      match: async (): Promise<GuideMatchResult> => {
        calls += 1
        return matchResult
      },
      generate: async (): Promise<GuideGenerateResult> => generated,
      refine: async (): Promise<GuideRefineResult> => refined,
    },
    matchCalls: () => calls,
  }
}

describe("CachedGuideProvider", () => {
  it("reuses the last identical match without storing the raw intent", async () => {
    const cachePath = await temporaryCachePath()
    const fake = fakeProvider()
    const options = {
      cachePath,
      model: "mai-code-1.1-flash",
      effort: "medium",
      matchPrompt: "Match profiles.",
    }
    const provider = new CachedGuideProvider(fake.provider, options)
    const input: GuideMatchInput = { intent: "Write a LinkedIn post about AI agents", entries }

    expect(await provider.match(input)).toEqual(matchResult)
    expect(await new CachedGuideProvider(fake.provider, options).match(input)).toEqual(matchResult)
    expect(fake.matchCalls()).toBe(1)
    expect(await readFile(cachePath, "utf8")).not.toContain('"intent"')

    await provider.match({ ...input, intent: "Write a technical blog post" })
    expect(fake.matchCalls()).toBe(2)
    await provider.match(input)
    expect(fake.matchCalls()).toBe(3)
  })

  it("invalidates the cache when model or catalog metadata changes", async () => {
    const cachePath = await temporaryCachePath()
    const fake = fakeProvider()
    const input: GuideMatchInput = { intent: "Write a post", entries }
    const first = new CachedGuideProvider(fake.provider, {
      cachePath,
      model: "model-a",
      effort: "medium",
      matchPrompt: "Match profiles.",
    })
    const second = new CachedGuideProvider(fake.provider, {
      cachePath,
      model: "model-b",
      effort: "medium",
      matchPrompt: "Match profiles.",
    })
    const changedPrompt = new CachedGuideProvider(fake.provider, {
      cachePath,
      model: "model-b",
      effort: "medium",
      matchPrompt: "Match profiles with revised instructions.",
    })

    await first.match(input)
    await second.match(input)
    await changedPrompt.match(input)
    await second.match({
      ...input,
      entries: entries.map((entry, index) => (index === 0 ? { ...entry, ref: "sandbox:replacement" } : entry)),
    })

    expect(fake.matchCalls()).toBe(4)
  })

  it("delegates generation and refinement without caching them", async () => {
    const fake = fakeProvider()
    const provider = new CachedGuideProvider(fake.provider, {
      cachePath: await temporaryCachePath(),
      model: "model-a",
      effort: "medium",
      matchPrompt: "Match profiles.",
    })
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
    await expect(
      provider.refine({
        ...generationInput,
        candidate: generated.candidates[0]!,
        feedback: "Make it shorter",
      }),
    ).resolves.toEqual(refined)
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
    const provider = new CachedGuideProvider(fake.provider, {
      cachePath,
      model: "model-a",
      effort: "medium",
      matchPrompt: "Match profiles.",
      onWarning: (message) => warnings.push(message),
    })

    await expect(provider.match({ intent: "Write a post", entries })).resolves.toEqual(matchResult)
    expect(fake.matchCalls()).toBe(1)
    expect(warnings).toHaveLength(1)
  })
})
