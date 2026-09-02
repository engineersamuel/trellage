import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import type { ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import { parseGuideCatalog, type CombinedGuideCatalog } from "../src/guide-catalog.js"
import {
  GuideEffort,
  guideIntentMaximumLength,
  literalGuideMatch,
  templatePromptCandidates,
  type GuideRecommendation,
} from "../src/guide-api.js"
import type {
  GuideGenerateCandidate,
  GuideGenerateInput,
  GuideGenerateResult,
  GuideMatchInput,
  GuideMatchResult,
  GuideOptimizeInput,
  GuideOptimizeResult,
  GuideProvider,
  GuideRefineInput,
  GuideRefineResult,
} from "../src/guide-provider.js"
import type { SelectedGuideDocument } from "../src/guide-selected.js"
import type { GitInspectionReady, HerdrContext, SelectedProfile, WorktreeCollisionResult } from "../src/guide-launch.js"
import { ProfileReadinessKind, type ProfileReadinessResult } from "../src/guide-preflight.js"
import {
  GuideGenerationPhase,
  GuideMatchPhase,
  GuidePinnedLensKind,
  GuideUiActionType,
  GuideUiDestination,
  GuideUiStage,
  GuideWizardStep,
  buildCancelResult,
  buildCurrentHerdrWorkspaceResult,
  buildCurrentTerminalResult,
  buildExistingHerdrWorktreeResult,
  buildNewHerdrWorktreeResult,
  buildPrintResult,
  boundedPastedText,
  candidatePaneHeight,
  candidateRailWidth,
  captureSourcePresentation,
  compactCommandPreview,
  createInitialGuideUiState,
  describeGuideUiError,
  destinationOptions,
  guideTextViewport,
  enrichLiteralCandidate,
  generationProgressItems,
  guideUiReducer,
  isWithinTextBound,
  promptReviewMetrics,
  isWorktreeConfirmed,
  literalGuideRecommendations,
  markdownPromptLines,
  markdownInlineSegments,
  matchProgressItems,
  pinnedGuideLenses,
  requiredWorktreeConfirmations,
  runGuideGenerationStep,
  runGuideMatchingStep,
  runGuideRefinementStep,
  selectedProfileForPinnedLens,
  spinnerFrameAt,
  spinnerMessageAt,
  summarizeGenerationIntent,
  wrapGuideText,
  templateGuideCandidates,
  wizardStepForStage,
  wizardBreadcrumbLabel,
  worktreeDirtyWarning,
  type GuideUiAction,
  type GuideUiState,
} from "../src/guide-ui.js"

// ---------------------------------------------------------------------------
// Shared fixtures: a 3-entry catalog (2 native, 1 sandbox), mirroring the
// fixture conventions in test/guide-api.test.ts.
// ---------------------------------------------------------------------------

const headless = (overrides: { readonly prompt: boolean }): CombinedGuideCatalog["native"][number]["headless"] => ({
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

const guideReviewer: ProfileGuideV1 = {
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
      promptTemplate: "Review the diff for: {{intent}}",
    },
  ],
}

const firstmateGuide = (pstackWorkers: boolean): ProfileGuideV1 => ({
  schemaVersion: 1,
  capabilities: ["fleet-orchestration"],
  bestFor: ["Parallel repository work", "Captain-owned delivery"],
  avoidFor: ["One-line edits", "Untrusted repositories"],
  prerequisites: [{ id: "git-repo", description: "A git repository checkout." }],
  workflows: [
    {
      id: "orchestrate",
      description: "Coordinate a Firstmate fleet.",
      examples: ["Coordinate parallel implementation", "Dispatch isolated workers"],
      promptTemplate: [
        pstackWorkers ? "## Firstmate pstack-worker operating contract" : "## Firstmate operating contract",
        "Keep Firstmate as the sole router.",
        ...(pstackWorkers
          ? ["", "### Worker inner-loop contract", "Keep each worker brief bounded and evidence-driven."]
          : []),
        "",
        "## Task",
        "{{intent}}",
      ].join("\n"),
    },
  ],
})

const reviewerGuideMarkdown = `---
schemaVersion: 1
capabilities:
  - code-review
bestFor:
  - Reviewing pull requests
  - Focused diff analysis
avoidFor:
  - Long-running background jobs
  - Unrelated content work
prerequisites:
  - id: git-repo
    description: A git repository checkout.
workflows:
  - id: review
    description: Review a diff.
    examples:
      - Review my last commit
      - Check this diff
      - Review this PR
    promptTemplate: |
      Review the diff for: {{intent}}
---
# Reviewer

Use this profile to review diffs.
`

const firstmateDefaultGuideMarkdown = `---
schemaVersion: 1
capabilities:
  - fleet-orchestration
bestFor:
  - Parallel repository work
  - Captain-owned delivery
avoidFor:
  - One-line edits
  - Untrusted repositories
prerequisites:
  - id: git-repo
    description: A git repository checkout.
workflows:
  - id: orchestrate
    description: Coordinate a Firstmate fleet.
    examples:
      - Coordinate parallel implementation
      - Dispatch isolated workers
    promptTemplate: |
      ## Firstmate operating contract
      Keep Firstmate as the sole router.

      ## Task
      {{intent}}
---
# Firstmate

Use this profile for fleet orchestration.
`

const firstmatePstackGuideMarkdown = `---
schemaVersion: 1
capabilities:
  - fleet-orchestration
bestFor:
  - Parallel repository work
  - Captain-owned delivery
avoidFor:
  - One-line edits
  - Untrusted repositories
prerequisites:
  - id: git-repo
    description: A git repository checkout.
workflows:
  - id: orchestrate
    description: Coordinate a Firstmate fleet.
    examples:
      - Coordinate parallel implementation
      - Dispatch isolated workers
    promptTemplate: |
      ## Firstmate pstack-worker operating contract
      Keep Firstmate as the sole router.

      ### Worker inner-loop contract
      Keep each worker brief bounded and evidence-driven.

      ## Task
      {{intent}}
---
# Firstmate

Use this profile for fleet orchestration.
`

const guideWriter: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["docs"],
  bestFor: ["Writing documentation", "Drafting release notes"],
  avoidFor: ["Shell access", "Complex implementation work"],
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

const guidePlanner: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["planning"],
  bestFor: ["Planning a feature", "Drafting technical designs"],
  avoidFor: ["One-line fixes", "Immediate implementation"],
  prerequisites: [],
  workflows: [
    {
      id: "plan",
      description: "Draft an implementation plan.",
      examples: ["Plan this feature", "Draft a design"],
      promptTemplate: "Plan: {{intent}}",
    },
  ],
}

const guideCouncil: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["multi-perspective-deliberation"],
  bestFor: ["Pressure-testing ideas", "High-stakes architecture decisions"],
  avoidFor: ["Quick factual lookups", "Small reversible edits"],
  prerequisites: [],
  workflows: [
    {
      id: "run-council-deliberation",
      description: "Pressure-test an idea and its implementation.",
      skill: "council",
      examples: ["Pressure-test this architecture", "Challenge this product decision"],
      promptTemplate: "/council Pressure-test this idea and its implementation: {{intent}}",
    },
  ],
}

const guideResearch: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["bounded-factual-research"],
  bestFor: ["Source-backed research", "Comparing implementation options"],
  avoidFor: ["Pure implementation", "One-line code fixes"],
  prerequisites: [],
  workflows: [
    {
      id: "vault-backed-research",
      description: "Research evidence before implementation.",
      skill: "hyperresearch",
      examples: ["Research this implementation approach", "Compare these options with sources"],
      promptTemplate: "/hyperresearch Research this request before implementation: {{intent}}",
    },
  ],
}

describe("capture source presentation", () => {
  it("labels exact and terminal sources without relying on color alone", () => {
    expect(captureSourcePresentation({ source: "capture-queue", confidence: "user-curated" })).toEqual({
      label: "Curated capture queue",
      detail: "The guide is using the highlighted text and agent results you queued.",
      color: "cyan",
    })
    expect(
      captureSourcePresentation({
        source: "transcript",
        confidence: "exact",
        agent: "copilot",
        sessionId: "12345678-1234-4234-8234-123456789abc",
      }),
    ).toEqual({
      label: "Exact agent result",
      detail: "Copilot · session 12345678-123",
      color: "green",
    })
    expect(
      captureSourcePresentation({
        source: "terminal",
        confidence: "snapshot",
        agent: "copilot",
      }),
    ).toEqual({
      label: "Terminal snapshot",
      detail: "This is not an exact message and can include prompts, status rows, or earlier output.",
      color: "yellow",
    })
    expect(
      captureSourcePresentation({
        source: "sandbox-transcript",
        confidence: "exact",
        agent: "claude",
        sessionId: "87654321-4321-4321-8321-cba987654321",
        profile: "claude-research",
      }),
    ).toEqual({
      label: "Exact Sandbox result",
      detail: "Claude · session 87654321-432 · profile claude-research",
      color: "green",
    })
  })
})

const guideHve: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["research-plan-implement-review-workflow"],
  bestFor: ["Durable RPI delivery", "Evidence-backed feature implementation"],
  avoidFor: ["One-line edits", "Quick factual lookups"],
  prerequisites: [],
  workflows: [
    {
      id: "rpi-agent-cycle",
      description: "Run the dedicated HVE Core RPI agent.",
      examples: ["Take this feature through the full RPI cycle", "Deliver this change with RPI evidence"],
      promptTemplate: "Research, plan, implement, and review: {{intent}}",
    },
  ],
}

