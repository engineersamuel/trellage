import { randomUUID } from "node:crypto"
import { mkdtemp, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseGuideCatalog } from "../../src/guide-catalog.ts"
import {
  ActionAccess,
  ActionImportance,
  ContinuationOutcome,
  ConversationAgent,
  ConversationRole,
  ConversationSurface,
  type ContinuationAssessment,
  type ConversationSnapshot,
} from "@trellage/guide-core"

export const createContinuationFixtureRoot = async (): Promise<string> => {
  // Match the store tests: shared temporary ancestors are intentionally rejected.
  const directory = await realpath(fileURLToPath(new URL("../", import.meta.url)))
  return mkdtemp(path.join(directory, ".continuation-state-"))
}

export const runtimeSnapshot = (cwd: string): ConversationSnapshot => ({
  schemaVersion: 1,
  id: randomUUID(),
  source: {
    serverId: "test-server",
    surface: ConversationSurface.Host,
    agent: ConversationAgent.Copilot,
    sessionId: "a55e7d51-a735-41eb-8e14-b8dd112713c5",
    workspaceId: "w1",
    paneId: "w1:p1",
    tabId: "t1",
    cwd,
  },
  capturedAt: "2026-01-01T00:00:00.000Z",
  cutoff: { messageId: "m2", recordIndex: 1 },
  revision: "a".repeat(64),
  messages: [
    { id: "m1", role: ConversationRole.User, text: "Implement the search flow.", recordIndex: 0 },
    {
      id: "m2",
      role: ConversationRole.Assistant,
      text: "The search flow is implemented. A review remains.",
      recordIndex: 1,
    },
  ],
  coverage: { complete: true, notices: [] },
})

export const runtimeAssessment = (): ContinuationAssessment => ({
  schemaVersion: 1,
  outcome: ContinuationOutcome.Recommendations,
  goal: "Deliver an understandable search flow.",
  reportedProgress: ["The conversation reports the implementation is complete."],
  unresolvedWork: ["A review remains."],
  blockers: [],
  questions: [],
  actions: [
    ["Review correctness", "Review error handling.", "A prioritized review report."],
    ["Visualize the flow", "Draw the implemented data flow.", "A flow diagram."],
    ["Explain tradeoffs", "Explain the design decisions.", "A design explanation."],
    ["Test edge cases", "Add targeted search cases.", "Focused regression tests."],
    ["Draft release notes", "Summarize the user-facing change.", "Release notes."],
  ].map(([title, brief, expectedOutput], index) => ({
    id: `action-${index + 1}`,
    rank: index + 1,
    title: title!,
    brief: brief!,
    whyNow: "The implementation was reported complete.",
    expectedOutput: expectedOutput!,
    evidenceIds: ["m2"],
    importance: ActionImportance.Optional,
    profileRef: "native:cdx/default",
    workflowId: "review",
    dependsOn: [],
    access: ActionAccess.Unknown,
  })),
})

export const runtimeCatalog = () =>
  parseGuideCatalog(
    JSON.stringify({
      schemaVersion: 1,
      sandboxCommandPath: "/profiles/trellage",
      sandbox: [],
      native: [
        {
          launcher: "cdx",
          harness: "codex",
          name: "default",
          description: "Synthetic profile for runtime tests.",
          commandPath: "/profiles/cdx",
          sandbox: false,
          herdrCompatibility: { status: "supported" },
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
          guide: {
            schemaVersion: 1,
            capabilities: ["review"],
            bestFor: ["Reviewing changes", "Explaining code"],
            avoidFor: ["Unrelated work", "Unbounded background tasks"],
            prerequisites: [],
            workflows: [
              {
                id: "review",
                description: "Review the implementation.",
                examples: ["Review this diff", "Review the flow", "Find defects"],
                promptTemplate: "Review the implementation: {{intent}}",
              },
            ],
          },
        },
      ],
    }),
  )
