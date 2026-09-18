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
} from "../src/conversation.ts"
import {
  firstmateSubmissionDigest,
  parseFirstmateSubmissionReceiptV1,
  parseFirstmateSubmissionRequestV1,
  parseGuideProjectTargetV1,
} from "../src/orchestration.ts"
import { parseFirstmateInstanceReferenceV1 } from "../src/firstmate-instances.ts"

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
    { launchOrigin: { schemaVersion: 1 } },
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

  const projectC = () => parseGuideProjectTargetV1({
    schemaVersion: 1,
    projectName: null,
    source: { kind: "local", location: "/work/project-c" },
    entryWorktree: "/work/project-c",
    baseRevision: "c".repeat(40),
    dirty: true,
    dirtyChanges: "excluded",
  })

  const submissionRequest = () => parseFirstmateSubmissionRequestV1({
    schemaVersion: 1,
    requestId: "487921de-3110-44ae-9d7c-060ce10c07e0",
    expectedFleet: {
      profile: "default",
      instanceId: "f5c86f7e-e66d-4bb7-b8e8-f24f9242398b",
      home: "/state/firstmate/default",
      sourceRevision: "b".repeat(40),
    },
    originalIntent: "  Review project C.\r\nDo not merge. 😀  ",
    generatedSpec: "Inspect the committed project C revision and report defects. Do not copy dirty changes.",
    workflowId: "review",
    projectTarget: projectC(),
  })

  const submissionDraft = (
    status = ContinuationActionStatus.Accepted,
    receiptState: "saved" | "handled" | "rejected" | null = "saved",
  ): ContinuationDraft => {
    const original = draft()
    const request = submissionRequest()
    const receipt = receiptState === null ? null : parseFirstmateSubmissionReceiptV1({
      schemaVersion: 1,
      requestId: request.requestId,
      digest: firstmateSubmissionDigest(request),
      fleet: request.expectedFleet,
      state: receiptState,
      noteId: receiptState === "rejected" ? null : "captain-note-1",
      announcement: receiptState === "rejected" ? "not-needed" : "failed",
      supervisorState: "running",
      error: { code: "synthetic-failure", message: "Synthetic control result; work is not verified." },
    })
    return {
      ...original,
      actions: original.actions.map((edit, index) => index > 0 ? edit : {
        ...edit,
        status,
        originalIntent: request.originalIntent,
        prompt: request.generatedSpec,
        projectTarget: request.projectTarget,
        projectTargetConfirmed: true,
        profileRef: "native:fmx/default",
        workflowId: request.workflowId,
        placement: { kind: ContinuationPlacementKind.NewTab },
        firstmateSubmission: { request, receipt },
      }),
    }
  }

  describe("continuation task context persistence", () => {
    it.each([false, true])("round-trips exact intent and proposed/confirmed project C, independent of source A: %s", (confirmed) => {
      const original = draft()
      const intent = "  Human brief.\r\nKeep whitespace and Unicode 😀.\t"
      const contextual = {
        ...original,
        snapshot: { ...original.snapshot, source: { ...original.snapshot.source, cwd: "/work/source-a" } },
        actions: original.actions.map((edit, index) => index > 0 ? edit : {
          ...edit, originalIntent: intent, projectTarget: projectC(), projectTargetConfirmed: confirmed,
        }),
      }
      const loaded = validateContinuationDraft(JSON.parse(JSON.stringify(contextual)))
      expect(loaded).toEqual(contextual)
      expect(loaded.actions[0]?.originalIntent).toBe(intent)
      expect(loaded.actions[0]?.projectTarget?.source?.location).toBe("/work/project-c")
      expect(loaded.actions[0]?.projectTarget).toMatchObject({ dirty: true, dirtyChanges: "excluded", baseRevision: "c".repeat(40) })
    })

    it("preserves old preparations without inventing original intent or target consent", () => {
      const original = draft()
      const actions = original.actions.map((edit) => ({
        ...edit,
        profileRef: "native:fmx/default",
        workflowId: "review",
        status: ContinuationActionStatus.Prepared,
        prompt: "Old saved Firstmate preparation.",
        placement: { kind: ContinuationPlacementKind.NewTab },
      }))
      const loaded = validateContinuationDraft({ ...original, actions })
      expect(loaded.actions).toEqual(actions)
      expect(loaded.actions[0]).not.toHaveProperty("originalIntent")
      expect(loaded.actions[0]).not.toHaveProperty("projectTargetConfirmed")
    })

    it.each([null, parseGuideProjectTargetV1({
      schemaVersion: 1, projectName: "registered-c", source: null, entryWorktree: null,
      baseRevision: null, dirty: null, dirtyChanges: "excluded",
    })])("preserves explicit fleet scope and registered-only targets: %#", (target) => {
      const original = draft()
      const actions = original.actions.map((edit) => ({ ...edit, projectTarget: target, projectTargetConfirmed: true }))
      expect(validateContinuationDraft({ ...original, actions }).actions).toEqual(actions)
    })

    it("accepts the exact 60000 UTF-16-unit original intent limit without trimming", () => {
      const original = draft()
      const originalIntent = ` ${"😀".repeat(29_999)} `
      expect(originalIntent.length).toBe(60_000)
      const actions = original.actions.map((edit) => ({ ...edit, originalIntent }))
      expect(validateContinuationDraft({ ...original, actions }).actions[0]?.originalIntent).toBe(originalIntent)
    })

    it.each([
      { originalIntent: "x".repeat(60_001) },
      { originalIntent: " \n " },
      { originalIntent: "Bad\u0000input" },
      { originalIntent: "\ud800" },
      { projectTargetConfirmed: true },
      { projectTargetConfirmed: "yes", projectTarget: null },
      { projectTarget: { ...projectC(), dirty: null } },
      { projectTarget: { ...projectC(), source: { kind: "local", location: "relative" } } },
      { projectTarget: { ...projectC(), baseRevision: null } },
      { projectTarget: { ...projectC(), dirtyChanges: "copied" } },
      { projectTarget: { ...projectC(), command: "must not execute" } },
    ])("rejects invalid optional context without weakening legacy fields: %#", (change) => {
      const original = draft()
      expect(() => validateContinuationDraft({
        ...original, actions: original.actions.map((edit, index) => index > 0 ? edit : { ...edit, ...change }),
      })).toThrow(ConversationValidationError)
    })

    it("does not evaluate an accessor in shared target data", () => {
      const original = draft()
      const target = projectC()
      Object.defineProperty(target, "source", { enumerable: true, get: () => { throw new Error("must not execute") } })
      expect(() => validateContinuationDraft({
        ...original, actions: original.actions.map((edit) => ({ ...edit, projectTarget: target })),
      })).toThrow(/JSON fields/u)
    })
  })

  describe("continuation Firstmate request and receipt persistence", () => {
    it.each(["named", "legacy"])("persists a per-action %s reference without changing saved authority or source", (mode) => {
      const original = submissionDraft()
      const request = submissionRequest()
      const firstmateInstance = parseFirstmateInstanceReferenceV1({
        schemaVersion: 1, profile: request.expectedFleet.profile, instanceId: request.expectedFleet.instanceId, mode,
      })
      const selected = {
        ...original,
        actions: original.actions.map((edit, index) => index > 0 ? edit : { ...edit, firstmateInstance }),
      }
      const loaded = validateContinuationDraft(JSON.parse(JSON.stringify(selected)))
      expect(loaded).toEqual(selected)
      expect(loaded.snapshot.source).toEqual(original.snapshot.source)
      expect(loaded.actions[0]?.firstmateSubmission).toEqual(original.actions[0]?.firstmateSubmission)
      expect(firstmateSubmissionDigest(loaded.actions[0]!.firstmateSubmission!.request)).toBe(firstmateSubmissionDigest(request))
      expect(validateContinuationDraft(original).actions[0]).not.toHaveProperty("firstmateInstance")
    })

    it("allows instance selection before preparation, but only for the selected static Firstmate profile", () => {
      const original = draft()
      const firstmateInstance = parseFirstmateInstanceReferenceV1({
        schemaVersion: 1, profile: "default", instanceId: submissionRequest().expectedFleet.instanceId, mode: "named",
      })
      const actions = original.actions.map((edit, index) => index > 0 ? edit : {
        ...edit, profileRef: "native:fmx/default", workflowId: "review", firstmateInstance,
      })
      expect(validateContinuationDraft({ ...original, actions }).actions).toEqual(actions)
      for (const profileRef of ["native:fmx/pstack-workers", "native:cdx/default"]) {
        expect(() => validateContinuationDraft({
          ...original, actions: actions.map((edit, index) => index > 0 ? edit : { ...edit, profileRef }),
        })).toThrow(/selected static profile/)
      }
      const inherited = {
        ...original,
        assessment: {
          ...original.assessment!,
          actions: original.assessment!.actions.map((action, index) => index > 0 ? action : { ...action, profileRef: "native:fmx/default" }),
        },
        actions: original.actions.map((edit, index) => index > 0 ? edit : { ...edit, firstmateInstance }),
      }
      expect(validateContinuationDraft(inherited)).toEqual(inherited)
    })

    it.each([
      { instanceId: "aec37eab-d811-4d46-af45-8b6adf3e85c6" },
      { profile: "pstack-workers" },
      { instanceId: null },
      { mode: "automatic" },
      { schemaVersion: 2 },
      { name: "mutable-label" },
    ])("rejects invalid references or conflicts with a saved expectedFleet: %#", (change) => {
      const original = submissionDraft()
      const firstmateInstance = {
        schemaVersion: 1, profile: "default", mode: "named",
        instanceId: submissionRequest().expectedFleet.instanceId, ...change,
      }
      expect(() => validateContinuationDraft({
        ...original,
        actions: original.actions.map((edit, index) => index > 0 ? edit : { ...edit, firstmateInstance }),
      })).toThrow(ConversationValidationError)
    })

    it.each(["start", "recover", "submit"] as const)("round-trips explicit %s approval without creating a pane receipt", (firstmateAction) => {
      const original = submissionDraft(ContinuationActionStatus.Prepared, null)
      const approved = {
        ...original,
        actions: original.actions.map((edit, index) => index > 0 ? edit : { ...edit, firstmateAction }),
      }
      expect(validateContinuationDraft(JSON.parse(JSON.stringify(approved)))).toEqual(approved)
      expect(approved.actions[0]).not.toHaveProperty("launch")
    })

    it("allows send-only preparation without a Herdr placement, but not start or recovery", () => {
      const original = submissionDraft(ContinuationActionStatus.Prepared, null)
      const actions = original.actions.map((edit, index) => {
        if (index > 0) return edit
        const { placement: _placement, ...rest } = edit
        return { ...rest, firstmateAction: "submit" as const }
      })
      expect(validateContinuationDraft({ ...original, actions }).actions).toEqual(actions)
      for (const firstmateAction of ["start", "recover"]) {
        expect(() => validateContinuationDraft({
          ...original,
          actions: actions.map((edit, index) => index > 0 ? edit : { ...edit, firstmateAction }),
        })).toThrow(/destination/u)
      }
    })

    it("keeps frontend delivery diagnostics separate from the native receipt", () => {
      const original = submissionDraft()
      const actions = original.actions.map((edit, index) => index > 0 ? edit : {
        ...edit,
        firstmateAction: "start" as const,
        firstmateDiagnostic: "Supervisor startup failed.\nThe note is saved; no task completion is verified.",
      })
      const loaded = validateContinuationDraft({ ...original, actions })
      expect(loaded.actions).toEqual(actions)
      expect(loaded.actions[0]?.firstmateSubmission).toEqual(original.actions[0]?.firstmateSubmission)
    })

    it.each([
      { firstmateAction: "install" },
      { firstmateAction: "recover", firstmateSubmission: undefined },
      { firstmateDiagnostic: "Diagnostic without a request.", firstmateSubmission: undefined },
      { firstmateAction: "start", status: ContinuationActionStatus.Draft },
      { firstmateDiagnostic: "x".repeat(64_001) },
      { firstmateDiagnostic: "unsafe\u0000text" },
    ])("rejects unsupported or unbound action approval data: %#", (change) => {
      const original = submissionDraft(ContinuationActionStatus.Prepared, null)
      expect(() => validateContinuationDraft({
        ...original,
        actions: original.actions.map((edit, index) => index > 0 ? edit : {
          ...edit, ...change,
        }),
      })).toThrow(ConversationValidationError)
    })

    it.each(["saved", "handled"] as const)("retains %s evidence, including a failed announcement, without calling work completed", (state) => {
      const original = submissionDraft(ContinuationActionStatus.Accepted, state)
      expect(validateContinuationDraft(JSON.parse(JSON.stringify(original)))).toEqual(original)
      expect(original.actions[0]?.status).toBe("accepted")
      expect(original.actions[0]?.firstmateSubmission?.receipt?.announcement).toBe("failed")
    })

    it.each([ContinuationActionStatus.Submitting, ContinuationActionStatus.SubmissionUnknown])("keeps the immutable request for %s without inventing a receipt", (status) => {
      const original = submissionDraft(status, null)
      expect(validateContinuationDraft(original)).toEqual(original)
      const actions = original.actions.map(({ firstmateSubmission: _submission, ...edit }) => edit)
      expect(() => validateContinuationDraft({ ...original, actions })).toThrow(/saved Firstmate submission/u)
    })

    it.each([null, "rejected"] as const)("supports a rejected control result with receipt %s", (receipt) => {
      const original = submissionDraft(ContinuationActionStatus.SubmissionRejected, receipt)
      expect(validateContinuationDraft(original)).toEqual(original)
    })

    it("requires accepted evidence and rejects false rejection or mutable receipt states", () => {
      expect(() => validateContinuationDraft(submissionDraft(ContinuationActionStatus.Accepted, null))).toThrow(/saved or handled/u)
      expect(() => validateContinuationDraft(submissionDraft(ContinuationActionStatus.Accepted, "rejected"))).toThrow(/saved or handled/u)
      expect(() => validateContinuationDraft(submissionDraft(ContinuationActionStatus.SubmissionRejected, "saved"))).toThrow(/rejected receipt/u)
      expect(() => validateContinuationDraft(submissionDraft(ContinuationActionStatus.Prepared, "saved"))).toThrow(/submission status/u)
      expect(validateContinuationDraft(submissionDraft(ContinuationActionStatus.Prepared, null)).actions[0]?.firstmateSubmission?.receipt).toBeNull()
    })

    it.each([
      { requestId: "aec37eab-d811-4d46-af45-8b6adf3e85c6" },
      { digest: "f".repeat(64) },
      { fleet: { ...submissionRequest().expectedFleet, instanceId: "aec37eab-d811-4d46-af45-8b6adf3e85c6" } },
      { fleet: { ...submissionRequest().expectedFleet, home: "/state/another-fleet" } },
    ])("rejects a receipt not bound to the saved request: %#", (change) => {
      const original = submissionDraft()
      const actions = original.actions.map((edit, index) => index > 0 ? edit : {
        ...edit, firstmateSubmission: {
          request: edit.firstmateSubmission!.request,
          receipt: { ...edit.firstmateSubmission!.receipt, ...change },
        },
      })
      expect(() => validateContinuationDraft({ ...original, actions })).toThrow(/same request ID, digest, and fleet/u)
    })

    it.each([
      { originalIntent: "Changed captain brief" },
      { prompt: "Changed generated specification" },
      { workflowId: "another-workflow" },
      { profileRef: "native:fmx/pstack-workers" },
      { projectTarget: null },
      { projectTargetConfirmed: false },
    ])("rejects persisted action content which contradicts its payload: %#", (change) => {
      const original = submissionDraft()
      expect(() => validateContinuationDraft({
        ...original, actions: original.actions.map((edit, index) => index > 0 ? edit : { ...edit, ...change }),
      })).toThrow(ConversationValidationError)
    })

    it("does not let sibling actions share a request ID", () => {
      const original = submissionDraft()
      const actions = original.actions.map((edit, index) => index !== 1 ? edit : { ...original.actions[0]!, actionId: edit.actionId })
      expect(() => validateContinuationDraft({ ...original, actions })).toThrow(/requestId: must contain unique/u)
    })
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
