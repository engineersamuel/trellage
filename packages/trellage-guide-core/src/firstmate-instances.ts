import path from "node:path"
import type { FirstmateFleetIdentityV1 } from "./orchestration.ts"
import {
  absolutePath, canonicalDigest, canonicalJson, choice, exactKeys, exactText, fail,
  hex, identifier, identityPart, integer, record, uuid, version,
} from "./validation.ts"

export const firstmateInstanceLimits = Object.freeze({
  envelopeBytes: 64 * 1024,
  nameChars: 64,
  pathChars: 4096,
  decimalDigits: 40,
  diagnosticCount: 16,
  diagnosticChars: 2000,
  pageItems: 32,
  registryItems: 1_000_000,
  cursorChars: 80,
  taskIdChars: 64,
  taskSuffixChars: 55,
})

export const firstmateInstanceCli = Object.freeze({
  selector: "--instance",
  context: "--fmx-instance-context-json",
  expectedFleet: "--fmx-expected-fleet-json",
  expectedSourceRevision: "--expected-source-revision",
  approveCreation: "--approve-creation",
  cursor: "--cursor",
  limit: "--limit",
  expectedBindingDigest: "--expected-binding-digest",
  confirm: "--confirm",
})

export const FIRSTMATE_INSTANCE_DIAGNOSTIC_CODES = [
  "worktree-missing", "worktree-replaced", "worktree-moved", "generation-unavailable",
  "ambiguous-worktree", "name-conflict", "worktree-conflict", "namespace-conflict",
  "source-mismatch", "runtime-missing", "runtime-drift", "missing-identity",
  "unsafe-state", "upgrade-required", "bootstrap-required", "busy", "stale-plan",
  "creation-incomplete", "not-found", "approval-mismatch", "stale-cursor",
] as const

export type FirstmateInstanceDiagnosticCode = (typeof FIRSTMATE_INSTANCE_DIAGNOSTIC_CODES)[number]

export interface FirstmateInstanceDiagnosticV1 {
  readonly code: FirstmateInstanceDiagnosticCode
  readonly message: string
}

/** Names, homes, worktree paths, and readiness are not request authority. */
export interface FirstmateInstanceReferenceV1 {
  readonly schemaVersion: 1
  readonly profile: string
  readonly mode: "named" | "legacy"
  readonly instanceId: string
}

export type FirstmateNamedInstanceReferenceV1 = FirstmateInstanceReferenceV1 & { readonly mode: "named" }
export type FirstmateLegacyInstanceReferenceV1 = FirstmateInstanceReferenceV1 & { readonly mode: "legacy" }

export interface FirstmateRuntimeVariantV1 {
  readonly schemaVersion: 1
  readonly variant: "firstmate-instance-v1"
  readonly sourceRevision: string
  readonly baseManifestDigest: string
  readonly supplementManifestDigest: string
  readonly effectiveContentDigest: string
}

/** Unsigned decimal strings without leading zeros. Birth time must be positive and reliable. */
export interface FirstmateFilesystemGenerationV1 {
  readonly device: string
  readonly inode: string
  readonly birthtimeNs: string
}

export interface FirstmateWorktreeGenerationV1 {
  readonly schemaVersion: 1
  readonly kind: "stat-birthtime-v1"
  readonly worktree: FirstmateFilesystemGenerationV1
  readonly privateGitDir: FirstmateFilesystemGenerationV1
  readonly commonGitDir: FirstmateFilesystemGenerationV1
}

export interface FirstmateWorktreeEvidenceV1 {
  readonly schemaVersion: 1
  readonly locators: {
    readonly worktree: string
    readonly privateGitDir: string
    readonly commonGitDir: string
  }
  readonly generation: FirstmateWorktreeGenerationV1
  /** SHA-256 of canonical generation, excluding all locators, HEAD, branch, and dirty state. */
  readonly generationDigest: string
}

export interface FirstmateBoundWorktreeV1 {
  readonly status: "bound" | "missing" | "moved" | "replaced" | "unverifiable"
  /** Retained binding evidence, including when its locators no longer resolve. */
  readonly evidence: FirstmateWorktreeEvidenceV1
}

export interface FirstmateNamedRuntimeEvidenceV1 {
  readonly state: "verified" | "missing" | "drift" | "unsafe"
  /** Required integrity, not a claim that a missing or changed runtime has been verified. */
  readonly required: FirstmateRuntimeVariantV1
}

interface FirstmateInstanceDescriptorBaseV1 {
  readonly schemaVersion: 1
  readonly profile: string
  readonly root: string
  readonly taskIdPrefix: string
  readonly diagnostics: ReadonlyArray<FirstmateInstanceDiagnosticV1>
}

export interface FirstmateNamedInstanceDescriptorV1 extends FirstmateInstanceDescriptorBaseV1 {
  readonly mode: "named"
  readonly name: string
  readonly reference: FirstmateNamedInstanceReferenceV1
  readonly creationState: "creating" | "published" | "incomplete" | "missing-identity" | "unsafe"
  readonly worktree: FirstmateBoundWorktreeV1
  readonly runtime: FirstmateNamedRuntimeEvidenceV1
}

export interface FirstmateLegacyInstanceDescriptorV1 extends FirstmateInstanceDescriptorBaseV1 {
  readonly mode: "legacy"
  readonly name: "legacy"
  readonly reference: FirstmateLegacyInstanceReferenceV1 | null
  readonly creationState: "published" | "missing-identity"
  readonly worktree: { readonly status: "unbound"; readonly evidence: null }
  readonly runtime: { readonly state: "legacy" }
}

