import { describe, expect, it } from "vitest"
import {
  ActionAccess,
  ActionImportance,
  ContinuationActionStatus,
  ContinuationOutcome,
  ContinuationPlacementKind,
  ConversationAgent,
  ConversationRole,
  ConversationSurface,
  ConversationValidationError,
  conversationLimits,
  conversationSourceKey,
  validateContinuationAssessment,
  validateContinuationDraft,
  validateConversationSnapshot,
  validateConversationSource,
  type ContinuationAssessment,
  type ContinuationDraft,
  type ConversationSnapshot,
  type ConversationSource,
} from "../src/conversation.js"

const snapshot = (): ConversationSnapshot => ({
  schemaVersion: 1,
  id: "c909793f-e80d-4f74-b92c-d59676ae9fb4",
  source: {
    serverId: "server-1",
    surface: ConversationSurface.Host,
    agent: ConversationAgent.Copilot,
    sessionId: "session-1",
    workspaceId: "workspace-1",
    paneId: "workspace-1:pane-1",
    tabId: "tab-1",
    cwd: "/work/search",
  },
  capturedAt: "2026-09-09T21:02:09.441Z",
  cutoff: { messageId: "message-4", recordIndex: 8 },
  revision: "a".repeat(64),
  messages: [
    { id: "message-1", role: ConversationRole.User, text: "Explain search.", recordIndex: 0 },
    { id: "message-2", role: ConversationRole.Assistant, text: "The search uses an index.", recordIndex: 3 },
    { id: "message-3", role: ConversationRole.User, text: "Explain search.", recordIndex: 5 },
    {
      id: "message-4",
      role: ConversationRole.Assistant,
      text: "  An index maps terms to records. 😀\n",
      recordIndex: 8,
    },
  ],
  coverage: { complete: true, notices: [] },
})

const assessment = (): ContinuationAssessment => ({
  schemaVersion: 1,
  outcome: ContinuationOutcome.Recommendations,
  goal: "Understand and deliver the search design.",
  reportedProgress: ["The assistant reports an explanation."],
  unresolvedWork: ["The index design still needs a review."],
  blockers: [],
  actions: ["Visualize", "Review", "Research", "Explain", "Test"].map((title, index) => ({
    id: `action-${index + 1}`,
    rank: index + 1,
    title: `${title} the search design`,
    brief: `${title} the search index and report findings.`,
    whyNow: "The explanation is ready.",
    expectedOutput: `A ${title.toLowerCase()} result.`,
    evidenceIds: ["message-1", "message-4"],
    importance: index === 0 ? ActionImportance.Required : ActionImportance.Optional,
    profileRef: "native:cdx/default",
    workflowId: "review",
    dependsOn: index === 4 ? ["action-1"] : [],
    access: ActionAccess.Unknown,
  })),
  questions: [],
})

const catalog = new Map([["native:cdx/default", new Set(["review"])]])

const draft = (): ContinuationDraft => {
  const result = assessment()
  return {
    schemaVersion: 1,
    id: "057ee2b1-a946-42e8-b26b-40e6a901ea65",
    revision: 0,
    snapshot: snapshot(),
    model: "gpt-5.5",
    effort: "high",
    summaries: [
      { key: "summary-1", text: "The search design was explained.", evidenceIds: ["message-1", "message-2"] },
    ],
    assessment: result,
    actions: result.actions.map((action) => ({
      actionId: action.id,
      brief: action.brief,
      selected: false,
      status: ContinuationActionStatus.Draft,
    })),
  }
}

