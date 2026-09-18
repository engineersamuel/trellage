import {
  absolutePath, boolean, canonicalDigest, canonicalJson, choice, exactKeys, exactText,
  fail, hex, identifier, integer, record, uuid as requestId, version,
} from "./validation.ts"

export const FIRSTMATE_MAX_REQUEST_BYTES = 512 * 1024
export const FIRSTMATE_MAX_RESPONSE_BYTES = 64 * 1024
export const GUIDE_MAX_ORIGINAL_INTENT = 60_000
export const GUIDE_MAX_GENERATED_SPEC = 8_000
export const FIRSTMATE_WORKER_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
export type FirstmateWorkerEffort = (typeof FIRSTMATE_WORKER_EFFORTS)[number]
export type FirstmateSupervisorState = "running" | "stopped" | "stale" | "unsafe"

export interface FirstmateOrchestrationV1 {
  readonly schemaVersion: 1
  readonly kind: "firstmate"
  readonly sourceRevision: string
  readonly taskIdPrefix: string
  readonly workerPolicy: { readonly name: string; readonly digest: string } | null
  readonly workerHarness: "claude"
  readonly workerEfforts: ReadonlyArray<FirstmateWorkerEffort>
  readonly dispatchRules: "claude-single"
  readonly submission: { readonly schemaVersion: 1; readonly maxRequestBytes: number }
  readonly preparation?: { readonly schemaVersion: 1 }
  readonly instances?: { readonly schemaVersion: 1 }
}

export interface GuideProjectTargetV1 {
  readonly schemaVersion: 1
  readonly projectName: string | null
  readonly source: { readonly kind: "local" | "git"; readonly location: string } | null
  readonly entryWorktree: string | null
  readonly baseRevision: string | null
  readonly dirty: boolean | null
  readonly dirtyChanges: "excluded"
}

export interface FirstmateFleetIdentityV1 {
  readonly profile: string
  readonly instanceId: string
  readonly home: string
  readonly sourceRevision: string
}

export interface FirstmateActionPermissionV1 {
  readonly allowed: boolean
  readonly reason: string | null
}

export interface FirstmatePrerequisiteInstallPlanV1 {
  readonly identity: string
  readonly destination: string
  readonly tools: ReadonlyArray<{ readonly name: string; readonly version: string }>
  readonly sources: ReadonlyArray<string>
  readonly statePaths: ReadonlyArray<string>
}

export interface FirstmatePreparationV1 {
  readonly schemaVersion: 1
  readonly state: "ready" | "repairable" | "needs-consent" | "blocked"
  readonly diagnostic: string | null
  readonly repairs: ReadonlyArray<string>
  readonly installation: FirstmatePrerequisiteInstallPlanV1 | null
}

export interface FirstmateFleetReadinessV1 {
  readonly schemaVersion: 1
  readonly identity: FirstmateFleetIdentityV1 | null
  readonly runtime: "ready" | "missing" | "drift" | "unsafe" | "busy"
  readonly backend: "herdr" | "tmux" | null
  readonly supervisor: {
    readonly state: FirstmateSupervisorState
    readonly pid: number | null
  }
  readonly activeWorkers: number
  readonly prerequisites: ReadonlyArray<{
    readonly id: string
    readonly ready: boolean
    readonly description: string
    readonly status?: "ready" | "blocked" | "not-checked"
  }>
  readonly consentRequired: boolean
  readonly actions: {
    readonly start: FirstmateActionPermissionV1
    readonly recover: FirstmateActionPermissionV1
    readonly submit: FirstmateActionPermissionV1
  }
  readonly preparation?: FirstmatePreparationV1
}

export interface FirstmateSubmissionRequestV1 {
  readonly schemaVersion: 1
  readonly requestId: string
  readonly expectedFleet: FirstmateFleetIdentityV1
  readonly originalIntent: string
  readonly generatedSpec: string
  readonly workflowId: string
  readonly projectTarget: GuideProjectTargetV1 | null
}