export type FirstmateInstanceDescriptorV1 =
  | FirstmateNamedInstanceDescriptorV1
  | FirstmateLegacyInstanceDescriptorV1

export interface FirstmateInstanceListCursorV1 {
  readonly schemaVersion: 1
  readonly snapshotDigest: string
  readonly offset: number
}

interface FirstmateInstanceResultBaseV1 {
  readonly schemaVersion: 1
  readonly profile: string
  readonly diagnostics: ReadonlyArray<FirstmateInstanceDiagnosticV1>
}

/** Pages are ordered legacy first, then by UUID. A null nextCursor means end, not a full list. */
export type FirstmateInstanceListResultV1 = FirstmateInstanceResultBaseV1 & (
  | {
    readonly state: "page"
    readonly instances: ReadonlyArray<FirstmateInstanceDescriptorV1>
    readonly page: {
      /** SHA-256 of canonical {schemaVersion:1, profile, instances: ALL ordered descriptors}. */
      readonly snapshotDigest: string
      readonly offset: number
      readonly total: number
      /** v1.<snapshotDigest>.<next decimal offset>; the snapshot must include the profile. */
      readonly nextCursor: string | null
    }
  }
  | {
    readonly state: "blocked" | "stale-cursor"
    readonly instances: readonly []
    readonly page: null
  }
)

export type FirstmateInstanceResolveResultV1 = FirstmateInstanceResultBaseV1 & (
  | {
    readonly state: "matched"
    readonly worktree: FirstmateWorktreeEvidenceV1
    readonly descriptor: FirstmateNamedInstanceDescriptorV1
  }
  | {
    readonly state: "not-found"
    readonly worktree: FirstmateWorktreeEvidenceV1
    readonly descriptor: null
  }
  | {
    readonly state: "blocked"
    readonly worktree: FirstmateWorktreeEvidenceV1 | null
    readonly descriptor: null
  }
)

export interface FirstmateInstanceCreationPlanBodyV1 {
  readonly schemaVersion: 1
  readonly reference: FirstmateNamedInstanceReferenceV1
  readonly name: string
  readonly sourceRevision: string
  readonly taskIdPrefix: string
  readonly destination: string
  readonly worktree: FirstmateWorktreeEvidenceV1
  readonly runtimeRequirements: FirstmateRuntimeVariantV1
  /** Exactly these two owned subtrees, in this order; no package/cache or repository writes. */
  readonly permittedWrites: readonly [
    { readonly kind: "instance-root"; readonly path: string },
    { readonly kind: "registry-locks"; readonly path: string },
  ]
}

/** Planning supplies this whole object. Consent is a separate matching --approve-creation value. */
export interface FirstmateInstanceCreationPlanV1 extends FirstmateInstanceCreationPlanBodyV1 {
  readonly approvalDigest: string
}

export type FirstmateInstancePlanResultV1 = FirstmateInstanceResultBaseV1 & (
  | { readonly state: "ready"; readonly plan: FirstmateInstanceCreationPlanV1 }
  | { readonly state: "blocked"; readonly plan: null }
)

export type FirstmateInstanceCreateResultV1 = {
  readonly schemaVersion: 1
  readonly reference: FirstmateNamedInstanceReferenceV1
  readonly approvalDigest: string
  readonly diagnostics: ReadonlyArray<FirstmateInstanceDiagnosticV1>
} & (
  | { readonly state: "created" | "existing"; readonly descriptor: FirstmateNamedInstanceDescriptorV1 }
  | { readonly state: "blocked" | "incomplete"; readonly descriptor: FirstmateNamedInstanceDescriptorV1 | null }
)

/** Also used for FMX_LAUNCH_PROVENANCE_JSON. Native must revalidate it against owned state.
 * It is not a task target, package-install consent, or a substitute for a saved fleet identity.
 * Receipt lookup uses only the instance selector and unchanged V1 receipt request.
 */
export interface FirstmateInstanceControlContextV1 {
  readonly schemaVersion: 1
  readonly reference: FirstmateInstanceReferenceV1
  readonly expectedBindingDigest: string | null
  readonly expectedRuntimeDigest: string | null
  readonly entryWorktree: FirstmateWorktreeEvidenceV1 | null
  readonly selection: "entry-match" | "confirmed-join"
}

const bounded = <T>(value: T, field: string): T => {
  if (Buffer.byteLength(canonicalJson(value), "utf8") > firstmateInstanceLimits.envelopeBytes) {
    fail(field, `must contain at most ${firstmateInstanceLimits.envelopeBytes} serialized bytes`)
  }
  return value
}

const envelopeJson = (value: string, field: string): unknown => {
  if (typeof value !== "string") return fail(field, "must be a JSON string")
  if (Buffer.byteLength(value, "utf8") > firstmateInstanceLimits.envelopeBytes) {
    fail(field, `must contain at most ${firstmateInstanceLimits.envelopeBytes} input bytes`)
  }
  try {
    return JSON.parse(value)
  } catch (error) {
    if (error instanceof SyntaxError) return fail(field, "must contain valid JSON")
    throw error
  }
}

const canonicalPath = (value: unknown, field: string): string => {
  const result = absolutePath(value, field)
  if (path.normalize(result) !== result || (result !== path.parse(result).root && result.endsWith(path.sep))) {
    fail(field, "must be a canonical absolute locator without dot components or a trailing separator")
  }
  return result
}

