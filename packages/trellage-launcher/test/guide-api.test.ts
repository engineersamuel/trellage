import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import type { ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import { parseGuideCatalog, type CombinedGuideCatalog } from "../src/guide-catalog.js"
import type {
  GuideGenerateInput,
  GuideGenerateResult,
  GuideMatchInput,
  GuideMatchResult,
  GuideProvider,
} from "../src/guide-provider.js"
import { GuideValidationError } from "../src/guide-text.js"
import {
  GuideArgsError,
  GuideEffort,
  GuidePhase,
  GuideServiceError,
  defaultGuideEffort,
  defaultGuideModelId,
  literalGuideMatch,
  parseGuideHeadlessArgv,
  parseGuideServiceRequestJson,
  publicGuideLaunchCommand,
  resolveGuideModelConfig,
  runGuideGenerate,
  runGuideMatch,
  selectedProfileFromCatalogRef,
  templatePromptCandidates,
} from "../src/guide-api.js"

// ---------------------------------------------------------------------------
// Shared catalog fixture: 4 profiles across native and Sandbox surfaces.
// ---------------------------------------------------------------------------

const headless = (overrides: { readonly prompt: boolean }) => ({
  schemaVersion: 1,
  prompt: overrides.prompt,
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
})

const guideCdxHve: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["code-review"],
  bestFor: ["Reviewing pull requests"],
  avoidFor: ["Long-running background jobs"],
  prerequisites: [{ id: "git-repo", description: "A git repository checkout." }],
  workflows: [
    {
      id: "review",
      description: "Review a diff.",
      examples: ["Review my last commit", "Check this diff", "Review this PR"],
      promptTemplate: "Review the diff for: {{intent}}.",
    },
  ],
}

const guideOther: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["docs"],
  bestFor: ["Writing documentation"],
  avoidFor: ["Shell access"],
  prerequisites: [],
  workflows: [
    {
      id: "draft",
      description: "Draft documentation.",
      examples: ["Write the README", "Draft release notes", "Update the changelog"],
      promptTemplate: "Draft docs: {{intent}}",
    },
  ],
}

const primeAgentGuideMarkdown = `---
schemaVersion: 1
capabilities:
  - general-coding
bestFor:
  - General repository work
avoidFor:
  - Highly regulated environments
prerequisites: []
workflows:
  - id: review
    description: Review a diff for correctness and security.
    examples:
      - Review my last commit
      - Review this PR
    promptTemplate: |
      Review the diff for: {{intent}}
  - id: plan
    description: Draft an implementation plan.
    examples:
      - Plan this feature
    promptTemplate: |
      Plan: {{intent}}
---
# Prime Agent

Use this profile for general repository work.
`

const guidePrimeAgent: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["general-coding"],
  bestFor: ["General repository work"],
  avoidFor: ["Highly regulated environments"],
  prerequisites: [],
  workflows: [
    {
      id: "review",
      description: "Review a diff for correctness and security.",
      examples: ["Review my last commit", "Review this PR"],
      promptTemplate: "Review the diff for: {{intent}}",
    },
    {
      id: "plan",
      description: "Draft an implementation plan.",
      examples: ["Plan this feature"],
      promptTemplate: "Plan: {{intent}}",
    },
  ],
}

const fooGuideMarkdown = `---
schemaVersion: 1
capabilities:
  - repository-delivery
bestFor:
  - Small edits
avoidFor:
  - Long refactors
prerequisites: []
workflows:
  - id: quick-fix
    description: Fix a small typo or bug quickly.
    examples:
      - Fix the typo in README
    promptTemplate: |
      Fix this quickly: {{intent}}
  - id: deep-refactor
    description: Refactor a complex subsystem carefully.
    examples:
      - Refactor the auth module
      - Rewrite the payment pipeline
    promptTemplate: |
      Carefully refactor: {{intent}}
---
# Foo

Use this profile for repository delivery.
`