export interface FirstmateReceiptRequestV1 {
  readonly schemaVersion: 1
  readonly requestId: string
  readonly expectedFleet: FirstmateFleetIdentityV1
}

export interface FirstmateSubmissionReceiptV1 {
  readonly schemaVersion: 1
  readonly requestId: string
  readonly digest: string | null
  readonly fleet: FirstmateFleetIdentityV1 | null
  readonly state: "saved" | "handled" | "not-found" | "rejected"
  readonly noteId: string | null
  readonly announcement: "sent" | "pending" | "failed" | "not-needed"
  readonly supervisorState: FirstmateSupervisorState
  readonly error: { readonly code: string; readonly message: string } | null
}

const registeredProjectName = (value: unknown, field: string): string => {
  const result = exactText(value, field, 128)
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u.test(result)) {
    fail(field, "must be a safe project basename without whitespace or path separators")
  }
  return result
}

export const parseFirstmateOrchestrationV1 = (
  value: unknown,
  field = "orchestration",
): FirstmateOrchestrationV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, [
    "schemaVersion", "kind", "sourceRevision", "taskIdPrefix", "workerPolicy",
    "workerHarness", "workerEfforts", "dispatchRules", "submission",
  ], ["preparation", "instances"])
  version(fields, field)
  const workerPolicy = fields.workerPolicy === null ? null : record(fields.workerPolicy, `${field}.workerPolicy`)
  if (workerPolicy !== null) exactKeys(workerPolicy, `${field}.workerPolicy`, ["name", "digest"])
  if (!Array.isArray(fields.workerEfforts) || fields.workerEfforts.length === 0 || fields.workerEfforts.length > 5) {
    return fail(`${field}.workerEfforts`, "must contain supported Claude efforts")
  }
  const workerEfforts = fields.workerEfforts.map((effort, index) =>
    choice(effort, `${field}.workerEfforts[${index}]`, FIRSTMATE_WORKER_EFFORTS),
  )
  if (new Set(workerEfforts).size !== workerEfforts.length) fail(`${field}.workerEfforts`, "must contain unique efforts")
  const submission = record(fields.submission, `${field}.submission`)
  exactKeys(submission, `${field}.submission`, ["schemaVersion", "maxRequestBytes"])
  version(submission, `${field}.submission`)
  if (fields.preparation !== undefined) {
    const preparation = record(fields.preparation, `${field}.preparation`)
    exactKeys(preparation, `${field}.preparation`, ["schemaVersion"])
    version(preparation, `${field}.preparation`)
  }
  if (fields.instances !== undefined) {
    const instances = record(fields.instances, `${field}.instances`)
    exactKeys(instances, `${field}.instances`, ["schemaVersion"])
    version(instances, `${field}.instances`)
  }
  return {
    schemaVersion: 1,
    kind: choice(fields.kind, `${field}.kind`, ["firstmate"]),
    sourceRevision: hex(fields.sourceRevision, `${field}.sourceRevision`, [40]),
    taskIdPrefix: identifier(fields.taskIdPrefix, `${field}.taskIdPrefix`),
    workerPolicy: workerPolicy === null ? null : {
      name: identifier(workerPolicy.name, `${field}.workerPolicy.name`),
      digest: hex(workerPolicy.digest, `${field}.workerPolicy.digest`, [64]),
    },
    workerHarness: choice(fields.workerHarness, `${field}.workerHarness`, ["claude"]),
    workerEfforts,
    dispatchRules: choice(fields.dispatchRules, `${field}.dispatchRules`, ["claude-single"]),
    submission: {
      schemaVersion: 1,
      maxRequestBytes: integer(submission.maxRequestBytes, `${field}.submission.maxRequestBytes`, 1024, FIRSTMATE_MAX_REQUEST_BYTES),
    },
    ...(fields.preparation === undefined ? {} : { preparation: { schemaVersion: 1 as const } }),
    ...(fields.instances === undefined ? {} : { instances: { schemaVersion: 1 as const } }),
  }
}