const entries = <T>(
  value: unknown, field: string, minimum: number, maximum: number, parse: (value: unknown, field: string) => T,
): ReadonlyArray<T> => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    return fail(field, `must contain ${minimum} to ${maximum} entries`)
  }
  return value.map((entry, index) => parse(entry, `${field}[${index}]`))
}

const diagnostics = (value: unknown, field: string, required = false): ReadonlyArray<FirstmateInstanceDiagnosticV1> =>
  entries(value, field, required ? 1 : 0, firstmateInstanceLimits.diagnosticCount, (value, field) => {
    const fields = record(value, field)
    exactKeys(fields, field, ["code", "message"])
    return {
      code: choice(fields.code, `${field}.code`, FIRSTMATE_INSTANCE_DIAGNOSTIC_CODES),
      message: exactText(fields.message, `${field}.message`, firstmateInstanceLimits.diagnosticChars, true),
    }
  })

const requireDiagnostic = (
  values: ReadonlyArray<FirstmateInstanceDiagnosticV1>, code: FirstmateInstanceDiagnosticCode, field: string,
): void => {
  if (!values.some((diagnostic) => diagnostic.code === code)) fail(field, `requires a ${code} diagnostic`)
}

export const parseFirstmateInstanceName = (value: unknown, field = "instance name"): string => {
  const name = exactText(value, field, firstmateInstanceLimits.nameChars)
  if (!identityPart.test(name)) fail(field, "must be a lowercase kebab-case identifier")
  if (name === "legacy" || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(name)) {
    fail(field, "must not be legacy or a UUID-shaped alias")
  }
  return name
}

export const parseFirstmateInstanceTaskIdPrefix = (value: unknown, field = "taskIdPrefix"): string => {
  const prefix = exactText(value, field, 8)
  if (!/^fi[a-f0-9]{6}$/u.test(prefix)) fail(field, "must be fi followed by six lowercase hexadecimal characters")
  return prefix
}

export const parseFirstmateInstanceReferenceV1 = (
  value: unknown, field = "instance reference",
): FirstmateInstanceReferenceV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, ["schemaVersion", "profile", "mode", "instanceId"])
  version(fields, field)
  return {
    schemaVersion: 1,
    profile: identifier(fields.profile, `${field}.profile`),
    mode: choice(fields.mode, `${field}.mode`, ["named", "legacy"]),
    instanceId: uuid(fields.instanceId, `${field}.instanceId`),
  }
}

const namedReference = (value: unknown, field: string): FirstmateNamedInstanceReferenceV1 => {
  const reference = parseFirstmateInstanceReferenceV1(value, field)
  if (reference.mode !== "named") return fail(`${field}.mode`, "must equal named")
  return { ...reference, mode: "named" }
}

export const sameFirstmateInstance = (
  left: FirstmateInstanceReferenceV1, right: FirstmateInstanceReferenceV1,
): boolean => left.profile === right.profile && left.mode === right.mode && left.instanceId === right.instanceId

/** Mode/home/source/runtime conflicts within this key must be rejected, not split into another group. */
export const firstmateInstanceKey = (reference: FirstmateInstanceReferenceV1): string =>
  `native:fmx/${reference.profile}:${reference.instanceId}`

export const validateFirstmateInstanceFleet = (
  reference: FirstmateInstanceReferenceV1, fleet: FirstmateFleetIdentityV1, field = "instance reference",
): void => {
  if (reference.profile !== fleet.profile || reference.instanceId !== fleet.instanceId) {
    fail(field, "must agree with the saved fleet profile and UUID")
  }
}

export const parseFirstmateRuntimeVariantV1 = (
  value: unknown, field = "runtime variant",
): FirstmateRuntimeVariantV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, [
    "schemaVersion", "variant", "sourceRevision", "baseManifestDigest", "supplementManifestDigest", "effectiveContentDigest",
  ])
  version(fields, field)
  return {
    schemaVersion: 1,
    variant: choice(fields.variant, `${field}.variant`, ["firstmate-instance-v1"]),
    sourceRevision: hex(fields.sourceRevision, `${field}.sourceRevision`, [40]),
    baseManifestDigest: hex(fields.baseManifestDigest, `${field}.baseManifestDigest`, [64]),
    supplementManifestDigest: hex(fields.supplementManifestDigest, `${field}.supplementManifestDigest`, [64]),
    effectiveContentDigest: hex(fields.effectiveContentDigest, `${field}.effectiveContentDigest`, [64]),
  }
}

export const firstmateRuntimeVariantDigest = (runtime: FirstmateRuntimeVariantV1): string =>
  canonicalDigest(parseFirstmateRuntimeVariantV1(runtime))

const decimal = (value: unknown, field: string, positive = false): string => {
  const result = exactText(value, field, firstmateInstanceLimits.decimalDigits)
  if (!/^(?:0|[1-9][0-9]*)$/u.test(result) || (positive && result === "0")) {
    fail(field, `must be a ${positive ? "positive" : "nonnegative"} decimal string without leading zeros`)
  }
  return result
}

const filesystemGeneration = (value: unknown, field: string): FirstmateFilesystemGenerationV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, ["device", "inode", "birthtimeNs"])
  return {
    device: decimal(fields.device, `${field}.device`),
    inode: decimal(fields.inode, `${field}.inode`, true),
    birthtimeNs: decimal(fields.birthtimeNs, `${field}.birthtimeNs`, true),
  }
}

