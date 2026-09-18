import { mkdtemp, rm, readdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseGuideCatalog, type CombinedGuideCatalog } from "../src/guide-catalog.ts"
import { GuideArtifactCache } from "../src/guide-match-cache.ts"
import { GuideEffort, runGuideMatch, prefilterGuideMatchCatalogEntries } from "../src/guide-api.ts"
import { prepareGuideGoal } from "../src/guide-goal-execution.ts"
import type { GuideMatchAdapter, GuideProvider } from "../src/guide-provider.ts"

const guide = (goal = false) => ({
  schemaVersion: 1,
  capabilities: ["implementation"],
  bestFor: ["Implementation work", "Repository changes"],
  avoidFor: ["Unrelated work", "Quick lookups"],
  prerequisites: [],
  workflows: [
    {
      id: "implement",
      description: "Implement the change",
      examples: ["implement this", "ship this"],
      promptTemplate: "{{intent}}",
    },
  ],
  ...(goal ? { goalExecution: { controller: "claude-goal", workflowIds: ["implement"] } } : {}),
})

const catalog = (goalCompatible = false): CombinedGuideCatalog =>
  parseGuideCatalog(
    JSON.stringify({
      schemaVersion: 1,
      sandboxCommandPath: "/opt/trellage/bin/trellage",
      native: [],
      sandbox: Array.from({ length: 16 }, (_, index) => ({
        name: `profile-${index}`,
        description: `Profile ${index}`,
        guide: guide(goalCompatible),
        path: `/profiles/profile-${index}/profile.toml`,
        supportedPlatforms: ["linux/amd64"],
        harness: { kind: goalCompatible ? "claude" : "copilot", version: "1" },
        resolutionPolicy: "floating",
        locallyResolved: false,
        releaseLockAvailable: false,
        skillBundles: ["sandbox-common"],
        skillsMode: "floating",
        finalDigestLocked: false,
        skills: [],
        plugins: [],
        mcps: [],
        sandbox: true,
        headless: {
          schemaVersion: 1,
          prompt: true,
          outputFormats: ["json"],
          eventContract: null,
          trellageEventContract: null,
          sessionId: "native",
          resume: false,
          resumeWithPrompt: false,
          questionToolControl: "hard-deny",
          changedFiles: "native",
          usage: true,
          cost: true,
          modelOverride: false,
          effortOverride: false,
          testedHarnessVersion: null,
        },
        locked: false,
        herdrCompatibility: { status: "supported" },
      })),
    }),
  )