/** Builds a 3-entry catalog (2 native, 1 sandbox), rooted at `tmpRoot` for the sandbox profile path. */
const buildCatalog = (tmpRoot: string): CombinedGuideCatalog =>
  parseGuideCatalog(
    JSON.stringify({
      schemaVersion: 1,
      sandboxCommandPath: "/opt/trellage/bin/trellage",
      native: [
        {
          launcher: "cdx",
          harness: "codex",
          name: "reviewer",
          description: "Codex host-native launcher.",
          headless: headless({ prompt: true }),
          sandbox: false,
          herdrCompatibility: { status: "supported" },
          guide: guideReviewer,
          commandPath: "/opt/trellage/cdx/bin/cdx",
        },
        {
          launcher: "jcx",
          harness: "jules",
          name: "writer",
          description: "Jules code-native launcher.",
          headless: headless({ prompt: true }),
          sandbox: false,
          herdrCompatibility: { status: "supported" },
          guide: guideWriter,
          commandPath: "/opt/trellage/jcx/bin/jcx",
        },
      ],
      sandbox: [
        {
          name: "planner",
          description: "Sandboxed planning profile.",
          guide: guidePlanner,
          path: path.join(tmpRoot, "profiles", "planner", "profile.toml"),
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

const buildFirstmateCatalog = (tmpRoot: string): CombinedGuideCatalog => {
  const catalog = buildCatalog(tmpRoot)
  const firstmateEntry = (name: "default" | "pstack-workers"): CombinedGuideCatalog["native"][number] => ({
    launcher: "fmx",
    harness: "firstmate",
    name,
    description: `Firstmate ${name} profile.`,
    headless: headless({ prompt: false }),
    sandbox: false,
    herdrCompatibility: { status: "supported" },
    guide: firstmateGuide(name === "pstack-workers"),
    commandPath: "/opt/trellage/fmx/bin/fmx",
  })
  return {
    ...catalog,
    native: [...catalog.native, firstmateEntry("default"), firstmateEntry("pstack-workers")],
  }
}

const buildCatalogWithPinnedLenses = (tmpRoot: string): CombinedGuideCatalog => {
  const catalog = buildCatalog(tmpRoot)
  const sandboxEntry = (
    name: string,
    description: string,
    guide: ProfileGuideV1,
  ): CombinedGuideCatalog["sandbox"][number] => ({
    name,
    description,
    guide,
    path: path.join(tmpRoot, "profiles", name, "profile.toml"),
    supportedPlatforms: ["linux/amd64"],
    harness: { kind: "claude", version: "1.0.0" },
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
      sessionId: "trellage",
      resume: true,
      resumeWithPrompt: true,
      questionToolControl: "hard-deny",
      changedFiles: "git-diff",
      usage: true,
      cost: true,
      modelOverride: false,
      effortOverride: false,
      testedHarnessVersion: null,
    },
    locked: false,
    herdrCompatibility: { status: "supported" },
  })
  return {
    ...catalog,
    native: [
      ...catalog.native,
      {
        launcher: "cpx",
        harness: "copilot",
        name: "hve",
        description: "Copilot with HVE Core.",
        headless: catalog.native[0]!.headless,
        sandbox: false,
        herdrCompatibility: { status: "supported" },
        guide: guideHve,
        commandPath: "/opt/trellage/cpx/bin/cpx",
      },
    ],
    sandbox: [
      ...catalog.sandbox,
      sandboxEntry("claude-council", "Council profile.", guideCouncil),
      sandboxEntry("claude-research", "Research profile.", guideResearch),
    ],
  }
}

/** Writes the native "cdx/reviewer" guide Markdown fixture under `root`, matching `guideReviewer`. */
const writeGuideFixtures = async (root: string): Promise<void> => {
  await mkdir(path.join(root, "native", "cdx"), { recursive: true })
  await writeFile(path.join(root, "native", "cdx", "reviewer.md"), reviewerGuideMarkdown)
}

const writeFirstmateGuideFixture = async (root: string, profile: "default" | "pstack-workers"): Promise<void> => {
  await mkdir(path.join(root, "native", "fmx"), { recursive: true })
  await writeFile(
    path.join(root, "native", "fmx", `${profile}.md`),
    profile === "pstack-workers" ? firstmatePstackGuideMarkdown : firstmateDefaultGuideMarkdown,
  )
}

const nativeSelectedProfile = (headlessPrompt: boolean): SelectedProfile => ({
  surface: "native",
  launcher: "cdx",
  commandPath: "/opt/trellage/cdx/bin/cdx",
  profile: "reviewer",
  headlessPrompt,
})

const candidate = (overrides: Partial<GuideGenerateCandidate> = {}): GuideGenerateCandidate => ({
  title: "Focused",
  prompt: "Do the focused thing.",
  notes: "Quick pass.",
  ...overrides,
})

const candidateTriple = (): readonly [GuideGenerateCandidate, GuideGenerateCandidate, GuideGenerateCandidate] => [
  candidate({ title: "Focused", prompt: "Do the focused thing.", notes: "Quick pass." }),
  candidate({ title: "Thorough", prompt: "Do the thorough thing.", notes: "Deep pass." }),
  candidate({ title: "Cautious", prompt: "Do the cautious thing.", notes: "Careful pass." }),
]

const recommendation = (overrides: Partial<GuideRecommendation> = {}): GuideRecommendation => ({
  profileRef: "native:cdx/reviewer",
  workflowId: "review",
  confidence: 0.9,
  reason: "Best match for reviewing a diff.",
  tradeoff: "Slower than a quick fix.",
  surface: "native",
  name: "reviewer",
  launcher: "cdx",
  description: "Codex host-native launcher.",
  sandbox: false,
  workflow: { id: "review", description: "Review a diff.", examples: ["Review my last commit"] },
  prerequisites: guideReviewer.prerequisites,
  headless: headless({ prompt: true }) as never,
  herdrCompatibility: { status: "supported" },
  ...overrides,
})

const recommendationTriple = (): readonly [GuideRecommendation, GuideRecommendation, GuideRecommendation] => [
  recommendation({ profileRef: "native:cdx/reviewer", workflowId: "review" }),
  recommendation({
    profileRef: "native:jcx/writer",
    workflowId: "draft",
    surface: "native",
    name: "writer",
    launcher: "jcx",
  }),
  recommendation({
    profileRef: "sandbox:planner",
    workflowId: "plan",
    surface: "sandbox",
    name: "planner",
    harness: "copilot",
  }),
]

const readyInspection = (dirty: boolean): GitInspectionReady => ({
  kind: "ready",
  currentCheckoutRoot: "/repo",
  primaryCheckoutPath: "/repo",
  currentHeadSha: "abc123",
  baseRef: "main",
  branch: "worktree/do-the-thing",
  dirty,
  branchExists: false,
  activeBranchWorktree: null,
  activePathWorktree: null,
})

const collisionInspection = (
  kind: "branch-exists" | "branch-active" | "path-active",
  collisionPath?: string,
): WorktreeCollisionResult => ({
  kind: "collision",
  currentCheckoutRoot: "/repo",
  primaryCheckoutPath: "/repo",
  currentHeadSha: "abc123",
  baseRef: "main",
  branch: "worktree/do-the-thing",
  dirty: false,
  branchExists: kind !== "branch-active" ? true : true,
  activeBranchWorktree: null,
  activePathWorktree: null,
  collision: { kind, ...(collisionPath === undefined ? {} : { path: collisionPath }) },
})

// ---------------------------------------------------------------------------
// Fake GuideProvider: records every call; `match` throws so tests can assert
// that generation/refinement never re-run matching.
// ---------------------------------------------------------------------------

class FakeGuideProvider implements GuideProvider {
  readonly matchCalls: Array<GuideMatchInput> = []
  readonly generateCalls: Array<GuideGenerateInput> = []
  readonly refineCalls: Array<GuideRefineInput> = []
  readonly optimizeCalls: Array<GuideOptimizeInput> = []

  constructor(
    private readonly generateResult: GuideGenerateResult = { candidates: candidateTriple() },
    private readonly refineResult: GuideRefineResult = { candidate: candidate({ title: "Refined" }) },
  ) {}

  async match(input: GuideMatchInput): Promise<GuideMatchResult> {
    this.matchCalls.push(input)
    throw new Error("match must not be called during generation or refinement")
  }

  async generate(input: GuideGenerateInput): Promise<GuideGenerateResult> {
    this.generateCalls.push(input)
    return this.generateResult
  }

  async refine(input: GuideRefineInput): Promise<GuideRefineResult> {
    this.refineCalls.push(input)
    return this.refineResult
  }

  async optimize(input: GuideOptimizeInput): Promise<GuideOptimizeResult> {
    this.optimizeCalls.push(input)
    return { candidates: input.candidates }
  }
}

// ---------------------------------------------------------------------------
// createInitialGuideUiState
// ---------------------------------------------------------------------------

describe("createInitialGuideUiState", () => {
  it("starts at the Intent stage with no initial intent", () => {
    const state = createInitialGuideUiState()
    expect(state.stage).toBe(GuideUiStage.Intent)
    expect(state.intent).toBeUndefined()
  })

  it("skips straight to Matching when a non-empty initial intent is supplied", () => {
    const state = createInitialGuideUiState("Review my last commit")
    expect(state.stage).toBe(GuideUiStage.Matching)
    expect(state.intent).toBe("Review my last commit")
    expect(state.matchPhase).toBe(GuideMatchPhase.LoadingProfiles)
  })

  it("ignores a blank/whitespace-only initial intent", () => {
    const state = createInitialGuideUiState("   ")
    expect(state.stage).toBe(GuideUiStage.Intent)
    expect(state.intent).toBeUndefined()
  })

  it("starts matching a supplied multiline intent without an initial review gate", () => {
    const state = createInitialGuideUiState("# Large prompt\n\nReview this")
    expect(state.stage).toBe(GuideUiStage.Matching)
    expect(state.intent).toBe("# Large prompt\n\nReview this")
  })
})

// ---------------------------------------------------------------------------
// Reducer: intent editing and match phase (literal fallback is user-triggered only).
// ---------------------------------------------------------------------------

describe("guideUiReducer: intent and match", () => {
  it("accumulates and backspaces intent text, then submits to Matching", () => {
    let state = createInitialGuideUiState()
    state = guideUiReducer(state, { type: GuideUiActionType.IntentChange, text: "Review" })
    state = guideUiReducer(state, { type: GuideUiActionType.IntentChange, text: "Review my PR" })
    state = guideUiReducer(state, { type: GuideUiActionType.IntentBackspace })
    expect(state.textDraft).toBe("Review my P")
    state = guideUiReducer(state, { type: GuideUiActionType.IntentChange, text: "Review my PR" })
    state = guideUiReducer(state, { type: GuideUiActionType.IntentSubmit })
    expect(state.stage).toBe(GuideUiStage.Matching)
    expect(state.intent).toBe("Review my PR")
  })

  it("backspaces one complete Unicode code point", () => {
    let state = createInitialGuideUiState()
    state = guideUiReducer(state, { type: GuideUiActionType.IntentChange, text: "Review 😀" })
    state = guideUiReducer(state, { type: GuideUiActionType.IntentBackspace })
    expect(state.textDraft).toBe("Review ")
  })

  describe("guideUiReducer: prompt review", () => {
    it("opens the prompt dashboard from matching and returns without rematching when unchanged", () => {
      const matching = createInitialGuideUiState("# Goal\n\nReview this")
      const review = guideUiReducer(matching, { type: GuideUiActionType.PromptReviewOpen })
      expect(review).toMatchObject({
        stage: GuideUiStage.PromptReview,
        textDraft: "# Goal\n\nReview this",
        promptReviewReturnStage: GuideUiStage.Matching,
        promptReviewEditing: false,
      })
      expect(guideUiReducer(review, { type: GuideUiActionType.PromptReviewSubmit })).toMatchObject({
        stage: GuideUiStage.Matching,
        intent: "# Goal\n\nReview this",
      })
    })

    it("discards draft edits before returning from the Markdown preview", () => {
      const matching = createInitialGuideUiState("Original prompt")
      let state = guideUiReducer(matching, { type: GuideUiActionType.PromptReviewOpen })
      state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewEdit, editing: true })
      state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewChange, text: "Changed draft" })
      state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewBack })
      expect(state).toMatchObject({
        stage: GuideUiStage.PromptReview,
        textDraft: "Original prompt",
        promptReviewEditing: false,
      })
      expect(guideUiReducer(state, { type: GuideUiActionType.PromptReviewBack }).stage).toBe(GuideUiStage.Matching)
    })

    it("returns to recommendations unchanged, but rematches after an edited prompt is submitted", () => {
      let state = createInitialGuideUiState("Review this")
      state = guideUiReducer(state, {
        type: GuideUiActionType.MatchSucceeded,
        recommendations: recommendationTriple(),
      })
      state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewOpen })
      expect(guideUiReducer(state, { type: GuideUiActionType.PromptReviewBack }).stage).toBe(
        GuideUiStage.Recommendations,
      )

      state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewEdit, editing: true })
      state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewChange, text: "Review this carefully" })
      state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewSubmit })
      expect(state).toMatchObject({
        stage: GuideUiStage.Matching,
        intent: "Review this carefully",
        matchPhase: GuideMatchPhase.LoadingProfiles,
        recommendations: undefined,
      })
    })
  })

  it("does not submit an empty/whitespace-only intent", () => {
    let state = createInitialGuideUiState()
    state = guideUiReducer(state, { type: GuideUiActionType.IntentChange, text: "   " })
    state = guideUiReducer(state, { type: GuideUiActionType.IntentSubmit })
    expect(state.stage).toBe(GuideUiStage.Intent)
  })

  it("on match failure moves to MatchFailed without any automatic literal fallback", () => {
    let state = createInitialGuideUiState("Review my PR")
    state = guideUiReducer(state, { type: GuideUiActionType.MatchFailed, message: "network error" })
    expect(state.stage).toBe(GuideUiStage.MatchFailed)
    expect(state.errorMessage).toBe("network error")
    expect(state.usedLiteralFallback).toBe(false)
    expect(state.recommendations).toBeUndefined()
  })

  it("match/literal is a no-op unless the stage is MatchFailed (never automatic)", () => {
    const matching = createInitialGuideUiState("Review my PR")
    const recommendations = recommendationTriple()
    const unaffected = guideUiReducer(matching, { type: GuideUiActionType.MatchLiteral, recommendations })
    expect(unaffected.stage).toBe(GuideUiStage.Matching)
    expect(unaffected.recommendations).toBeUndefined()
  })

  it("match/literal moves MatchFailed -> Recommendations with usedLiteralFallback true, only once dispatched", () => {
    let state = createInitialGuideUiState("Review my PR")
    state = guideUiReducer(state, { type: GuideUiActionType.MatchFailed, message: "network error" })
    const recommendations = recommendationTriple()
    state = guideUiReducer(state, { type: GuideUiActionType.MatchLiteral, recommendations })
    expect(state.stage).toBe(GuideUiStage.Recommendations)
    expect(state.usedLiteralFallback).toBe(true)
    expect(state.recommendations).toBe(recommendations)
  })

  it("match/succeeded moves Matching -> Recommendations with usedLiteralFallback false", () => {
    let state = createInitialGuideUiState("Review my PR")
    const recommendations = recommendationTriple()
    state = guideUiReducer(state, { type: GuideUiActionType.MatchSucceeded, recommendations })
    expect(state.stage).toBe(GuideUiStage.Recommendations)
    expect(state.usedLiteralFallback).toBe(false)
    expect(state.recommendationIndex).toBe(0)
    expect(state.matchPhase).toBeUndefined()
  })

  it("tracks high-level profile matching progress", () => {
    let state = createInitialGuideUiState("Review my PR")
    state = guideUiReducer(state, {
      type: GuideUiActionType.MatchProgress,
      phase: GuideMatchPhase.ComparingProfiles,
    })
    expect(state.matchPhase).toBe(GuideMatchPhase.ComparingProfiles)

    state = guideUiReducer(state, {
      type: GuideUiActionType.MatchProgress,
      phase: GuideMatchPhase.PreparingRecommendations,
    })
    expect(state.matchPhase).toBe(GuideMatchPhase.PreparingRecommendations)
  })

  it("match/retry moves MatchFailed -> Matching and clears the error", () => {
    let state = createInitialGuideUiState("Review my PR")
    state = guideUiReducer(state, { type: GuideUiActionType.MatchFailed, message: "boom" })
    state = guideUiReducer(state, { type: GuideUiActionType.MatchRetry })
    expect(state.stage).toBe(GuideUiStage.Matching)
    expect(state.errorMessage).toBeUndefined()
  })

  it("match/literal-failed replaces the error message with the fallback's own error, staying on MatchFailed (no silent catch)", () => {
    let state = createInitialGuideUiState("Review my PR")
    state = guideUiReducer(state, { type: GuideUiActionType.MatchFailed, message: "network error" })
    state = guideUiReducer(state, {
      type: GuideUiActionType.MatchLiteralFailed,
      message: describeGuideUiError(new Error("fewer than 3 catalog entries")),
    })
    expect(state.stage).toBe(GuideUiStage.MatchFailed)
    expect(state.errorMessage).toBe("fewer than 3 catalog entries")
    expect(state.recommendations).toBeUndefined()
  })

  it("match/literal-failed is a no-op unless the stage is MatchFailed", () => {
    const matching = createInitialGuideUiState("Review my PR")
    const unaffected = guideUiReducer(matching, { type: GuideUiActionType.MatchLiteralFailed, message: "boom" })
    expect(unaffected).toBe(matching)
  })
})