export const parseFirstmateWorktreeGenerationV1 = (
  value: unknown, field = "worktree generation",
): FirstmateWorktreeGenerationV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, ["schemaVersion", "kind", "worktree", "privateGitDir", "commonGitDir"])
  version(fields, field)
  return {
    schemaVersion: 1,
    kind: choice(fields.kind, `${field}.kind`, ["stat-birthtime-v1"]),
    worktree: filesystemGeneration(fields.worktree, `${field}.worktree`),
    privateGitDir: filesystemGeneration(fields.privateGitDir, `${field}.privateGitDir`),
    commonGitDir: filesystemGeneration(fields.commonGitDir, `${field}.commonGitDir`),
  }
}

export const firstmateWorktreeGenerationDigest = (generation: FirstmateWorktreeGenerationV1): string =>
  canonicalDigest(parseFirstmateWorktreeGenerationV1(generation))

export const parseFirstmateWorktreeEvidenceV1 = (
  value: unknown, field = "worktree evidence",
): FirstmateWorktreeEvidenceV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, ["schemaVersion", "locators", "generation", "generationDigest"])
  version(fields, field)
  const locators = record(fields.locators, `${field}.locators`)
  exactKeys(locators, `${field}.locators`, ["worktree", "privateGitDir", "commonGitDir"])
  const result: FirstmateWorktreeEvidenceV1 = {
    schemaVersion: 1,
    locators: {
      worktree: canonicalPath(locators.worktree, `${field}.locators.worktree`),
      privateGitDir: canonicalPath(locators.privateGitDir, `${field}.locators.privateGitDir`),
      commonGitDir: canonicalPath(locators.commonGitDir, `${field}.locators.commonGitDir`),
    },
    generation: parseFirstmateWorktreeGenerationV1(fields.generation, `${field}.generation`),
    generationDigest: hex(fields.generationDigest, `${field}.generationDigest`, [64]),
  }
  if (result.generationDigest !== firstmateWorktreeGenerationDigest(result.generation)) {
    fail(`${field}.generationDigest`, "must match the canonical generation digest")
  }
  if (result.locators.worktree === result.locators.privateGitDir || result.locators.worktree === result.locators.commonGitDir) {
    fail(`${field}.locators`, "must distinguish the worktree from its Git directories")
  }
  if (result.locators.privateGitDir === result.locators.commonGitDir &&
      canonicalJson(result.generation.privateGitDir) !== canonicalJson(result.generation.commonGitDir)) {
    fail(`${field}.generation`, "one Git directory cannot have two generations")
  }
  return bounded(result, field)
}

/** Includes locators as well as generation, so explicit locator refresh invalidates old approvals. */
export const firstmateWorktreeBindingDigest = (worktree: FirstmateWorktreeEvidenceV1): string =>
  canonicalDigest(parseFirstmateWorktreeEvidenceV1(worktree))

export const sameFirstmateWorktreeGeneration = (
  left: FirstmateWorktreeEvidenceV1, right: FirstmateWorktreeEvidenceV1,
): boolean => firstmateWorktreeGenerationDigest(left.generation) === firstmateWorktreeGenerationDigest(right.generation)

const boundWorktree = (value: unknown, field: string): FirstmateBoundWorktreeV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, ["status", "evidence"])
  return {
    status: choice(fields.status, `${field}.status`, ["bound", "missing", "moved", "replaced", "unverifiable"]),
    evidence: parseFirstmateWorktreeEvidenceV1(fields.evidence, `${field}.evidence`),
  }
}

const namedRuntime = (value: unknown, field: string): FirstmateNamedRuntimeEvidenceV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, ["state", "required"])
  return {
    state: choice(fields.state, `${field}.state`, ["verified", "missing", "drift", "unsafe"]),
    required: parseFirstmateRuntimeVariantV1(fields.required, `${field}.required`),
  }
}

const namedRoot = (value: unknown, reference: FirstmateNamedInstanceReferenceV1, field: string): string => {
  const root = canonicalPath(value, field)
  if (path.basename(root) !== reference.instanceId || path.basename(path.dirname(root)) !== "instances") {
    fail(field, "must be the exact instances/<UUID> destination")
  }
  return root
}

const legacyDescriptor = (
  fields: Record<string, unknown>, field: string, profile: string,
  reference: FirstmateInstanceReferenceV1 | null, notices: ReadonlyArray<FirstmateInstanceDiagnosticV1>,
): FirstmateLegacyInstanceDescriptorV1 => {
  const name = choice(fields.name, `${field}.name`, ["legacy"])
  const creationState = choice(fields.creationState, `${field}.creationState`, ["published", "missing-identity"])
  if ((reference === null) !== (creationState === "missing-identity")) {
    fail(`${field}.reference`, "must be null exactly when legacy setup identity is missing")
  }
  if (creationState === "missing-identity") requireDiagnostic(notices, "missing-identity", `${field}.diagnostics`)
  const worktree = record(fields.worktree, `${field}.worktree`)
  exactKeys(worktree, `${field}.worktree`, ["status", "evidence"])
  choice(worktree.status, `${field}.worktree.status`, ["unbound"])
  if (worktree.evidence !== null) fail(`${field}.worktree.evidence`, "must be null for unbound legacy state")
  const runtime = record(fields.runtime, `${field}.runtime`)
  exactKeys(runtime, `${field}.runtime`, ["state"])
  choice(runtime.state, `${field}.runtime.state`, ["legacy"])
  const root = canonicalPath(fields.root, `${field}.root`)
  if (path.basename(root) !== profile) fail(`${field}.root`, "must retain the legacy profile root")
  return bounded({
    schemaVersion: 1, profile, mode: "legacy", name,
    reference: reference === null ? null : { ...reference, mode: "legacy" },
    root, taskIdPrefix: identifier(fields.taskIdPrefix, `${field}.taskIdPrefix`), creationState,
    worktree: { status: "unbound", evidence: null }, runtime: { state: "legacy" }, diagnostics: notices,
  }, field)
}

