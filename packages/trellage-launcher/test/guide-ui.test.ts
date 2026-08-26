import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import type { ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import { parseGuideCatalog, type CombinedGuideCatalog } from "../src/guide-catalog.js"
import { literalGuideMatch, templatePromptCandidates, type GuideRecommendation } from "../src/guide-api.js"
import type {
  GuideGenerateCandidate,
  GuideGenerateInput,
  GuideGenerateResult,
  GuideMatchInput,
  GuideMatchResult,
  GuideProvider,
  GuideRefineInput,
  GuideRefineResult,
} from "../src/guide-provider.js"
import type { SelectedGuideDocument } from "../src/guide-selected.js"
import type { GitInspectionReady, HerdrContext, SelectedProfile, WorktreeCollisionResult } from "../src/guide-launch.js"
import { ProfileReadinessKind, type ProfileReadinessResult } from "../src/guide-preflight.js"
import {
  GuideUiActionType,
  GuideUiDestination,
  GuideUiStage,
  buildCancelResult,
  buildCurrentHerdrWorkspaceResult,
  buildCurrentTerminalResult,
  buildExistingHerdrWorktreeResult,
  buildNewHerdrWorktreeResult,
  buildPrintResult,
  createInitialGuideUiState,
  describeGuideUiError,
  destinationOptions,
  enrichLiteralCandidate,
  guideUiReducer,
  isWithinTextBound,
  isWorktreeConfirmed,
  literalGuideRecommendations,
  requiredWorktreeConfirmations,
  runGuideGenerationStep,
  runGuideRefinementStep,
  templateGuideCandidates,
  worktreeDirtyWarning,
  type GuideUiAction,
  type GuideUiState,
} from "../src/guide-ui.js"

// ---------------------------------------------------------------------------
// Shared fixtures: a 3-entry catalog (2 native, 1 sandbox), mirroring the
// fixture conventions in test/guide-api.test.ts.
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

const guideReviewer: ProfileGuideV1 = {
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
      promptTemplate: "Review the diff for: {{intent}}",
    },
  ],
}

const reviewerGuideMarkdown = `---
schemaVersion: 1
capabilities:
  - code-review
bestFor:
  - Reviewing pull requests
avoidFor:
  - Long-running background jobs
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

const guideWriter: ProfileGuideV1 = {
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

const guidePlanner: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["planning"],
  bestFor: ["Planning a feature"],
  avoidFor: ["One-line fixes"],
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

/** Builds a 3-entry catalog (2 native, 1 sandbox), rooted at `tmpRoot` for the sandbox profile path. */
const buildCatalog = (tmpRoot: string): CombinedGuideCatalog =>
  parseGuideCatalog(
    JSON.stringify({
      schemaVersion: 1,
      sandboxCommandPath: "/opt/trellage/bin/trellage",
      native: [
        {
          launcher: "cdx",
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

/** Writes the native "cdx/reviewer" guide Markdown fixture under `root`, matching `guideReviewer`. */
const writeGuideFixtures = async (root: string): Promise<void> => {
  await mkdir(path.join(root, "native", "cdx"), { recursive: true })
  await writeFile(path.join(root, "native", "cdx", "reviewer.md"), reviewerGuideMarkdown)
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
  })

  it("ignores a blank/whitespace-only initial intent", () => {
    const state = createInitialGuideUiState("   ")
    expect(state.stage).toBe(GuideUiStage.Intent)
    expect(state.intent).toBeUndefined()
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
    expect(state.candidates).toBeUndefined()
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

describe("runGuideGenerationStep", () => {
  it("loads only the selected guide and calls provider.generate with the recommendation's own workflow and body, never match", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "guide-ui-generate-"))
    try {
      const catalog = buildCatalog(tmpRoot)
      await writeGuideFixtures(tmpRoot)
      const provider = new FakeGuideProvider()
      const chosen = recommendation({ profileRef: "native:cdx/reviewer", workflowId: "review" })

      const result = await runGuideGenerationStep(catalog, tmpRoot, provider, "Review my PR", chosen)

      expect(provider.matchCalls).toHaveLength(0)
      expect(provider.generateCalls).toHaveLength(1)
      expect(provider.generateCalls[0]).toEqual({
        intent: "Review my PR",
        profileRef: "native:cdx/reviewer",
        workflowId: "review",
        guide: guideReviewer,
        guideBody: expect.stringContaining("Use this profile to review diffs."),
      })
      expect(result.candidates).toEqual(candidateTriple())
      expect(result.guideDocument.guide).toEqual(guideReviewer)
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
    const [firstRec, secondRec, thirdRec] = recommendations
    const [firstLiteral, secondLiteral, thirdLiteral] = literalCandidates
    for (const [rec, literal] of [
      [firstRec, firstLiteral],
      [secondRec, secondLiteral],
      [thirdRec, thirdLiteral],
    ] as const) {
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
        expect(rec.harness).toBe(entry?.harness)
      }
    }
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

  it("offers all three destinations, in order, when Herdr is enabled", () => {
    expect(destinationOptions(true)).toEqual([
      GuideUiDestination.CurrentTerminal,
      GuideUiDestination.CurrentHerdrWorkspace,
      GuideUiDestination.NewHerdrWorktree,
    ])
  })
})

describe("buildCurrentTerminalResult: headless gating", () => {
  it("uses -p with the prompt when the selected profile's headless.prompt is true", () => {
    const result = buildCurrentTerminalResult(nativeSelectedProfile(true), "Do the thing.", "/repo")
    expect(result.action).toBe("current-terminal")
    expect(result.command.args).toEqual(["reviewer", "-p", "Do the thing."])
    expect(result.promptHandling).toBe("argv")
  })

  it("omits -p and marks manual paste when the selected profile's headless.prompt is false", () => {
    const result = buildCurrentTerminalResult(nativeSelectedProfile(false), "Do the thing.", "/repo")
    expect(result.command.args).toEqual(["reviewer"])
    expect(result.promptHandling).toBe("manual-paste")
  })
})

describe("Herdr result builders: base interactive command, never -p", () => {
  const herdrContext: HerdrContext = { workspaceId: "workspace-1", paneId: "pane-1" }

  it("buildCurrentHerdrWorkspaceResult previews the base interactive command and carries the caller pane id", () => {
    const result = buildCurrentHerdrWorkspaceResult(nativeSelectedProfile(true), "Do the thing.", "/repo", herdrContext)
    expect(result.action).toBe("current-herdr-workspace")
    expect(result.command.args).toEqual(["reviewer"])
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
    expect(result.command.args).toEqual(["reviewer"])
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
    expect(result.command.args).toEqual(["reviewer"])
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