// ---------------------------------------------------------------------------
// Reducer: recommendations -> generation.
// ---------------------------------------------------------------------------

describe("guideUiReducer: recommendations and generation", () => {
  const recommendations = recommendationTriple()

  const recommendationsState = (): GuideUiState => {
    let state = createInitialGuideUiState("Review my PR")
    state = guideUiReducer(state, { type: GuideUiActionType.MatchSucceeded, recommendations })
    return state
  }

  it("recommendations/move wraps around in both directions", () => {
    let state = recommendationsState()
    state = guideUiReducer(state, { type: GuideUiActionType.RecommendationsMove, delta: -1 })
    expect(state.recommendationIndex).toBe(2)
    state = guideUiReducer(state, { type: GuideUiActionType.RecommendationsMove, delta: 1 })
    expect(state.recommendationIndex).toBe(0)
    state = guideUiReducer(state, { type: GuideUiActionType.RecommendationsMove, delta: 1 })
    expect(state.recommendationIndex).toBe(1)
  })

  it("recommendations/confirm selects the recommendation at the current index and moves to Generating", () => {
    let state = recommendationsState()
    state = guideUiReducer(state, { type: GuideUiActionType.RecommendationsMove, delta: 1 })
    const selectedProfile = nativeSelectedProfile(true)
    state = guideUiReducer(state, { type: GuideUiActionType.RecommendationsConfirm, selectedProfile })
    expect(state.stage).toBe(GuideUiStage.Generating)
    expect(state.selectedRecommendation).toEqual(recommendations[1])
    expect(state.selectedProfile).toBe(selectedProfile)
    expect(state.generationPhase).toBe(GuideGenerationPhase.LoadingProfile)
    expect(state.candidates).toBeUndefined()
  })

  it("tracks high-level generation progress without exposing model output", () => {
    let state = recommendationsState()
    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })

    state = guideUiReducer(state, {
      type: GuideUiActionType.GenerateProgress,
      phase: GuideGenerationPhase.GeneratingCandidates,
    })
    expect(state.generationPhase).toBe(GuideGenerationPhase.GeneratingCandidates)

    state = guideUiReducer(state, {
      type: GuideUiActionType.GenerateProgress,
      phase: GuideGenerationPhase.OptimizingCandidates,
    })
    expect(state.generationPhase).toBe(GuideGenerationPhase.OptimizingCandidates)
  })

  it("recommendations/confirm can select a pinned lens outside the ranked recommendation list", () => {
    const pinned = pinnedGuideLenses(buildCatalogWithPinnedLenses("/tmp-unused"))[0]
    expect(pinned).toBeDefined()
    if (pinned === undefined) throw new Error("Missing pinned council lens")

    let state = recommendationsState()
    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: {
        surface: "sandbox",
        commandPath: "/opt/trellage/bin/trellage",
        profile: "claude-council",
        headlessPrompt: true,
      },
      recommendation: pinned.recommendation,
    })

    expect(state.stage).toBe(GuideUiStage.Generating)
    expect(state.selectedRecommendation?.profileRef).toBe("sandbox:claude-council")
    expect(state.selectedRecommendation?.workflowId).toBe("run-council-deliberation")
  })

  it("generate/failed moves Generating -> GenerateFailed with the safe message", () => {
    let state = recommendationsState()
    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })
    state = guideUiReducer(state, { type: GuideUiActionType.GenerateFailed, message: "model unavailable" })
    expect(state.stage).toBe(GuideUiStage.GenerateFailed)
    expect(state.errorMessage).toBe("model unavailable")
  })

  it("generate/template-fallback moves GenerateFailed -> Candidates with usedTemplateFallback true", () => {
    let state = recommendationsState()
    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })
    state = guideUiReducer(state, { type: GuideUiActionType.GenerateFailed, message: "model unavailable" })
    const candidates = candidateTriple()
    state = guideUiReducer(state, { type: GuideUiActionType.GenerateTemplateFallback, candidates })
    expect(state.stage).toBe(GuideUiStage.Candidates)
    expect(state.usedTemplateFallback).toBe(true)
    expect(state.candidates).toBe(candidates)
  })

  it("generate/back returns GenerateFailed -> Recommendations", () => {
    let state = recommendationsState()
    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })
    state = guideUiReducer(state, { type: GuideUiActionType.GenerateFailed, message: "boom" })
    state = guideUiReducer(state, { type: GuideUiActionType.GenerateBack })
    expect(state.stage).toBe(GuideUiStage.Recommendations)
    expect(state.selectedRecommendation).toBeUndefined()
    expect(state.selectedProfile).toBeUndefined()
    expect(state.guideDocument).toBeUndefined()
  })

  it("generate/succeeded moves Generating -> Candidates with usedTemplateFallback false", () => {
    let state = recommendationsState()
    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })
    const candidates = candidateTriple()
    state = guideUiReducer(state, { type: GuideUiActionType.GenerateSucceeded, candidates })
    expect(state.stage).toBe(GuideUiStage.Candidates)
    expect(state.usedTemplateFallback).toBe(false)
    expect(state.candidates).toBe(candidates)
  })

  it("regression: the guide document loaded via generate/guide-loaded survives a later generate/failed, keeping template fallback available", () => {
    let state = recommendationsState()
    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })
    state = guideUiReducer(state, {
      type: GuideUiActionType.GenerateGuideLoaded,
      guideDocument: { ref: "native:cdx/reviewer", guide: guideReviewer, body: "guide body" },
    })
    state = guideUiReducer(state, { type: GuideUiActionType.GenerateFailed, message: "model unavailable" })
    expect(state.stage).toBe(GuideUiStage.GenerateFailed)
    expect(state.errorMessage).toBe("model unavailable")
    // The guide document must remain available so `t` template fallback works.
    expect(state.guideDocument).toEqual({ ref: "native:cdx/reviewer", guide: guideReviewer, body: "guide body" })
  })

  it("generate/template-fallback-failed replaces the error message with the fallback's own error, staying on GenerateFailed (no silent catch)", () => {
    let state = recommendationsState()
    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })
    state = guideUiReducer(state, {
      type: GuideUiActionType.GenerateGuideLoaded,
      guideDocument: { ref: "native:cdx/reviewer", guide: guideReviewer, body: "guide body" },
    })
    state = guideUiReducer(state, { type: GuideUiActionType.GenerateFailed, message: "model unavailable" })
    state = guideUiReducer(state, {
      type: GuideUiActionType.GenerateTemplateFallbackFailed,
      message: describeGuideUiError(new Error("no workflow to template")),
    })
    expect(state.stage).toBe(GuideUiStage.GenerateFailed)
    expect(state.errorMessage).toBe("no workflow to template")
    expect(state.candidates).toBeUndefined()
  })

  it("generate/template-fallback-failed is a no-op unless the stage is GenerateFailed", () => {
    const generating = recommendationsState()
    const withProfile = guideUiReducer(generating, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })
    const unaffected = guideUiReducer(withProfile, {
      type: GuideUiActionType.GenerateTemplateFallbackFailed,
      message: "boom",
    })
    expect(unaffected).toBe(withProfile)
  })
})