export const parseFirstmateInstanceDescriptorV1 = (
  value: unknown, field = "instance descriptor",
): FirstmateInstanceDescriptorV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, [
    "schemaVersion", "profile", "mode", "name", "reference", "root", "taskIdPrefix",
    "creationState", "worktree", "runtime", "diagnostics",
  ])
  version(fields, field)
  const profile = identifier(fields.profile, `${field}.profile`)
  const mode = choice(fields.mode, `${field}.mode`, ["named", "legacy"])
  const reference = fields.reference === null ? null : parseFirstmateInstanceReferenceV1(fields.reference, `${field}.reference`)
  if (reference !== null && (reference.profile !== profile || reference.mode !== mode)) {
    fail(`${field}.reference`, "must agree with descriptor profile and mode")
  }
  const notices = diagnostics(fields.diagnostics, `${field}.diagnostics`)
  if (mode === "legacy") return legacyDescriptor(fields, field, profile, reference, notices)
  const named = namedReference(reference, `${field}.reference`)
  const creationState = choice(fields.creationState, `${field}.creationState`, [
    "creating", "published", "incomplete", "missing-identity", "unsafe",
  ])
  if (creationState !== "published" && notices.length === 0) {
    fail(`${field}.diagnostics`, "must explain an unpublished or unsafe instance")
  }
  if (creationState === "missing-identity") requireDiagnostic(notices, "missing-identity", `${field}.diagnostics`)
  return bounded({
    schemaVersion: 1, profile, mode, name: parseFirstmateInstanceName(fields.name, `${field}.name`),
    reference: named, root: namedRoot(fields.root, named, `${field}.root`),
    taskIdPrefix: parseFirstmateInstanceTaskIdPrefix(fields.taskIdPrefix, `${field}.taskIdPrefix`),
    creationState, worktree: boundWorktree(fields.worktree, `${field}.worktree`),
    runtime: namedRuntime(fields.runtime, `${field}.runtime`), diagnostics: notices,
  }, field)
}

const namedDescriptor = (value: unknown, field: string): FirstmateNamedInstanceDescriptorV1 => {
  const descriptor = parseFirstmateInstanceDescriptorV1(value, field)
  if (descriptor.mode !== "named") return fail(`${field}.mode`, "must equal named")
  return descriptor
}

export const parseFirstmateInstanceListCursorV1 = (
  value: unknown, field = "instance cursor",
): FirstmateInstanceListCursorV1 => {
  const cursor = exactText(value, field, firstmateInstanceLimits.cursorChars)
  const match = /^v1\.([a-f0-9]{64})\.(0|[1-9][0-9]{0,6})$/u.exec(cursor)
  if (match === null) return fail(field, "must be v1.<SHA256>.<decimal offset>")
  return {
    schemaVersion: 1,
    snapshotDigest: match[1]!,
    offset: integer(Number(match[2]), `${field}.offset`, 0, firstmateInstanceLimits.registryItems),
  }
}

export const firstmateInstanceListCursor = (cursor: FirstmateInstanceListCursorV1): string => {
  const fields = record(cursor, "instance cursor")
  exactKeys(fields, "instance cursor", ["schemaVersion", "snapshotDigest", "offset"])
  version(fields, "instance cursor")
  const digest = hex(cursor.snapshotDigest, "instance cursor.snapshotDigest", [64])
  const offset = integer(cursor.offset, "instance cursor.offset", 0, firstmateInstanceLimits.registryItems)
  return `v1.${digest}.${offset}`
}

const resultBase = (fields: Record<string, unknown>, field: string, blocked = false): FirstmateInstanceResultBaseV1 => {
  version(fields, field)
  return {
    schemaVersion: 1,
    profile: identifier(fields.profile, `${field}.profile`),
    diagnostics: diagnostics(fields.diagnostics, `${field}.diagnostics`, blocked),
  }
}

const validatePageInstances = (
  instances: ReadonlyArray<FirstmateInstanceDescriptorV1>, profile: string, offset: number, field: string,
): void => {
  if (instances.some((instance) => instance.profile !== profile)) fail(field, "must contain only the requested profile")
  const names = instances.map(({ name }) => name)
  const ids = instances.flatMap(({ reference }) => reference === null ? [] : [reference.instanceId])
  if (new Set(names).size !== names.length || new Set(ids).size !== ids.length) {
    fail(field, "must contain unique names and UUIDs")
  }
  const keys = instances.map((instance) => instance.mode === "legacy" ? "" : instance.reference.instanceId)
  if ((offset > 0 && keys.includes("")) || keys.some((key, index) => index > 0 && key <= keys[index - 1]!)) {
    fail(field, "must be ordered legacy first, then by UUID")
  }
}

export const firstmateInstanceListSnapshotDigest = (
  profile: string, instances: ReadonlyArray<FirstmateInstanceDescriptorV1>,
): string => {
  const parsedProfile = identifier(profile, "instance list.profile")
  const parsed = entries(instances, "instance list.instances", 0, firstmateInstanceLimits.registryItems, parseFirstmateInstanceDescriptorV1)
  validatePageInstances(parsed, parsedProfile, 0, "instance list.instances")
  return canonicalDigest({ schemaVersion: 1, profile: parsedProfile, instances: parsed })
}