const gitSourceUrl = (location: string, field: string): URL => {
  try {
    return new URL(location)
  } catch (cause) {
    if (cause instanceof TypeError) return fail(field, "must be an HTTPS or SSH Git source")
    throw cause
  }
}

const validateGitSource = (location: string, field: string): void => {
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/u.test(location)) return
  const url = gitSourceUrl(location, field)
  if (url.protocol !== "https:" && url.protocol !== "ssh:") fail(field, "must use HTTPS or SSH")
  if (url.password || (url.protocol === "https:" && url.username)) {
    fail(field, "must not contain credentials")
  }
  if (url.search || url.hash || !url.hostname || url.pathname === "/") {
    fail(field, "must identify a Git repository without query or fragment data")
  }
}

const projectSource = (value: unknown, field: string): GuideProjectTargetV1["source"] => {
  if (value === null) return null
  const fields = record(value, field)
  exactKeys(fields, field, ["kind", "location"])
  const kind = choice(fields.kind, `${field}.kind`, ["local", "git"])
  const location = kind === "local"
    ? absolutePath(fields.location, `${field}.location`)
    : exactText(fields.location, `${field}.location`, 4096)
  if (kind === "git") validateGitSource(location, `${field}.location`)
  return { kind, location }
}

const validateProjectInspection = (target: GuideProjectTargetV1, field: string): void => {
  if (target.projectName === null && target.source === null) {
    fail(field, "requires a registered project name or an explicit source")
  }
  if (target.source !== null && target.baseRevision === null) {
    fail(`${field}.baseRevision`, "must be resolved for an explicit source")
  }
  if (target.source?.kind === "local" && (target.entryWorktree === null || target.dirty === null)) {
    fail(field, "local targets require an entry worktree and inspected dirty state")
  }
  if (target.source === null && (target.entryWorktree !== null || target.baseRevision !== null || target.dirty !== null)) {
    fail(field, "Git inspection fields require an explicit source")
  }
}

export const parseGuideProjectTargetV1 = (value: unknown, field = "projectTarget"): GuideProjectTargetV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, [
    "schemaVersion", "projectName", "source", "entryWorktree", "baseRevision", "dirty", "dirtyChanges",
  ])
  version(fields, field)
  const result: GuideProjectTargetV1 = {
    schemaVersion: 1,
    projectName: fields.projectName === null ? null : registeredProjectName(fields.projectName, `${field}.projectName`),
    source: projectSource(fields.source, `${field}.source`),
    entryWorktree: fields.entryWorktree === null ? null : absolutePath(fields.entryWorktree, `${field}.entryWorktree`),
    baseRevision: fields.baseRevision === null ? null : hex(fields.baseRevision, `${field}.baseRevision`, [40, 64]),
    dirty: fields.dirty === null ? null : boolean(fields.dirty, `${field}.dirty`),
    dirtyChanges: choice(fields.dirtyChanges, `${field}.dirtyChanges`, ["excluded"]),
  }
  validateProjectInspection(result, field)
  return result
}

export const parseFirstmateFleetIdentityV1 = (value: unknown, field = "fleet"): FirstmateFleetIdentityV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, ["profile", "instanceId", "home", "sourceRevision"])
  return {
    profile: identifier(fields.profile, `${field}.profile`),
    instanceId: requestId(fields.instanceId, `${field}.instanceId`),
    home: absolutePath(fields.home, `${field}.home`),
    sourceRevision: hex(fields.sourceRevision, `${field}.sourceRevision`, [40]),
  }
}

const permission = (value: unknown, field: string): FirstmateActionPermissionV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, ["allowed", "reason"])
  const allowed = boolean(fields.allowed, `${field}.allowed`)
  const reason = fields.reason === null ? null : exactText(fields.reason, `${field}.reason`, 2000)
  if (!allowed && reason === null) fail(`${field}.reason`, "is required when the action is not allowed")
  return { allowed, reason }
}

