export enum ConversationSurface {
  Host = "host",
  Native = "native",
  Sandbox = "sandbox",
}

export enum ConversationAgent {
  Copilot = "copilot",
  Codex = "codex",
  Claude = "claude",
}

export enum ConversationRole {
  User = "user",
  Assistant = "assistant",
}

export interface ConversationSource {
  readonly serverId: string
  readonly surface: ConversationSurface
  readonly agent: ConversationAgent
  readonly sessionId: string
  readonly workspaceId: string
  readonly paneId: string
  readonly cwd: string
  readonly tabId?: string
  readonly profile?: string
  readonly containerId?: string
  readonly invocationId?: string
}

export interface ConversationMessage {
  readonly id: string
  readonly role: ConversationRole
  readonly text: string
  readonly recordIndex: number
}

export interface ConversationSnapshot {
  readonly schemaVersion: 1
  readonly id: string
  readonly source: ConversationSource
  readonly capturedAt: string
  readonly cutoff: { readonly messageId: string; readonly recordIndex: number }
  readonly revision: string
  readonly messages: ReadonlyArray<ConversationMessage>
  readonly coverage: { readonly complete: boolean; readonly notices: ReadonlyArray<string> }
}

export enum ContinuationOutcome {
  Recommendations = "recommendations",
  NeedsClarification = "needs-clarification",
  NoFurtherAction = "no-further-action",
}

export enum ActionImportance {
  Required = "required",
  Optional = "optional",
}

export enum ActionAccess {
  ReadOnly = "read-only",
  Write = "write",
  Unknown = "unknown",
}

export interface NextAction {
  readonly id: string
  readonly rank: number
  readonly title: string
  readonly brief: string
  readonly whyNow: string
  readonly expectedOutput: string
  readonly evidenceIds: ReadonlyArray<string>
  readonly importance: ActionImportance
  readonly profileRef: string
  readonly workflowId: string
  readonly dependsOn: ReadonlyArray<string>
  readonly access: ActionAccess
}

export interface ContinuationAssessment {
  readonly schemaVersion: 1
  readonly outcome: ContinuationOutcome
  readonly goal: string
  readonly reportedProgress: ReadonlyArray<string>
  readonly unresolvedWork: ReadonlyArray<string>
  readonly blockers: ReadonlyArray<string>
  readonly actions: ReadonlyArray<NextAction>
  readonly questions: ReadonlyArray<string>
}

export interface ConversationSummary {
  readonly key: string
  readonly text: string
  readonly evidenceIds: ReadonlyArray<string>
}

export enum ContinuationPlacementKind {
  CurrentWorkspacePane = "current-workspace-pane",
  NewTab = "new-tab",
  NewWorktree = "new-worktree",
  ExistingWorktree = "existing-worktree",
}

export type ContinuationPlacement =
  | { readonly kind: ContinuationPlacementKind.CurrentWorkspacePane; readonly direction: "right" | "down" }
  | { readonly kind: ContinuationPlacementKind.NewTab }
  | { readonly kind: ContinuationPlacementKind.NewWorktree; readonly branch: string; readonly baseRef: string }
  | { readonly kind: ContinuationPlacementKind.ExistingWorktree; readonly path: string }

export enum ContinuationActionStatus {
  Draft = "draft",
  Prepared = "prepared",
  Waiting = "waiting",
  Launching = "launching",
  Launched = "launched",
  Failed = "failed",
  Unknown = "unknown",
}

export interface ContinuationLaunchReceipt {
  readonly attemptId: string
  readonly status: ContinuationActionStatus
  readonly paneId?: string
  readonly workspaceId?: string
  readonly cwd?: string
  readonly message?: string
}

export interface ContinuationPromptCandidate {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly notes: string
}

export interface ContinuationActionDraft {
  readonly actionId: string
  readonly brief: string
  readonly selected: boolean
  readonly status: ContinuationActionStatus
  readonly prompt?: string
  readonly candidates?: ReadonlyArray<ContinuationPromptCandidate>
  /** The explicitly chosen candidate origin, retained after outgoing prompt edits. */
  readonly selectedCandidateId?: string
  readonly profileRef?: string
  readonly workflowId?: string
  readonly placement?: ContinuationPlacement
  readonly prerequisitesConfirmed?: boolean
  readonly sharedWriteConfirmed?: boolean
  readonly uncommittedChangesConfirmed?: boolean
  readonly launch?: ContinuationLaunchReceipt
}