export const parseFirstmateInstanceListResultV1 = (
  value: unknown, field = "instance list",
): FirstmateInstanceListResultV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, ["schemaVersion", "profile", "state", "instances", "page", "diagnostics"])
  const state = choice(fields.state, `${field}.state`, ["page", "blocked", "stale-cursor"])
  const base = resultBase(fields, field, state !== "page")
  if (state !== "page") {
    entries(fields.instances, `${field}.instances`, 0, 0, parseFirstmateInstanceDescriptorV1)
    if (fields.page !== null) fail(`${field}.page`, "must be null on a failed listing")
    if (state === "stale-cursor") requireDiagnostic(base.diagnostics, "stale-cursor", `${field}.diagnostics`)
    return bounded({ ...base, state, instances: [], page: null }, field)
  }
  const instances = entries(fields.instances, `${field}.instances`, 0, firstmateInstanceLimits.pageItems, parseFirstmateInstanceDescriptorV1)
  const page = record(fields.page, `${field}.page`)
  exactKeys(page, `${field}.page`, ["snapshotDigest", "offset", "total", "nextCursor"])
  const snapshotDigest = hex(page.snapshotDigest, `${field}.page.snapshotDigest`, [64])
  const total = integer(page.total, `${field}.page.total`, 0, firstmateInstanceLimits.registryItems)
  const offset = integer(page.offset, `${field}.page.offset`, 0, total)
  const end = offset + instances.length
  if (end > total || (instances.length === 0 && (total !== 0 || offset !== 0))) {
    fail(`${field}.page`, "must make progress within the complete snapshot total")
  }
  const nextCursor = page.nextCursor === null ? null : exactText(page.nextCursor, `${field}.page.nextCursor`, firstmateInstanceLimits.cursorChars)
  const expected = end === total ? null : firstmateInstanceListCursor({ schemaVersion: 1, snapshotDigest, offset: end })
  if (nextCursor !== expected) fail(`${field}.page.nextCursor`, "must advance within this snapshot; only its last page may end the list")
  validatePageInstances(instances, base.profile, offset, `${field}.instances`)
  return bounded({ ...base, state, instances, page: { snapshotDigest, offset, total, nextCursor } }, field)
}

export const parseFirstmateInstanceResolveResultV1 = (
  value: unknown, field = "instance resolve",
): FirstmateInstanceResolveResultV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, ["schemaVersion", "profile", "state", "worktree", "descriptor", "diagnostics"])
  const state = choice(fields.state, `${field}.state`, ["matched", "not-found", "blocked"])
  const base = resultBase(fields, field, state === "blocked")
  const worktree = fields.worktree === null ? null : parseFirstmateWorktreeEvidenceV1(fields.worktree, `${field}.worktree`)
  if (state !== "matched") {
    if (fields.descriptor !== null) fail(`${field}.descriptor`, "must be null without one proved match")
    if (state === "blocked") return bounded({ ...base, state, worktree, descriptor: null }, field)
    if (worktree === null) return fail(`${field}.worktree`, "requires reliable worktree evidence for not-found")
    return bounded({ ...base, state, worktree, descriptor: null }, field)
  }
  if (worktree === null) return fail(`${field}.worktree`, "requires reliable worktree evidence for a match")
  const descriptor = namedDescriptor(fields.descriptor, `${field}.descriptor`)
  if (descriptor.profile !== base.profile || descriptor.worktree.status !== "bound" ||
      firstmateWorktreeBindingDigest(descriptor.worktree.evidence) !== firstmateWorktreeBindingDigest(worktree)) {
    fail(`${field}.descriptor`, "must match this profile and exact current worktree binding")
  }
  return bounded({ ...base, state, worktree, descriptor }, field)
}

const planKeys = [
  "schemaVersion", "reference", "name", "sourceRevision", "taskIdPrefix", "destination",
  "worktree", "runtimeRequirements", "permittedWrites",
] as const

const creationPlanBody = (fields: Record<string, unknown>, field: string): FirstmateInstanceCreationPlanBodyV1 => {
  version(fields, field)
  const reference = namedReference(fields.reference, `${field}.reference`)
  const destination = namedRoot(fields.destination, reference, `${field}.destination`)
  const runtimeRequirements = parseFirstmateRuntimeVariantV1(fields.runtimeRequirements, `${field}.runtimeRequirements`)
  const sourceRevision = hex(fields.sourceRevision, `${field}.sourceRevision`, [40])
  if (sourceRevision !== runtimeRequirements.sourceRevision) fail(`${field}.runtimeRequirements`, "must match the planned source revision")
  const writes = entries(fields.permittedWrites, `${field}.permittedWrites`, 2, 2, (value, field) => {
    const write = record(value, field)
    exactKeys(write, field, ["kind", "path"])
    return {
      kind: choice(write.kind, `${field}.kind`, ["instance-root", "registry-locks"]),
      path: canonicalPath(write.path, `${field}.path`),
    }
  })
  const registryLocks = path.join(path.dirname(destination), "locks")
  if (writes[0]!.kind !== "instance-root" || writes[0]!.path !== destination ||
      writes[1]!.kind !== "registry-locks" || writes[1]!.path !== registryLocks) {
    fail(`${field}.permittedWrites`, "must declare only this instance root, then its sibling registry locks")
  }
  return {
    schemaVersion: 1, reference, name: parseFirstmateInstanceName(fields.name, `${field}.name`),
    sourceRevision, taskIdPrefix: parseFirstmateInstanceTaskIdPrefix(fields.taskIdPrefix, `${field}.taskIdPrefix`),
    destination, worktree: parseFirstmateWorktreeEvidenceV1(fields.worktree, `${field}.worktree`),
    runtimeRequirements,
    permittedWrites: [{ kind: "instance-root", path: destination }, { kind: "registry-locks", path: registryLocks }],
  }
}

