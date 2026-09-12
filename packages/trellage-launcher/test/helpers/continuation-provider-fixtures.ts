import {
  ActionAccess,
  ActionImportance,
  ContinuationOutcome,
  ConversationAgent,
  ConversationRole,
  ConversationSurface,
  type ContinuationAssessment,
  type ConversationSnapshot,
  type NextAction,
} from "@trellage/guide-core/conversation"
import type { GuideMatchCatalogEntry } from "../../src/guide-catalog.ts"
import type { GuideReasoningEffort } from "../../src/guide-model-routing.ts"
import type {
  ContinuationAssessmentInput,
  ContinuationProvider,
  ContinuationRequestOptions,
  ContinuationSummaryInput,
} from "../../src/continuation-provider.ts"

export const continuationEntries: GuideMatchCatalogEntry[] = [{
  ref: "native:cpx/default",
  surface: "native",
  name: "default",
  launcher: "cpx",
  description: "An assistant for scoped development and explanation.",
  sandbox: false,
  guide: {
    schemaVersion: 1,
    capabilities: ["implementation", "review", "explanation"],
    bestFor: ["Scoped work", "Independent analysis"],
    avoidFor: ["Unbounded work", "Assuming completed checks"],
    prerequisites: [{ id: "repository", description: "A selected repository is needed for later code work." }],
    workflows: [{ id: "assist", description: "Perform the selected scoped task.", examples: ["Explain the design", "Review the changes"] }],
  },
}]

export const conversationFixture = (count = 2, size = 180): ConversationSnapshot => {
  const messages = Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? ConversationRole.User : ConversationRole.Assistant,
    text: (index === 0
      ? "Original goal: design and build a widget; explain the plan, obtain a second opinion, review the result, and implement remaining validation."
      : `Turn ${index}: ${index % 2 === 0 ? "Keep the stated scope and constraints." : "The widget was implemented as reported, but validation remains open."}`).padEnd(size, "x"),
    recordIndex: index,
  }))
  const last = messages.at(-1)!
  return {
    schemaVersion: 1,
    id: "11111111-1111-4111-8111-111111111111",
    source: {
      serverId: "server-one", surface: ConversationSurface.Host, agent: ConversationAgent.Copilot,
      sessionId: "session-one", workspaceId: "workspace-one", paneId: "pane-one", cwd: "/source/workspace",
    },
    capturedAt: "2026-09-09T21:00:00.000Z",
    cutoff: { messageId: last.id, recordIndex: last.recordIndex },
    revision: "a".repeat(64),
    messages,
    coverage: { complete: true, notices: [] },
  }
}

const action = (index: number, title: string, brief: string, output: string): NextAction => ({
  id: `action-${index}`, rank: index, title, brief, expectedOutput: output,
  whyNow: "The conversation asks for this scoped follow-up.",
  evidenceIds: ["message-0", "message-1"],
  importance: ActionImportance.Optional,
  profileRef: "native:cpx/default",
  workflowId: "assist",
  dependsOn: [],
  access: ActionAccess.ReadOnly,
})

export const assessmentFixture = (): ContinuationAssessment => ({
  schemaVersion: 1,
  outcome: ContinuationOutcome.Recommendations,
  goal: "Complete the widget and communicate the bounded design.",
  reportedProgress: ["The assistant reported implementing the widget."],
  unresolvedWork: ["Validation remains open."],
  blockers: [],
  actions: [
    action(1, "Draw the implemented widget", "Create a diagram of the widget's reported components and interfaces; mark reported behavior as unverified.", "A component diagram with a legend."),
    action(2, "Request an independent design opinion", "Assess alternative designs against the stated scope and explain which trade-offs deserve discussion.", "A comparison of design alternatives."),
    action(3, "Review correctness of the result", "Inspect the widget's eventual changes for correctness problems and missing boundary tests without modifying files.", "A ranked list of review findings."),
    action(4, "Explain the decisions", "Write an explanation of why the widget plan chose each interface, separating decisions from unresolved questions.", "A short decision explanation for maintainers."),
    {
      ...action(5, "Implement remaining validation", "Add boundary validation for the widget after the review findings are available, preserving the stated constraints.", "Validation changes and focused test evidence."),
      dependsOn: ["action-3"],
      access: ActionAccess.Write,
      importance: ActionImportance.Required,
    },
  ],
  questions: [],
})

export const summaryFixture = (input: ContinuationSummaryInput): unknown => ({
  evidenceIds: input.evidenceIds,
  points: [{
    kind: "goal",
    text: input.messages[0]?.text.slice(0, 170) ?? input.summaries.map(({ text }) => text.slice(0, 180)).join(" "),
    evidenceIds: input.evidenceIds,
  }],
})

export class FakeContinuationProvider implements ContinuationProvider {
  model = "fixture-model"
  effort: GuideReasoningEffort = "medium"
  digest = "b".repeat(64)
  digestCalls = 0
  readonly summaryRequests: Array<{ input: ContinuationSummaryInput; options: ContinuationRequestOptions }> = []
  readonly assessmentRequests: Array<{ input: ContinuationAssessmentInput; options: ContinuationRequestOptions }> = []
  summaryResponse: (input: ContinuationSummaryInput, index: number) => unknown | Promise<unknown> = summaryFixture
  assessmentResponse: (input: ContinuationAssessmentInput, index: number) => unknown | Promise<unknown> = assessmentFixture

  async promptDigest(): Promise<string> {
    this.digestCalls += 1
    return this.digest
  }

  async summarize(input: ContinuationSummaryInput, options: ContinuationRequestOptions): Promise<unknown> {
    this.summaryRequests.push({ input, options })
    return this.summaryResponse(input, this.summaryRequests.length - 1)
  }

  async assess(input: ContinuationAssessmentInput, options: ContinuationRequestOptions): Promise<unknown> {
    this.assessmentRequests.push({ input, options })
    return this.assessmentResponse(input, this.assessmentRequests.length - 1)
  }
}