describe("conversation source identity", () => {
  it.each(
    Object.values(ConversationSurface).flatMap((surface) =>
      Object.values(ConversationAgent).map((agent) => ({ surface, agent })),
    ),
  )("accepts exact $surface/$agent identity", ({ surface, agent }) => {
    const source: ConversationSource = {
      ...snapshot().source,
      surface,
      agent,
      ...(surface === ConversationSurface.Host ? {} : { profile: "default" }),
      ...(surface === ConversationSurface.Sandbox ? { containerId: "container-1", invocationId: "invocation-1" } : {}),
    }
    expect(validateConversationSource(source)).toEqual(source)
  })

  it("uses canonical field order without changing source identity", () => {
    const source = snapshot().source
    const reordered = Object.fromEntries(Object.entries(source).reverse()) as unknown as ConversationSource
    expect(conversationSourceKey(source)).toMatch(/^[0-9a-f]{64}$/u)
    expect(conversationSourceKey(reordered)).toBe(conversationSourceKey(source))
  })

  it.each(["serverId", "sessionId", "workspaceId", "paneId", "tabId", "cwd"] as const)(
    "binds %s even when all other fields match",
    (field) => {
      const source = snapshot().source
      const changed = { ...source, [field]: field === "cwd" ? "/work/other" : "other-identity" }
      expect(conversationSourceKey(changed)).not.toBe(conversationSourceKey(source))
    },
  )

  it.each([
    { surface: "container" },
    { agent: "other-agent" },
    { surface: ConversationSurface.Native },
    { surface: ConversationSurface.Sandbox, profile: "default", containerId: "container-1" },
    { containerId: "container-1" },
    { profile: "default" },
    { cwd: "relative/work" },
    { cwd: "/work/../other" },
    { paneId: "pane\nsecret" },
    { sessionId: "x".repeat(conversationLimits.identifierChars + 1) },
    { command: "do not execute" },
  ])("rejects an invalid or ambiguous source %#", (change) => {
    expect(() => validateConversationSource({ ...snapshot().source, ...change })).toThrow(ConversationValidationError)
  })

  it("rejects inherited fields and accessors without evaluating them", () => {
    const source = snapshot().source
    expect(() => validateConversationSource(Object.create(source))).toThrow(/plain object/u)
    const accessor = { ...source }
    Object.defineProperty(accessor, "sessionId", {
      enumerable: true,
      get: () => {
        throw new Error("must not run")
      },
    })
    expect(() => validateConversationSource(accessor)).toThrow(/JSON fields/u)
  })
})

describe("conversation snapshot", () => {
  it("preserves genuine repeated messages, whitespace, Unicode, and source record gaps", () => {
    const original = snapshot()
    const parsed = validateConversationSnapshot(original)
    expect(parsed).toEqual(original)
    expect(parsed).not.toBe(original)
    expect(parsed.messages).not.toBe(original.messages)
    expect(parsed.source).not.toBe(original.source)
  })

  it("keeps a Sandbox domain snapshot UUID separate from its sealed transport identity", () => {
    const original = snapshot()
    const exported = {
      ...original,
      source: {
        ...original.source,
        surface: ConversationSurface.Sandbox,
        profile: "claude-council",
        containerId: "b".repeat(64),
        invocationId: "invocation-1",
      },
    }
    expect(validateConversationSnapshot(exported)).toEqual(exported)
    expect(() => validateConversationSnapshot({ ...exported, id: "c".repeat(64) })).toThrow(/UUID/u)
  })

  it.each([
    "a".repeat(63),
    "a".repeat(64),
    "a".repeat(65),
    "a".repeat(128),
    "A".repeat(64),
    `sha256:${"a".repeat(64)}`,
  ])("rejects a non-UUID domain snapshot identity %#", (id) => {
    expect(() => validateConversationSnapshot({ ...snapshot(), id })).toThrow(/UUID/u)
  })

  it("accepts a disclosed incomplete history and Python-style timestamp precision", () => {
    const original = {
      ...snapshot(),
      capturedAt: "2026-09-09T21:02:09.441123Z",
      coverage: {
        complete: false,
        notices: ["Earlier source history is unavailable after compaction."],
      },
    }
    expect(validateConversationSnapshot(original)).toEqual(original)
  })

  it.each([
    { schemaVersion: 2 },
    { id: "../../outside" },
    { revision: "not-a-digest" },
    { revision: "A".repeat(64) },
    { capturedAt: "2026-02-30T00:00:00.000Z" },
    { capturedAt: "yesterday" },
    { coverage: { complete: false, notices: [] } },
    { coverage: { complete: "true", notices: [] } },
    { messages: [] },
    { cutoff: { messageId: "message-2", recordIndex: 3 } },
    { cutoff: { messageId: "message-4", recordIndex: 9 } },
    { command: "must not be stored" },
  ])("rejects an invalid snapshot %#", (change) => {
    expect(() => validateConversationSnapshot({ ...snapshot(), ...change })).toThrow(ConversationValidationError)
  })

  it.each([
    { role: ConversationRole.User },
    { role: "commentary" },
    { text: "private\u001b]52;clipboard" },
    { text: "\ud800" },
    { text: "  " },
    { id: "message-1" },
    { recordIndex: -1 },
    { recordIndex: 5 },
    { recordIndex: Number.MAX_SAFE_INTEGER + 1 },
    { recordIndex: 8.5 },
    { toolCalls: [] },
  ])("rejects an invalid final message %#", (change) => {
    const original = snapshot()
    const messages = original.messages.map((message, index) => (index === 3 ? { ...message, ...change } : message))
    expect(() => validateConversationSnapshot({ ...original, messages })).toThrow(ConversationValidationError)
  })

  it("rejects sparse arrays and oversize UTF-8 records", () => {
    expect(() => validateConversationSnapshot({ ...snapshot(), messages: Array(1) })).toThrow(/dense/u)
    const original = snapshot()
    const messages = original.messages.map((message, index) =>
      index === 3 ? { ...message, text: "😀".repeat(conversationLimits.messageBytes / 4 + 1) } : message,
    )
    expect(() => validateConversationSnapshot({ ...original, messages })).toThrow(/byte limit/u)
  })

  it("rejects array subclasses before executing custom array methods", () => {
    const messages = [...snapshot().messages]
    Object.setPrototypeOf(
      messages,
      Object.create(Array.prototype, {
        map: {
          value: () => {
            throw new Error("must not execute")
          },
        },
      }),
    )
    expect(() => validateConversationSnapshot({ ...snapshot(), messages })).toThrow(/plain JSON array/u)
  })

  it("accepts the exact message byte limit without truncation", () => {
    const original = snapshot()
    const messages = original.messages.map((message, index) =>
      index === 3 ? { ...message, text: "x".repeat(conversationLimits.messageBytes) } : message,
    )
    expect(validateConversationSnapshot({ ...original, messages }).messages[3]!.text.length).toBe(
      conversationLimits.messageBytes,
    )
  })
})