const fleetPrerequisites = (value: unknown, field: string): FirstmateFleetReadinessV1["prerequisites"] => {
  if (!Array.isArray(value) || value.length > 32) {
    return fail(field, "must be an array of at most 32 prerequisites")
  }
  const prerequisites = value.map((item, index) => {
    const key = `${field}[${index}]`
    const prerequisite = record(item, key)
    exactKeys(prerequisite, key, ["id", "ready", "description"], ["status"])
    const ready = boolean(prerequisite.ready, `${key}.ready`)
    const status = prerequisite.status === undefined
      ? undefined
      : choice(prerequisite.status, `${key}.status`, ["ready", "blocked", "not-checked"])
    if (status !== undefined && ready !== (status === "ready")) {
      fail(`${key}.status`, "must agree with prerequisite readiness")
    }
    return {
      id: identifier(prerequisite.id, `${key}.id`),
      ready,
      description: exactText(prerequisite.description, `${key}.description`, 2000),
      ...(status === undefined ? {} : { status }),
    }
  })
  if (new Set(prerequisites.map(({ id }) => id)).size !== prerequisites.length) {
    fail(field, "must contain unique prerequisite IDs")
  }
  return prerequisites
}

const preparationList = <T>(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  parse: (entry: unknown, key: string) => T,
): ReadonlyArray<T> => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    return fail(field, `must be an array of ${minimum} to ${maximum} entries`)
  }
  return value.map((entry, index) => parse(entry, `${field}[${index}]`))
}

export const parseFirstmatePrerequisiteInstallPlanV1 = (
  value: unknown,
  field = "installation",
): FirstmatePrerequisiteInstallPlanV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, ["identity", "destination", "tools", "sources", "statePaths"])
  const tools = preparationList(fields.tools, `${field}.tools`, 1, 16, (entry, key) => {
    const tool = record(entry, key)
    exactKeys(tool, key, ["name", "version"])
    return {
      name: identifier(tool.name, `${key}.name`),
      version: exactText(tool.version, `${key}.version`, 128),
    }
  })
  if (new Set(tools.map(({ name }) => name)).size !== tools.length) {
    fail(`${field}.tools`, "must contain unique tool names")
  }
  return {
    identity: hex(fields.identity, `${field}.identity`, [64]),
    destination: absolutePath(fields.destination, `${field}.destination`),
    tools,
    sources: preparationList(fields.sources, `${field}.sources`, 1, 8, (entry, key) => exactText(entry, key, 2000)),
    statePaths: preparationList(fields.statePaths, `${field}.statePaths`, 0, 8, absolutePath),
  }
}

export const parseFirstmatePreparationV1 = (
  value: unknown,
  field = "preparation",
): FirstmatePreparationV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, ["schemaVersion", "state", "diagnostic", "repairs", "installation"])
  version(fields, field)
  const state = choice(fields.state, `${field}.state`, ["ready", "repairable", "needs-consent", "blocked"])
  const diagnostic = fields.diagnostic === null ? null : exactText(fields.diagnostic, `${field}.diagnostic`, 4000, true)
  const installation = fields.installation === null
    ? null
    : parseFirstmatePrerequisiteInstallPlanV1(fields.installation, `${field}.installation`)
  if (state !== "ready" && diagnostic === null) fail(`${field}.diagnostic`, "is required when preparation is not ready")
  if (state === "needs-consent" && installation === null) fail(`${field}.installation`, "is required for installation consent")
  if (state === "ready" && installation !== null) fail(`${field}.installation`, "must be null when preparation is ready")
  return {
    schemaVersion: 1,
    state,
    diagnostic,
    repairs: preparationList(fields.repairs, `${field}.repairs`, 0, 16, (entry, key) => exactText(entry, key, 512)),
    installation,
  }
}

