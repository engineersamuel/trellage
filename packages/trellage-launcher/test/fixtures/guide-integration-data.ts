import type { NativeSelectedProfile, CommandSpec } from "../../src/guide-launch.js"
import type {
  GuideEnrichInput,
  GuideGenerateCandidate,
  GuideGenerateInput,
  GuideOptimizeInput,
} from "../../src/guide-provider.js"
import type { GuideUiResult } from "../../src/guide-ui.js"

export enum FixtureMode {
  Terminal = "terminal",
  Herdr = "herdr",
  DirtyWorktree = "dirty-worktree",
  ExistingWorktree = "existing-worktree",
}

export type FixtureProfileId =
  | "planner"
  | "reviewer"
  | "writer"
  | "builder"
  | "sandbox"
  | "council"
  | "research"
  | "hve"

export type FixtureProfile = {
  readonly id: FixtureProfileId
  readonly ref: string
  readonly name: string
  readonly harness: string
  readonly workflowId: string
  readonly beforeBody: string
  readonly afterBody: string
  readonly skill?: string
  readonly key?: string
} & (
  | { readonly surface: "native"; readonly launcher: NativeSelectedProfile["launcher"]; readonly agent?: string }
  | { readonly surface: "sandbox" }
)

export const fixtureProfiles: ReadonlyArray<FixtureProfile> = [
  {
    id: "planner",
    ref: "native:cdx/planner",
    surface: "native",
    launcher: "cdx",
    name: "planner",
    harness: "codex",
    workflowId: "review",
    beforeBody: "",
    afterBody: "",
  },
  {
    id: "reviewer",
    ref: "native:cpx/reviewer",
    surface: "native",
    launcher: "cpx",
    name: "reviewer",
    harness: "copilot",
    workflowId: "review",
    beforeBody: "",
    afterBody: "",
  },
  {
    id: "writer",
    ref: "native:cldx/writer",
    surface: "native",
    launcher: "cldx",
    name: "writer",
    harness: "claude",
    workflowId: "review",
    beforeBody: "",
    afterBody: "",
  },
  {
    id: "builder",
    ref: "native:picx/builder",
    surface: "native",
    launcher: "picx",
    name: "builder",
    harness: "pi",
    workflowId: "review",
    beforeBody: "",
    afterBody: "",
  },
  {
    id: "sandbox",
    ref: "sandbox:sandbox-reviewer",
    surface: "sandbox",
    name: "sandbox-reviewer",
    harness: "copilot",
    workflowId: "review",
    beforeBody: "",
    afterBody: "",
  },
  {
    id: "council",
    ref: "sandbox:claude-council",
    surface: "sandbox",
    name: "claude-council",
    harness: "claude",
    workflowId: "run-council-deliberation",
    key: "c",
    skill: "council",
    beforeBody: "/council Pressure-test this request:\n",
    afterBody: "\nEnd with an actionable verdict.",
  },
  {
    id: "research",
    ref: "sandbox:claude-research",
    surface: "sandbox",
    name: "claude-research",
    harness: "claude",
    workflowId: "vault-backed-research",
    key: "r",
    skill: "hyperresearch",
    beforeBody: "/hyperresearch Gather evidence for:\n",
    afterBody: "\nCite the sources.",
  },
  {
    id: "hve",
    ref: "native:cpx/hve",
    surface: "native",
    launcher: "cpx",
    name: "hve",
    harness: "copilot",
    workflowId: "rpi-agent-cycle",
    key: "h",
    agent: "hve-core:rpi-agent",
    beforeBody: "Research, plan, implement, and review:\n",
    afterBody: "",
  },
]

export const recommendationIds: ReadonlyArray<FixtureProfileId> = [
  "planner",
  "reviewer",
  "writer",
  "builder",
  "sandbox",
]
export const pinnedIds: ReadonlyArray<FixtureProfileId> = ["council", "research", "hve"]
export const candidateTitles = ["Focused", "Thorough", "Minimal"] as const
export const fixtureIntent = "Review the 'login flow' for regressions."
export const fixtureBranch = "worktree/review-the-login-flow-for-regressions"
export const fixtureHead = "1234567890abcdef1234567890abcdef12345678"
export const repositoryPack = "# Repository\n\nsrc/login.ts checks token expiry before refresh.\n"

export const fixtureProfile = (id: FixtureProfileId): FixtureProfile => {
  const profile = fixtureProfiles.find((entry) => entry.id === id)
  if (profile === undefined) throw new Error(`Unknown fixture profile: ${id}`)
  return profile
}

export const guideSource = (profile: FixtureProfile): string => {
  const metadata = {
    schemaVersion: 1,
    capabilities: ["code-review"],
    bestFor: ["Reviewing changes", "Tracing regressions"],
    avoidFor: ["Unrelated writing", "Long-running jobs"],
    prerequisites: [],
    workflows: [
      {
        id: profile.workflowId,
        description: `Review with ${profile.name}.`,
        examples: ["Review this change", "Find regressions in this diff"],
        ...(profile.skill === undefined ? {} : { skill: profile.skill }),
        promptTemplate: `${profile.beforeBody}{{intent}}${profile.afterBody}`,
      },
    ],
  }
  return `---\n${JSON.stringify(metadata, null, 2)}\n---\n# ${profile.ref}\n\nReview the change with ${profile.name}.\n`
}

export const generatedCandidates = (profile: FixtureProfile, intent: string): ReadonlyArray<GuideGenerateCandidate> =>
  candidateTitles.map((title) => {
    const body = `${intent}\nProfile: ${profile.ref}\nApproach: ${title.toLowerCase()}.`
    return {
      title,
      prompt: profile.skill === undefined ? `${profile.beforeBody}${body}${profile.afterBody}` : body,
      notes: `${title} review`,
    }
  })

export const researchIntent = (intent: string): string =>
  `${intent}\nEvidence: cover expired tokens and repeated requests.`

export const codebaseIntent = (intent: string): string =>
  `${intent}\nCodebase: preserve the expiry check in src/login.ts.`

export interface RecordedCommand {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
}

export type FixtureEvent =
  | { readonly kind: "input"; readonly input: string }
  | {
      readonly kind: "match"
      readonly intent: string
      readonly profileRefs: ReadonlyArray<string>
      readonly recommendations: ReadonlyArray<string>
    }
  | {
      readonly kind: "generate"
      readonly input: Pick<GuideGenerateInput, "intent" | "profileRef" | "workflowId">
      readonly candidates: ReadonlyArray<GuideGenerateCandidate>
    }
  | {
      readonly kind: "optimize"
      readonly input: GuideOptimizeInput
      readonly candidates: ReadonlyArray<GuideGenerateCandidate>
    }
  | { readonly kind: "enrich"; readonly input: GuideEnrichInput; readonly intent: string }
  | { readonly kind: "command"; readonly command: RecordedCommand }
  | {
      readonly kind: "interactive-launch"
      readonly command: CommandSpec
      readonly cwd: string
      readonly automation: string | undefined
    }

export interface FixtureReport {
  readonly result: GuideUiResult
  readonly events: ReadonlyArray<FixtureEvent>
  readonly writes: ReadonlyArray<string>
}

export type RecordFixtureEvent = (event: FixtureEvent) => Promise<void>