// ---------------------------------------------------------------------------
// Reducer: candidates, direct edit, and refine (constraints preserved).
// ---------------------------------------------------------------------------

describe("guideUiReducer: candidates, direct edit, and refine", () => {
  const candidatesState = (): GuideUiState => {
    let state = createInitialGuideUiState("Review my PR")
    state = guideUiReducer(state, { type: GuideUiActionType.MatchSucceeded, recommendations: recommendationTriple() })
    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })
    state = guideUiReducer(state, {
      type: GuideUiActionType.GenerateGuideLoaded,
      guideDocument: { ref: "native:cdx/reviewer", guide: guideReviewer, body: "guide body" },
    })
    state = guideUiReducer(state, { type: GuideUiActionType.GenerateSucceeded, candidates: candidateTriple() })
    return state
  }

  it("candidates/move wraps around", () => {
    let state = candidatesState()
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesMove, delta: -1 })
    expect(state.candidateIndex).toBe(2)
  })

  it("candidates/back returns to profile selection and clears generated state so confirmation regenerates prompts", () => {
    let state = candidatesState()
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesBack })
    expect(state.stage).toBe(GuideUiStage.Recommendations)
    expect(state.selectedRecommendation).toBeUndefined()
    expect(state.selectedProfile).toBeUndefined()
    expect(state.guideDocument).toBeUndefined()
    expect(state.candidates).toBeUndefined()
    expect(state.candidateIndex).toBe(0)
    expect(state.selectedCandidate).toBeUndefined()

    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })
    expect(state.stage).toBe(GuideUiStage.Generating)
    expect(state.candidates).toBeUndefined()
  })

  it("candidates/confirm selects the candidate at the current index and moves to CheckingReadiness", () => {
    let state = candidatesState()
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesMove, delta: 1 })
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesConfirm })
    expect(state.stage).toBe(GuideUiStage.CheckingReadiness)
    expect(state.selectedCandidate).toEqual(candidateTriple()[1])
  })

  it("candidates/direct-edit-start seeds the editor with the current candidate's prompt", () => {
    let state = candidatesState()
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesMove, delta: 1 })
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesDirectEditStart })
    expect(state.stage).toBe(GuideUiStage.DirectEditor)
    expect(state.textDraft).toBe(candidateTriple()[1].prompt)
  })

  it("editor/change and editor/backspace only apply while in an editing stage", () => {
    const notEditing = candidatesState()
    const unaffected = guideUiReducer(notEditing, { type: GuideUiActionType.EditorChange, text: "ignored" })
    expect(unaffected.textDraft).toBe(notEditing.textDraft)

    let state = guideUiReducer(candidatesState(), { type: GuideUiActionType.CandidatesDirectEditStart })
    state = guideUiReducer(state, { type: GuideUiActionType.EditorChange, text: "new prompt" })
    expect(state.textDraft).toBe("new prompt")
    state = guideUiReducer(state, { type: GuideUiActionType.EditorBackspace })
    expect(state.textDraft).toBe("new promp")
  })

  it("direct-edit/submit replaces only the prompt of the selected candidate, preserving title/notes", () => {
    let state = candidatesState()
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesMove, delta: 1 })
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesDirectEditStart })
    state = guideUiReducer(state, { type: GuideUiActionType.EditorChange, text: "A hand-edited prompt." })
    state = guideUiReducer(state, { type: GuideUiActionType.DirectEditSubmit })
    expect(state.stage).toBe(GuideUiStage.Candidates)
    const candidates = candidateTriple()
    expect(state.candidates).toEqual([
      candidates[0],
      { ...candidates[1], prompt: "A hand-edited prompt." },
      candidates[2],
    ])
  })

  it("direct-edit/back discards the draft and returns to Candidates unchanged", () => {
    let state = candidatesState()
    const before = state.candidates
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesDirectEditStart })
    state = guideUiReducer(state, { type: GuideUiActionType.EditorChange, text: "discard me" })
    state = guideUiReducer(state, { type: GuideUiActionType.DirectEditBack })
    expect(state.stage).toBe(GuideUiStage.Candidates)
    expect(state.candidates).toBe(before)
  })

  it("candidates/refine-start clears the draft and moves to RefineEditor", () => {
    let state = candidatesState()
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesRefineStart })
    expect(state.stage).toBe(GuideUiStage.RefineEditor)
    expect(state.textDraft).toBe("")
  })

  it("refine/submit requires non-empty feedback before moving to Refining", () => {
    let state = guideUiReducer(candidatesState(), { type: GuideUiActionType.CandidatesRefineStart })
    const unaffected = guideUiReducer(state, { type: GuideUiActionType.RefineSubmit })
    expect(unaffected.stage).toBe(GuideUiStage.RefineEditor)
    state = guideUiReducer(state, { type: GuideUiActionType.EditorChange, text: "Make it shorter." })
    state = guideUiReducer(state, { type: GuideUiActionType.RefineSubmit })
    expect(state.stage).toBe(GuideUiStage.Refining)
  })

  it("refine/succeeded replaces only the candidate at the current index", () => {
    let state = candidatesState()
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesMove, delta: 1 })
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesRefineStart })
    state = guideUiReducer(state, { type: GuideUiActionType.EditorChange, text: "Make it shorter." })
    state = guideUiReducer(state, { type: GuideUiActionType.RefineSubmit })
    const refined = candidate({ title: "Thorough (refined)", prompt: "Refined prompt.", notes: "Shorter." })
    state = guideUiReducer(state, { type: GuideUiActionType.RefineSucceeded, candidate: refined })
    expect(state.stage).toBe(GuideUiStage.Candidates)
    const candidates = candidateTriple()
    expect(state.candidates).toEqual([candidates[0], refined, candidates[2]])
  })

  it("refine/failed preserves the prior candidates and supports retry/back without losing them", () => {
    let state = candidatesState()
    const priorCandidates = state.candidates
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesRefineStart })
    state = guideUiReducer(state, { type: GuideUiActionType.EditorChange, text: "feedback" })
    state = guideUiReducer(state, { type: GuideUiActionType.RefineSubmit })
    state = guideUiReducer(state, { type: GuideUiActionType.RefineFailed, message: "refine timed out" })
    expect(state.stage).toBe(GuideUiStage.RefineFailed)
    expect(state.errorMessage).toBe("refine timed out")
    expect(state.candidates).toBe(priorCandidates)

    const retried = guideUiReducer(state, { type: GuideUiActionType.RefineRetry })
    expect(retried.stage).toBe(GuideUiStage.Refining)
    expect(retried.candidates).toBe(priorCandidates)

    const backed = guideUiReducer(state, { type: GuideUiActionType.RefineBack })
    expect(backed.stage).toBe(GuideUiStage.Candidates)
    expect(backed.candidates).toBe(priorCandidates)
  })

  it("printing from Candidates uses the currently-highlighted candidate's prompt, independent of readiness (readiness gates launch, not print)", () => {
    let state = candidatesState()
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesMove, delta: 1 })
    expect(state.stage).toBe(GuideUiStage.Candidates)
    const highlighted = state.candidates?.[state.candidateIndex]
    expect(highlighted).toBeDefined()
    // This mirrors exactly what the Candidates-stage `c` key handler does:
    // it never dispatches `candidates/confirm` or reaches CheckingReadiness.
    const result = buildPrintResult(highlighted?.prompt ?? "")
    expect(result).toEqual({ action: "print", prompt: candidateTriple()[1].prompt })
    expect(state.readiness).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// runGuideGenerationStep / runGuideRefinementStep: constraint-preservation
// against a real fake provider (and real loadSelectedGuide via a fixture).
// ---------------------------------------------------------------------------

describe("runGuideMatchingStep", () => {
  it("reports concise matching phases around the model-backed profile comparison", async () => {
    const catalog = buildCatalog("/tmp-unused")
    const phases: GuideMatchPhase[] = []
    const provider: GuideProvider = {
      match: async () => ({
        candidates: recommendationTriple().map(({ profileRef, workflowId, confidence, reason, tradeoff }) => ({
          profileRef,
          workflowId,
          confidence,
          reason,
          tradeoff,
        })),
      }),
      generate: () => Promise.reject(new Error("generate must not be called during matching")),
      refine: () => Promise.reject(new Error("refine must not be called during matching")),
      optimize: () => Promise.reject(new Error("optimize must not be called during matching")),
    }

    const response = await runGuideMatchingStep(
      provider,
      catalog,
      { intent: "Review my PR", model: "test-model", effort: GuideEffort.Medium },
      (phase) => phases.push(phase),
    )

    expect(response.recommendations).toHaveLength(3)
    expect(phases).toEqual([GuideMatchPhase.ComparingProfiles, GuideMatchPhase.PreparingRecommendations])
  })
})