const guideFoo: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["repository-delivery"],
  bestFor: ["Small edits"],
  avoidFor: ["Long refactors"],
  prerequisites: [],
  workflows: [
    {
      id: "quick-fix",
      description: "Fix a small typo or bug quickly.",
      examples: ["Fix the typo in README"],
      promptTemplate: "Fix this quickly: {{intent}}",
    },
    {
      id: "deep-refactor",
      description: "Refactor a complex subsystem carefully.",
      examples: ["Refactor the auth module", "Rewrite the payment pipeline"],
      promptTemplate: "Carefully refactor: {{intent}}",
    },
  ],
}

/** Builds the combined catalog, rooted at `tmpRoot` for the Sandbox profile path and native guide-loading fixtures. */
const buildCatalog = (tmpRoot: string): CombinedGuideCatalog =>
  parseGuideCatalog(
    JSON.stringify({
      schemaVersion: 1,
      sandboxCommandPath: "/opt/trellage/bin/trellage",
      native: [
        {
          launcher: "cdx",
          name: "hve",
          description: "Codex host-native launcher.",
          headless: headless({ prompt: true }),
          sandbox: false,
          herdrCompatibility: { status: "supported" },
          guide: guideCdxHve,
          commandPath: "/opt/trellage/cdx/bin/cdx",
        },
        {
          launcher: "jcx",
          name: "foo",
          description: "Jules code-native launcher.",
          headless: headless({ prompt: true }),
          sandbox: false,
          herdrCompatibility: { status: "supported" },
          guide: guideFoo,
          commandPath: "/opt/trellage/jcx/bin/jcx",
        },
      ],
      sandbox: [
        {
          name: "prime-agent",
          description: "Sandboxed prime agent profile.",
          guide: guidePrimeAgent,
          path: path.join(tmpRoot, "profiles", "prime-agent", "profile.toml"),
          supportedPlatforms: ["linux/amd64"],
          harness: "copilot",
          skillBundles: ["sandbox-common"],
          skillsMode: "floating",
          finalDigestLocked: false,
          skills: [],
          plugins: [],
          mcps: [],
          sandbox: true,
          headless: headless({ prompt: true }),
          locked: false,
          herdrCompatibility: { status: "supported" },
        },
        {
          name: "other",
          description: "Sandboxed documentation profile.",
          guide: guideOther,
          path: path.join(tmpRoot, "profiles", "other", "profile.toml"),
          supportedPlatforms: ["linux/amd64"],
          harness: "copilot",
          skillBundles: ["sandbox-common"],
          skillsMode: "floating",
          finalDigestLocked: false,
          skills: [],
          plugins: [],
          mcps: [],
          sandbox: true,
          headless: headless({ prompt: false }),
          locked: false,
          herdrCompatibility: { status: "supported" },
        },
      ],
    }),
  )

/** Writes the guide Markdown fixtures matching the catalog's `foo` and `prime-agent` guides under `root`. */
const writeGuideFixtures = async (root: string): Promise<void> => {
  await mkdir(path.join(root, "native", "jcx"), { recursive: true })
  await mkdir(path.join(root, "profile-guides", "sandbox"), { recursive: true })
  await writeFile(path.join(root, "native", "jcx", "foo.md"), fooGuideMarkdown)
  await writeFile(path.join(root, "profile-guides", "sandbox", "prime-agent.md"), primeAgentGuideMarkdown)
}

// ---------------------------------------------------------------------------
// Fake GuideProvider: no model/network calls, ever.
// ---------------------------------------------------------------------------

class FakeGuideProvider implements GuideProvider {
  matchCalls: Array<GuideMatchInput> = []
  generateCalls: Array<GuideGenerateInput> = []

  constructor(
    private readonly matchResult: GuideMatchResult,
    private readonly generateResult: GuideGenerateResult,
  ) {}

  async match(input: GuideMatchInput): Promise<GuideMatchResult> {
    this.matchCalls.push(input)
    return this.matchResult
  }

  async generate(input: GuideGenerateInput): Promise<GuideGenerateResult> {
    this.generateCalls.push(input)
    return this.generateResult
  }

  async refine(): Promise<never> {
    throw new Error("refine must not be called by these tests")
  }
}