describe("continuation assessment", () => {
  it("accepts five ranked actions with repeated profiles and valid dependencies", () => {
    const original = assessment()
    expect(validateContinuationAssessment(original, snapshot(), catalog)).toEqual(original)
  })

  it("requires an explicit catalog at the public validation boundary", () => {
    expect(() => validateContinuationAssessment(assessment(), snapshot(), undefined!)).toThrow(/catalog/u)
  })

  it.each([
    { outcome: "done" },
    { schemaVersion: 2 },
    { actions: [] },
    { actions: assessment().actions.slice(0, 4) },
    { actions: [...assessment().actions, assessment().actions[4]] },
    { outcome: ContinuationOutcome.NeedsClarification },
    { outcome: ContinuationOutcome.NoFurtherAction },
    { command: "must not execute" },
  ])("rejects an invalid recommendation outcome %#", (change) => {
    expect(() => validateContinuationAssessment({ ...assessment(), ...change }, snapshot(), catalog)).toThrow(
      ConversationValidationError,
    )
  })

  it.each([
    { rank: 0 },
    { rank: 2 },
    { id: "action-2" },
    { title: " review  the search design " },
    { brief: " REVIEW  the search index and report findings. " },
    { evidenceIds: [] },
    { evidenceIds: ["invented-message"] },
    { evidenceIds: ["message-1", "message-1"] },
    { profileRef: "native:cdx/invented" },
    { profileRef: "cdx default; do-something" },
    { workflowId: "invented" },
    { dependsOn: ["action-1"] },
    { dependsOn: ["action-6"] },
    { dependsOn: ["action-2", "action-2"] },
    { importance: "critical" },
    { access: "safe" },
    { command: { argv: ["do-something"] } },
    { brief: "x".repeat(conversationLimits.briefChars + 1) },
  ])("rejects invalid action data %#", (change) => {
    const original = assessment()
    const actions = original.actions.map((action, index) => (index === 0 ? { ...action, ...change } : action))
    expect(() => validateContinuationAssessment({ ...original, actions }, snapshot(), catalog)).toThrow(
      ConversationValidationError,
    )
  })

  it("rejects a dependency cycle independently of rank", () => {
    const original = assessment()
    const actions = original.actions.map((action, index) =>
      index === 0 ? { ...action, dependsOn: ["action-5"] } : action,
    )
    expect(() => validateContinuationAssessment({ ...original, actions }, snapshot(), catalog)).toThrow(/cycle/u)
  })

  it("accepts an acyclic dependency on a later-ranked action", () => {
    const original = assessment()
    const actions = original.actions.map((action, index) =>
      index === 0 ? { ...action, dependsOn: ["action-2"] } : action,
    )
    expect(validateContinuationAssessment({ ...original, actions }, snapshot(), catalog).actions).toEqual(actions)
  })

  it("supports clarification and no-further-action without five placeholder cards", () => {
    for (const outcome of [ContinuationOutcome.NeedsClarification, ContinuationOutcome.NoFurtherAction]) {
      const value = {
        ...assessment(),
        outcome,
        actions: [],
        questions: outcome === ContinuationOutcome.NeedsClarification ? ["Which result do you need?"] : [],
      }
      expect(validateContinuationAssessment(value, snapshot(), catalog)).toEqual(value)
    }
    expect(() =>
      validateContinuationAssessment(
        {
          ...assessment(),
          outcome: ContinuationOutcome.NeedsClarification,
          actions: [],
          questions: [],
        },
        snapshot(),
        catalog,
      ),
    ).toThrow(/question/u)
    expect(() =>
      validateContinuationAssessment(
        {
          ...assessment(),
          outcome: ContinuationOutcome.NoFurtherAction,
          actions: [],
          questions: ["What next?"],
        },
        snapshot(),
        catalog,
      ),
    ).toThrow(/question/u)
  })
})