describe("runGuideGenerationStep", () => {
  it("loads only the selected guide and calls provider.generate with the recommendation's own workflow and body, never match", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "guide-ui-generate-"))
    try {
      const catalog = buildCatalog(tmpRoot)
      await writeGuideFixtures(tmpRoot)
      const provider = new FakeGuideProvider()
      const chosen = recommendation({ profileRef: "native:cdx/reviewer", workflowId: "review" })

      const phases: GuideGenerationPhase[] = []
      const result = await runGuideGenerationStep(
        catalog,
        tmpRoot,
        provider,
        "Review my PR",
        chosen,
        undefined,
        (phase) => phases.push(phase),
      )

      expect(provider.matchCalls).toHaveLength(0)
      expect(provider.generateCalls).toHaveLength(1)
      expect(provider.optimizeCalls).toEqual([
        {
          targetTool: "codex",
          profileRef: "native:cdx/reviewer",
          candidates: candidateTriple(),
        },
      ])
      expect(provider.generateCalls[0]).toEqual({
        intent: "Review my PR",
        profileRef: "native:cdx/reviewer",
        workflowId: "review",
        guide: guideReviewer,
        guideBody: expect.stringContaining("Use this profile to review diffs."),
      })
      expect(result.candidates).toEqual(candidateTriple())
      expect(result.guideDocument.guide).toEqual(guideReviewer)
      expect(phases).toEqual([
        GuideGenerationPhase.GeneratingCandidates,
        GuideGenerationPhase.ApplyingWorkflow,
        GuideGenerationPhase.OptimizingCandidates,
      ])
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("rejects a generation result that does not contain exactly three candidates", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "guide-ui-generate-bad-"))
    try {
      const catalog = buildCatalog(tmpRoot)
      await writeGuideFixtures(tmpRoot)
      const provider = new FakeGuideProvider({ candidates: [candidate()] })
      const chosen = recommendation({ profileRef: "native:cdx/reviewer", workflowId: "review" })

      await expect(runGuideGenerationStep(catalog, tmpRoot, provider, "Review my PR", chosen)).rejects.toThrow(
        /exactly three/u,
      )
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it.each([
    ["default", "## Firstmate operating contract", false],
    ["pstack-workers", "## Firstmate pstack-worker operating contract", true],
  ] as const)(
    "reapplies the canonical Firstmate contract after interactive generation for %s",
    async (profile, expectedHeading, expectsWorkerContract) => {
      const tmpRoot = await mkdtemp(path.join(tmpdir(), `guide-ui-generate-fmx-${profile}-`))
      try {
        const catalog = buildFirstmateCatalog(tmpRoot)
        await writeFirstmateGuideFixture(tmpRoot, profile)
        const provider = new FakeGuideProvider()
        const chosen = recommendation({
          profileRef: `native:fmx/${profile}`,
          workflowId: "orchestrate",
          launcher: "fmx",
          name: profile,
        })

        const result = await runGuideGenerationStep(
          catalog,
          tmpRoot,
          provider,
          "Implement the feature with isolated workers.",
          chosen,
        )

        for (const generatedCandidate of result.candidates) {
          expect(generatedCandidate.prompt).toContain(expectedHeading)
          expect(generatedCandidate.prompt).toContain("Do the ")
          expect(generatedCandidate.prompt.includes("### Worker inner-loop contract")).toBe(expectsWorkerContract)
        }
      } finally {
        await rm(tmpRoot, { recursive: true, force: true })
      }
    },
  )

  it("invokes onGuideLoaded with the loaded guide before calling provider.generate, even when generation itself fails (regression: template fallback must stay available)", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "guide-ui-generate-loaded-"))
    try {
      const catalog = buildCatalog(tmpRoot)
      await writeGuideFixtures(tmpRoot)
      const chosen = recommendation({ profileRef: "native:cdx/reviewer", workflowId: "review" })
      const failingProvider: GuideProvider = {
        match: () => Promise.reject(new Error("match must not be called during generation")),
        generate: () => Promise.reject(new Error("model unavailable")),
        refine: () => Promise.reject(new Error("refine must not be called during generation")),
        optimize: () => Promise.reject(new Error("optimize must not be called after failed generation")),
      }
      let loaded: SelectedGuideDocument | undefined
      const onGuideLoaded = (guideDocument: SelectedGuideDocument) => {
        loaded = guideDocument
      }

      await expect(
        runGuideGenerationStep(catalog, tmpRoot, failingProvider, "Review my PR", chosen, onGuideLoaded),
      ).rejects.toThrow(/model unavailable/u)

      // The guide document must already be available for template fallback,
      // despite the overall step having rejected.
      expect(loaded).toBeDefined()
      expect(loaded?.guide).toEqual(guideReviewer)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })
})

describe("runGuideRefinementStep", () => {
  it("calls provider.refine constrained by the same intent/profile/workflow/guide/body plus the prior candidate and feedback", async () => {
    const provider = new FakeGuideProvider()
    const chosen = recommendation({ profileRef: "native:cdx/reviewer", workflowId: "review" })
    const guideDocument: SelectedGuideDocument = {
      ref: "native:cdx/reviewer",
      guide: guideReviewer,
      body: "guide body",
    }
    const prior = candidate({ title: "Focused", prompt: "Do the focused thing.", notes: "Quick pass." })

    const refined = await runGuideRefinementStep(
      buildCatalog("/tmp-unused"),
      provider,
      "Review my PR",
      chosen,
      guideDocument,
      prior,
      "Make it shorter.",
    )

    expect(provider.matchCalls).toHaveLength(0)
    expect(provider.generateCalls).toHaveLength(0)
    expect(provider.refineCalls).toHaveLength(1)
    expect(provider.optimizeCalls).toEqual([
      {
        targetTool: "codex",
        profileRef: "native:cdx/reviewer",
        candidates: [{ title: "Refined", prompt: "Do the focused thing.", notes: "Quick pass." }],
      },
    ])
    expect(provider.refineCalls[0]).toEqual({
      intent: "Review my PR",
      profileRef: "native:cdx/reviewer",
      workflowId: "review",
      guide: guideReviewer,
      guideBody: "guide body",
      candidate: prior,
      feedback: "Make it shorter.",
    })
    expect(refined).toEqual({ title: "Refined", prompt: "Do the focused thing.", notes: "Quick pass." })
  })

  it("restores the selected workflow skill invocation when refinement returns plain prose", async () => {
    const provider = new FakeGuideProvider()
    const skillGuide: ProfileGuideV1 = {
      ...guideReviewer,
      workflows: guideReviewer.workflows.map((workflow) =>
        workflow.id === "review"
          ? {
              ...workflow,
              skill: "social-media-skills:post-writer",
              promptTemplate: "/social-media-skills:post-writer {{intent}}",
            }
          : workflow,
      ),
    }
    const chosen = recommendation({ profileRef: "native:cdx/reviewer", workflowId: "review" })
    const guideDocument: SelectedGuideDocument = {
      ref: "native:cdx/reviewer",
      guide: skillGuide,
      body: "guide body",
    }

    const refined = await runGuideRefinementStep(
      buildCatalog("/tmp-unused"),
      provider,
      "Write about AI agents",
      chosen,
      guideDocument,
      candidate(),
      "Make it shorter.",
    )

    expect(refined.prompt).toBe("/social-media-skills:post-writer Do the focused thing.")
  })

  it.each([
    ["default", "## Firstmate operating contract", false],
    ["pstack-workers", "## Firstmate pstack-worker operating contract", true],
  ] as const)(
    "reapplies the canonical Firstmate contract after interactive refinement for %s",
    async (profile, expectedHeading, expectsWorkerContract) => {
      const chosen = recommendation({
        profileRef: `native:fmx/${profile}`,
        workflowId: "orchestrate",
        launcher: "fmx",
        name: profile,
      })
      const guide = firstmateGuide(profile === "pstack-workers")
      const guideDocument: SelectedGuideDocument = {
        ref: `native:fmx/${profile}`,
        guide,
        body: "guide body",
      }
      const provider = new FakeGuideProvider()

      const refined = await runGuideRefinementStep(
        buildFirstmateCatalog("/tmp-unused"),
        provider,
        "Implement the feature with isolated workers.",
        chosen,
        guideDocument,
        candidate(),
        "Make the worker boundaries explicit.",
      )

      expect(refined.prompt).toContain(expectedHeading)
      expect(refined.prompt).toContain("Do the focused thing.")
      expect(refined.prompt.includes("### Worker inner-loop contract")).toBe(expectsWorkerContract)
    },
  )
})

// ---------------------------------------------------------------------------
// Deterministic literal-match enrichment and template fallback.
// ---------------------------------------------------------------------------

describe("literalGuideRecommendations / enrichLiteralCandidate", () => {
  it("enriches every literal candidate with catalog-derived display fields matching the referenced entry", () => {
    const tmpRoot = "/tmp-unused"
    const catalog = buildCatalog(tmpRoot)
    const recommendations = literalGuideRecommendations(catalog, "Review my last commit")
    const literalCandidates = literalGuideMatch(catalog, "Review my last commit")

    expect(recommendations).toHaveLength(3)
    for (const [index, rec] of recommendations.entries()) {
      const literal = literalCandidates[index]
      expect(literal).toBeDefined()
      if (literal === undefined) throw new Error(`Missing literal candidate at index ${index}`)
      expect(rec.profileRef).toBe(literal.profileRef)
      expect(rec.workflowId).toBe(literal.workflowId)
      expect(rec.confidence).toBe(literal.confidence)
      if (rec.surface === "native") {
        const entry = catalog.native.find(
          (candidateEntry) => `native:${candidateEntry.launcher}/${candidateEntry.name}` === rec.profileRef,
        )
        expect(entry).toBeDefined()
        expect(rec.name).toBe(entry?.name)
        expect(rec.launcher).toBe(entry?.launcher)
        expect(rec.description).toBe(entry?.description)
        expect(rec.headless.prompt).toBe(entry?.headless.prompt)
        expect(rec.herdrCompatibility.status).toBe(entry?.herdrCompatibility.status)
        expect(rec.prerequisites).toBe(entry?.guide.prerequisites)
      } else {
        const entry = catalog.sandbox.find((candidateEntry) => `sandbox:${candidateEntry.name}` === rec.profileRef)
        expect(entry).toBeDefined()
        expect(rec.name).toBe(entry?.name)
        expect(rec.harness).toBe(entry?.harness.kind)
      }
    }
  })

  describe("pinnedGuideLenses", () => {
    it("pins council, research, and the HVE RPI agent with visible lens metadata", () => {
      const lenses = pinnedGuideLenses(buildCatalogWithPinnedLenses("/tmp-unused"))

      expect(
        lenses.map(({ kind, key, emoji, recommendation }) => ({
          kind,
          key,
          emoji,
          profileRef: recommendation.profileRef,
          workflowId: recommendation.workflowId,
        })),
      ).toEqual([
        {
          kind: "council",
          key: "c",
          emoji: "🧠",
          profileRef: "sandbox:claude-council",
          workflowId: "run-council-deliberation",
        },
        {
          kind: "research",
          key: "r",
          emoji: "🔎",
          profileRef: "sandbox:claude-research",
          workflowId: "vault-backed-research",
        },
        {
          kind: "hve-rpi",
          key: "h",
          emoji: "🔄",
          profileRef: "native:cpx/hve",
          workflowId: "rpi-agent-cycle",
        },
      ])
    })

    it("selects the pinned HVE lens with its validated Copilot agent override", () => {
      const catalog = buildCatalogWithPinnedLenses("/tmp-unused")
      const lens = pinnedGuideLenses(catalog).find(({ kind }) => kind === GuidePinnedLensKind.HveRpi)
      expect(lens).toBeDefined()
      if (lens === undefined) throw new Error("Missing pinned HVE RPI lens")

      expect(selectedProfileForPinnedLens(catalog, lens)).toEqual({
        surface: "native",
        launcher: "cpx",
        commandPath: "/opt/trellage/cpx/bin/cpx",
        profile: "hve",
        headlessPrompt: true,
        agent: "hve-core:rpi-agent",
      })
    })
  })

  it("enrichLiteralCandidate throws a safe error for an unknown profile reference", () => {
    const catalog = buildCatalog("/tmp-unused")
    expect(() =>
      enrichLiteralCandidate(catalog, {
        profileRef: "native:missing/profile",
        workflowId: "review",
        confidence: 0.5,
        reason: "n/a",
        tradeoff: "n/a",
      }),
    ).toThrow(/unknown profile/u)
  })
})