const validateFleetAdmission = (result: FirstmateFleetReadinessV1, field: string): void => {
  const anyAllowed = Object.values(result.actions).some(({ allowed }) => allowed)
  if (anyAllowed && (result.identity === null || result.runtime !== "ready" || result.supervisor.state === "unsafe")) {
    fail(`${field}.actions`, "require a ready owned runtime and safe supervisor state")
  }
  if ((result.actions.start.allowed || result.actions.recover.allowed) &&
      (result.backend === null || result.consentRequired || result.prerequisites.some(({ ready }) => !ready))) {
    fail(`${field}.actions`, "start and recovery require a backend, ready prerequisites, and prior consent")
  }
}

const validateSupervisorAdmission = (result: FirstmateFleetReadinessV1, field: string): void => {
  if (result.supervisor.state === "running" && (result.actions.start.allowed || result.actions.recover.allowed)) {
    fail(`${field}.actions`, "must not admit another running supervisor")
  }
  if (result.activeWorkers > 0 && result.actions.start.allowed) {
    fail(`${field}.actions.start`, "live workers require recovery instead of a fresh start")
  }
  if (result.supervisor.state === "running" && result.supervisor.pid === null) {
    fail(`${field}.supervisor.pid`, "is required for a running supervisor")
  }
}

export const parseFirstmateFleetReadinessV1 = (value: unknown, field = "fleet"): FirstmateFleetReadinessV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, [
    "schemaVersion", "identity", "runtime", "backend", "supervisor", "activeWorkers",
    "prerequisites", "consentRequired", "actions",
  ], ["preparation"])
  version(fields, field)
  const supervisor = record(fields.supervisor, `${field}.supervisor`)
  exactKeys(supervisor, `${field}.supervisor`, ["state", "pid"])
  const actions = record(fields.actions, `${field}.actions`)
  exactKeys(actions, `${field}.actions`, ["start", "recover", "submit"])
  const result: FirstmateFleetReadinessV1 = {
    schemaVersion: 1,
    identity: fields.identity === null ? null : parseFirstmateFleetIdentityV1(fields.identity, `${field}.identity`),
    runtime: choice(fields.runtime, `${field}.runtime`, ["ready", "missing", "drift", "unsafe", "busy"]),
    backend: fields.backend === null ? null : choice(fields.backend, `${field}.backend`, ["herdr", "tmux"] as const),
    supervisor: {
      state: choice(supervisor.state, `${field}.supervisor.state`, ["running", "stopped", "stale", "unsafe"]),
      pid: supervisor.pid === null ? null : integer(supervisor.pid, `${field}.supervisor.pid`, 1, 2_147_483_647),
    },
    activeWorkers: integer(fields.activeWorkers, `${field}.activeWorkers`, 0, 1_000_000),
    prerequisites: fleetPrerequisites(fields.prerequisites, `${field}.prerequisites`),
    consentRequired: boolean(fields.consentRequired, `${field}.consentRequired`),
    actions: {
      start: permission(actions.start, `${field}.actions.start`),
      recover: permission(actions.recover, `${field}.actions.recover`),
      submit: permission(actions.submit, `${field}.actions.submit`),
    },
    ...(fields.preparation === undefined
      ? {}
      : { preparation: parseFirstmatePreparationV1(fields.preparation, `${field}.preparation`) }),
  }
  validateFleetAdmission(result, field)
  validateSupervisorAdmission(result, field)
  return result
}