describe("continuation draft", () => {
  it("preserves the provider's versioned summary key and a 4096-byte Unicode summary", () => {
    const original = draft()
    const key = `continuation-v1:${"a".repeat(64)}:${"b".repeat(64)}`
    const summary = {
      key,
      text: "😀".repeat(1024),
      evidenceIds: original.snapshot.messages.map(({ id }) => id),
    }
    expect(key).toHaveLength(145)
    expect(Buffer.byteLength(summary.text, "utf8")).toBe(4096)
    expect(validateContinuationDraft({ ...original, summaries: [summary] }).summaries).toEqual([summary])
  })

  it("validates persisted assessment shape without trusting a catalog", () => {
    const original = draft()
    expect(validateContinuationDraft(original)).toEqual(original)
    expect(() => validateContinuationAssessment(original.assessment, original.snapshot, new Map())).toThrow(/catalog/u)
  })

  it("accepts an unassessed revision-zero draft", () => {
    const { assessment: _assessment, ...unassessed } = draft()
    const original = { ...unassessed, summaries: [], actions: [] }
    expect(validateContinuationDraft(original)).toEqual(original)
  })

  it.each([
    { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { effort: "high\nsecret" },
    { model: "--run-a-command" },
    { id: "/outside" },
    { id: "a".repeat(64) },
    { summaries: [{ key: "summary-1", text: "A result.", evidenceIds: ["invented"] }] },
    { summaries: [{ key: "summary-1", text: "A result.", evidenceIds: ["message-1"], command: "no" }] },
    { actions: [] },
    { command: "never restore executable commands" },
  ])("rejects an invalid persisted draft %#", (change) => {
    expect(() => validateContinuationDraft({ ...draft(), ...change })).toThrow(ConversationValidationError)
  })

  it.each([
    { actionId: "invented" },
    { actionId: "action-2" },
    { selected: "true" },
    { status: "complete" },
    { status: ContinuationActionStatus.Launching },
    { status: ContinuationActionStatus.Prepared },
    { profileRef: "native:cdx/default" },
    { prerequisitesConfirmed: 1 },
    { sharedWriteConfirmed: "yes" },
    { prompt: "x".repeat(conversationLimits.promptChars + 1) },
    { placement: { kind: ContinuationPlacementKind.NewTab, command: "no" } },
    { placement: { kind: ContinuationPlacementKind.NewTab, direction: "right" } },
    { placement: { kind: ContinuationPlacementKind.CurrentWorkspacePane, direction: "left" } },
    { placement: { kind: ContinuationPlacementKind.NewWorktree, branch: "topic; command", baseRef: "HEAD" } },
    { placement: { kind: ContinuationPlacementKind.NewWorktree, branch: "topic", baseRef: "--run" } },
    { placement: { kind: ContinuationPlacementKind.ExistingWorktree, path: "../outside" } },
    { launch: { attemptId: "not-an-id", status: ContinuationActionStatus.Draft } },
    { launch: { attemptId: "a".repeat(64), status: ContinuationActionStatus.Draft } },
    { argv: ["must", "not", "execute"] },
  ])("rejects invalid saved action data %#", (change) => {
    const original = draft()
    const actions = original.actions.map((action, index) => (index === 0 ? { ...action, ...change } : action))
    expect(() => validateContinuationDraft({ ...original, actions })).toThrow(ConversationValidationError)
  })

  it.each([
    { kind: ContinuationPlacementKind.CurrentWorkspacePane, direction: "right" },
    { kind: ContinuationPlacementKind.NewTab },
    { kind: ContinuationPlacementKind.NewWorktree, branch: "next-steps/search", baseRef: "HEAD~1" },
    { kind: ContinuationPlacementKind.ExistingWorktree, path: "/work/second tree" },
  ])("preserves validated prepared placement $kind", (placement) => {
    const original = draft()
    const actions = original.actions.map((action, index) =>
      index === 0
        ? {
            ...action,
            status: ContinuationActionStatus.Prepared,
            prompt: "Review this selected action.",
            placement,
            profileRef: "native:cdx/default",
            workflowId: "review",
            prerequisitesConfirmed: true,
            sharedWriteConfirmed: false,
          }
        : action,
    )
    expect(validateContinuationDraft({ ...original, actions }).actions).toEqual(actions)
  })

  it("validates recovered launch receipts and rejects conflicting or command-bearing receipts", () => {
    const original = draft()
    const launch = {
      attemptId: "7c2a7bfb-6d66-4cbe-a670-63e0c70623c6",
      status: ContinuationActionStatus.Unknown,
      paneId: "workspace-1:pane-2",
      workspaceId: "workspace-1",
      cwd: "/work/search",
      message: "Inspect this pane before retrying.",
    }
    const actions = original.actions.map((action, index) =>
      index === 0
        ? {
            ...action,
            status: ContinuationActionStatus.Unknown,
            launch,
            prompt: "Review search.",
            placement: { kind: ContinuationPlacementKind.NewTab },
          }
        : action,
    )
    expect(validateContinuationDraft({ ...original, actions }).actions).toEqual(actions)
    for (const change of [{ status: ContinuationActionStatus.Launched }, { command: "no" }]) {
      expect(() =>
        validateContinuationDraft({
          ...original,
          actions: actions.map((action, index) =>
            index === 0 ? { ...action, launch: { ...launch, ...change } } : action,
          ),
        }),
      ).toThrow(ConversationValidationError)
    }
  })

  it("does not include private text in validation diagnostics", () => {
    const privateText = "PRIVATE-CONTENT-DO-NOT-REPORT"
    expect(() => validateContinuationDraft({ ...draft(), [privateText]: "anything" })).toThrow(
      /^draft: contains unsupported fields$/u,
    )
  })

  it("rejects a launch attempt identity shared by two different actions", () => {
    const original = draft()
    const actions = original.actions.map((action, index) =>
      index < 2
        ? {
            ...action,
            status: ContinuationActionStatus.Unknown,
            prompt: "Inspect this action; do not resend it.",
            placement: { kind: ContinuationPlacementKind.NewTab },
            launch: {
              attemptId: "7c2a7bfb-6d66-4cbe-a670-63e0c70623c6",
              status: ContinuationActionStatus.Unknown,
            },
          }
        : action,
    )
    expect(() => validateContinuationDraft({ ...original, actions })).toThrow(/attemptId: must contain unique/u)
  })
})