describe("templateGuideCandidates", () => {
  it("matches templatePromptCandidates exactly for the same guide/workflow/intent", () => {
    const fromHelper = templateGuideCandidates(guideReviewer, "review", "Review my PR")
    const fromLibrary = templatePromptCandidates(guideReviewer, "review", "Review my PR")
    expect(fromHelper).toEqual(fromLibrary)
  })
})

// ---------------------------------------------------------------------------
// describeGuideUiError
// ---------------------------------------------------------------------------

describe("describeGuideUiError", () => {
  it("returns the Error's message when present", () => {
    expect(describeGuideUiError(new Error("network timeout"))).toBe("network timeout")
  })

  it("returns a generic message for an Error with an empty message", () => {
    expect(describeGuideUiError(new Error(""))).toBe("An unknown error occurred.")
  })

  it("returns a generic message for a non-Error thrown value", () => {
    expect(describeGuideUiError("just a string")).toBe("An unknown error occurred.")
    expect(describeGuideUiError({ some: "object" })).toBe("An unknown error occurred.")
    expect(describeGuideUiError(undefined)).toBe("An unknown error occurred.")
  })
})

describe("isWithinTextBound", () => {
  it("bounds direct prompt editing at the provider's 8000-character prompt maximum, like intent/feedback/branch", () => {
    const promptMaxLength = 8000
    expect(isWithinTextBound("a".repeat(promptMaxLength - 1), "b", promptMaxLength)).toBe(true)
    expect(isWithinTextBound("a".repeat(promptMaxLength), "b", promptMaxLength)).toBe(false)
  })

  it("stays exact at the boundary (append that lands exactly on the maximum is allowed)", () => {
    expect(isWithinTextBound("a".repeat(7999), "b", 8000)).toBe(true)
  })

  it("uses the shared guide intent boundary", () => {
    expect(isWithinTextBound("a".repeat(guideIntentMaximumLength - 1), "b", guideIntentMaximumLength)).toBe(true)
    expect(isWithinTextBound("a".repeat(guideIntentMaximumLength), "b", guideIntentMaximumLength)).toBe(false)
  })

  it("counts astral symbols as one character", () => {
    expect(isWithinTextBound("😀".repeat(guideIntentMaximumLength - 1), "😀", guideIntentMaximumLength)).toBe(true)
    expect(isWithinTextBound("😀".repeat(guideIntentMaximumLength), "😀", guideIntentMaximumLength)).toBe(false)
  })
})

describe("boundedPastedText", () => {
  it("preserves multiline paste while removing unsafe controls and respecting the remaining bound", () => {
    expect(boundedPastedText("123", "one\r\ntwo\u0000\nthree", 14)).toBe("one\ntwo\nthr")
  })

  it("does not split an astral symbol at the remaining character boundary", () => {
    expect(boundedPastedText("a".repeat(13), "😀x", 14)).toBe("😀")
  })
})

describe("promptReviewMetrics", () => {
  it("summarizes long Markdown prompts for split and dashboard variants", () => {
    expect(promptReviewMetrics("# Goal\n\nDo the work.\n## Checks\nRun tests.")).toEqual({
      characters: 41,
      words: 9,
      sourceLines: 5,
      headings: ["Goal", "Checks"],
    })
  })
})

describe("markdownPromptLines", () => {
  it("styles common Markdown structures without exposing markup prefixes", () => {
    expect(
      markdownPromptLines("# Goal\nIntro\n## Work\n- first\n1. second\n- [x] done\n> note\n```\nconst x = 1\n```", 80),
    ).toEqual([
      { text: "Goal", kind: "heading" },
      { text: "", kind: "body" },
      { text: "Intro", kind: "body" },
      { text: "", kind: "body" },
      { text: "Work", kind: "heading" },
      { text: "", kind: "body" },
      { text: "• first", kind: "list" },
      { text: "1. second", kind: "list" },
      { text: "☒ done", kind: "list" },
      { text: "│ note", kind: "quote" },
      { text: "```", kind: "code" },
      { text: "const x = 1", kind: "code" },
      { text: "```", kind: "code" },
    ])
  })

  it("does not split inline Markdown delimiters across wrapped lines", () => {
    expect(markdownPromptLines("Use **important requirement** now", 12)).toEqual([
      { text: "Use ", kind: "body" },
      { text: "**important requirement**", kind: "body" },
      { text: "now", kind: "body" },
    ])
  })

  it("parses safe inline Markdown without evaluating MDX or HTML", () => {
    expect(
      markdownInlineSegments("Use **bold**, *italics*, `code`, ~~old~~, and [docs](https://example.com)."),
    ).toEqual([
      { text: "Use ", kind: "text" },
      { text: "bold", kind: "bold" },
      { text: ", ", kind: "text" },
      { text: "italics", kind: "italic" },
      { text: ", ", kind: "text" },
      { text: "code", kind: "code" },
      { text: ", ", kind: "text" },
      { text: "old", kind: "strikethrough" },
      { text: ", and ", kind: "text" },
      { text: "docs (https://example.com)", kind: "link" },
      { text: ".", kind: "text" },
    ])
  })
})