const genCandidates = (): GuideGenerateResult => ({
  candidates: [
    { title: "Focused", prompt: "Do the focused thing.", notes: "Quick pass." },
    { title: "Thorough", prompt: "Do the thorough thing.", notes: "Deep pass." },
    { title: "Cautious", prompt: "Do the cautious thing.", notes: "Careful pass." },
  ],
})

// ---------------------------------------------------------------------------
// Headless argv parsing.
// ---------------------------------------------------------------------------

describe("parseGuideHeadlessArgv", () => {
  it("accepts --json with --intent", () => {
    const args = parseGuideHeadlessArgv(["--json", "--intent", "Review my PR"])
    expect(args).toEqual({
      help: false,
      json: true,
      intent: "Review my PR",
      profile: undefined,
      model: undefined,
      effort: undefined,
    })
  })

  it("accepts a single positional intent instead of --intent", () => {
    const args = parseGuideHeadlessArgv(["--json", "Review my PR"])
    expect(args.intent).toBe("Review my PR")
  })

  it("accepts --profile only alongside --json", () => {
    const args = parseGuideHeadlessArgv(["--json", "--intent", "Review my PR", "--profile", "native:cdx/hve"])
    expect(args.profile).toBe("native:cdx/hve")
  })

  it("rejects --profile without --json", () => {
    expect(() => parseGuideHeadlessArgv(["--intent", "Review my PR", "--profile", "native:cdx/hve"])).toThrow(
      GuideArgsError,
    )
  })

  it("rejects both --intent and a positional intent", () => {
    expect(() => parseGuideHeadlessArgv(["--json", "--intent", "Review my PR", "extra"])).toThrow(GuideArgsError)
  })

  it("rejects more than one positional argument", () => {
    expect(() => parseGuideHeadlessArgv(["--json", "first", "second"])).toThrow(GuideArgsError)
  })

  it("rejects an unknown flag", () => {
    expect(() => parseGuideHeadlessArgv(["--json", "--bogus", "value"])).toThrow(GuideArgsError)
  })

  it("rejects a duplicate flag", () => {
    expect(() => parseGuideHeadlessArgv(["--json", "--json", "--intent", "Review my PR"])).toThrow(GuideArgsError)
  })

  it("rejects a flag missing its value", () => {
    expect(() => parseGuideHeadlessArgv(["--json", "--intent"])).toThrow(GuideArgsError)
    expect(() => parseGuideHeadlessArgv(["--json", "--intent", "--json"])).toThrow(GuideArgsError)
  })

  it("rejects an empty intent", () => {
    expect(() => parseGuideHeadlessArgv(["--json", "--intent", "   "])).toThrow(GuideValidationError)
  })

  it("rejects a control-character-containing intent", () => {
    expect(() => parseGuideHeadlessArgv(["--json", "--intent", "hello\u0000world"])).toThrow(GuideValidationError)
  })

  it("rejects an oversized intent", () => {
    expect(() => parseGuideHeadlessArgv(["--json", "--intent", "a".repeat(4001)])).toThrow(GuideValidationError)
  })

  it("allows JSON mode to read stdin and interactive mode to open its intent editor", () => {
    expect(parseGuideHeadlessArgv(["--json"]).intent).toBeUndefined()
    expect(parseGuideHeadlessArgv([]).intent).toBeUndefined()
    expect(() => parseGuideHeadlessArgv(["--help"])).not.toThrow()
    expect(parseGuideHeadlessArgv(["--help"]).help).toBe(true)
  })

  it("validates --model as a safe bounded identifier", () => {
    expect(parseGuideHeadlessArgv(["--json", "--intent", "x", "--model", "mai-code-1.1-flash"]).model).toBe(
      "mai-code-1.1-flash",
    )
    expect(() => parseGuideHeadlessArgv(["--json", "--intent", "x", "--model", "Not A Model!"])).toThrow(
      GuideValidationError,
    )
  })

  it("validates --effort against the known enum values", () => {
    expect(parseGuideHeadlessArgv(["--json", "--intent", "x", "--effort", "high"]).effort).toBe(GuideEffort.High)
    expect(() => parseGuideHeadlessArgv(["--json", "--intent", "x", "--effort", "extreme"])).toThrow(
      GuideValidationError,
    )
  })
})