/** Canonical whole plan excluding only approvalDigest. This computes an identity, not consent. */
export const firstmateInstanceCreationPlanDigest = (plan: FirstmateInstanceCreationPlanBodyV1): string => {
  const fields = record(plan, "creation plan")
  exactKeys(fields, "creation plan", planKeys, ["approvalDigest"])
  return canonicalDigest(bounded(creationPlanBody(fields, "creation plan"), "creation plan"))
}

export const parseFirstmateInstanceCreationPlanV1 = (
  value: unknown, field = "creation plan",
): FirstmateInstanceCreationPlanV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, [...planKeys, "approvalDigest"])
  const body = creationPlanBody(fields, field)
  const approvalDigest = hex(fields.approvalDigest, `${field}.approvalDigest`, [64])
  if (canonicalDigest(body) !== approvalDigest) fail(`${field}.approvalDigest`, "must match the complete canonical creation plan")
  return bounded({ ...body, approvalDigest }, field)
}

export const parseFirstmateInstanceCreationPlanJson = (source: string): FirstmateInstanceCreationPlanV1 =>
  parseFirstmateInstanceCreationPlanV1(envelopeJson(source, "creation plan JSON"))

export const parseFirstmateInstancePlanResultV1 = (
  value: unknown, field = "instance plan",
): FirstmateInstancePlanResultV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, ["schemaVersion", "profile", "state", "plan", "diagnostics"])
  const state = choice(fields.state, `${field}.state`, ["ready", "blocked"])
  const base = resultBase(fields, field, state === "blocked")
  if (state === "blocked") {
    if (fields.plan !== null) fail(`${field}.plan`, "must be null when creation planning is blocked")
    return bounded({ ...base, state, plan: null }, field)
  }
  const plan = parseFirstmateInstanceCreationPlanV1(fields.plan, `${field}.plan`)
  if (plan.reference.profile !== base.profile) fail(`${field}.plan`, "must match the requested profile")
  return bounded({ ...base, state, plan }, field)
}

const validateCreatedDescriptorPlan = (
  descriptor: FirstmateNamedInstanceDescriptorV1, plan: FirstmateInstanceCreationPlanV1, field: string,
): void => {
  if (!sameFirstmateInstance(descriptor.reference, plan.reference) ||
      descriptor.name !== plan.name || descriptor.root !== plan.destination ||
      descriptor.taskIdPrefix !== plan.taskIdPrefix ||
      firstmateRuntimeVariantDigest(descriptor.runtime.required) !== firstmateRuntimeVariantDigest(plan.runtimeRequirements) ||
      !sameFirstmateWorktreeGeneration(descriptor.worktree.evidence, plan.worktree)) {
    fail(field, "must retain the planned instance, namespace, runtime, destination, and generation")
  }
}

const publishedDescriptor = (
  descriptor: FirstmateNamedInstanceDescriptorV1 | null, plan: FirstmateInstanceCreationPlanV1, field: string,
): FirstmateNamedInstanceDescriptorV1 => {
  if (descriptor === null || descriptor.creationState !== "published" ||
      descriptor.worktree.status !== "bound" || descriptor.runtime.state !== "verified" ||
      firstmateWorktreeBindingDigest(descriptor.worktree.evidence) !== firstmateWorktreeBindingDigest(plan.worktree)) {
    return fail(field, "successful creation requires the published instance and exact verified plan binding/runtime")
  }
  return descriptor
}

/** Requires the original approved plan: response loss or retry cannot select a new UUID. */
export const parseFirstmateInstanceCreateResultV1 = (
  value: unknown, approvedPlan: FirstmateInstanceCreationPlanV1, field = "instance create",
): FirstmateInstanceCreateResultV1 => {
  const plan = parseFirstmateInstanceCreationPlanV1(approvedPlan, "approved creation plan")
  const fields = record(value, field)
  exactKeys(fields, field, ["schemaVersion", "reference", "approvalDigest", "state", "descriptor", "diagnostics"])
  version(fields, field)
  const reference = namedReference(fields.reference, `${field}.reference`)
  const approvalDigest = hex(fields.approvalDigest, `${field}.approvalDigest`, [64])
  if (!sameFirstmateInstance(reference, plan.reference) || approvalDigest !== plan.approvalDigest) {
    fail(field, "must reconcile the same planned UUID and approval digest")
  }
  const state = choice(fields.state, `${field}.state`, ["created", "existing", "blocked", "incomplete"])
  const notices = diagnostics(fields.diagnostics, `${field}.diagnostics`, state === "blocked" || state === "incomplete")
  const descriptor = fields.descriptor === null ? null : namedDescriptor(fields.descriptor, `${field}.descriptor`)
  if (descriptor !== null) validateCreatedDescriptorPlan(descriptor, plan, `${field}.descriptor`)
  const base = { schemaVersion: 1 as const, reference, approvalDigest, diagnostics: notices }
  if (state === "blocked" || state === "incomplete") {
    if (state === "incomplete") requireDiagnostic(notices, "creation-incomplete", `${field}.diagnostics`)
    return bounded({ ...base, state, descriptor }, field)
  }
  return bounded({ ...base, state, descriptor: publishedDescriptor(descriptor, plan, `${field}.descriptor`) }, field)
}