describe("worktreeDirtyWarning", () => {
  it("explicitly states uncommitted changes will not be included in the new worktree when dirty", () => {
    expect(worktreeDirtyWarning(true)).toBe(
      "Uncommitted changes in the current working tree will not be included in the new worktree.",
    )
  })

  it("is undefined (nothing to warn about) when the source working tree is clean", () => {
    expect(worktreeDirtyWarning(false)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Destination visibility (Herdr gating) and headless command gating.
// ---------------------------------------------------------------------------

describe("destinationOptions", () => {
  it("offers only CurrentTerminal when Herdr is not enabled", () => {
    expect(destinationOptions(false)).toEqual([GuideUiDestination.CurrentTerminal])
  })

  describe("wizardStepForStage", () => {
    it("maps the interactive flow to profile, prompt candidate, and destination steps", () => {
      expect(wizardStepForStage(GuideUiStage.Intent)).toBeUndefined()
      expect(wizardStepForStage(GuideUiStage.Recommendations)).toBe(GuideWizardStep.Profile)
      expect(wizardStepForStage(GuideUiStage.PromptReview)).toBe(GuideWizardStep.Profile)
      expect(wizardStepForStage(GuideUiStage.Generating)).toBe(GuideWizardStep.PromptCandidates)
      expect(wizardStepForStage(GuideUiStage.Candidates)).toBe(GuideWizardStep.PromptCandidates)
      expect(wizardStepForStage(GuideUiStage.Destination)).toBe(GuideWizardStep.Destination)
      expect(wizardStepForStage(GuideUiStage.WorktreeReady)).toBe(GuideWizardStep.Destination)
    })

    describe("spinner helpers", () => {
      it("cycles animated frames and contextual messages deterministically", () => {
        expect(spinnerFrameAt(0)).toBe("⠋")
        expect(spinnerFrameAt(10)).toBe("⠋")
        expect(spinnerMessageAt(["first", "second"], 0)).toBe("first")
        expect(spinnerMessageAt(["first", "second"], 15)).toBe("second")
        expect(spinnerMessageAt(["first", "second"], 30)).toBe("first")
        expect(spinnerMessageAt([], 0)).toBeUndefined()
      })

      it("labels breadcrumb numbers explicitly as steps", () => {
        expect(wizardBreadcrumbLabel(0, "Profile", true)).toBe("✓ Step 1: Profile")
        expect(wizardBreadcrumbLabel(1, "Prompt candidates", false)).toBe("Step 2: Prompt candidates")
        expect(wizardBreadcrumbLabel(2, "Destination", false)).toBe("Step 3: Destination")
      })

      it("describes generation as concise user-facing processing steps", () => {
        const chosen = recommendation({ profileRef: "native:cdx/reviewer", workflowId: "review" })
        expect(generationProgressItems(chosen)).toEqual([
          { phase: GuideGenerationPhase.LoadingProfile, label: "Read Reviewer guidance" },
          {
            phase: GuideGenerationPhase.GeneratingCandidates,
            label: "Draft three profile-specific approaches",
          },
          { phase: GuideGenerationPhase.ApplyingWorkflow, label: "Apply the review workflow" },
          {
            phase: GuideGenerationPhase.OptimizingCandidates,
            label: "Improve clarity and completeness with Prompt Master",
          },
        ])
        expect(summarizeGenerationIntent("  Review\nmy   pull request  ", 40)).toBe("Review my pull request")
        expect(summarizeGenerationIntent("A request that is too long", 12)).toBe("A request t…")
      })

      it("describes matching as concise user-facing processing steps", () => {
        expect(matchProgressItems(12)).toEqual([
          {
            phase: GuideMatchPhase.LoadingProfiles,
            label: "Read 12 available profiles and their workflows",
          },
          {
            phase: GuideMatchPhase.ComparingProfiles,
            label: "Compare the request with capabilities and trade-offs",
          },
          {
            phase: GuideMatchPhase.PreparingRecommendations,
            label: "Prepare the ranked profile choices",
          },
        ])
      })

      it("bounds the split candidate layout to the terminal viewport", () => {
        expect(candidatePaneHeight(24)).toBe(16)
        expect(candidatePaneHeight(10)).toBe(6)
        expect(candidateRailWidth(100)).toBe(30)
        expect(candidateRailWidth(60)).toBe(20)
        expect(compactCommandPreview("cpx hve -i 'line one\nline two'")).toBe("cpx hve -i 'line one line two'")
      })

      it("wraps and pages large guide text without losing content", () => {
        expect(wrapGuideText("alpha beta gamma\n\ndelta", 10)).toEqual(["alpha beta", "gamma", "", "delta"])
        expect(wrapGuideText("    indented\n   ", 20)).toEqual(["    indented", "   "])
        expect(wrapGuideText("你好世界", 4)).toEqual(["你好", "世界"])
        expect(wrapGuideText("ab👨‍👩‍👧‍👦cd", 4)).toEqual(["ab👨‍👩‍👧‍👦", "cd"])
        expect(guideTextViewport("one\ntwo\nthree\nfour", 20, 2, 0)).toEqual({
          text: "one\ntwo",
          lines: ["one", "two"],
          startLine: 0,
          maximumStartLine: 2,
          atStart: true,
          atEnd: false,
        })
        expect(guideTextViewport("one\ntwo\nthree\nfour", 20, 2, Number.MAX_SAFE_INTEGER)).toEqual({
          text: "three\nfour",
          lines: ["three", "four"],
          startLine: 2,
          maximumStartLine: 2,
          atStart: false,
          atEnd: true,
        })
      })
    })
  })

  it("offers all three destinations, in order, when Herdr is enabled", () => {
    expect(destinationOptions(true)).toEqual([
      GuideUiDestination.CurrentTerminal,
      GuideUiDestination.CurrentHerdrWorkspace,
      GuideUiDestination.NewHerdrWorktree,
    ])
  })

  it("omits the temporary current terminal in a Herdr popup", () => {
    expect(destinationOptions(true, "popup")).toEqual([
      GuideUiDestination.CurrentHerdrWorkspace,
      GuideUiDestination.NewHerdrWorktree,
    ])
  })
})

describe("buildCurrentTerminalResult: headless gating", () => {
  it("uses Copilot interactive prompt delivery when the selected cpx profile supports prompts", () => {
    const result = buildCurrentTerminalResult(
      {
        surface: "native",
        launcher: "cpx",
        commandPath: "/opt/trellage/cpx/bin/cpx",
        profile: "plannotator",
        headlessPrompt: true,
      },
      "Do the thing.",
      "/repo",
    )
    expect(result.action).toBe("current-terminal")
    expect(result.command.args).toEqual(["plannotator", "-i", "Do the thing."])
    expect(result.promptHandling).toBe("argv")
  })

  it("passes a pinned Copilot agent before the interactive prompt", () => {
    const result = buildCurrentTerminalResult(
      {
        surface: "native",
        launcher: "cpx",
        commandPath: "/opt/trellage/cpx/bin/cpx",
        profile: "hve",
        headlessPrompt: true,
        agent: "hve-core:rpi-agent",
      },
      "Build the feature through the full RPI cycle.",
      "/repo",
    )
    expect(result.command.args).toEqual([
      "hve",
      "--agent",
      "hve-core:rpi-agent",
      "-i",
      "Build the feature through the full RPI cycle.",
    ])
    expect(result.promptHandling).toBe("argv")
  })

  it("passes a cdx prompt positionally even when conservative headless support is false", () => {
    const result = buildCurrentTerminalResult(nativeSelectedProfile(false), "Do the thing.", "/repo")
    expect(result.command.args).toEqual(["reviewer", "--", "Do the thing."])
    expect(result.promptHandling).toBe("argv")
  })

  it("omits -p and marks manual paste for other native profiles without prompt support", () => {
    const result = buildCurrentTerminalResult(
      {
        surface: "native",
        launcher: "grx",
        commandPath: "/opt/trellage/grx/bin/grx",
        profile: "reviewer",
        headlessPrompt: false,
      },
      "Do the thing.",
      "/repo",
    )
    expect(result.command.args).toEqual(["reviewer"])
    expect(result.promptHandling).toBe("manual-paste")
  })

  it("passes the prompt to an interactive Sandbox launch without requiring headless support", () => {
    const result = buildCurrentTerminalResult(
      {
        surface: "sandbox",
        commandPath: "/opt/trellage/bin/trellage",
        profile: "claude-research",
        headlessPrompt: false,
      },
      "Research the repository.",
      "/repo",
    )
    expect(result.command.args).toEqual(["--profile", "claude-research", "Research the repository."])
    expect(result.promptHandling).toBe("argv")
  })
})

describe("Herdr result builders: trust-safe initial prompt delivery", () => {
  const herdrContext: HerdrContext = { workspaceId: "workspace-1", paneId: "pane-1", surface: "pane" }

  it("queues a cpx prompt in the interactive command so folder trust cannot consume later prompt injection", () => {
    const result = buildCurrentHerdrWorkspaceResult(
      {
        surface: "native",
        launcher: "cpx",
        commandPath: "/opt/trellage/cpx/bin/cpx",
        profile: "hve",
        headlessPrompt: false,
        agent: "hve-core:rpi-agent",
      },
      "Run the complete RPI cycle.",
      "/repo",
      herdrContext,
    )
    expect(result.command.args).toEqual(["hve", "--agent", "hve-core:rpi-agent", "-i", "Run the complete RPI cycle."])
    expect(result.promptDelivery).toBe("command")
  })

  it("queues a cdx positional prompt so hook trust cannot consume later prompt injection", () => {
    const result = buildCurrentHerdrWorkspaceResult(nativeSelectedProfile(true), "Do the thing.", "/repo", herdrContext)
    expect(result.action).toBe("current-herdr-workspace")
    expect(result.command.args).toEqual(["reviewer", "--", "Do the thing."])
    expect(result.promptDelivery).toBe("command")
    expect(result.callerPaneId).toBe("pane-1")
    expect(result.direction).toBe("right")
  })

  it("buildNewHerdrWorktreeResult previews the base interactive command and carries branch/base/checkout", () => {
    const result = buildNewHerdrWorktreeResult(
      nativeSelectedProfile(true),
      "Do the thing.",
      "/repo",
      "worktree/do-the-thing",
      "main",
    )
    expect(result.action).toBe("herdr-worktree-create")
    expect(result.command.args).toEqual(["reviewer", "--", "Do the thing."])
    expect(result.promptDelivery).toBe("command")
    expect(result.branch).toBe("worktree/do-the-thing")
    expect(result.baseRef).toBe("main")
    expect(result.primaryCheckoutPath).toBe("/repo")
  })

  it("buildExistingHerdrWorktreeResult previews the base interactive command and carries the exact collision path", () => {
    const result = buildExistingHerdrWorktreeResult(
      nativeSelectedProfile(true),
      "Do the thing.",
      "/repo",
      "/repo-worktrees/existing",
    )
    expect(result.action).toBe("herdr-worktree-open")
    expect(result.command.args).toEqual(["reviewer", "--", "Do the thing."])
    expect(result.promptDelivery).toBe("command")
    expect(result.path).toBe("/repo-worktrees/existing")
  })
})

describe("buildCancelResult / buildPrintResult", () => {
  it("cancel carries exit code 130", () => {
    expect(buildCancelResult()).toEqual({ action: "cancel", exitCode: 130 })
  })

  it("print carries exactly the selected prompt", () => {
    expect(buildPrintResult("Do the thing.")).toEqual({ action: "print", prompt: "Do the thing." })
  })
})

// ---------------------------------------------------------------------------
// Reducer: readiness (checked once, blocked prevents Destination).
// ---------------------------------------------------------------------------

describe("guideUiReducer: readiness", () => {
  const checkingReadinessState = (): GuideUiState => {
    let state = createInitialGuideUiState("Review my PR")
    state = guideUiReducer(state, { type: GuideUiActionType.MatchSucceeded, recommendations: recommendationTriple() })
    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })
    state = guideUiReducer(state, {
      type: GuideUiActionType.GenerateGuideLoaded,
      guideDocument: { ref: "native:cdx/reviewer", guide: guideReviewer, body: "guide body" },
    })
    state = guideUiReducer(state, { type: GuideUiActionType.GenerateSucceeded, candidates: candidateTriple() })
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesConfirm })
    return state
  }

  it("a blocked readiness result moves to ReadinessBlocked, never Destination", () => {
    const blocked: ProfileReadinessResult = {
      kind: ProfileReadinessKind.Blocked,
      summary: "reviewer failed validation",
      diagnostic: "profile.toml is missing",
    }
    const state = guideUiReducer(checkingReadinessState(), {
      type: GuideUiActionType.ReadinessBlocked,
      result: blocked,
    })
    expect(state.stage).toBe(GuideUiStage.ReadinessBlocked)
    expect(state.readiness).toEqual(blocked)
  })

  it("readiness/back returns ReadinessBlocked -> Candidates so the user can retry a different candidate", () => {
    const blocked: ProfileReadinessResult = { kind: ProfileReadinessKind.Blocked, summary: "blocked", diagnostic: "x" }
    let state = guideUiReducer(checkingReadinessState(), { type: GuideUiActionType.ReadinessBlocked, result: blocked })
    state = guideUiReducer(state, { type: GuideUiActionType.ReadinessBack })
    expect(state.stage).toBe(GuideUiStage.Candidates)
  })

  it("readiness/retry re-enters CheckingReadiness (checked again only on explicit retry)", () => {
    const blocked: ProfileReadinessResult = { kind: ProfileReadinessKind.Blocked, summary: "blocked", diagnostic: "x" }
    let state = guideUiReducer(checkingReadinessState(), { type: GuideUiActionType.ReadinessBlocked, result: blocked })
    state = guideUiReducer(state, { type: GuideUiActionType.ReadinessRetry })
    expect(state.stage).toBe(GuideUiStage.CheckingReadiness)
  })

  it("a ready readiness result moves to Destination with destinationIndex reset to 0", () => {
    const ready: ProfileReadinessResult = { kind: ProfileReadinessKind.Ready, summary: "reviewer is healthy" }
    const state = guideUiReducer(checkingReadinessState(), { type: GuideUiActionType.ReadinessReady, result: ready })
    expect(state.stage).toBe(GuideUiStage.Destination)
    expect(state.destinationIndex).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Reducer: destination and worktree flow (confirmation counts, collisions,
// invalid branch).
// ---------------------------------------------------------------------------

describe("guideUiReducer: destination", () => {
  const destinationState = (): GuideUiState => {
    let state = createInitialGuideUiState("Review my PR")
    state = guideUiReducer(state, { type: GuideUiActionType.MatchSucceeded, recommendations: recommendationTriple() })
    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })
    state = guideUiReducer(state, {
      type: GuideUiActionType.GenerateGuideLoaded,
      guideDocument: { ref: "native:cdx/reviewer", guide: guideReviewer, body: "guide body" },
    })
    state = guideUiReducer(state, { type: GuideUiActionType.GenerateSucceeded, candidates: candidateTriple() })
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesConfirm })
    state = guideUiReducer(state, {
      type: GuideUiActionType.ReadinessReady,
      result: { kind: ProfileReadinessKind.Ready, summary: "ok" },
    })
    return state
  }

  it("destination/move wraps according to the given option count", () => {
    let state = destinationState()
    state = guideUiReducer(state, { type: GuideUiActionType.DestinationMove, delta: -1, optionCount: 3 })
    expect(state.destinationIndex).toBe(2)
    state = guideUiReducer(state, { type: GuideUiActionType.DestinationMove, delta: 1, optionCount: 3 })
    expect(state.destinationIndex).toBe(0)
  })

  it("destination/back returns to Candidates", () => {
    const state = guideUiReducer(destinationState(), { type: GuideUiActionType.DestinationBack })
    expect(state.stage).toBe(GuideUiStage.Candidates)
  })

  it("destination/start-worktree seeds the branch editor with the default slug branch", () => {
    const state = guideUiReducer(destinationState(), { type: GuideUiActionType.DestinationStartWorktree })
    expect(state.stage).toBe(GuideUiStage.WorktreeBranchEditor)
    expect(state.textDraft.startsWith("worktree/")).toBe(true)
  })
})

describe("guideUiReducer: worktree branch, invalid branch, and inspection failure", () => {
  const branchEditorState = (): GuideUiState => {
    let state = createInitialGuideUiState("Review my PR")
    state = guideUiReducer(state, { type: GuideUiActionType.MatchSucceeded, recommendations: recommendationTriple() })
    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })
    state = guideUiReducer(state, {
      type: GuideUiActionType.GenerateGuideLoaded,
      guideDocument: { ref: "native:cdx/reviewer", guide: guideReviewer, body: "guide body" },
    })
    state = guideUiReducer(state, { type: GuideUiActionType.GenerateSucceeded, candidates: candidateTriple() })
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesConfirm })
    state = guideUiReducer(state, {
      type: GuideUiActionType.ReadinessReady,
      result: { kind: ProfileReadinessKind.Ready, summary: "ok" },
    })
    state = guideUiReducer(state, { type: GuideUiActionType.DestinationStartWorktree })
    return state
  }

  it("worktree/submit-branch requires a non-empty branch before moving to InspectingWorktree", () => {
    let state = branchEditorState()
    state = guideUiReducer(state, { type: GuideUiActionType.EditorChange, text: "   " })
    const unaffected = guideUiReducer(state, { type: GuideUiActionType.WorktreeSubmitBranch })
    expect(unaffected.stage).toBe(GuideUiStage.WorktreeBranchEditor)

    state = guideUiReducer(state, { type: GuideUiActionType.EditorChange, text: "worktree/my-branch" })
    state = guideUiReducer(state, { type: GuideUiActionType.WorktreeSubmitBranch })
    expect(state.stage).toBe(GuideUiStage.InspectingWorktree)
    expect(state.worktreeBranch).toBe("worktree/my-branch")
  })

  it("an invalid branch returns to the branch editor with a diagnostic, preserving the previous branch text", () => {
    let state = guideUiReducer(branchEditorState(), { type: GuideUiActionType.EditorChange, text: "bad branch name" })
    state = guideUiReducer(state, { type: GuideUiActionType.WorktreeSubmitBranch })
    state = guideUiReducer(state, { type: GuideUiActionType.WorktreeInvalidBranch })
    expect(state.stage).toBe(GuideUiStage.WorktreeBranchEditor)
    expect(state.errorMessage).toBe("Invalid branch name.")
    expect(state.textDraft).toBe("bad branch name")
  })

  it("an unexpected inspection failure surfaces the safe error message instead of a generic invalid-branch message", () => {
    let state = guideUiReducer(branchEditorState(), {
      type: GuideUiActionType.EditorChange,
      text: "worktree/my-branch",
    })
    state = guideUiReducer(state, { type: GuideUiActionType.WorktreeSubmitBranch })
    state = guideUiReducer(state, {
      type: GuideUiActionType.WorktreeInspectFailed,
      message: "git executable not found",
    })
    expect(state.stage).toBe(GuideUiStage.WorktreeBranchEditor)
    expect(state.errorMessage).toBe("git executable not found")
    expect(state.textDraft).toBe("worktree/my-branch")
  })
})