export interface ContinuationDraft {
  readonly schemaVersion: 1
  readonly id: string
  readonly revision: number
  readonly snapshot: ConversationSnapshot
  readonly model: string
  readonly effort: string
  readonly summaries: ReadonlyArray<ConversationSummary>
  readonly assessment?: ContinuationAssessment
  readonly actions: ReadonlyArray<ContinuationActionDraft>
}

export const conversationLimits = Object.freeze({
  snapshotBytes: 64 * 1024 * 1024,
  draftBytes: 80 * 1024 * 1024,
  messageBytes: 4 * 1024 * 1024,
  messageCount: 100_000,
  identifierChars: 256,
  pathChars: 4096,
  actionCount: 5,
  briefChars: 16_000,
  promptChars: 64_000,
  promptCandidateCount: 3,
  promptCandidateTitleChars: 200,
  promptCandidateNotesChars: 1000,
  summaryCount: 512,
  summaryChars: 16_000,
  evidenceCount: 100_000,
  noticeCount: 64,
  noticeChars: 2000,
  journalBytes: 8 * 1024 * 1024,
  journalEventBytes: 8192,
})

export class ConversationValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`)
    this.name = "ConversationValidationError"
  }
}

const invalid = (field: string, message: string): never => {
  throw new ConversationValidationError(field, message)
}

const controls = /(?![\t\r\n])\p{Cc}/u
const singleLineControls = /\p{Cc}/u
const loneSurrogates = /[\ud800-\udfff]/u
const opaqueIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u
const kebabPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const digestPattern = /^[0-9a-f]{64}$/u
const profilePattern =
  /^(?:native:[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*|sandbox:[a-z0-9]+(?:-[a-z0-9]+)*)$/u

const object = (
  value: unknown,
  field: string,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(field, "must be an object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return invalid(field, "must be a plain object")
  const allowed = new Set([...required, ...optional])
  const fields: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) return invalid(field, "contains unsupported fields")
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value") || descriptor.value === undefined) {
      return invalid(field, "must contain only defined JSON fields")
    }
    fields[key] = descriptor.value
  }
  if (required.some((key) => !Object.hasOwn(fields, key))) return invalid(field, "is missing required fields")
  return fields
}

const array = (value: unknown, field: string, maximum: number, minimum = 0): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) return invalid(field, "must be an array")
  if (Object.getPrototypeOf(value) !== Array.prototype) return invalid(field, "must be a plain JSON array")
  if (value.length < minimum || value.length > maximum) {
    return invalid(field, `must contain between ${minimum} and ${maximum} entries`)
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) return invalid(field, "must be a dense JSON array")
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      return invalid(field, "must be a dense JSON array")
    }
  }
  return value
}

const string = (value: unknown, field: string, maximum: number, multiline = false): string => {
  if (typeof value !== "string" || value.trim().length === 0) return invalid(field, "must be non-empty text")
  if (value.length > maximum) return invalid(field, `must contain at most ${maximum} characters`)
  if ((multiline ? controls : singleLineControls).test(value) || loneSurrogates.test(value)) {
    return invalid(field, "must contain valid Unicode without control characters")
  }
  return value
}

const identifier = (value: unknown, field: string): string => {
  const result = string(value, field, conversationLimits.identifierChars)
  if (!identityPattern.test(result)) return invalid(field, "must be a portable identifier")
  return result
}

const opaqueId = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !opaqueIdPattern.test(value)) return invalid(field, "must be an opaque UUID")
  return value
}

const digest = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !digestPattern.test(value))
    return invalid(field, "must be a lowercase SHA-256 digest")
  return value
}

const boolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") return invalid(field, "must be a boolean")
  return value
}

const integer = (value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    return invalid(field, "must be a non-negative safe integer within the limit")
  }
  return value
}

const enumeration = <T extends string>(value: unknown, field: string, members: ReadonlyArray<T>): T => {
  for (const member of members) {
    if (value === member) return member
  }
  return invalid(field, "contains an unsupported enum value")
}

const absolutePath = (value: unknown, field: string): string => {
  const result = string(value, field, conversationLimits.pathChars)
  if (!path.posix.isAbsolute(result) || result.split("/").includes("..")) {
    return invalid(field, "must be an absolute path without parent traversal")
  }
  return result
}

const profileRef = (value: unknown, field: string): string => {
  const result = string(value, field, conversationLimits.identifierChars)
  if (!profilePattern.test(result)) return invalid(field, "must be a native or Sandbox profile reference")
  return result
}

const workflowId = (value: unknown, field: string): string => {
  const result = string(value, field, 128)
  if (!kebabPattern.test(result)) return invalid(field, "must be a lowercase kebab-case identifier")
  return result
}

const unique = (values: ReadonlyArray<string>, field: string): void => {
  if (new Set(values).size !== values.length) invalid(field, "must contain unique entries")
}

const strings = (
  value: unknown,
  field: string,
  maximum: number = conversationLimits.noticeCount,
  itemMaximum: number = conversationLimits.noticeChars,
): ReadonlyArray<string> => {
  const result = array(value, field, maximum).map((item, index) =>
    string(item, `${field}[${index}]`, itemMaximum, true),
  )
  unique(result, field)
  return result
}

const identifiers = (value: unknown, field: string, maximum: number, minimum = 0): ReadonlyArray<string> => {
  const result = array(value, field, maximum, minimum).map((item, index) => identifier(item, `${field}[${index}]`))
  unique(result, field)
  return result
}

const evidence = (value: unknown, field: string, messages: ReadonlySet<string>): ReadonlyArray<string> => {
  const result = identifiers(value, field, conversationLimits.evidenceCount, 1)
  if (result.some((id) => !messages.has(id))) invalid(field, "references a message outside the snapshot")
  return result
}

const serializedSize = (value: object, field: string, maximum: number): void => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum) {
    invalid(field, `must contain at most ${maximum} serialized UTF-8 bytes`)
  }
}

const timestamp = (value: unknown, field: string): string => {
  const result = string(value, field, 64)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(result)) {
    return invalid(field, "must be an ISO-8601 UTC timestamp")
  }
  const parsed = new Date(result)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== result.slice(0, 19)) {
    return invalid(field, "must be a valid timestamp")
  }
  return result
}

const validateSourceAttachment = (
  surface: ConversationSurface,
  profile: string | undefined,
  containerId: string | undefined,
  invocationId: string | undefined,
): void => {
  const field = "source"
  if (surface !== ConversationSurface.Host && profile === undefined)
    invalid(field, "requires a profile on this surface")
  if (surface === ConversationSurface.Sandbox && (containerId === undefined || invocationId === undefined)) {
    invalid(field, "requires exact container and invocation identities for Sandbox")
  }
  if (surface !== ConversationSurface.Sandbox && (containerId !== undefined || invocationId !== undefined)) {
    invalid(field, "contains Sandbox identities on a non-Sandbox surface")
  }
  if (surface === ConversationSurface.Host && profile !== undefined)
    invalid(field, "contains a profile on the host surface")
}

export const validateConversationSource = (value: unknown): ConversationSource => {
  const field = "source"
  const fields = object(
    value,
    field,
    ["serverId", "surface", "agent", "sessionId", "workspaceId", "paneId", "cwd"],
    ["tabId", "profile", "containerId", "invocationId"],
  )
  const surface = enumeration(fields.surface, `${field}.surface`, Object.values(ConversationSurface))
  const profile = fields.profile === undefined ? undefined : workflowId(fields.profile, `${field}.profile`)
  const containerId =
    fields.containerId === undefined ? undefined : identifier(fields.containerId, `${field}.containerId`)
  const invocationId =
    fields.invocationId === undefined ? undefined : identifier(fields.invocationId, `${field}.invocationId`)
  validateSourceAttachment(surface, profile, containerId, invocationId)
  return {
    serverId: identifier(fields.serverId, `${field}.serverId`),
    surface,
    agent: enumeration(fields.agent, `${field}.agent`, Object.values(ConversationAgent)),
    sessionId: identifier(fields.sessionId, `${field}.sessionId`),
    workspaceId: identifier(fields.workspaceId, `${field}.workspaceId`),
    paneId: identifier(fields.paneId, `${field}.paneId`),
    cwd: absolutePath(fields.cwd, `${field}.cwd`),
    ...(fields.tabId === undefined ? {} : { tabId: identifier(fields.tabId, `${field}.tabId`) }),
    ...(profile === undefined ? {} : { profile }),
    ...(containerId === undefined ? {} : { containerId }),
    ...(invocationId === undefined ? {} : { invocationId }),
  }
}

/** Identity is not a cwd lookup: every bound pane, session, and surface field participates. */
export const conversationSourceKey = (source: ConversationSource): string =>
  createHash("sha256")
    .update(JSON.stringify(validateConversationSource(source)), "utf8")
    .digest("hex")

export const validateConversationSnapshot = (value: unknown): ConversationSnapshot => {
  const field = "snapshot"
  const fields = object(value, field, [
    "schemaVersion",
    "id",
    "source",
    "capturedAt",
    "cutoff",
    "revision",
    "messages",
    "coverage",
  ])
  if (fields.schemaVersion !== 1) invalid(`${field}.schemaVersion`, "must equal 1")
  let textBytes = 0
  const messages = array(fields.messages, `${field}.messages`, conversationLimits.messageCount, 1).map(
    (item, index): ConversationMessage => {
      const itemField = `${field}.messages[${index}]`
      const message = object(item, itemField, ["id", "role", "text", "recordIndex"])
      const text = string(message.text, `${itemField}.text`, conversationLimits.messageBytes, true)
      const size = Buffer.byteLength(text, "utf8")
      if (size > conversationLimits.messageBytes) invalid(`${itemField}.text`, "exceeds the message UTF-8 byte limit")
      textBytes += size
      if (textBytes > conversationLimits.snapshotBytes) invalid(field, "exceeds the snapshot byte limit")
      return {
        id: identifier(message.id, `${itemField}.id`),
        role: enumeration(message.role, `${itemField}.role`, Object.values(ConversationRole)),
        text,
        recordIndex: integer(message.recordIndex, `${itemField}.recordIndex`),
      }
    },
  )
  unique(
    messages.map(({ id }) => id),
    `${field}.messages`,
  )
  for (let index = 1; index < messages.length; index += 1) {
    if (messages[index]!.recordIndex <= messages[index - 1]!.recordIndex) {
      invalid(`${field}.messages`, "record indexes must be strictly increasing")
    }
  }
  const rawCutoff = object(fields.cutoff, `${field}.cutoff`, ["messageId", "recordIndex"])
  const cutoff = {
    messageId: identifier(rawCutoff.messageId, `${field}.cutoff.messageId`),
    recordIndex: integer(rawCutoff.recordIndex, `${field}.cutoff.recordIndex`),
  }
  const last = messages[messages.length - 1]!
  if (
    last.role !== ConversationRole.Assistant ||
    last.id !== cutoff.messageId ||
    last.recordIndex !== cutoff.recordIndex
  ) {
    invalid(`${field}.cutoff`, "must match the last completed assistant message")
  }
  const rawCoverage = object(fields.coverage, `${field}.coverage`, ["complete", "notices"])
  const coverage = {
    complete: boolean(rawCoverage.complete, `${field}.coverage.complete`),
    notices: strings(rawCoverage.notices, `${field}.coverage.notices`),
  }
  if (!coverage.complete && coverage.notices.length === 0) invalid(`${field}.coverage`, "must disclose missing history")
  const snapshot: ConversationSnapshot = {
    schemaVersion: 1,
    id: opaqueId(fields.id, `${field}.id`),
    source: validateConversationSource(fields.source),
    capturedAt: timestamp(fields.capturedAt, `${field}.capturedAt`),
    cutoff,
    revision: digest(fields.revision, `${field}.revision`),
    messages,
    coverage,
  }
  serializedSize(snapshot, field, conversationLimits.snapshotBytes)
  return snapshot
}

const validateDependencies = (actions: ReadonlyArray<NextAction>): void => {
  const byId = new Map(actions.map((action) => [action.id, action]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) invalid("assessment.actions", "dependencies must not contain a cycle")
    if (visited.has(id)) return
    const action = byId.get(id)
    if (action === undefined) return invalid("assessment.actions", "dependency references an unknown action")
    visiting.add(id)
    for (const dependency of action.dependsOn) {
      if (dependency === id) invalid("assessment.actions", "actions must not depend on themselves")
      visit(dependency)
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const action of actions) visit(action.id)
}

const assessment = (
  value: unknown,
  snapshot: ConversationSnapshot,
  catalogRefs?: ReadonlyMap<string, ReadonlySet<string>>,
): ContinuationAssessment => {
  const field = "assessment"
  const fields = object(value, field, [
    "schemaVersion",
    "outcome",
    "goal",
    "reportedProgress",
    "unresolvedWork",
    "blockers",
    "actions",
    "questions",
  ])
  if (fields.schemaVersion !== 1) invalid(`${field}.schemaVersion`, "must equal 1")
  const outcome = enumeration(fields.outcome, `${field}.outcome`, Object.values(ContinuationOutcome))
  const messageIds = new Set(snapshot.messages.map(({ id }) => id))
  const actions = array(fields.actions, `${field}.actions`, conversationLimits.actionCount).map(
    (item, index): NextAction => {
      const itemField = `${field}.actions[${index}]`
      const action = object(item, itemField, [
        "id",
        "rank",
        "title",
        "brief",
        "whyNow",
        "expectedOutput",
        "evidenceIds",
        "importance",
        "profileRef",
        "workflowId",
        "dependsOn",
        "access",
      ])
      const profile = profileRef(action.profileRef, `${itemField}.profileRef`)
      const workflow = workflowId(action.workflowId, `${itemField}.workflowId`)
      if (catalogRefs !== undefined && !catalogRefs.get(profile)?.has(workflow)) {
        invalid(itemField, "profile or workflow is not in the supplied catalog")
      }
      const rank = integer(action.rank, `${itemField}.rank`, conversationLimits.actionCount)
      if (rank !== index + 1) invalid(`${itemField}.rank`, "must follow ranked order from 1 to 5")
      return {
        id: identifier(action.id, `${itemField}.id`),
        rank,
        title: string(action.title, `${itemField}.title`, 200),
        brief: string(action.brief, `${itemField}.brief`, conversationLimits.briefChars, true),
        whyNow: string(action.whyNow, `${itemField}.whyNow`, 4000, true),
        expectedOutput: string(action.expectedOutput, `${itemField}.expectedOutput`, 4000, true),
        evidenceIds: evidence(action.evidenceIds, `${itemField}.evidenceIds`, messageIds),
        importance: enumeration(action.importance, `${itemField}.importance`, Object.values(ActionImportance)),
        profileRef: profile,
        workflowId: workflow,
        dependsOn: identifiers(action.dependsOn, `${itemField}.dependsOn`, conversationLimits.actionCount - 1),
        access: enumeration(action.access, `${itemField}.access`, Object.values(ActionAccess)),
      }
    },
  )
  const normalized = (text: string): string => text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase()
  unique(
    actions.map(({ id }) => id),
    `${field}.actions`,
  )
  unique(
    actions.map(({ title }) => normalized(title)),
    `${field}.actions.title`,
  )
  unique(
    actions.map(({ brief }) => normalized(brief)),
    `${field}.actions.brief`,
  )
  validateDependencies(actions)
  const questions = strings(fields.questions, `${field}.questions`, 16)
  if (outcome === ContinuationOutcome.Recommendations && actions.length !== conversationLimits.actionCount) {
    invalid(`${field}.actions`, "recommendations must contain exactly five actions")
  }
  if (outcome !== ContinuationOutcome.Recommendations && actions.length !== 0) {
    invalid(`${field}.actions`, "clarification and no-action outcomes must not contain actions")
  }
  if (outcome === ContinuationOutcome.NeedsClarification && questions.length === 0) {
    invalid(`${field}.questions`, "clarification requires at least one question")
  }
  if (outcome === ContinuationOutcome.NoFurtherAction && questions.length !== 0) {
    invalid(`${field}.questions`, "no-action outcomes must not contain unresolved questions")
  }
  return {
    schemaVersion: 1,
    outcome,
    goal: string(fields.goal, `${field}.goal`, 4000, true),
    reportedProgress: strings(fields.reportedProgress, `${field}.reportedProgress`),
    unresolvedWork: strings(fields.unresolvedWork, `${field}.unresolvedWork`),
    blockers: strings(fields.blockers, `${field}.blockers`),
    actions,
    questions,
  }
}

export const validateContinuationAssessment = (
  value: unknown,
  snapshot: ConversationSnapshot,
  catalogRefs: ReadonlyMap<string, ReadonlySet<string>>,
): ContinuationAssessment => {
  if (catalogRefs === undefined || catalogRefs === null || typeof catalogRefs.get !== "function") {
    return invalid("assessment.catalog", "requires an explicit profile and workflow catalog")
  }
  return assessment(value, validateConversationSnapshot(snapshot), catalogRefs)
}

enum PaneDirection {
  Right = "right",
  Down = "down",
}

const gitRef = (value: unknown, field: string, revision = false): string => {
  const result = string(value, field, conversationLimits.identifierChars)
  const pattern = revision ? /^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/u : /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u
  if (
    !pattern.test(result) ||
    result.includes("..") ||
    result.includes("//") ||
    result.endsWith("/") ||
    result.endsWith(".") ||
    result.split("/").some((part) => part.endsWith(".lock"))
  ) {
    return invalid(field, "must be a safe Git reference")
  }
  return result
}

const placement = (value: unknown, field: string): ContinuationPlacement => {
  const fields = object(value, field, ["kind"], ["direction", "branch", "baseRef", "path"])
  const kind = enumeration(fields.kind, `${field}.kind`, Object.values(ContinuationPlacementKind))
  switch (kind) {
    case ContinuationPlacementKind.CurrentWorkspacePane:
      object(value, field, ["kind", "direction"])
      return { kind, direction: enumeration(fields.direction, `${field}.direction`, Object.values(PaneDirection)) }
    case ContinuationPlacementKind.NewTab:
      object(value, field, ["kind"])
      return { kind }
    case ContinuationPlacementKind.NewWorktree:
      object(value, field, ["kind", "branch", "baseRef"])
      return {
        kind,
        branch: gitRef(fields.branch, `${field}.branch`),
        baseRef: gitRef(fields.baseRef, `${field}.baseRef`, true),
      }
    case ContinuationPlacementKind.ExistingWorktree:
      object(value, field, ["kind", "path"])
      return { kind, path: absolutePath(fields.path, `${field}.path`) }
  }
}

const launchReceipt = (value: unknown, field: string): ContinuationLaunchReceipt => {
  const fields = object(value, field, ["attemptId", "status"], ["paneId", "workspaceId", "cwd", "message"])
  return {
    attemptId: opaqueId(fields.attemptId, `${field}.attemptId`),
    status: enumeration(fields.status, `${field}.status`, Object.values(ContinuationActionStatus)),
    ...(fields.paneId === undefined ? {} : { paneId: identifier(fields.paneId, `${field}.paneId`) }),
    ...(fields.workspaceId === undefined
      ? {}
      : { workspaceId: identifier(fields.workspaceId, `${field}.workspaceId`) }),
    ...(fields.cwd === undefined ? {} : { cwd: absolutePath(fields.cwd, `${field}.cwd`) }),
    ...(fields.message === undefined ? {} : { message: string(fields.message, `${field}.message`, 4000, true) }),
  }
}

const validateActionPreparation = (
  fields: Record<string, unknown>,
  field: string,
  status: ContinuationActionStatus,
  launch: ContinuationLaunchReceipt | undefined,
  prompt: string | undefined,
): void => {
  if (launch !== undefined && launch.status !== status) invalid(`${field}.launch`, "status must match the action")
  const inFlight =
    status === ContinuationActionStatus.Launching ||
    status === ContinuationActionStatus.Launched ||
    status === ContinuationActionStatus.Unknown
  if (inFlight && launch === undefined) invalid(field, "requires a saved launch attempt")
  if ((fields.profileRef === undefined) !== (fields.workflowId === undefined)) {
    invalid(field, "profile and workflow overrides must be provided together")
  }
  if (
    (inFlight || status === ContinuationActionStatus.Prepared) &&
    (prompt === undefined || fields.placement === undefined)
  ) {
    invalid(field, "requires a prepared prompt and destination")
  }
}

const candidateText = (value: unknown, field: string, maximum: number, multiline = false): string => {
  const result = string(value, field, maximum * 2, multiline)
  if ([...result].length > maximum) invalid(field, `must contain at most ${maximum} characters`)
  return result
}

const promptCandidates = (value: unknown, field: string): ReadonlyArray<ContinuationPromptCandidate> => {
  const candidates = array(
    value,
    field,
    conversationLimits.promptCandidateCount,
    conversationLimits.promptCandidateCount,
  ).map((item, index): ContinuationPromptCandidate => {
    const itemField = `${field}[${index}]`
    const fields = object(item, itemField, ["id", "title", "prompt", "notes"])
    return {
      id: identifier(fields.id, `${itemField}.id`),
      title: candidateText(fields.title, `${itemField}.title`, conversationLimits.promptCandidateTitleChars),
      prompt: string(fields.prompt, `${itemField}.prompt`, conversationLimits.promptChars, true),
      notes: candidateText(fields.notes, `${itemField}.notes`, conversationLimits.promptCandidateNotesChars, true),
    }
  })
  unique(
    candidates.map(({ id }) => id),
    `${field}.id`,
  )
  unique(
    candidates.map(({ prompt }) => prompt.trim()),
    `${field}.prompt`,
  )
  return candidates
}

const validateSelectedCandidate = (
  candidates: ReadonlyArray<ContinuationPromptCandidate> | undefined,
  selectedCandidateId: string,
  status: ContinuationActionStatus,
  prompt: string | undefined,
  field: string,
): void => {
  const selected = candidates?.find(({ id }) => id === selectedCandidateId)
  if (selected === undefined) {
    return invalid(`${field}.selectedCandidateId`, "must reference one of this action's saved candidates")
  }
  if (prompt === undefined || status === ContinuationActionStatus.Draft) {
    invalid(`${field}.selectedCandidateId`, "requires an explicitly prepared outgoing prompt")
  }
}

const actionCandidateFields = (
  fields: Record<string, unknown>,
  field: string,
  status: ContinuationActionStatus,
  prompt: string | undefined,
): Pick<ContinuationActionDraft, "candidates" | "selectedCandidateId"> => {
  const candidates =
    fields.candidates === undefined ? undefined : promptCandidates(fields.candidates, `${field}.candidates`)
  const selectedCandidateId =
    fields.selectedCandidateId === undefined
      ? undefined
      : identifier(fields.selectedCandidateId, `${field}.selectedCandidateId`)
  if (selectedCandidateId !== undefined) {
    validateSelectedCandidate(candidates, selectedCandidateId, status, prompt, field)
  }
  if (candidates !== undefined && status === ContinuationActionStatus.Draft && prompt !== undefined) {
    invalid(`${field}.prompt`, "must remain absent until a saved candidate is explicitly chosen")
  }
  if (candidates !== undefined && prompt !== undefined && selectedCandidateId === undefined) {
    invalid(`${field}.selectedCandidateId`, "is required for an outgoing prompt with saved candidates")
  }
  return {
    ...(candidates === undefined ? {} : { candidates }),
    ...(selectedCandidateId === undefined ? {} : { selectedCandidateId }),
  }
}

const actionConfirmations = (
  fields: Record<string, unknown>,
  field: string,
): Pick<
  ContinuationActionDraft,
  "prerequisitesConfirmed" | "sharedWriteConfirmed" | "uncommittedChangesConfirmed"
> => ({
  ...(fields.prerequisitesConfirmed === undefined
    ? {}
    : {
        prerequisitesConfirmed: boolean(fields.prerequisitesConfirmed, `${field}.prerequisitesConfirmed`),
      }),
  ...(fields.sharedWriteConfirmed === undefined
    ? {}
    : {
        sharedWriteConfirmed: boolean(fields.sharedWriteConfirmed, `${field}.sharedWriteConfirmed`),
      }),
  ...(fields.uncommittedChangesConfirmed === undefined
    ? {}
    : {
        uncommittedChangesConfirmed: boolean(
          fields.uncommittedChangesConfirmed,
          `${field}.uncommittedChangesConfirmed`,
        ),
      }),
})

const actionDraft = (value: unknown, field: string): ContinuationActionDraft => {
  const fields = object(
    value,
    field,
    ["actionId", "brief", "selected", "status"],
    [
      "prompt",
      "candidates",
      "selectedCandidateId",
      "profileRef",
      "workflowId",
      "placement",
      "prerequisitesConfirmed",
      "sharedWriteConfirmed",
      "uncommittedChangesConfirmed",
      "launch",
    ],
  )
  const status = enumeration(fields.status, `${field}.status`, Object.values(ContinuationActionStatus))
  const launch = fields.launch === undefined ? undefined : launchReceipt(fields.launch, `${field}.launch`)
  const prompt =
    fields.prompt === undefined
      ? undefined
      : string(fields.prompt, `${field}.prompt`, conversationLimits.promptChars, true)
  validateActionPreparation(fields, field, status, launch, prompt)
  return {
    actionId: identifier(fields.actionId, `${field}.actionId`),
    brief: string(fields.brief, `${field}.brief`, conversationLimits.briefChars, true),
    selected: boolean(fields.selected, `${field}.selected`),
    status,
    ...(prompt === undefined ? {} : { prompt }),
    ...actionCandidateFields(fields, field, status, prompt),
    ...(fields.profileRef === undefined ? {} : { profileRef: profileRef(fields.profileRef, `${field}.profileRef`) }),
    ...(fields.workflowId === undefined ? {} : { workflowId: workflowId(fields.workflowId, `${field}.workflowId`) }),
    ...(fields.placement === undefined ? {} : { placement: placement(fields.placement, `${field}.placement`) }),
    ...actionConfirmations(fields, field),
    ...(launch === undefined ? {} : { launch }),
  }
}

export const validateContinuationDraft = (value: unknown): ContinuationDraft => {
  const field = "draft"
  const fields = object(
    value,
    field,
    ["schemaVersion", "id", "revision", "snapshot", "model", "effort", "summaries", "actions"],
    ["assessment"],
  )
  if (fields.schemaVersion !== 1) invalid(`${field}.schemaVersion`, "must equal 1")
  const snapshot = validateConversationSnapshot(fields.snapshot)
  const messageIds = new Set(snapshot.messages.map(({ id }) => id))
  const summaries = array(fields.summaries, `${field}.summaries`, conversationLimits.summaryCount).map(
    (item, index): ConversationSummary => {
      const itemField = `${field}.summaries[${index}]`
      const summary = object(item, itemField, ["key", "text", "evidenceIds"])
      return {
        key: identifier(summary.key, `${itemField}.key`),
        text: string(summary.text, `${itemField}.text`, conversationLimits.summaryChars, true),
        evidenceIds: evidence(summary.evidenceIds, `${itemField}.evidenceIds`, messageIds),
      }
    },
  )
  unique(
    summaries.map(({ key }) => key),
    `${field}.summaries`,
  )
  const parsedAssessment = fields.assessment === undefined ? undefined : assessment(fields.assessment, snapshot)
  const actions = array(fields.actions, `${field}.actions`, conversationLimits.actionCount).map((item, index) =>
    actionDraft(item, `${field}.actions[${index}]`),
  )
  unique(
    actions.map(({ actionId }) => actionId),
    `${field}.actions`,
  )
  unique(
    actions.flatMap(({ launch }) => (launch === undefined ? [] : [launch.attemptId])),
    `${field}.actions.launch.attemptId`,
  )
  const actionIds = new Set(parsedAssessment?.actions.map(({ id }) => id) ?? [])
  if (actions.length !== actionIds.size || actions.some(({ actionId }) => !actionIds.has(actionId))) {
    invalid(`${field}.actions`, "must match the assessment's action IDs exactly")
  }
  const draft: ContinuationDraft = {
    schemaVersion: 1,
    id: opaqueId(fields.id, `${field}.id`),
    revision: integer(fields.revision, `${field}.revision`),
    snapshot,
    model: identifier(fields.model, `${field}.model`),
    effort: identifier(fields.effort, `${field}.effort`),
    summaries,
    ...(parsedAssessment === undefined ? {} : { assessment: parsedAssessment }),
    actions,
  }
  serializedSize(draft, field, conversationLimits.draftBytes)
  return draft
}
import { createHash } from "node:crypto"
import path from "node:path"