// ---------------------------------------------------------------------------
// Stdin JSON request parsing.
// ---------------------------------------------------------------------------

describe("parseGuideServiceRequestJson", () => {
  it("accepts a minimal valid request", () => {
    const request = parseGuideServiceRequestJson(JSON.stringify({ schemaVersion: 1, intent: "Review my PR" }))
    expect(request).toEqual({ schemaVersion: 1, intent: "Review my PR" })
  })

  it("accepts optional profile/model/effort", () => {
    const request = parseGuideServiceRequestJson(
      JSON.stringify({
        schemaVersion: 1,
        intent: "Review my PR",
        profile: "native:cdx/hve",
        model: "gpt-5.4",
        effort: "xhigh",
      }),
    )
    expect(request).toEqual({
      schemaVersion: 1,
      intent: "Review my PR",
      profile: "native:cdx/hve",
      model: "gpt-5.4",
      effort: GuideEffort.XHigh,
    })
  })

  it("rejects malformed JSON", () => {
    expect(() => parseGuideServiceRequestJson("{not json")).toThrow(GuideValidationError)
  })

  it("rejects a wrong schemaVersion", () => {
    expect(() => parseGuideServiceRequestJson(JSON.stringify({ schemaVersion: 2, intent: "x" }))).toThrow(
      GuideValidationError,
    )
  })

  it("rejects a missing intent", () => {
    expect(() => parseGuideServiceRequestJson(JSON.stringify({ schemaVersion: 1 }))).toThrow(GuideValidationError)
  })

  it("rejects unsupported top-level keys", () => {
    expect(() =>
      parseGuideServiceRequestJson(JSON.stringify({ schemaVersion: 1, intent: "x", commandPath: "/bin/sh" })),
    ).toThrow(GuideValidationError)
  })

  it("rejects an invalid effort value", () => {
    expect(() =>
      parseGuideServiceRequestJson(JSON.stringify({ schemaVersion: 1, intent: "x", effort: "extreme" })),
    ).toThrow(GuideValidationError)
  })
})

// ---------------------------------------------------------------------------
// Model/effort configuration resolution.
// ---------------------------------------------------------------------------

describe("resolveGuideModelConfig", () => {
  it("falls back to defaults when nothing is set", () => {
    expect(resolveGuideModelConfig({}, {})).toEqual({ model: defaultGuideModelId, effort: defaultGuideEffort })
  })

  it("prefers the environment over defaults", () => {
    expect(resolveGuideModelConfig({}, { TRELLAGE_GUIDE_MODEL: "gpt-5.4", TRELLAGE_GUIDE_EFFORT: "high" })).toEqual({
      model: "gpt-5.4",
      effort: GuideEffort.High,
    })
  })

  it("prefers explicit overrides over the environment", () => {
    expect(
      resolveGuideModelConfig(
        { model: "claude-opus-5", effort: GuideEffort.Max },
        { TRELLAGE_GUIDE_MODEL: "gpt-5.4", TRELLAGE_GUIDE_EFFORT: "high" },
      ),
    ).toEqual({ model: "claude-opus-5", effort: GuideEffort.Max })
  })

  it("rejects an invalid model from the environment", () => {
    expect(() => resolveGuideModelConfig({}, { TRELLAGE_GUIDE_MODEL: "Not A Model!" })).toThrow(GuideValidationError)
  })

  it("rejects an invalid effort from the environment", () => {
    expect(() => resolveGuideModelConfig({}, { TRELLAGE_GUIDE_EFFORT: "extreme" })).toThrow(GuideValidationError)
  })
})

// ---------------------------------------------------------------------------
// Match service.
// ---------------------------------------------------------------------------