describe("guideUiReducer: worktree collision handling", () => {
  const inspectingState = (): GuideUiState => {
    let state = createInitialGuideUiState("Review my PR")
    state = guideUiReducer(state, { type: GuideUiActionType.MatchSucceeded, recommendations: recommendationTriple() })
    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })
    state = guideUiReducer(state, {
      type: GuideUiActionType.GenerateGuideLoaded,
      guideDocument: { ref: "native:cdx/reviewer", guide: guideReviewer, body: "guide body" },
    })
    state = guideUiReducer(state, { type: GuideUiActionType.GenerateSucceeded, candidates: candidateTriple() })
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesConfirm })
    state = guideUiReducer(state, {
      type: GuideUiActionType.ReadinessReady,
      result: { kind: ProfileReadinessKind.Ready, summary: "ok" },
    })
    state = guideUiReducer(state, { type: GuideUiActionType.DestinationStartWorktree })
    state = guideUiReducer(state, { type: GuideUiActionType.EditorChange, text: "worktree/my-branch" })
    state = guideUiReducer(state, { type: GuideUiActionType.WorktreeSubmitBranch })
    return state
  }

  it("branch-exists-without-active-path collision carries no path (must require edit/cancel, never guessed)", () => {
    const collision = collisionInspection("branch-exists")
    const state = guideUiReducer(inspectingState(), {
      type: GuideUiActionType.WorktreeCollision,
      inspection: collision,
    })
    expect(state.stage).toBe(GuideUiStage.WorktreeCollision)
    expect(state.worktreeInspection).toBe(collision)
    expect((state.worktreeInspection as WorktreeCollisionResult).collision.path).toBeUndefined()
  })

  it("branch-active/path-active collision carries the active path, enabling open-existing", () => {
    const collision = collisionInspection("path-active", "/repo-worktrees/existing")
    const state = guideUiReducer(inspectingState(), {
      type: GuideUiActionType.WorktreeCollision,
      inspection: collision,
    })
    expect(state.stage).toBe(GuideUiStage.WorktreeCollision)
    expect((state.worktreeInspection as WorktreeCollisionResult).collision.path).toBe("/repo-worktrees/existing")
  })

  it("worktree/edit-branch returns WorktreeCollision -> WorktreeBranchEditor, seeded with the prior branch", () => {
    let state = guideUiReducer(inspectingState(), {
      type: GuideUiActionType.WorktreeCollision,
      inspection: collisionInspection("branch-exists"),
    })
    state = guideUiReducer(state, { type: GuideUiActionType.WorktreeEditBranch })
    expect(state.stage).toBe(GuideUiStage.WorktreeBranchEditor)
    expect(state.textDraft).toBe("worktree/my-branch")
  })

  it("worktree/back from WorktreeCollision returns to Destination and clears inspection state", () => {
    let state = guideUiReducer(inspectingState(), {
      type: GuideUiActionType.WorktreeCollision,
      inspection: collisionInspection("branch-exists"),
    })
    state = guideUiReducer(state, { type: GuideUiActionType.WorktreeBack })
    expect(state.stage).toBe(GuideUiStage.Destination)
    expect(state.worktreeInspection).toBeUndefined()
    expect(state.worktreeConfirmations).toBe(0)
  })
})

describe("guideUiReducer: worktree ready and confirmation counts", () => {
  const inspectingState = (): GuideUiState => {
    let state = createInitialGuideUiState("Review my PR")
    state = guideUiReducer(state, { type: GuideUiActionType.MatchSucceeded, recommendations: recommendationTriple() })
    state = guideUiReducer(state, {
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: nativeSelectedProfile(true),
    })
    state = guideUiReducer(state, {
      type: GuideUiActionType.GenerateGuideLoaded,
      guideDocument: { ref: "native:cdx/reviewer", guide: guideReviewer, body: "guide body" },
    })
    state = guideUiReducer(state, { type: GuideUiActionType.GenerateSucceeded, candidates: candidateTriple() })
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesConfirm })
    state = guideUiReducer(state, {
      type: GuideUiActionType.ReadinessReady,
      result: { kind: ProfileReadinessKind.Ready, summary: "ok" },
    })
    state = guideUiReducer(state, { type: GuideUiActionType.DestinationStartWorktree })
    state = guideUiReducer(state, { type: GuideUiActionType.EditorChange, text: "worktree/my-branch" })
    state = guideUiReducer(state, { type: GuideUiActionType.WorktreeSubmitBranch })
    return state
  }

  it("requiredWorktreeConfirmations/isWorktreeConfirmed: clean requires 1, dirty requires 2", () => {
    expect(requiredWorktreeConfirmations(false)).toBe(1)
    expect(requiredWorktreeConfirmations(true)).toBe(2)
    expect(isWorktreeConfirmed(0, false)).toBe(false)
    expect(isWorktreeConfirmed(1, false)).toBe(true)
    expect(isWorktreeConfirmed(1, true)).toBe(false)
    expect(isWorktreeConfirmed(2, true)).toBe(true)
  })

  it("worktree/ready resets confirmations to 0 regardless of dirty state", () => {
    const dirtyState = guideUiReducer(inspectingState(), {
      type: GuideUiActionType.WorktreeReady,
      inspection: readyInspection(true),
    })
    expect(dirtyState.stage).toBe(GuideUiStage.WorktreeReady)
    expect(dirtyState.worktreeConfirmations).toBe(0)
  })

  it("worktree/confirm increments the confirmation counter without changing stage", () => {
    let state = guideUiReducer(inspectingState(), {
      type: GuideUiActionType.WorktreeReady,
      inspection: readyInspection(true),
    })
    state = guideUiReducer(state, { type: GuideUiActionType.WorktreeConfirm })
    expect(state.stage).toBe(GuideUiStage.WorktreeReady)
    expect(state.worktreeConfirmations).toBe(1)
    expect(isWorktreeConfirmed(state.worktreeConfirmations, true)).toBe(false)
    state = guideUiReducer(state, { type: GuideUiActionType.WorktreeConfirm })
    expect(state.worktreeConfirmations).toBe(2)
    expect(isWorktreeConfirmed(state.worktreeConfirmations, true)).toBe(true)
  })

  it("a clean source is confirmed after a single confirmation", () => {
    let state = guideUiReducer(inspectingState(), {
      type: GuideUiActionType.WorktreeReady,
      inspection: readyInspection(false),
    })
    expect(isWorktreeConfirmed(state.worktreeConfirmations, false)).toBe(false)
    state = guideUiReducer(state, { type: GuideUiActionType.WorktreeConfirm })
    expect(isWorktreeConfirmed(state.worktreeConfirmations, false)).toBe(true)
  })

  it("worktree/back from WorktreeReady returns to Destination and resets confirmations", () => {
    let state = guideUiReducer(inspectingState(), {
      type: GuideUiActionType.WorktreeReady,
      inspection: readyInspection(true),
    })
    state = guideUiReducer(state, { type: GuideUiActionType.WorktreeConfirm })
    state = guideUiReducer(state, { type: GuideUiActionType.WorktreeBack })
    expect(state.stage).toBe(GuideUiStage.Destination)
    expect(state.worktreeConfirmations).toBe(0)
    expect(state.worktreeInspection).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Actions that don't apply to the current stage are no-ops (pure/guarded reducer).
// ---------------------------------------------------------------------------

describe("guideUiReducer: stage-guarded no-ops", () => {
  it("ignores actions that do not apply to the current stage", () => {
    const intentState = createInitialGuideUiState()
    const actionsInvalidAtIntent: ReadonlyArray<GuideUiAction> = [
      { type: GuideUiActionType.RecommendationsMove, delta: 1 },
      { type: GuideUiActionType.CandidatesConfirm },
      { type: GuideUiActionType.WorktreeConfirm },
      { type: GuideUiActionType.ReadinessRetry },
    ]
    for (const action of actionsInvalidAtIntent) {
      expect(guideUiReducer(intentState, action)).toBe(intentState)
    }
  })

  it("an unknown action type is a no-op (exhaustive default case)", () => {
    const state = createInitialGuideUiState()
    const result = guideUiReducer(state, { type: "not-a-real-action" } as unknown as GuideUiAction)
    expect(result).toBe(state)
  })
})