const resultFor = (refs: string[]) => ({
  candidates: refs
    .slice(0, 3)
    .map((profileRef, index) => ({
      profileRef,
      workflowId: "implement",
      confidence: 0.9 - index / 10,
      reason: "fits",
      tradeoff: "tradeoff",
    })),
})
const provider = (calls: { legacy: unknown[] }): GuideProvider => ({
  match: async (input) => {
    calls.legacy.push(input)
    return resultFor(input.entries.slice(0, 3).map((entry) => entry.ref))
  },
  generate: async () => ({ candidates: [] }),
  refine: async () => ({ candidate: { title: "", prompt: "", notes: "" } }),
  optimize: async () => ({ candidates: [] }),
})
const matcher = (calls: { matcher: unknown[]; fail?: boolean }): GuideMatchAdapter => ({
  execution: { backend: "jev", model: "jev-1.13.0" },
  revision: "test",
  match: async (input) => {
    calls.matcher.push(input)
    if (calls.fail) throw new Error("matcher unavailable")
    return resultFor(input.entries.slice(0, 3).map((entry) => entry.ref))
  },
})
const routing = {
  match: { model: "m", effort: GuideEffort.Medium },
  generate: { model: "m", effort: GuideEffort.Medium },
  optimize: { model: "m", effort: GuideEffort.Medium },
  refine: { model: "m", effort: GuideEffort.Medium },
  enrich: { model: "m", effort: GuideEffort.Medium },
}
const prompts = { match: "match", generate: "generate", optimize: "optimize", refine: "refine", enrich: "enrich" }
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("guide match service", () => {
  it("passes the complete catalog to Jev while retaining the smaller legacy input", async () => {
    const calls = { legacy: [] as unknown[], matcher: [] as unknown[] }
    await runGuideMatch(
      provider(calls),
      catalog(),
      { intent: "Use sandbox:profile-0 to implement the change", model: "copilot", effort: GuideEffort.Medium },
      undefined,
      { matcher: matcher(calls) },
    )
    expect((calls.matcher[0] as { entries: unknown[] }).entries).toHaveLength(16)
    const pruned = prefilterGuideMatchCatalogEntries(catalog(), "Use sandbox:profile-0 to implement the change")
    expect(pruned).toHaveLength(12)
    const omitted = catalog()
      .sandbox.map(({ name }) => `sandbox:${name}`)
      .find((ref) => !pruned.some((entry) => entry.ref === ref))
    expect((calls.matcher[0] as { entries: { ref: string }[] }).entries.some(({ ref }) => ref === omitted)).toBe(true)
    expect(calls.legacy).toHaveLength(0)
  })

  it("uses the exact legacy provider input after a matcher failure", async () => {
    const calls = { legacy: [] as unknown[], matcher: [] as unknown[], fail: true }
    const request = {
      intent: "Use sandbox:profile-0 to implement the change",
      model: "copilot",
      effort: GuideEffort.Medium,
    }
    await runGuideMatch(provider(calls), catalog(), request, undefined, { matcher: matcher(calls) })
    expect(calls.legacy).toHaveLength(1)
    const direct: { legacy: unknown[]; matcher: unknown[] } = { legacy: [], matcher: [] }
    await runGuideMatch(provider(direct), catalog(), request)
    expect(calls.legacy[0]).toEqual(direct.legacy[0])
  })

  it("does not invoke legacy fallback for cancellation", async () => {
    const cancelled = new AbortController()
    cancelled.abort()
    const calls = { legacy: [] as unknown[], matcher: [] as unknown[] }
    await expect(
      runGuideMatch(
        provider(calls),
        catalog(),
        { intent: "Implement", model: "copilot", effort: GuideEffort.Medium },
        undefined,
        { matcher: matcher(calls), signal: cancelled.signal },
      ),
    ).rejects.toThrow()
    expect(calls.legacy).toHaveLength(0)
  })

  it("keeps Jev and Copilot artifacts isolated and reuses a Jev cache hit with one attempt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "guide-match-service-"))
    roots.push(root)
    const cache = new GuideArtifactCache({ cwd: root, routing, prompts })
    const first = { legacy: [] as unknown[], matcher: [] as unknown[] }
    const request = { intent: "Implement the change", model: "copilot", effort: GuideEffort.Medium }
    const firstResponse = await runGuideMatch(provider(first), catalog(), request, cache, { matcher: matcher(first) })
    const second = { legacy: [] as unknown[], matcher: [] as unknown[] }
    const secondResponse = await runGuideMatch(
      provider(second),
      catalog(),
      { ...request, model: "different", effort: GuideEffort.High },
      cache,
      { matcher: matcher(second) },
    )
    expect(firstResponse.execution).toEqual({ backend: "jev", model: "jev-1.13.0" })
    expect(secondResponse.execution).toEqual(firstResponse.execution)
    expect(second.matcher).toHaveLength(0)
    expect(second.legacy).toHaveLength(0)
  })

  it("refreshes capabilities after a match, including when the match is a cache hit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "guide-match-capabilities-"))
    roots.push(root)
    const cache = new GuideArtifactCache({ cwd: root, routing, prompts })
    const events: string[] = []
    const refreshed = (source: CombinedGuideCatalog): CombinedGuideCatalog => ({
      ...source,
      sandbox: source.sandbox.map((entry, index) =>
        index === 0 ? { ...entry, headless: { ...entry.headless, prompt: false } } : entry,
      ),
    })
    const resolveCatalog = async (): Promise<CombinedGuideCatalog> => {
      events.push("resolve")
      return refreshed(catalog())
    }
    const options = {
      matcher: {
        execution: { backend: "jev" as const, model: "jev-1.13.0" },
        revision: "test",
        match: async (input: Parameters<GuideMatchAdapter["match"]>[0]) => {
          events.push("match")
          return resultFor(input.entries.slice(0, 3).map((entry) => entry.ref))
        },
      },
      resolveCatalog,
    }
    const request = { intent: "Use sandbox:profile-0 to implement", model: "m", effort: GuideEffort.Medium }
    const first = await runGuideMatch(provider({ legacy: [] }), catalog(), request, cache, options)
    expect(events).toEqual(["match", "resolve"])
    expect(first.recommendations[0]?.headless.prompt).toBe(false)
    events.length = 0
    const second = await runGuideMatch(provider({ legacy: [] }), catalog(), request, cache, options)
    expect(events).toEqual(["resolve"])
    expect(second.recommendations[0]?.headless.prompt).toBe(false)
  })

  it("accepts a goal request with only goal-compatible catalog entries", async () => {
    const calls = { legacy: [] as unknown[], matcher: [] as unknown[] }
    const goal = prepareGuideGoal({
      prompt: "Implement",
      draft: { artifact: "patch", task: "Implement", criteria: ["Tests pass", "Review passes", "No secrets"] },
    })
    const response = await runGuideMatch(
      provider(calls),
      catalog(true),
      { intent: "Implement", model: "m", effort: GuideEffort.Medium, goal },
      undefined,
      { matcher: matcher(calls) },
    )
    expect(response.recommendations.length).toBeGreaterThanOrEqual(1)
  })
  it("keeps low probability Jev results and falls back on invalid results", async () => {
    const calls = { legacy: [] as unknown[], matcher: [] as unknown[] }
    const base = matcher(calls)
    const request = { intent: "Implement", model: "override", effort: GuideEffort.High }
    const low = await runGuideMatch(provider(calls), catalog(), request, undefined, {
      matcher: {
        ...base,
        match: async (input) => ({
          candidates: resultFor(input.entries.map(({ ref }) => ref)).candidates.map((candidate) => ({
            ...candidate,
            confidence: 0,
          })),
        }),
      },
    })
    expect(low.execution?.backend).toBe("jev")
    expect(low.model).toBe("override")
    expect(low.effort).toBe(GuideEffort.High)
    expect(calls.legacy).toHaveLength(0)
    const invalid = await runGuideMatch(provider(calls), catalog(), request, undefined, {
      matcher: { ...base, match: async () => ({ candidates: [] }) },
    })
    expect(invalid.execution).toEqual({ backend: "copilot", model: "override", effort: "high" })
    expect(calls.legacy).toHaveLength(1)
  })

  it("retries Jev after cached fallback and reports cache-hit execution and count", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "guide-match-recovery-"))
    roots.push(root)
    const cache = new GuideArtifactCache({ cwd: root, routing, prompts })
    const calls = { legacy: [] as unknown[], matcher: [] as unknown[], fail: true }
    const request = { intent: "Use sandbox:profile-0 to implement changes", model: "m", effort: GuideEffort.Medium }
    const invoke = (options = {}, selectedCache = cache) =>
      runGuideMatch(provider(calls), catalog(), request, selectedCache, { matcher: matcher(calls), ...options })
    expect((await invoke()).execution?.backend).toBe("copilot")
    expect((await invoke()).execution?.backend).toBe("copilot")
    expect(calls.legacy).toHaveLength(1)
    expect(calls.matcher).toHaveLength(2)
    calls.fail = false
    expect((await invoke()).execution?.backend).toBe("jev")
    const attempts: unknown[] = []
    const changedCache = new GuideArtifactCache({
      cwd: root,
      routing: { ...routing, match: { model: "different", effort: GuideEffort.Max } },
      prompts: { ...prompts, match: "changed llm instructions" },
    })
    const hit = await invoke({ onAttempt: (attempt: unknown) => attempts.push(attempt) }, changedCache)
    expect(hit.execution).toEqual({ backend: "jev", model: "jev-1.13.0" })
    expect(calls.matcher).toHaveLength(3)
    expect(attempts).toEqual([{ execution: hit.execution, profileCount: 16 }])
    const sessions = await readdir(path.join(root, ".trx-guide"))
    const artifacts = await Promise.all(
      sessions.map((session) =>
        readFile(path.join(root, ".trx-guide", session, "1-profile-recommendations.md"), "utf8"),
      ),
    )
    expect(artifacts).toHaveLength(2)
    const jev = artifacts.find((artifact) => artifact.includes("Routing: Jev"))!
    expect(jev).toContain("Routing: Jev · jev-1.13.0\n")
    expect(jev).not.toContain("(medium)")
    const revised = { ...matcher(calls), revision: "new-questions" }
    await invoke({ matcher: revised })
    expect(calls.matcher).toHaveLength(4)
  })
})