describe("runGuideMatch", () => {
  it("enriches exactly three recommendations without leaking paths or prompt templates", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-"))
    try {
      const catalog = buildCatalog(tmpRoot)
      const provider = new FakeGuideProvider(
        {
          candidates: [
            {
              profileRef: "native:cdx/hve",
              workflowId: "review",
              confidence: 0.9,
              reason: "Strong fit for reviewing diffs.",
              tradeoff: "Requires a local git checkout.",
            },
            {
              profileRef: "sandbox:prime-agent",
              workflowId: "review",
              confidence: 0.6,
              reason: "General-purpose reviewer.",
              tradeoff: "Runs in a sandbox.",
            },
            {
              profileRef: "sandbox:other",
              workflowId: "draft",
              confidence: 0.2,
              reason: "Only useful for docs.",
              tradeoff: "Cannot run headless prompts.",
            },
          ],
        },
        genCandidates(),
      )

      const response = await runGuideMatch(provider, catalog, {
        intent: "Review my open pull request",
        model: "mai-code-1.1-flash",
        effort: GuideEffort.Medium,
      })

      expect(response.schemaVersion).toBe(1)
      expect(response.phase).toBe(GuidePhase.Match)
      expect(response.recommendations).toHaveLength(3)

      const [first, second, third] = response.recommendations
      expect(first).toMatchObject({
        profileRef: "native:cdx/hve",
        workflowId: "review",
        surface: "native",
        launcher: "cdx",
        name: "hve",
        sandbox: false,
      })
      expect(first?.workflow).toEqual({
        id: "review",
        description: "Review a diff.",
        examples: ["Review my last commit", "Check this diff", "Review this PR"],
      })
      expect(first?.prerequisites).toEqual([{ id: "git-repo", description: "A git repository checkout." }])
      expect(first?.headless.prompt).toBe(true)
      expect(first?.herdrCompatibility).toEqual({ status: "supported" })

      expect(second).toMatchObject({ profileRef: "sandbox:prime-agent", surface: "sandbox", harness: "copilot" })
      expect(third).toMatchObject({ profileRef: "sandbox:other", surface: "sandbox" })

      const serialized = JSON.stringify(response)
      expect(serialized).not.toContain("promptTemplate")
      expect(serialized).not.toContain("commandPath")
      expect(serialized).not.toContain("/opt/trellage")
      expect(serialized).not.toContain(tmpRoot)
      expect(serialized).not.toContain("profile.toml")

      expect(provider.matchCalls).toHaveLength(1)
      expect(provider.matchCalls[0]?.entries).toHaveLength(4)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("throws when the provider does not return exactly three candidates", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-"))
    try {
      const catalog = buildCatalog(tmpRoot)
      const provider = new FakeGuideProvider(
        {
          candidates: [
            {
              profileRef: "native:cdx/hve",
              workflowId: "review",
              confidence: 0.9,
              reason: "Strong fit.",
              tradeoff: "None.",
            },
          ],
        },
        genCandidates(),
      )

      await expect(
        runGuideMatch(provider, catalog, { intent: "Review my PR", model: "m", effort: GuideEffort.Medium }),
      ).rejects.toThrow(GuideServiceError)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Generation service.
// ---------------------------------------------------------------------------

describe("runGuideGenerate", () => {
  it("selects the matching workflow without repeating the model match phase", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-"))
    try {
      await writeGuideFixtures(tmpRoot)
      const catalog = buildCatalog(tmpRoot)
      const provider = new FakeGuideProvider(
        {
          candidates: [
            {
              profileRef: "sandbox:prime-agent",
              workflowId: "plan",
              confidence: 0.8,
              reason: "Best fit for planning.",
              tradeoff: "Sandboxed.",
            },
            {
              profileRef: "native:cdx/hve",
              workflowId: "review",
              confidence: 0.5,
              reason: "Alternative.",
              tradeoff: "None.",
            },
            {
              profileRef: "sandbox:other",
              workflowId: "draft",
              confidence: 0.1,
              reason: "Weak fit.",
              tradeoff: "None.",
            },
          ],
        },
        genCandidates(),
      )

      const response = await runGuideGenerate(provider, catalog, tmpRoot, {
        intent: "Plan the next milestone",
        profileRef: "sandbox:prime-agent",
        model: "mai-code-1.1-flash",
        effort: GuideEffort.Medium,
      })

      expect(response.phase).toBe(GuidePhase.Generation)
      expect(response.profile.workflowId).toBe("plan")
      expect(response.profile.profileRef).toBe("sandbox:prime-agent")
      expect(response.candidates).toHaveLength(3)

      // The provider must receive the full authored guide body, loaded from disk.
      expect(provider.generateCalls).toHaveLength(1)
      expect(provider.generateCalls[0]?.workflowId).toBe("plan")
      expect(provider.generateCalls[0]?.guideBody).toContain("Use this profile for general repository work.")
      expect(provider.generateCalls[0]?.guide).toEqual(guidePrimeAgent)
      expect(provider.matchCalls).toHaveLength(0)

      const serialized = JSON.stringify(response)
      expect(serialized).not.toContain("promptTemplate")
      expect(serialized).not.toContain("profile.toml")
      expect(serialized).not.toContain(tmpRoot)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("deterministically falls back to token-overlap workflow selection when the profile is not among the top three", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-"))
    try {
      await writeGuideFixtures(tmpRoot)
      const catalog = buildCatalog(tmpRoot)
      // The match candidates deliberately exclude native:jcx/foo.
      const provider = new FakeGuideProvider(
        {
          candidates: [
            {
              profileRef: "native:cdx/hve",
              workflowId: "review",
              confidence: 0.9,
              reason: "Top pick.",
              tradeoff: "None.",
            },
            {
              profileRef: "sandbox:prime-agent",
              workflowId: "review",
              confidence: 0.5,
              reason: "Second pick.",
              tradeoff: "None.",
            },
            {
              profileRef: "sandbox:other",
              workflowId: "draft",
              confidence: 0.1,
              reason: "Weakest pick.",
              tradeoff: "None.",
            },
          ],
        },
        genCandidates(),
      )

      const response = await runGuideGenerate(provider, catalog, tmpRoot, {
        intent: "Refactor the payment pipeline safely",
        profileRef: "native:jcx/foo",
        model: "mai-code-1.1-flash",
        effort: GuideEffort.Medium,
      })

      // "deep-refactor" shares far more tokens with the intent than "quick-fix".
      expect(response.profile.workflowId).toBe("deep-refactor")
      expect(provider.generateCalls[0]?.workflowId).toBe("deep-refactor")
      expect(provider.generateCalls[0]?.guideBody).toContain("Use this profile for repository delivery.")
      expect(provider.matchCalls).toHaveLength(0)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("fails clearly for an unknown profile reference", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-"))
    try {
      const catalog = buildCatalog(tmpRoot)
      const provider = new FakeGuideProvider({ candidates: [] } as unknown as GuideMatchResult, genCandidates())

      await expect(
        runGuideGenerate(provider, catalog, tmpRoot, {
          intent: "Do something",
          profileRef: "sandbox:does-not-exist",
          model: "m",
          effort: GuideEffort.Medium,
        }),
      ).rejects.toThrow(GuideServiceError)
      expect(provider.matchCalls).toHaveLength(0)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Public command projection and internal SelectedProfile conversion.
// ---------------------------------------------------------------------------

describe("publicGuideLaunchCommand", () => {
  it("uses the launcher alias and appends -p <prompt> when headless.prompt is true", () => {
    const catalog = buildCatalog("/tmp-unused")
    const command = publicGuideLaunchCommand(catalog, "native:cdx/hve", "say hello world")
    expect(command.executable).toBe("cdx")
    expect(command.args).toEqual(["hve", "-p", "say hello world"])
    expect(command.promptHandling).toBe("argv")
    expect(command.preview).toBe(`cdx hve -p 'say hello world'`)
    expect(command.preview).not.toContain("/opt/trellage")
  })

  it("uses 'trellage' and the base interactive command when headless.prompt is false", () => {
    const catalog = buildCatalog("/tmp-unused")
    const command = publicGuideLaunchCommand(catalog, "sandbox:other", "say hello world")
    expect(command.executable).toBe("trellage")
    expect(command.args).toEqual(["--profile", "other"])
    expect(command.promptHandling).toBe("manual-paste")
    expect(command.preview).toBe("trellage --profile other")
  })

  it("throws for an unknown profile reference", () => {
    const catalog = buildCatalog("/tmp-unused")
    expect(() => publicGuideLaunchCommand(catalog, "sandbox:does-not-exist", "x")).toThrow(GuideServiceError)
  })
})

describe("selectedProfileFromCatalogRef", () => {
  it("uses the native entry's own commandPath", () => {
    const catalog = buildCatalog("/tmp-unused")
    expect(selectedProfileFromCatalogRef(catalog, "native:cdx/hve")).toEqual({
      surface: "native",
      launcher: "cdx",
      commandPath: "/opt/trellage/cdx/bin/cdx",
      profile: "hve",
      headlessPrompt: true,
    })
  })

  it("uses the root sandboxCommandPath, not the profile's own path", () => {
    const catalog = buildCatalog("/tmp-unused")
    expect(selectedProfileFromCatalogRef(catalog, "sandbox:other")).toEqual({
      surface: "sandbox",
      commandPath: "/opt/trellage/bin/trellage",
      profile: "other",
      headlessPrompt: false,
    })
  })

  it("throws for an unknown profile reference", () => {
    const catalog = buildCatalog("/tmp-unused")
    expect(() => selectedProfileFromCatalogRef(catalog, "native:cdx/does-not-exist")).toThrow(GuideServiceError)
  })
})

// ---------------------------------------------------------------------------
// Deterministic literal fallbacks (no model calls).
// ---------------------------------------------------------------------------

describe("literalGuideMatch", () => {
  it("ranks known profiles by normalized token overlap, distinct refs, source-order tie-break", () => {
    const catalog = buildCatalog("/tmp-unused")
    const candidates = literalGuideMatch(catalog, "Refactor the payment pipeline carefully")

    expect(candidates).toHaveLength(3)
    const refs = candidates.map((c) => c.profileRef)
    expect(new Set(refs).size).toBe(3)
    // native:jcx/foo's deep-refactor workflow shares the most terms with the intent.
    expect(candidates[0]?.profileRef).toBe("native:jcx/foo")
    expect(candidates[0]?.workflowId).toBe("deep-refactor")
    for (const candidate of candidates) {
      expect(candidate.confidence).toBeGreaterThanOrEqual(0)
      expect(candidate.confidence).toBeLessThanOrEqual(1)
      expect(candidate.reason.length).toBeGreaterThan(0)
      expect(candidate.tradeoff.length).toBeGreaterThan(0)
    }
    // Non-increasing confidence: a ranked list.
    for (let i = 1; i < candidates.length; i += 1) {
      expect(candidates[i]!.confidence).toBeLessThanOrEqual(candidates[i - 1]!.confidence)
    }
  })

  it("throws when the catalog has fewer than three profiles", () => {
    const tinyCatalog = parseGuideCatalog(
      JSON.stringify({
        schemaVersion: 1,
        sandboxCommandPath: "/opt/trellage/bin/trellage",
        native: [
          {
            launcher: "cdx",
            name: "hve",
            description: "Codex host-native launcher.",
            headless: headless({ prompt: true }),
            sandbox: false,
            herdrCompatibility: { status: "supported" },
            guide: guideCdxHve,
            commandPath: "/opt/trellage/cdx/bin/cdx",
          },
        ],
        sandbox: [],
      }),
    )
    expect(() => literalGuideMatch(tinyCatalog, "Review my PR")).toThrow(GuideServiceError)
  })
})

describe("templatePromptCandidates", () => {
  it("replaces {{intent}} and produces three distinct provider-shaped candidates", () => {
    const candidates = templatePromptCandidates(guidePrimeAgent, "review", "check the latest diff")
    expect(candidates).toHaveLength(3)
    const prompts = candidates.map((c) => c.prompt)
    expect(new Set(prompts).size).toBe(3)
    for (const candidate of candidates) {
      expect(candidate.prompt).toContain("check the latest diff")
      expect(candidate.prompt).not.toContain("{{intent}}")
      expect(candidate).toHaveProperty("title")
      expect(candidate).toHaveProperty("notes")
    }
  })

  it("throws for an unknown workflow id", () => {
    expect(() => templatePromptCandidates(guidePrimeAgent, "does-not-exist", "x")).toThrow(GuideServiceError)
  })
})