export const parseFirstmateInstanceControlContextV1 = (
  value: unknown, field = "instance control context",
): FirstmateInstanceControlContextV1 => {
  const fields = record(value, field)
  exactKeys(fields, field, [
    "schemaVersion", "reference", "expectedBindingDigest", "expectedRuntimeDigest", "entryWorktree", "selection",
  ])
  version(fields, field)
  const reference = parseFirstmateInstanceReferenceV1(fields.reference, `${field}.reference`)
  const expectedBindingDigest = fields.expectedBindingDigest === null ? null : hex(fields.expectedBindingDigest, `${field}.expectedBindingDigest`, [64])
  const expectedRuntimeDigest = fields.expectedRuntimeDigest === null ? null : hex(fields.expectedRuntimeDigest, `${field}.expectedRuntimeDigest`, [64])
  const entryWorktree = fields.entryWorktree === null ? null : parseFirstmateWorktreeEvidenceV1(fields.entryWorktree, `${field}.entryWorktree`)
  const selection = choice(fields.selection, `${field}.selection`, ["entry-match", "confirmed-join"])
  if (reference.mode === "named" && (expectedBindingDigest === null || expectedRuntimeDigest === null)) {
    fail(field, "named control requires binding and explicit runtime digests")
  }
  if (reference.mode === "legacy" && (expectedBindingDigest !== null || expectedRuntimeDigest !== null || selection !== "confirmed-join")) {
    fail(field, "legacy control is an explicit confirmed join without named binding or runtime expectations")
  }
  if (selection === "entry-match" &&
      (entryWorktree === null || firstmateWorktreeBindingDigest(entryWorktree) !== expectedBindingDigest)) {
    fail(`${field}.entryWorktree`, "entry-match requires the exact captured binding; another entry requires confirmed-join")
  }
  return bounded({ schemaVersion: 1, reference, expectedBindingDigest, expectedRuntimeDigest, entryWorktree, selection }, field)
}

export const parseFirstmateInstanceControlContextJson = (source: string): FirstmateInstanceControlContextV1 =>
  parseFirstmateInstanceControlContextV1(envelopeJson(source, "instance control context JSON"))

/** Used for new preparation/submission/startup, never as a receipt-read prerequisite. */
export const validateFirstmateInstanceControlContextV1 = (
  context: FirstmateInstanceControlContextV1, descriptor: FirstmateInstanceDescriptorV1, field = "instance control context",
): void => {
  const parsed = parseFirstmateInstanceControlContextV1(context, field)
  const current = parseFirstmateInstanceDescriptorV1(descriptor, "instance descriptor")
  if (current.reference === null || !sameFirstmateInstance(parsed.reference, current.reference)) {
    fail(`${field}.reference`, "must match the selected owned instance")
  }
  if (current.creationState !== "published") {
    fail(field, "requires published setup identity; reconcile creation or missing identity before control")
  }
  if (current.mode === "named" && (
    current.worktree.status !== "bound" ||
    parsed.expectedBindingDigest !== firstmateWorktreeBindingDigest(current.worktree.evidence) ||
    parsed.expectedRuntimeDigest !== firstmateRuntimeVariantDigest(current.runtime.required)
  )) {
    fail(field, "must match the current valid binding and required runtime")
  }
}

export const firstmateInstanceControlContextDigest = (context: FirstmateInstanceControlContextV1): string =>
  canonicalDigest(parseFirstmateInstanceControlContextV1(context))

/** refresh-locator returns only a descriptor, after Native proves generation/backlinks under its idle gate.
 * CLI: instances refresh-locator PROFILE --instance UUID --worktree PATH --json
 *      --expected-binding-digest SHA256 --confirm
 */
export const parseFirstmateInstanceLocatorRefreshResultV1 = (
  value: unknown, previous: FirstmateNamedInstanceDescriptorV1, field = "refreshed instance descriptor",
): FirstmateNamedInstanceDescriptorV1 => {
  const before = namedDescriptor(previous, "previous instance descriptor")
  const after = namedDescriptor(value, field)
  if (!sameFirstmateInstance(before.reference, after.reference) ||
      before.name !== after.name || before.root !== after.root || before.taskIdPrefix !== after.taskIdPrefix ||
      before.creationState !== after.creationState ||
      firstmateRuntimeVariantDigest(before.runtime.required) !== firstmateRuntimeVariantDigest(after.runtime.required) ||
      !sameFirstmateWorktreeGeneration(before.worktree.evidence, after.worktree.evidence) ||
      after.worktree.status !== "bound") {
    fail(field, "locator refresh must retain the same instance and generation and return a proved bound descriptor")
  }
  return after
}

export const canonicalFirstmateInstanceJson = (
  value:
    | FirstmateInstanceReferenceV1 | FirstmateRuntimeVariantV1 | FirstmateWorktreeGenerationV1
    | FirstmateWorktreeEvidenceV1 | FirstmateInstanceDescriptorV1 | FirstmateInstanceListResultV1
    | FirstmateInstanceResolveResultV1 | FirstmateInstanceCreationPlanV1 | FirstmateInstancePlanResultV1
    | FirstmateInstanceCreateResultV1 | FirstmateInstanceControlContextV1,
): string => canonicalJson(bounded(value, "instance JSON"))
