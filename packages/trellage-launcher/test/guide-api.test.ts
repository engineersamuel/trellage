import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
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
  GuideOptimizeInput,
  GuideOptimizeResult,
  GuideProvider,
} from "../src/guide-provider.js"
import { GuideValidationError } from "../src/guide-text.js"
import { GuideArtifactCache } from "../src/guide-match-cache.js"
import {
  applyRequiredProfilePromptTemplate,
  applyWorkflowPromptTemplate,
  GuideArgsError,
  GuideEffort,
  GuideLongPromptVariant,
  GuidePhase,
  GuideServiceError,
  defaultGuideEffort,
  defaultGuideModelId,
  defaultGuideModelRouting,
  guideIntentMaximumLength,
  literalGuideMatch,
  parseGuideHeadlessArgv,
  parseGuideServiceRequestJson,
  publicGuideLaunchCommand,
  resolveGuideModelConfig,
  resolveGuideModelRouting,
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
  bestFor: ["Reviewing pull requests", "Focused diff analysis"],
  avoidFor: ["Long-running background jobs", "Unrelated content work"],
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
  bestFor: ["Writing documentation", "Release-note drafting"],
  avoidFor: ["Shell access", "Complex code implementation"],
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
  - Repository planning and review
avoidFor:
  - Highly regulated environments
  - Long-running background investigation
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
    skill: writing-plans
    examples:
      - Plan this feature
      - Draft a phased implementation plan
    promptTemplate: |
      Use the writing-plans skill:
      {{intent}}
---
# Prime Agent

Use this profile for general repository work.
`

const guidePrimeAgent: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["general-coding"],
  bestFor: ["General repository work", "Repository planning and review"],
  avoidFor: ["Highly regulated environments", "Long-running background investigation"],
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
      skill: "writing-plans",
      examples: ["Plan this feature", "Draft a phased implementation plan"],
      promptTemplate: "Use the writing-plans skill:\n{{intent}}",
    },
  ],
}

const guideCompoundEngineering: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["compound-engineering"],
  bestFor: ["Capturing verified repository learning", "Autonomous delivery"],
  avoidFor: ["Unrelated prose", "Read-only research"],
  prerequisites: [],
  workflows: [
    {
      id: "capture-verified-repository-learning",
      description: "Capture one verified repository learning.",
      skill: "ce-compound",
      examples: ["Capture this verified fix", "Record this repository learning"],
      promptTemplate: "/ce-compound mode:non-interactive {{intent}}",
    },
    {
      id: "autonomous-lfg-plan-to-pr",
      description: "Deliver a change autonomously.",
      skill: "lfg",
      examples: ["Ship this feature", "Open a pull request"],
      promptTemplate: "/lfg {{intent}}",
    },
  ],
}

const compoundEngineeringGuideMarkdown = `---
schemaVersion: 1
capabilities:
  - compound-engineering
bestFor:
  - Capturing verified repository learning
  - Autonomous delivery
avoidFor:
  - Unrelated prose
  - Read-only research
prerequisites: []
workflows:
  - id: capture-verified-repository-learning
    description: Capture one verified repository learning.
    skill: ce-compound
    examples:
      - Capture this verified fix
      - Record this repository learning
    promptTemplate: |
      /ce-compound mode:non-interactive {{intent}}
  - id: autonomous-lfg-plan-to-pr
    description: Deliver a change autonomously.
    skill: lfg
    examples:
      - Ship this feature
      - Open a pull request
    promptTemplate: |
      /lfg {{intent}}
---
# Compound engineering

Use this profile to capture verified repository learning.
`

const guidePstack: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["review-and-polish"],
  bestFor: ["Skeptical review", "Prompt cleanup"],
  avoidFor: ["Unrelated prose", "Read-only research"],
  prerequisites: [],
  workflows: [
    {
      id: "review-and-polish",
      description: "Review a diff, then remove low-value prose.",
      skill: "pstack-for-codex:interrogate",
      examples: ["Review this change", "Polish this diff"],
      promptTemplate:
        "$pstack-for-codex:interrogate {{intent}}\n" + "$pstack-for-codex:no-comments\n" + "$pstack-for-codex:unslop",
    },
  ],
}

const pstackGuideMarkdown = `---
schemaVersion: 1
capabilities:
  - review-and-polish
bestFor:
  - Skeptical review
  - Prompt cleanup
avoidFor:
  - Unrelated prose
  - Read-only research
prerequisites: []
workflows:
  - id: review-and-polish
    description: Review a diff, then remove low-value prose.
    skill: pstack-for-codex:interrogate
    examples:
      - Review this change
      - Polish this diff
    promptTemplate: |
      $pstack-for-codex:interrogate {{intent}}
      $pstack-for-codex:no-comments
      $pstack-for-codex:unslop
---
# pstack

Use this profile to review and polish a change.
`

describe("applyWorkflowPromptTemplate", () => {
  const candidate = {
    title: "LinkedIn draft",
    prompt: "Write a LinkedIn post about AI agents.",
    notes: "Uses a direct opening.",
  }
  const guide: ProfileGuideV1 = {
    schemaVersion: 1,
    capabilities: ["social-media-writing"],
    bestFor: ["LinkedIn posts", "Short social drafts"],
    avoidFor: ["Long-form articles", "Source-backed research"],
    prerequisites: [],
    workflows: [
      {
        id: "post-writer",
        description: "Draft a social post.",
        skill: "social-media-skills:post-writer",
        examples: ["Write a post about AI agents", "Draft a LinkedIn launch announcement"],
        promptTemplate: "/social-media-skills:post-writer {{intent}}",
      },
      {
        id: "plain",
        description: "Use a plain prompt.",
        examples: ["Write plain text", "Draft a concise unformatted note"],
        promptTemplate: "Plain: {{intent}}",
      },
      {
        id: "review-stack",
        description: "Run a review skill followed by cleanup skills.",
        skill: "interrogate",
        examples: ["Review this change", "Interrogate this diff before cleanup"],
        promptTemplate: "$interrogate {{intent}}\n$no-comments\n$unslop",
      },
    ],
  }

  it("renders an unframed body with the exact authored skill frame", () => {
    expect(applyWorkflowPromptTemplate(guide, "post-writer", candidate).prompt).toBe(
      "/social-media-skills:post-writer Write a LinkedIn post about AI agents.",
    )
  })

  it("does not duplicate an exact authored frame", () => {
    const wrapped = applyWorkflowPromptTemplate(guide, "post-writer", candidate)
    expect(applyWorkflowPromptTemplate(guide, "post-writer", wrapped)).toEqual(wrapped)
  })

  it("treats a non-exact partial frame as the complete edited body", () => {
    const partial = {
      ...candidate,
      prompt: "$interrogate Review this change.",
    }
    expect(applyWorkflowPromptTemplate(guide, "review-stack", partial).prompt).toBe(
      "$interrogate $interrogate Review this change.\n$no-comments\n$unslop",
    )
  })

  it("keeps exact authored suffix commands ordered and last", () => {
    const wrapped = applyWorkflowPromptTemplate(guide, "review-stack", candidate)
    expect(wrapped.prompt).toBe("$interrogate Write a LinkedIn post about AI agents.\n$no-comments\n$unslop")
    expect(applyWorkflowPromptTemplate(guide, "review-stack", wrapped)).toEqual(wrapped)
  })

  it("leaves workflows without a declared skill unchanged", () => {
    expect(applyWorkflowPromptTemplate(guide, "plain", candidate)).toEqual(candidate)
  })
})

describe("applyRequiredProfilePromptTemplate", () => {
  const candidate = {
    title: "Fleet delivery",
    prompt: "Implement the requested repository change.",
    notes: "Direct implementation.",
  }
  const guide: ProfileGuideV1 = {
    schemaVersion: 1,
    capabilities: ["fleet-orchestration"],
    bestFor: ["Parallel repository work"],
    avoidFor: ["Small edits"],
    prerequisites: [],
    workflows: [
      {
        id: "fleet",
        description: "Coordinate a fleet.",
        examples: ["Coordinate this change"],
        promptTemplate: "## Firstmate operating contract\nKeep Firstmate as the sole router.\n\n## Task\n{{intent}}",
      },
      {
        id: "investigation",
        description: "Coordinate an investigation.",
        examples: ["Investigate this failure"],
        promptTemplate:
          "## Firstmate investigation contract\nKeep Firstmate as the sole router.\n\n## Investigation\n{{intent}}",
      },
      {
        id: "pstack-investigation",
        description: "Coordinate a disciplined investigation.",
        examples: ["Investigate this failure with disciplined workers"],
        promptTemplate:
          "## Firstmate pstack-worker investigation contract\nKeep Firstmate as the sole router.\n\n## Investigation\n{{intent}}",
      },
    ],
  }

  it("wraps optimized fmx prompts with the authored operating contract", () => {
    expect(applyRequiredProfilePromptTemplate("native:fmx/default", guide, "fleet", candidate).prompt).toBe(
      "## Firstmate operating contract\nKeep Firstmate as the sole router.\n\n## Task\nImplement the requested repository change.",
    )
  })

  it("does not duplicate an already wrapped fmx prompt", () => {
    const wrapped = applyRequiredProfilePromptTemplate("native:fmx/default", guide, "fleet", candidate)

    expect(applyRequiredProfilePromptTemplate("native:fmx/default", guide, "fleet", wrapped)).toEqual(wrapped)
  })

  it("replaces a model-authored leading fleet contract instead of duplicating it", () => {
    const modelCandidate = {
      ...candidate,
      prompt:
        "## Operating contract\nUse Firstmate as the sole fleet router.\n\n## Task\nImplement the requested repository change.",
    }
    const wrapped = applyRequiredProfilePromptTemplate("native:fmx/default", guide, "fleet", modelCandidate)

    expect(wrapped.prompt).toBe(
      "## Firstmate operating contract\nKeep Firstmate as the sole router.\n\n## Task\nImplement the requested repository change.",
    )
    expect(wrapped.prompt.match(/operating contract/giu)).toHaveLength(1)
  })

  it.each([
    {
      profileRef: "native:fmx/default",
      workflowId: "investigation",
      modelHeading: "Firstmate investigation contract",
      authoredHeading: "Firstmate investigation contract",
    },
    {
      profileRef: "native:fmx/default",
      workflowId: "investigation",
      modelHeading: "Investigation contract",
      authoredHeading: "Firstmate investigation contract",
    },
    {
      profileRef: "native:fmx/pstack-workers",
      workflowId: "pstack-investigation",
      modelHeading: "Firstmate pstack-worker investigation contract",
      authoredHeading: "Firstmate pstack-worker investigation contract",
    },
  ])(
    "replaces a model-authored $modelHeading instead of duplicating it",
    ({ profileRef, workflowId, modelHeading, authoredHeading }) => {
      const modelCandidate = {
        ...candidate,
        prompt: [
          `## ${modelHeading}`,
          "Use Firstmate as the sole fleet router.",
          "",
          "## Investigation",
          "Find the root cause.",
        ].join("\n"),
      }
      const wrapped = applyRequiredProfilePromptTemplate(profileRef, guide, workflowId, modelCandidate)

      expect(wrapped.prompt).toBe(
        `## ${authoredHeading}\nKeep Firstmate as the sole router.\n\n## Investigation\nFind the root cause.`,
      )
      expect(wrapped.prompt.match(/investigation contract/giu)).toHaveLength(1)
      expect(wrapped.prompt.match(/^## Investigation$/gmu)).toHaveLength(1)
    },
  )

  it("preserves a legitimate task heading that discusses the Firstmate router", () => {
    const taskCandidate = {
      ...candidate,
      prompt: [
        "# Fix the Firstmate router",
        "",
        "Correct the profile selection regression.",
        "",
        "## Verification",
        "",
        "Run the router contract.",
      ].join("\n"),
    }

    const wrapped = applyRequiredProfilePromptTemplate("native:fmx/default", guide, "fleet", taskCandidate)

    expect(wrapped.prompt).toContain(taskCandidate.prompt)
    expect(wrapped.prompt.match(/Firstmate operating contract/gu)).toHaveLength(1)
  })

  it("leaves other profiles unchanged", () => {
    expect(applyRequiredProfilePromptTemplate("native:cdx/pstack", guide, "fleet", candidate)).toEqual(candidate)
  })
})