export const parseFirstmateSubmissionRequestV1 = (
  value: unknown,
  field = "submission",
): FirstmateSubmissionRequestV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, [
    "schemaVersion", "requestId", "expectedFleet", "originalIntent", "generatedSpec", "workflowId", "projectTarget",
  ])
  version(fields, field)
  const result: FirstmateSubmissionRequestV1 = {
    schemaVersion: 1,
    requestId: requestId(fields.requestId, `${field}.requestId`),
    expectedFleet: parseFirstmateFleetIdentityV1(fields.expectedFleet, `${field}.expectedFleet`),
    originalIntent: exactText(fields.originalIntent, `${field}.originalIntent`, GUIDE_MAX_ORIGINAL_INTENT, true),
    generatedSpec: exactText(fields.generatedSpec, `${field}.generatedSpec`, GUIDE_MAX_GENERATED_SPEC, true),
    workflowId: identifier(fields.workflowId, `${field}.workflowId`),
    projectTarget: fields.projectTarget === null ? null : parseGuideProjectTargetV1(fields.projectTarget, `${field}.projectTarget`),
  }
  if (Buffer.byteLength(canonicalFirstmateJson(result), "utf8") > FIRSTMATE_MAX_REQUEST_BYTES) {
    fail(field, `must contain at most ${FIRSTMATE_MAX_REQUEST_BYTES} serialized bytes`)
  }
  return result
}

export const parseFirstmateReceiptRequestV1 = (value: unknown, field = "receipt request"): FirstmateReceiptRequestV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, ["schemaVersion", "requestId", "expectedFleet"])
  version(fields, field)
  return {
    schemaVersion: 1,
    requestId: requestId(fields.requestId, `${field}.requestId`),
    expectedFleet: parseFirstmateFleetIdentityV1(fields.expectedFleet, `${field}.expectedFleet`),
  }
}

const validateReceiptEvidence = (result: FirstmateSubmissionReceiptV1, field: string): void => {
  if ((result.state === "saved" || result.state === "handled") &&
      (result.digest === null || result.fleet === null || result.noteId === null)) {
    fail(field, "saved and handled receipts require digest, fleet, and note ID evidence")
  }
  if ((result.state === "not-found" || result.state === "rejected") && result.noteId !== null) {
    fail(`${field}.noteId`, "must be null when no accepted note is reported")
  }
  if ((result.state === "rejected" || result.announcement === "failed") && result.error === null) {
    fail(`${field}.error`, "must explain rejection or announcement failure")
  }
}

export const parseFirstmateSubmissionReceiptV1 = (
  value: unknown,
  field = "receipt",
): FirstmateSubmissionReceiptV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, [
    "schemaVersion", "requestId", "digest", "fleet", "state", "noteId",
    "announcement", "supervisorState", "error",
  ])
  version(fields, field)
  const error = fields.error === null ? null : record(fields.error, `${field}.error`)
  if (error !== null) exactKeys(error, `${field}.error`, ["code", "message"])
  const result: FirstmateSubmissionReceiptV1 = {
    schemaVersion: 1,
    requestId: requestId(fields.requestId, `${field}.requestId`),
    digest: fields.digest === null ? null : hex(fields.digest, `${field}.digest`, [64]),
    fleet: fields.fleet === null ? null : parseFirstmateFleetIdentityV1(fields.fleet, `${field}.fleet`),
    state: choice(fields.state, `${field}.state`, ["saved", "handled", "not-found", "rejected"]),
    noteId: fields.noteId === null ? null : exactText(fields.noteId, `${field}.noteId`, 128),
    announcement: choice(fields.announcement, `${field}.announcement`, ["sent", "pending", "failed", "not-needed"]),
    supervisorState: choice(fields.supervisorState, `${field}.supervisorState`, ["running", "stopped", "stale", "unsafe"]),
    error: error === null ? null : {
      code: identifier(error.code, `${field}.error.code`),
      message: exactText(error.message, `${field}.error.message`, 4096, true),
    },
  }
  validateReceiptEvidence(result, field)
  return result
}

export const canonicalFirstmateJson = (value: FirstmateSubmissionRequestV1 | FirstmateReceiptRequestV1): string =>
  canonicalJson(value)

export const firstmateSubmissionDigest = (request: FirstmateSubmissionRequestV1): string =>
  canonicalDigest(request)

export const sameFirstmateFleet = (left: FirstmateFleetIdentityV1, right: FirstmateFleetIdentityV1): boolean =>
  left.profile === right.profile && left.instanceId === right.instanceId &&
  left.home === right.home && left.sourceRevision === right.sourceRevision