const fooGuideMarkdown = `---
schemaVersion: 1
capabilities:
  - repository-delivery
bestFor:
  - Small edits
  - Focused subsystem refactors
avoidFor:
  - Long refactors
  - Broad content generation
prerequisites: []
workflows:
  - id: quick-fix
    description: Fix a small typo or bug quickly.
    examples:
      - Fix the typo in README
      - Correct this small validation bug
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
  bestFor: ["Small edits", "Focused subsystem refactors"],
  avoidFor: ["Long refactors", "Broad content generation"],
  prerequisites: [],
  workflows: [
    {
      id: "quick-fix",
      description: "Fix a small typo or bug quickly.",
      examples: ["Fix the typo in README", "Correct this small validation bug"],
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
          harness: "codex",
          name: "pstack",
          description: "Codex host-native launcher.",
          headless: headless({ prompt: true }),
          sandbox: false,
          herdrCompatibility: { status: "supported" },
          guide: guideCdxHve,
          commandPath: "/opt/trellage/cdx/bin/cdx",
        },
        {
          launcher: "jcx",
          harness: "jules",
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
          harness: { kind: "copilot", version: "1.0.0" },
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
          harness: { kind: "copilot", version: "1.0.0" },
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
          headless: headless({ prompt: false }),
          locked: false,
          herdrCompatibility: { status: "supported" },
        },
      ],
    }),
  )

const withCdxPstackGuide = (catalog: CombinedGuideCatalog, guide: ProfileGuideV1): CombinedGuideCatalog => ({
  ...catalog,
  native: catalog.native.map((entry) =>
    entry.launcher === "cdx" && entry.name === "pstack" ? { ...entry, guide } : entry,
  ),
})

const writeCdxPstackGuide = async (root: string, markdown: string): Promise<void> => {
  await mkdir(path.join(root, "native", "cdx"), { recursive: true })
  await writeFile(path.join(root, "native", "cdx", "pstack.md"), markdown)
}

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
  optimizeCalls: Array<GuideOptimizeInput> = []

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

  async optimize(input: GuideOptimizeInput): Promise<GuideOptimizeResult> {
    this.optimizeCalls.push(input)
    return {
      candidates: input.candidates.map((candidate) => ({
        ...candidate,
        prompt: `Prompt Master: ${candidate.prompt}`,
      })),
    }
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
      intentStdin: false,
      profile: undefined,
      model: undefined,
      effort: undefined,
    })
  })

  it("accepts a single positional intent instead of --intent", () => {
    const args = parseGuideHeadlessArgv(["--json", "Review my PR"])
    expect(args.intent).toBe("Review my PR")
  })

  it("accepts an inline intent that begins with option-like text", () => {
    const intent = "---\nresult: complete"
    expect(parseGuideHeadlessArgv(["--json", `--intent=${intent}`]).intent).toBe(intent)
  })

  it("accepts --profile only alongside --json", () => {
    const args = parseGuideHeadlessArgv(["--json", "--intent", "Review my PR", "--profile", "native:cdx/pstack"])
    expect(args.profile).toBe("native:cdx/pstack")
  })

  it("rejects --profile without --json", () => {
    expect(() => parseGuideHeadlessArgv(["--intent", "Review my PR", "--profile", "native:cdx/pstack"])).toThrow(
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
    expect(() => parseGuideHeadlessArgv(["--intent=first", "--intent", "second"])).toThrow(GuideArgsError)
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

  it("preserves multiline intent text", () => {
    const intent = "Research the options.\n\nThen recommend:\n- a profile\n- a workflow"
    expect(parseGuideHeadlessArgv(["--json", "--intent", intent]).intent).toBe(intent)
  })

  it("accepts an intent at the 60000-character limit", () => {
    expect(parseGuideHeadlessArgv(["--json", "--intent", "a".repeat(guideIntentMaximumLength)]).intent).toHaveLength(
      guideIntentMaximumLength,
    )
  })

  it("rejects an intent above the 60000-character limit", () => {
    expect(() => parseGuideHeadlessArgv(["--json", "--intent", "a".repeat(guideIntentMaximumLength + 1)])).toThrow(
      GuideValidationError,
    )
  })

  it("counts non-BMP Unicode as code points", () => {
    expect(parseGuideHeadlessArgv(["--intent", "😀".repeat(guideIntentMaximumLength)]).intent).toBe(
      "😀".repeat(guideIntentMaximumLength),
    )
    expect(() => parseGuideHeadlessArgv(["--intent", "😀".repeat(guideIntentMaximumLength + 1)])).toThrow(
      GuideValidationError,
    )
  })

  it("allows JSON mode to read stdin and interactive mode to open its intent editor", () => {
    expect(parseGuideHeadlessArgv(["--json"]).intent).toBeUndefined()
    expect(parseGuideHeadlessArgv([]).intent).toBeUndefined()
    expect(() => parseGuideHeadlessArgv(["--help"])).not.toThrow()
    expect(parseGuideHeadlessArgv(["--help"]).help).toBe(true)
  })

  it("accepts plain-text stdin only for the interactive guide", () => {
    expect(parseGuideHeadlessArgv(["--intent-stdin"]).intentStdin).toBe(true)
    expect(() => parseGuideHeadlessArgv(["--json", "--intent-stdin"])).toThrow(GuideArgsError)
    expect(() => parseGuideHeadlessArgv(["--intent-stdin", "--intent", "duplicate"])).toThrow(GuideArgsError)
    expect(() => parseGuideHeadlessArgv(["--intent-stdin", "duplicate"])).toThrow(GuideArgsError)
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

  it("accepts each interactive long-prompt UI variant", () => {
    for (const variant of Object.values(GuideLongPromptVariant)) {
      expect(parseGuideHeadlessArgv(["--intent", "Review this", "--ui-variant", variant]).uiVariant).toBe(variant)
    }
  })

  it("rejects unknown or JSON-mode UI variants", () => {
    expect(() => parseGuideHeadlessArgv(["--intent", "Review this", "--ui-variant", "unknown"])).toThrow(
      GuideValidationError,
    )
    expect(() =>
      parseGuideHeadlessArgv(["--json", "--intent", "Review this", "--ui-variant", GuideLongPromptVariant.Pager]),
    ).toThrow(GuideArgsError)
  })

  it("preserves multiline Markdown intent formatting", () => {
    const intent = "# Heading\n\n- first\n- second"
    expect(parseGuideHeadlessArgv(["--intent", intent]).intent).toBe(intent)
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

  it("preserves multiline intent text through the service request", () => {
    const intent = "Research the options.\n\nReturn:\n- findings\n- recommendation"
    const request = parseGuideServiceRequestJson(JSON.stringify({ schemaVersion: 1, intent }))
    expect(request.intent).toBe(intent)
  })

  it("accepts optional profile/model/effort", () => {
    const request = parseGuideServiceRequestJson(
      JSON.stringify({
        schemaVersion: 1,
        intent: "Review my PR",
        profile: "native:cdx/pstack",
        model: "gpt-5.4",
        effort: "xhigh",
      }),
    )
    expect(request).toEqual({
      schemaVersion: 1,
      intent: "Review my PR",
      profile: "native:cdx/pstack",
      model: "gpt-5.4",
      effort: GuideEffort.XHigh,
    })
  })

  it("accepts an stdin intent at the 60000-character limit", () => {
    const request = parseGuideServiceRequestJson(
      JSON.stringify({ schemaVersion: 1, intent: "a".repeat(guideIntentMaximumLength) }),
    )
    expect(request.intent).toHaveLength(guideIntentMaximumLength)
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
    expect(resolveGuideModelRouting({}, {})).toEqual(defaultGuideModelRouting)
  })

  it("applies environment overrides across every phase", () => {
    expect(resolveGuideModelRouting({}, { TRELLAGE_GUIDE_MODEL: "gpt-5.4", TRELLAGE_GUIDE_EFFORT: "high" })).toEqual({
      match: { model: "gpt-5.4", effort: GuideEffort.High },
      generate: { model: "gpt-5.4", effort: GuideEffort.High },
      optimize: { model: "gpt-5.4", effort: GuideEffort.High },
      refine: { model: "gpt-5.4", effort: GuideEffort.High },
    })
  })

  it("applies explicit overrides across every phase ahead of the environment", () => {
    expect(
      resolveGuideModelRouting(
        { model: "claude-opus-5", effort: GuideEffort.Max },
        { TRELLAGE_GUIDE_MODEL: "gpt-5.4", TRELLAGE_GUIDE_EFFORT: "high" },
      ),
    ).toEqual({
      match: { model: "claude-opus-5", effort: GuideEffort.Max },
      generate: { model: "claude-opus-5", effort: GuideEffort.Max },
      optimize: { model: "claude-opus-5", effort: GuideEffort.Max },
      refine: { model: "claude-opus-5", effort: GuideEffort.Max },
    })
  })

  it("does not validate shadowed environment values", () => {
    expect(
      resolveGuideModelRouting(
        { model: "claude-opus-5", effort: GuideEffort.Max },
        { TRELLAGE_GUIDE_MODEL: "Not A Model!", TRELLAGE_GUIDE_EFFORT: "extreme" },
      ),
    ).toEqual({
      match: { model: "claude-opus-5", effort: GuideEffort.Max },
      generate: { model: "claude-opus-5", effort: GuideEffort.Max },
      optimize: { model: "claude-opus-5", effort: GuideEffort.Max },
      refine: { model: "claude-opus-5", effort: GuideEffort.Max },
    })
  })

  it("applies an effort-only override without collapsing the phase models", () => {
    expect(resolveGuideModelRouting({ effort: GuideEffort.High }, {})).toEqual({
      match: { model: "gpt-5.6-sol", effort: GuideEffort.High },
      generate: { model: "gpt-5.6-luna", effort: GuideEffort.High },
      optimize: { model: "gpt-5.6-sol", effort: GuideEffort.High },
      refine: { model: "gpt-5.6-sol", effort: GuideEffort.High },
    })
  })

  it("rejects an invalid model from the environment", () => {
    expect(() => resolveGuideModelRouting({}, { TRELLAGE_GUIDE_MODEL: "Not A Model!" })).toThrow(GuideValidationError)
  })

  it("rejects an invalid effort from the environment", () => {
    expect(() => resolveGuideModelRouting({}, { TRELLAGE_GUIDE_EFFORT: "extreme" })).toThrow(GuideValidationError)
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
              profileRef: "native:cdx/pstack",
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
        profileRef: "native:cdx/pstack",
        workflowId: "review",
        surface: "native",
        launcher: "cdx",
        name: "pstack",
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

  it("sends only the deterministic prefilter result to the match provider", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-prefilter-"))
    try {
      const baseCatalog = buildCatalog(tmpRoot)
      const template = baseCatalog.sandbox[1]
      if (template === undefined) throw new Error("missing Sandbox test profile")
      const extraNames = ["headlong", ...Array.from({ length: 16 }, (_, index) => `extra-${index}`)]
      const catalog: CombinedGuideCatalog = {
        ...baseCatalog,
        sandbox: [
          ...baseCatalog.sandbox,
          ...extraNames.map((name) => ({
            ...template,
            name,
            path: path.join(tmpRoot, "profiles", name, "profile.toml"),
          })),
        ],
      }
      const provider = new FakeGuideProvider(
        {
          candidates: [
            {
              profileRef: "native:jcx/foo",
              workflowId: "deep-refactor",
              confidence: 0.9,
              reason: "Strong refactoring fit.",
              tradeoff: "Uses the Jules harness.",
            },
            {
              profileRef: "native:cdx/pstack",
              workflowId: "review",
              confidence: 0.8,
              reason: "Structured engineering fit.",
              tradeoff: "Requires Codex.",
            },
            {
              profileRef: "sandbox:headlong",
              workflowId: "draft",
              confidence: 0.7,
              reason: "Persistent work option.",
              tradeoff: "Adds background machinery.",
            },
          ],
        },
        genCandidates(),
      )

      await runGuideMatch(provider, catalog, {
        intent: "Refactor the payment pipeline carefully with persistent progress",
        model: "test-model",
        effort: GuideEffort.Medium,
      })

      const matchEntries = provider.matchCalls[0]?.entries ?? []
      expect(matchEntries).toHaveLength(12)
      expect(matchEntries.map(({ ref }) => ref)).toEqual(
        expect.arrayContaining(["native:jcx/foo", "native:cdx/pstack", "sandbox:headlong"]),
      )
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
              profileRef: "native:cdx/pstack",
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
              profileRef: "native:cdx/pstack",
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
      expect(response.candidates[0]?.prompt).toBe("Use the writing-plans skill:\nPrompt Master: Do the focused thing.")
      expect(provider.optimizeCalls).toEqual([
        {
          targetTool: "copilot",
          profileRef: "sandbox:prime-agent",
          candidates: genCandidates().candidates,
          fixedFrame: {
            beforeBody: "Use the writing-plans skill:\n",
            afterBody: "",
          },
        },
      ])

      // The provider must receive the full authored guide body, loaded from disk.
      expect(provider.generateCalls).toHaveLength(1)
      expect(provider.generateCalls[0]?.workflowId).toBe("plan")
      expect(provider.generateCalls[0]?.guideBody).toContain("Use this profile for general repository work.")
      expect(provider.generateCalls[0]?.guide).toEqual(guidePrimeAgent)
      expect(provider.matchCalls).toHaveLength(0)

      const serialized = JSON.stringify(response)
      expect(serialized).not.toContain("promptTemplate")
      expect(serialized).not.toContain("fixedFrame")
      expect(serialized).not.toContain("beforeBody")
      expect(serialized).not.toContain("afterBody")
      expect(serialized).not.toContain("profile.toml")
      expect(serialized).not.toContain(tmpRoot)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("reuses headless generation artifacts rooted at the supplied effective cwd", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-cache-"))
    try {
      await writeGuideFixtures(tmpRoot)
      const catalog = buildCatalog(tmpRoot)
      const provider = new FakeGuideProvider({ candidates: [] }, genCandidates())
      const cache = new GuideArtifactCache({
        cwd: tmpRoot,
        routing: defaultGuideModelRouting,
        prompts: { match: "match", generate: "generate", optimize: "optimize", refine: "refine" },
      })
      const request = {
        intent: "Plan the next milestone",
        profileRef: "sandbox:prime-agent",
        model: defaultGuideModelRouting.generate.model,
        effort: defaultGuideModelRouting.generate.effort,
      }

      const first = await runGuideGenerate(provider, catalog, tmpRoot, request, cache)
      const second = await runGuideGenerate(provider, catalog, tmpRoot, request, cache)

      expect(second).toEqual(first)
      expect(provider.generateCalls).toHaveLength(1)
      expect(provider.optimizeCalls).toHaveLength(1)
      expect(await readdir(path.join(tmpRoot, ".trx-guide"))).toHaveLength(1)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("normalizes generated and optimized exact prose-frame echoes before one final render", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-prose-frame-"))
    try {
      await writeGuideFixtures(tmpRoot)
      const catalog = buildCatalog(tmpRoot)
      const optimizeCalls: GuideOptimizeInput[] = []
      const generatedBodies = [
        {
          title: "Focused",
          prompt: "Use the writing-plans skill:\nPlan the milestone in focused phases.",
          notes: "Uses focused phases.",
        },
        {
          title: "Thorough",
          prompt: "Use the writing-plans skill:\nPlan the milestone with risks and dependencies.",
          notes: "Adds risks and dependencies.",
        },
        {
          title: "Cautious",
          prompt: "Use the writing-plans skill:\nPlan the milestone with rollback points.",
          notes: "Adds rollback points.",
        },
      ] as const
      const provider: GuideProvider = {
        match: () => Promise.reject(new Error("match must not be called during generation")),
        generate: async () => ({ candidates: generatedBodies }),
        refine: () => Promise.reject(new Error("refine must not be called during generation")),
        optimize: async (input) => {
          optimizeCalls.push(input)
          return {
            candidates: input.candidates.map((candidate) => ({
              ...candidate,
              prompt: "Use the writing-plans skill:\n" + `Optimized body: ${candidate.prompt}`,
            })),
          }
        },
      }

      const response = await runGuideGenerate(provider, catalog, tmpRoot, {
        intent: "Plan the next milestone",
        profileRef: "sandbox:prime-agent",
        model: "test-model",
        effort: GuideEffort.Medium,
      })

      expect(optimizeCalls[0]?.candidates.map(({ prompt }) => prompt)).toEqual([
        "Plan the milestone in focused phases.",
        "Plan the milestone with risks and dependencies.",
        "Plan the milestone with rollback points.",
      ])
      expect(response.candidates[0]?.prompt).toBe(
        "Use the writing-plans skill:\n" + "Optimized body: Plan the milestone in focused phases.",
      )
      expect(response.candidates[0]?.prompt.match(/Use the writing-plans skill:/gu)).toHaveLength(1)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("fails before optimization when raw candidates collapse after generated-body normalization", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-body-collision-"))
    try {
      await writeGuideFixtures(tmpRoot)
      const catalog = buildCatalog(tmpRoot)
      const rawCandidates = [
        {
          title: "Exact frame",
          prompt: "Use the writing-plans skill:\nPlan the same milestone.",
          notes: "Uses the exact frame.",
        },
        {
          title: "Reflowed frame",
          prompt: "Use  the writing-plans skill:\nPlan the same milestone.",
          notes: "Reflows the prefix.",
        },
        {
          title: "Reflowed boundary",
          prompt: "Use the writing-plans skill: \n\tPlan the same milestone.",
          notes: "Reflows the body boundary.",
        },
      ] as const
      let optimizeCalls = 0
      const provider: GuideProvider = {
        match: () => Promise.reject(new Error("match must not be called during generation")),
        generate: async () => ({ candidates: rawCandidates }),
        refine: () => Promise.reject(new Error("refine must not be called during generation")),
        optimize: async () => {
          optimizeCalls += 1
          throw new Error("optimize must not be called after a body collision")
        },
      }

      expect(new Set(rawCandidates.map(({ prompt }) => prompt)).size).toBe(3)
      await expect(
        runGuideGenerate(provider, catalog, tmpRoot, {
          intent: "Plan the next milestone",
          profileRef: "sandbox:prime-agent",
          model: "test-model",
          effort: GuideEffort.Medium,
        }),
      ).rejects.toThrow(/no longer distinct after generated-body normalization.*template fallback/u)
      expect(optimizeCalls).toBe(0)
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
              profileRef: "native:cdx/pstack",
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
      expect(response.candidates[0]?.prompt).toBe("Prompt Master: Do the focused thing.")
      expect(provider.optimizeCalls).toEqual([
        {
          targetTool: "jules",
          profileRef: "native:jcx/foo",
          candidates: genCandidates().candidates,
        },
      ])
      expect(provider.generateCalls[0]?.workflowId).toBe("deep-refactor")
      expect(provider.generateCalls[0]?.guideBody).toContain("Use this profile for repository delivery.")
      expect(provider.matchCalls).toHaveLength(0)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("keeps no-skill generated and optimized candidates as complete prompts without a fixed frame", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-complete-prompts-"))
    try {
      await writeGuideFixtures(tmpRoot)
      const catalog = buildCatalog(tmpRoot)
      const generatedCandidates = [
        {
          title: "Focused",
          prompt: "Carefully refactor: the payment pipeline with focused regression coverage.",
          notes: "Keeps the refactor focused.",
        },
        {
          title: "Phased",
          prompt: "Carefully refactor: the payment pipeline in verified phases.",
          notes: "Uses verified phases.",
        },
        {
          title: "Rollback",
          prompt: "Carefully refactor: the payment pipeline with explicit rollback points.",
          notes: "Adds rollback planning.",
        },
      ] as const
      let optimizeInput: GuideOptimizeInput | undefined
      const provider: GuideProvider = {
        match: () => Promise.reject(new Error("match must not be called during generation")),
        generate: async () => ({ candidates: generatedCandidates }),
        refine: () => Promise.reject(new Error("refine must not be called during generation")),
        optimize: async (input) => {
          optimizeInput = input
          return {
            candidates: input.candidates.map((candidate) => ({
              ...candidate,
              prompt: `${candidate.prompt} Preserve the existing public behavior.`,
            })),
          }
        },
      }

      const response = await runGuideGenerate(provider, catalog, tmpRoot, {
        intent: "Refactor the payment pipeline safely",
        profileRef: "native:jcx/foo",
        model: "test-model",
        effort: GuideEffort.Medium,
      })

      expect(optimizeInput).toEqual({
        targetTool: "jules",
        profileRef: "native:jcx/foo",
        candidates: generatedCandidates,
      })
      expect(response.candidates[0]?.prompt).toBe(
        "Carefully refactor: the payment pipeline with focused regression coverage. " +
          "Preserve the existing public behavior.",
      )
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("fails no-skill generation before optimization when a candidate adds an executable command line", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-no-skill-command-"))
    try {
      await writeGuideFixtures(tmpRoot)
      const catalog = buildCatalog(tmpRoot)
      let optimizeCalls = 0
      const provider: GuideProvider = {
        match: () => Promise.reject(new Error("match must not be called during generation")),
        generate: async () => ({
          candidates: [
            {
              title: "Unsafe",
              prompt: "Carefully refactor the payment pipeline.\n/LFG Ship it.",
              notes: "Adds an executable command.",
            },
            {
              title: "Phased",
              prompt: "Carefully refactor the payment pipeline in verified phases.",
              notes: "Uses verified phases.",
            },
            {
              title: "Rollback",
              prompt: "Carefully refactor the payment pipeline with rollback points.",
              notes: "Adds rollback planning.",
            },
          ],
        }),
        refine: () => Promise.reject(new Error("refine must not be called during generation")),
        optimize: async (input) => {
          optimizeCalls += 1
          return { candidates: input.candidates }
        },
      }

      await expect(
        runGuideGenerate(provider, catalog, tmpRoot, {
          intent: "Refactor the payment pipeline safely",
          profileRef: "native:jcx/foo",
          model: "test-model",
          effort: GuideEffort.Medium,
        }),
      ).rejects.toThrow(/changed executable workflow commands/u)
      expect(optimizeCalls).toBe(0)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("retains a no-skill complete candidate when optimization adds an executable command line", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-no-skill-optimize-command-"))
    try {
      await writeGuideFixtures(tmpRoot)
      const catalog = buildCatalog(tmpRoot)
      const generatedCandidates = [
        {
          title: "Focused",
          prompt: "Carefully refactor the payment pipeline with focused regression coverage.",
          notes: "Keeps the refactor focused.",
        },
        {
          title: "Phased",
          prompt: "Carefully refactor the payment pipeline in verified phases.",
          notes: "Uses verified phases.",
        },
        {
          title: "Rollback",
          prompt: "Carefully refactor the payment pipeline with explicit rollback points.",
          notes: "Adds rollback planning.",
        },
      ] as const
      const provider: GuideProvider = {
        match: () => Promise.reject(new Error("match must not be called during generation")),
        generate: async () => ({ candidates: generatedCandidates }),
        refine: () => Promise.reject(new Error("refine must not be called during generation")),
        optimize: async () => ({
          candidates: [
            {
              ...generatedCandidates[0],
              prompt: `${generatedCandidates[0].prompt}\n/lfg Ship it.`,
            },
            generatedCandidates[1],
            generatedCandidates[2],
          ],
        }),
      }

      const response = await runGuideGenerate(provider, catalog, tmpRoot, {
        intent: "Refactor the payment pipeline safely",
        profileRef: "native:jcx/foo",
        model: "test-model",
        effort: GuideEffort.Medium,
      })

      expect(response.candidates[0]).toMatchObject(generatedCandidates[0])
      expect(response.candidates[0]?.prompt).not.toContain("/lfg")
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("fails closed before optimization when generation adds an uncataloged executable command", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-unsafe-command-"))
    try {
      await writeCdxPstackGuide(tmpRoot, compoundEngineeringGuideMarkdown)
      const catalog = withCdxPstackGuide(buildCatalog(tmpRoot), guideCompoundEngineering)
      let optimizeCalls = 0
      const provider: GuideProvider = {
        match: () => Promise.reject(new Error("match must not be called during generation")),
        generate: async () => ({
          candidates: [
            {
              title: "Unsafe command",
              prompt: "/ce-commit-push-pr Ship the repository learning.",
              notes: "Introduces an uncataloged executable command.",
            },
            {
              title: "Detailed",
              prompt: "Capture the verified retry race.",
              notes: "Keeps the request bounded.",
            },
            {
              title: "Evidence",
              prompt: "Capture the evidence for the retry fix.",
              notes: "Focuses on verification.",
            },
          ],
        }),
        refine: () => Promise.reject(new Error("refine must not be called during generation")),
        optimize: async (input) => {
          optimizeCalls += 1
          return { candidates: input.candidates }
        },
      }

      await expect(
        runGuideGenerate(provider, catalog, tmpRoot, {
          intent: "Capture this verified repository learning.",
          profileRef: "native:cdx/pstack",
          model: "test-model",
          effort: GuideEffort.Medium,
        }),
      ).rejects.toThrow(/changed executable workflow commands/u)
      expect(optimizeCalls).toBe(0)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("fails final generation when optimization fallback and rendering collapse candidates", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-final-collision-"))
    try {
      await writeCdxPstackGuide(tmpRoot, compoundEngineeringGuideMarkdown)
      const catalog = withCdxPstackGuide(buildCatalog(tmpRoot), guideCompoundEngineering)
      let optimizeCalls = 0
      const provider: GuideProvider = {
        match: () => Promise.reject(new Error("match must not be called during generation")),
        generate: async () => ({
          candidates: [
            {
              title: "First",
              prompt: "Capture the first verified learning.",
              notes: "First body.",
            },
            {
              title: "Second",
              prompt: "Capture the second verified learning.",
              notes: "Second body.",
            },
            {
              title: "Third",
              prompt: "Capture the third verified learning.",
              notes: "Third body.",
            },
          ],
        }),
        refine: () => Promise.reject(new Error("refine must not be called during generation")),
        optimize: async () => {
          optimizeCalls += 1
          return {
            candidates: [
              {
                title: "Safe collision",
                prompt: "Capture the second verified learning.",
                notes: "Safely rewrites the first candidate to the second body.",
              },
              {
                title: "Unsafe rewrite",
                prompt: "/lfg Ship an unrelated change.",
                notes: "Falls back to the authorized second candidate.",
              },
              {
                title: "Distinct third",
                prompt: "Capture the third verified learning with evidence.",
                notes: "Keeps the third candidate distinct.",
              },
            ],
          }
        },
      }

      await expect(
        runGuideGenerate(provider, catalog, tmpRoot, {
          intent: "Capture this verified repository learning.",
          profileRef: "native:cdx/pstack",
          model: "test-model",
          effort: GuideEffort.Medium,
        }),
      ).rejects.toThrow(/no longer distinct after optimization resolution and exact rendering.*template fallback/u)
      expect(optimizeCalls).toBe(1)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("never sends a 60000-character intent fallback to optimization", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-long-intent-"))
    try {
      await writeCdxPstackGuide(tmpRoot, compoundEngineeringGuideMarkdown)
      const catalog = withCdxPstackGuide(buildCatalog(tmpRoot), guideCompoundEngineering)
      const intent = `Capture ${"x".repeat(59_992)}`
      let optimizeInput: GuideOptimizeInput | undefined
      const provider: GuideProvider = {
        match: () => Promise.reject(new Error("match must not be called during generation")),
        generate: async () => ({
          candidates: [
            {
              title: "Unsafe sibling",
              prompt: "/LFG Ship this change.",
              notes: "Introduces a sibling workflow.",
            },
            {
              title: "Detailed",
              prompt: "Capture the bounded generated detail.",
              notes: "Keeps the candidate bounded.",
            },
            {
              title: "Evidence",
              prompt: "Capture the bounded verification evidence.",
              notes: "Keeps the candidate bounded.",
            },
          ],
        }),
        refine: () => Promise.reject(new Error("refine must not be called during generation")),
        optimize: async (input) => {
          optimizeInput = input
          return { candidates: input.candidates }
        },
      }

      expect(intent).toHaveLength(60_000)
      await expect(
        runGuideGenerate(provider, catalog, tmpRoot, {
          intent,
          profileRef: "native:cdx/pstack",
          model: "test-model",
          effort: GuideEffort.Medium,
        }),
      ).rejects.toThrow(/changed executable workflow commands/u)
      expect(optimizeInput).toBeUndefined()
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("normalizes a leading command echo before rendering the exact fixed argument once", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-compound-"))
    try {
      await writeCdxPstackGuide(tmpRoot, compoundEngineeringGuideMarkdown)
      const catalog = withCdxPstackGuide(buildCatalog(tmpRoot), guideCompoundEngineering)
      const optimizeCalls: GuideOptimizeInput[] = []
      const provider: GuideProvider = {
        match: () => Promise.reject(new Error("match must not be called during generation")),
        generate: async () => ({
          candidates: [
            {
              title: "Echoed command",
              prompt: "/ce-compound Capture the bounded generated repository learning.",
              notes: "Notes for the bounded generated body.",
            },
            {
              title: "Detailed",
              prompt: "Capture the verified retry race and the database constraint that fixed it.",
              notes: "Includes the cause and solution.",
            },
            {
              title: "Evidence",
              prompt: "Capture the evidence that proves the retry fix is correct.",
              notes: "Emphasizes verification.",
            },
          ],
        }),
        refine: () => Promise.reject(new Error("refine must not be called during generation")),
        optimize: async (input) => {
          optimizeCalls.push(input)
          return {
            candidates: [
              {
                title: "Normalized optimizer echo",
                prompt: "/ce-compound Rewrite the repository learning.",
                notes: "The optimizer omitted the authored fixed argument.",
              },
              {
                title: "Sharper verified learning",
                prompt:
                  "Capture the verified retry race, its database constraint fix, and the evidence that proves it.",
                notes: "Keeps the cause, fix, and verification together.",
              },
              input.candidates[2]!,
            ],
          }
        },
      }

      const response = await runGuideGenerate(provider, catalog, tmpRoot, {
        intent: "Capture this verified repository learning.",
        profileRef: "native:cdx/pstack",
        model: "test-model",
        effort: GuideEffort.Medium,
      })

      expect(optimizeCalls).toEqual([
        {
          targetTool: "codex",
          profileRef: "native:cdx/pstack",
          candidates: [
            {
              title: "Echoed command",
              prompt: "Capture the bounded generated repository learning.",
              notes: "Notes for the bounded generated body.",
            },
            {
              title: "Detailed",
              prompt: "Capture the verified retry race and the database constraint that fixed it.",
              notes: "Includes the cause and solution.",
            },
            {
              title: "Evidence",
              prompt: "Capture the evidence that proves the retry fix is correct.",
              notes: "Emphasizes verification.",
            },
          ],
          fixedFrame: {
            beforeBody: "/ce-compound mode:non-interactive ",
            afterBody: "",
          },
        },
      ])
      expect(response.candidates[0]).toMatchObject({
        title: "Normalized optimizer echo",
        prompt: "/ce-compound mode:non-interactive " + "Rewrite the repository learning.",
        notes: "The optimizer omitted the authored fixed argument.",
      })
      expect(response.candidates[1]?.prompt).toBe(
        "/ce-compound mode:non-interactive " +
          "Capture the verified retry race, its database constraint fix, and the evidence that proves it.",
      )
      expect(response.candidates[1]?.title).toBe("Sharper verified learning")
      expect(response.candidates[0]?.prompt.match(/\/ce-compound/gu)).toHaveLength(1)
      expect(response.candidates[0]?.prompt.match(/mode:non-interactive/gu)).toHaveLength(1)
      expect(response.candidates[0]?.command.args).toEqual([
        "pstack",
        "-p",
        "/ce-compound mode:non-interactive Rewrite the repository learning.",
      ])
      const serialized = JSON.stringify(response)
      expect(serialized).not.toContain("promptTemplate")
      expect(serialized).not.toContain("fixedFrame")
      expect(serialized).not.toContain("beforeBody")
      expect(serialized).not.toContain("afterBody")
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("keeps authored pstack suffix commands exact, ordered, unfenced, and last", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-api-pstack-"))
    try {
      await writeCdxPstackGuide(tmpRoot, pstackGuideMarkdown)
      const catalog = withCdxPstackGuide(buildCatalog(tmpRoot), guidePstack)
      const optimizeCalls: GuideOptimizeInput[] = []
      const provider: GuideProvider = {
        match: () => Promise.reject(new Error("match must not be called during generation")),
        generate: async () => genCandidates(),
        refine: () => Promise.reject(new Error("refine must not be called during generation")),
        optimize: async (input) => {
          optimizeCalls.push(input)
          return {
            candidates: [
              {
                title: "Structured review",
                prompt: [
                  "## Goal",
                  "",
                  "Review the queue for concurrency defects.",
                  "",
                  "```text",
                  "Preserve the observed failure evidence.",
                  "```",
                ].join("\n"),
                notes: "Uses a structured multi-line review body.",
              },
              input.candidates[1]!,
              input.candidates[2]!,
            ],
          }
        },
      }

      const response = await runGuideGenerate(provider, catalog, tmpRoot, {
        intent: "Review and polish this queue change",
        profileRef: "native:cdx/pstack",
        model: "test-model",
        effort: GuideEffort.Medium,
      })

      expect(optimizeCalls[0]).toMatchObject({
        candidates: genCandidates().candidates,
        fixedFrame: {
          beforeBody: "$pstack-for-codex:interrogate ",
          afterBody: "\n$pstack-for-codex:no-comments\n$pstack-for-codex:unslop",
        },
      })
      const prompt = response.candidates[0]?.prompt ?? ""
      const noCommentsIndex = prompt.indexOf("$pstack-for-codex:no-comments")
      const unslopIndex = prompt.indexOf("$pstack-for-codex:unslop")
      expect(prompt).toBe(
        [
          "$pstack-for-codex:interrogate ## Goal",
          "",
          "Review the queue for concurrency defects.",
          "",
          "```text",
          "Preserve the observed failure evidence.",
          "```",
          "$pstack-for-codex:no-comments",
          "$pstack-for-codex:unslop",
        ].join("\n"),
      )
      expect(noCommentsIndex).toBeGreaterThan(prompt.lastIndexOf("```"))
      expect(unslopIndex).toBeGreaterThan(noCommentsIndex)
      expect(prompt.endsWith("$pstack-for-codex:unslop")).toBe(true)
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
    const command = publicGuideLaunchCommand(catalog, "native:cdx/pstack", "say hello world")
    expect(command.executable).toBe("cdx")
    expect(command.args).toEqual(["pstack", "-p", "say hello world"])
    expect(command.promptHandling).toBe("argv")
    expect(command.preview).toBe(`cdx pstack -p 'say hello world'`)
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
    expect(selectedProfileFromCatalogRef(catalog, "native:cdx/pstack")).toEqual({
      surface: "native",
      launcher: "cdx",
      commandPath: "/opt/trellage/cdx/bin/cdx",
      profile: "pstack",
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
  it("ranks an explicitly named native launcher and profile first", () => {
    const candidates = literalGuideMatch(buildCatalog("/tmp-unused"), "Use cdx pstack to review this change")

    expect(candidates[0]?.profileRef).toBe("native:cdx/pstack")
    expect(candidates[0]?.reason).toContain("explicitly names native:cdx/pstack")
  })

  it("ranks known profiles by normalized token overlap, distinct refs, source-order tie-break", () => {
    const catalog = buildCatalog("/tmp-unused")
    const candidates = literalGuideMatch(catalog, "Refactor the payment pipeline carefully")

    expect(candidates).toHaveLength(4)
    const refs = candidates.map((c) => c.profileRef)
    expect(new Set(refs).size).toBe(candidates.length)
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

  it("normalizes token overlap so focused metadata outranks a broader keyword list", () => {
    const catalog = buildCatalog("/tmp-unused")
    const verboseGuide: ProfileGuideV1 = {
      ...guideFoo,
      capabilities: [
        "payments",
        "refactoring",
        "documentation",
        "browser-automation",
        "deployment",
        "monitoring",
        "security",
        "accessibility",
      ],
      bestFor: [
        "Payment work plus documentation, browser automation, deployment, monitoring, security, and accessibility",
      ],
      workflows: [
        {
          id: "broad-repository-work",
          description:
            "Handle payment refactors, documentation, browser automation, deployment, monitoring, security, and accessibility.",
          examples: ["Refactor the payment pipeline", "Work across many unrelated repository concerns"],
          promptTemplate: "{{intent}}",
        },
      ],
    }
    const focusedGuide: ProfileGuideV1 = {
      ...guideCdxHve,
      capabilities: ["payment-pipeline-refactoring"],
      bestFor: ["Focused payment pipeline refactors"],
      workflows: [
        {
          id: "payment-refactor",
          description: "Refactor a payment pipeline.",
          examples: ["Refactor the payment pipeline", "Simplify the payment processing path"],
          promptTemplate: "{{intent}}",
        },
      ],
    }
    const comparisonCatalog: CombinedGuideCatalog = {
      ...catalog,
      native: [
        { ...catalog.native[1]!, guide: verboseGuide, description: "Broad repository engineering profile." },
        { ...catalog.native[0]!, guide: focusedGuide, description: "Focused payment pipeline refactoring." },
      ],
    }

    const refs = literalGuideMatch(comparisonCatalog, "Refactor the payment pipeline").map(
      ({ profileRef }) => profileRef,
    )
    expect(refs.indexOf("native:cdx/pstack")).toBeLessThan(refs.indexOf("native:jcx/foo"))
  })

  it("throws when the catalog has fewer than three profiles", () => {
    const tinyCatalog = parseGuideCatalog(
      JSON.stringify({
        schemaVersion: 1,
        sandboxCommandPath: "/opt/trellage/bin/trellage",
        native: [
          {
            launcher: "cdx",
            harness: "codex",
            name: "pstack",
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

  it("keeps required workflow activation markers before Markdown fallback sections", () => {
    const guide: ProfileGuideV1 = {
      ...guidePrimeAgent,
      workflows: [
        {
          id: "poteto",
          description: "Run Poteto Mode.",
          skill: "pstack-for-codex:poteto-mode",
          examples: ["Implement a feature"],
          promptTemplate: "$poteto-mode\n$pstack-for-codex:poteto-mode {{intent}}",
        },
      ],
    }
    const candidates = templatePromptCandidates(guide, "poteto", "Implement the queue")
    for (const candidate of candidates) {
      expect(candidate.prompt).toMatch(/^\$poteto-mode\n\$pstack-for-codex:poteto-mode/u)
    }
    expect(candidates[1].prompt).toContain("\n\n## Scope\n")
    expect(candidates[2].prompt).toContain("\n\n## Completion\n")
  })

  it("keeps fallback constraints inside the current HVE plan-and-critique prose frame", () => {
    const hveGuide: ProfileGuideV1 = {
      schemaVersion: 1,
      capabilities: ["evidence-backed-rpi-delivery"],
      bestFor: ["Research, Plan, Implement, and Review workflows"],
      avoidFor: ["Unrelated prose"],
      prerequisites: [],
      workflows: [
        {
          id: "rpi-plan-and-critique",
          description: "Draft and critique an implementation plan.",
          examples: ["Turn the research into a plan", "Critique this plan"],
          promptTemplate:
            "Use the rpi-plan skill to draft a plan for {{intent}}, then use\n" +
            "rpi-plan-critique to challenge it before implementation begins.",
        },
      ],
    }
    const candidates = templatePromptCandidates(hveGuide, "rpi-plan-and-critique", "the queue retry change")
    expect(candidates[1].prompt).toBe(
      "Use the rpi-plan skill to draft a plan for the queue retry change; " +
        "keep the work within the smallest reasonable scope, then use\n" +
        "rpi-plan-critique to challenge it before implementation begins.",
    )
    expect(candidates[2].prompt).toBe(
      "Use the rpi-plan skill to draft a plan for the queue retry change; " +
        "after completing the work, verify it and report the verification evidence, then use\n" +
        "rpi-plan-critique to challenge it before implementation begins.",
    )
    expect(candidates[1].prompt).not.toContain("## Scope")
    expect(candidates[2].prompt).not.toContain("## Completion")
  })

  it("keeps Superpowers fallback constraints inside the body before its prose suffix", () => {
    const superpowersGuide: ProfileGuideV1 = {
      schemaVersion: 1,
      capabilities: ["plan-and-execute"],
      bestFor: ["Plan-led implementation"],
      avoidFor: ["Unrelated prose"],
      prerequisites: [],
      workflows: [
        {
          id: "plan-then-execute-branch",
          description: "Plan, execute, and finish a development branch.",
          skill: "writing-plans",
          examples: ["Plan and implement this feature", "Finish this approved plan"],
          promptTemplate:
            "Use the writing-plans skill to draft a plan for {{intent}}, then\n" +
            "executing-plans to carry it out, and finishing-a-development-branch to\n" +
            "close it out.",
        },
      ],
    }
    const candidates = templatePromptCandidates(superpowersGuide, "plan-then-execute-branch", "the upload feature")
    expect(candidates[1].prompt).toBe(
      "Use the writing-plans skill to draft a plan for the upload feature; " +
        "keep the work within the smallest reasonable scope, then\n" +
        "executing-plans to carry it out, and finishing-a-development-branch to\n" +
        "close it out.",
    )
    expect(candidates[1].prompt).not.toContain("## Scope")

    const normalizedDirect = templatePromptCandidates(
      superpowersGuide,
      "plan-then-execute-branch",
      "USE THE WRITING PLANS SKILL TO DRAFT A PLAN FOR the upload feature",
    )[0]
    expect(normalizedDirect.prompt).toBe(
      "Use the writing-plans skill to draft a plan for the upload feature, then\n" +
        "executing-plans to carry it out, and finishing-a-development-branch to\n" +
        "close it out.",
    )
    expect(normalizedDirect.prompt.match(/writing-plans skill to draft a plan/giu)).toHaveLength(1)
  })

  it("uses inline fallback constraints before Plannotator sentence punctuation", () => {
    const plannotatorGuide: ProfileGuideV1 = {
      schemaVersion: 1,
      capabilities: ["visual-artifacts"],
      bestFor: ["Interactive HTML prototypes"],
      avoidFor: ["Unrelated prose"],
      prerequisites: [],
      workflows: [
        {
          id: "wireframe-or-prototype",
          description: "Create a wireframe or polished prototype.",
          skill: "html-prototype",
          examples: ["Create a responsive wireframe", "Build an interactive prototype"],
          promptTemplate:
            "Use html-wireframe for a low-fidelity structure or html-prototype for a\n" +
            "polished interactive result that addresses {{intent}}.",
        },
      ],
    }
    const candidates = templatePromptCandidates(plannotatorGuide, "wireframe-or-prototype", "the deployment dashboard.")

    expect(candidates[0].prompt).toBe(
      "Use html-wireframe for a low-fidelity structure or html-prototype for a\n" +
        "polished interactive result that addresses the deployment dashboard.",
    )
    expect(candidates[1].prompt).toBe(
      "Use html-wireframe for a low-fidelity structure or html-prototype for a\n" +
        "polished interactive result that addresses the deployment dashboard; " +
        "keep the work within the smallest reasonable scope.",
    )
    expect(candidates[2].prompt).toBe(
      "Use html-wireframe for a low-fidelity structure or html-prototype for a\n" +
        "polished interactive result that addresses the deployment dashboard; " +
        "after completing the work, verify it and report the verification evidence.",
    )
    expect(candidates[1].prompt).not.toContain("## Scope")
    expect(candidates[2].prompt).not.toContain("## Completion")
  })

  it.each([
    ["trailing spaces", "the queue retry race. "],
    ["trailing newline", "the queue retry race.\n"],
  ])("renders one final period for a Superpowers-shaped Direct fallback with %s", (_kind, intent) => {
    const superpowersGuide: ProfileGuideV1 = {
      schemaVersion: 1,
      capabilities: ["test-driven-development"],
      bestFor: ["Test-first implementation"],
      avoidFor: ["Unrelated prose"],
      prerequisites: [],
      workflows: [
        {
          id: "test-driven-development",
          description: "Drive an implementation from a failing test.",
          skill: "test-driven-development",
          examples: ["Fix this regression test-first"],
          promptTemplate:
            "Use the test-driven-development and systematic-debugging skills to\n" + "address {{intent}}.",
        },
      ],
    }

    const candidates = templatePromptCandidates(superpowersGuide, "test-driven-development", intent)

    expect(candidates[0].prompt).toBe(
      "Use the test-driven-development and systematic-debugging skills to\n" + "address the queue retry race.",
    )
    expect(candidates[0].prompt.endsWith("..")).toBe(false)
  })

  it("keeps Council fallback constraints inside the body before the authored prose suffix", () => {
    const suffix =
      "\n\nChallenge the assumptions, identify risks and failure modes, compare credible alternatives,\n" +
      "assess feasibility and implementation tradeoffs, and recommend concrete next steps."
    const councilGuide: ProfileGuideV1 = {
      schemaVersion: 1,
      capabilities: ["multi-perspective-deliberation"],
      bestFor: ["Pressure-testing ideas"],
      avoidFor: ["Quick factual lookups"],
      prerequisites: [],
      workflows: [
        {
          id: "run-council-deliberation",
          description: "Pressure-test an idea and its implementation.",
          skill: "council",
          examples: ["Challenge this product decision"],
          promptTemplate: "/council Pressure-test this idea and its implementation: {{intent}}" + suffix,
        },
      ],
    }
    const candidates = templatePromptCandidates(
      councilGuide,
      "run-council-deliberation",
      "adopting event sourcing for billing",
    )

    expect(candidates[1].prompt).toBe(
      "/council Pressure-test this idea and its implementation: " +
        "adopting event sourcing for billing; keep the work within the smallest reasonable scope." +
        suffix,
    )
    expect(candidates[2].prompt).toBe(
      "/council Pressure-test this idea and its implementation: " +
        "adopting event sourcing for billing; after completing the work, verify it and report the verification evidence." +
        suffix,
    )
    expect(candidates[1].prompt).not.toContain("## Scope")
    expect(candidates[2].prompt).not.toContain("## Completion")
  })

  it.each([
    {
      name: "Council",
      workflowId: "run-council-deliberation",
      command: "/council",
      body: "Should we adopt event sourcing for billing?",
      prefix: "/council Pressure-test this idea and its implementation: ",
      suffix:
        "\n\nChallenge the assumptions, identify risks and failure modes, compare credible alternatives,\n" +
        "assess feasibility and implementation tradeoffs, and recommend concrete next steps.",
      skill: "council",
    },
    {
      name: "Hyperresearch",
      workflowId: "vault-backed-research",
      command: "/hyperresearch",
      body: "Compare passkeys with passwords for enterprise support costs.",
      prefix: "/hyperresearch Research the evidence that should inform this request before implementation: ",
      suffix:
        "\n\nFind relevant prior art and source-backed evidence, identify unresolved questions and risks,\n" +
        "compare implementation options, and explain how the findings should change the approach.",
      skill: "hyperresearch",
    },
  ])("does not duplicate a command-prefixed intent in the $name Direct fallback", (testCase) => {
    const guide: ProfileGuideV1 = {
      schemaVersion: 1,
      capabilities: ["framed-workflow"],
      bestFor: ["Structured work"],
      avoidFor: ["Unrelated prose"],
      prerequisites: [],
      workflows: [
        {
          id: testCase.workflowId,
          description: `Run the ${testCase.name} workflow.`,
          skill: testCase.skill,
          examples: [`${testCase.command} example`],
          promptTemplate: `${testCase.prefix}{{intent}}${testCase.suffix}`,
        },
      ],
    }

    const direct = templatePromptCandidates(guide, testCase.workflowId, `${testCase.command} ${testCase.body}`)[0]

    expect(direct.prompt).toBe(`${testCase.prefix}${testCase.body}${testCase.suffix}`)
    expect(direct.prompt.match(new RegExp(testCase.command, "gu"))).toHaveLength(1)
  })

  it.each([
    {
      name: "exact",
      intent: "Pressure-test this idea and its implementation: adopt event sourcing.",
    },
    {
      name: "whitespace-flexible",
      intent: "Pressure-test  this idea and its implementation:\n adopt event sourcing.",
    },
    {
      name: "case and punctuation normalized",
      intent: "PRESSURE test this IDEA and its IMPLEMENTATION - adopt event sourcing.",
    },
  ])("normalizes a $name commandless Council prefix in the Direct fallback", ({ intent }) => {
    const suffix =
      "\n\nChallenge the assumptions, identify risks and failure modes, compare credible alternatives,\n" +
      "assess feasibility and implementation tradeoffs, and recommend concrete next steps."
    const councilGuide: ProfileGuideV1 = {
      schemaVersion: 1,
      capabilities: ["multi-perspective-deliberation"],
      bestFor: ["Pressure-testing ideas"],
      avoidFor: ["Quick factual lookups"],
      prerequisites: [],
      workflows: [
        {
          id: "run-council-deliberation",
          description: "Pressure-test an idea and its implementation.",
          skill: "council",
          examples: ["Challenge this product decision"],
          promptTemplate: "/council Pressure-test this idea and its implementation: {{intent}}" + suffix,
        },
      ],
    }

    const direct = templatePromptCandidates(councilGuide, "run-council-deliberation", intent)[0]

    expect(direct.prompt).toBe(
      "/council Pressure-test this idea and its implementation: adopt event sourcing." + suffix,
    )
    expect(direct.prompt.match(/Pressure-test this idea and its implementation:/gu)).toHaveLength(1)
  })

  it("renders fallback Scope and Completion sections inside suffix-command frames", () => {
    const candidates = templatePromptCandidates(guidePstack, "review-and-polish", "Review the queue change")
    const suffix = "\n$pstack-for-codex:no-comments\n$pstack-for-codex:unslop"

    expect(candidates[0].prompt).toBe("$pstack-for-codex:interrogate Review the queue change" + suffix)
    expect(candidates[1].prompt).toContain(
      "Review the queue change\n\n## Scope\n\nLimit the change to the smallest reasonable scope." + suffix,
    )
    expect(candidates[2].prompt).toContain(
      "Review the queue change\n\n## Completion\n\n" +
        "After completing the work, verify it and report the verification evidence." +
        suffix,
    )
    for (const candidate of candidates) {
      expect(candidate.prompt.endsWith("$pstack-for-codex:unslop")).toBe(true)
    }
  })
})
