import { randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, mkdir, open, opendir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  FIRSTMATE_MAX_REQUEST_BYTES,
  FIRSTMATE_MAX_RESPONSE_BYTES,
  canonicalFirstmateJson,
  firstmateSubmissionDigest,
  firstmateInstanceKey,
  parseFirstmateInstanceReferenceV1,
  parseFirstmateSubmissionRequestV1,
  validateFirstmateInstanceFleet,
  type FirstmateInstanceReferenceV1,
  type FirstmateSubmissionReceiptV1,
  type FirstmateSubmissionRequestV1,
} from "@trellage/guide-core"
import { firstmateOutcomeFromReceipt, type FirstmateSubmissionOutcome } from "./guide-firstmate.ts"

export type FirstmateJournalStatus = "prepared" | "sending" | "accepted" | "rejected" | "unknown"

export interface FirstmateJournalEntry {
  readonly schemaVersion: 1
  readonly request: FirstmateSubmissionRequestV1
  readonly digest: string
  readonly status: FirstmateJournalStatus
  readonly receipt: FirstmateSubmissionReceiptV1 | null
  readonly message: string
}

export interface FirstmateSubmissionJournal {
  prepare(request: FirstmateSubmissionRequestV1): Promise<FirstmateJournalEntry>
  get(requestId: string): Promise<FirstmateJournalEntry | undefined>
  /** Only prepared -> sending succeeds. A second caller must inspect the same-ID receipt, not send. */
  begin(request: FirstmateSubmissionRequestV1): Promise<FirstmateJournalEntry>
  record(request: FirstmateSubmissionRequestV1, outcome: FirstmateSubmissionOutcome): Promise<FirstmateJournalEntry>
  listPending(): Promise<ReadonlyArray<FirstmateJournalEntry>>
}

export type FirstmateJournalFactory = (reference: FirstmateInstanceReferenceV1) => FirstmateSubmissionJournal

export enum FirstmateJournalErrorCode {
  InvalidRoot = "invalid-root",
  UnsafePath = "unsafe-path",
  InvalidData = "invalid-data",
  Changed = "changed",
  Conflict = "conflict",
  MissingRequest = "missing-request",
  AttemptProtected = "attempt-protected",
  LockUnavailable = "lock-unavailable",
  IoFailure = "io-failure",
}

export class FirstmateJournalError extends Error {
  constructor(
    readonly code: FirstmateJournalErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(`Firstmate journal: ${message}`, cause === undefined ? undefined : { cause })
    this.name = "FirstmateJournalError"
  }
}

export const FIRSTMATE_JOURNAL_MAX_FILE_BYTES = FIRSTMATE_MAX_REQUEST_BYTES + 2 * FIRSTMATE_MAX_RESPONSE_BYTES + 1024
const maximumMessageBytes = 32 * 1024
const maximumListEntries = 1024
const maximumListBytes = 16 * 1024 * 1024
const controls = /[\u0000-\u001f\u007f-\u009f]/u

interface Identity {
  readonly dev: number
  readonly ino: number
}

interface StoredEntry {
  readonly entry: FirstmateJournalEntry
  readonly stamp: Stats
}

type AssertLock = () => Promise<void>

function fail(code: FirstmateJournalErrorCode, message: string): never {
  throw new FirstmateJournalError(code, message)
}

const errno = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code

const io = async <T>(operation: string, action: () => Promise<T>): Promise<T> => {
  try {
    return await action()
  } catch (cause) {
    if (cause instanceof FirstmateJournalError) throw cause
    throw new FirstmateJournalError(
      FirstmateJournalErrorCode.IoFailure,
      `could not ${operation}; durable state was not confirmed.`,
      cause,
    )
  }
}

const sameIdentity = (left: Identity, right: Identity): boolean => left.dev === right.dev && left.ino === right.ino
const sameFile = (left: Stats, right: Stats): boolean =>
  sameIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs

const privateFile = (status: Stats, uid: number): void => {
  if (
    !status.isFile() || status.isSymbolicLink() || status.uid !== uid ||
    (status.mode & 0o7777) !== 0o600 || status.nlink !== 1
  ) {
    fail(FirstmateJournalErrorCode.UnsafePath, "files must be owned, single-link, mode-0600 regular files.")
  }
  if (status.size > FIRSTMATE_JOURNAL_MAX_FILE_BYTES) {
    fail(FirstmateJournalErrorCode.InvalidData, "a private file exceeds its byte limit.")
  }
}

const privateDirectory = (status: Stats, uid: number, privateMode: boolean): void => {
  if (!status.isDirectory() || status.isSymbolicLink()) {
    fail(FirstmateJournalErrorCode.UnsafePath, "directories and their ancestors must not be symbolic links.")
  }
  if (privateMode) {
    if (status.uid !== uid || (status.mode & 0o7777) !== 0o700) {
      fail(FirstmateJournalErrorCode.UnsafePath, "private directories must be owned and mode 0700; permissions were not changed.")
    }
  } else if ((status.uid !== uid && status.uid !== 0) || (status.mode & 0o022) !== 0) {
    fail(FirstmateJournalErrorCode.UnsafePath, "a directory ancestor has an unsafe owner or writable permissions.")
  }
}

const ancestors = (directory: string): ReadonlyArray<string> => {
  const root = path.parse(directory).root
  const result = [root]
  for (const component of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    result.push(path.join(result[result.length - 1]!, component))
  }
  return result
}

const checkedRequest = (value: FirstmateSubmissionRequestV1): FirstmateSubmissionRequestV1 => {
  try {
    const request = parseFirstmateSubmissionRequestV1(value)
    if (canonicalFirstmateJson(request) !== canonicalFirstmateJson(value)) {
      return fail(FirstmateJournalErrorCode.InvalidData, "request fields must be valid without normalization.")
    }
    return request
  } catch (cause) {
    if (cause instanceof FirstmateJournalError) throw cause
    return fail(FirstmateJournalErrorCode.InvalidData, "the request is invalid or exceeds its byte limit.")
  }
}

const checkedMessage = (value: unknown): string => {
  if (
    typeof value !== "string" || value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumMessageBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  ) {
    return fail(FirstmateJournalErrorCode.InvalidData, "a journal message is invalid or exceeds its byte limit.")
  }
  return value
}

const checkedOutcomeReceipt = (
  request: FirstmateSubmissionRequestV1,
  outcome: FirstmateSubmissionOutcome,
): FirstmateSubmissionReceiptV1 | null => {
  const status = outcome.status
  const verified = outcome.receipt === undefined ? undefined : firstmateOutcomeFromReceipt(request, outcome.receipt)
  if (verified !== undefined && (verified.receipt === undefined || verified.status !== status)) {
    return fail(FirstmateJournalErrorCode.InvalidData, "receipt evidence does not match the request and outcome.")
  }
  if ((status === "accepted" || status === "not-found") && verified?.receipt === undefined) {
    return fail(FirstmateJournalErrorCode.InvalidData, "this outcome requires a validated receipt.")
  }
  return verified?.receipt ?? null
}

const checkedOutcome = (
  request: FirstmateSubmissionRequestV1,
  outcome: FirstmateSubmissionOutcome,
): Pick<FirstmateJournalEntry, "status" | "receipt" | "message"> => {
  const status = outcome.status
  if (status !== "accepted" && status !== "rejected" && status !== "unknown" && status !== "not-found") {
    return fail(FirstmateJournalErrorCode.InvalidData, "a journal result must be a transport outcome.")
  }
  return {
    status: status === "not-found" ? "unknown" : status,
    receipt: checkedOutcomeReceipt(request, outcome),
    message: checkedMessage(outcome.message),
  }
}

const recordFields = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(FirstmateJournalErrorCode.InvalidData, "a private record must be a JSON object.")
  }
  const fields = value as Record<string, unknown>
  const required = ["schemaVersion", "request", "digest", "status", "receipt", "message"]
  if (Object.keys(fields).length !== required.length || required.some((key) => !Object.hasOwn(fields, key))) {
    return fail(FirstmateJournalErrorCode.InvalidData, "a private record has missing or unsupported fields.")
  }
  return fields
}

const checkedStoredReceipt = (
  request: FirstmateSubmissionRequestV1,
  status: FirstmateJournalStatus,
  value: unknown,
): FirstmateSubmissionReceiptV1 | null => {
  if (value === null) {
    if (status === "accepted") fail(FirstmateJournalErrorCode.InvalidData, "accepted state requires a validated receipt.")
    return null
  }
  const verified = firstmateOutcomeFromReceipt(request, value)
  if (
    verified.receipt === undefined || status === "prepared" || status === "sending" ||
    (status === "accepted") !== (verified.status === "accepted")
  ) {
    return fail(FirstmateJournalErrorCode.InvalidData, "saved receipt evidence does not match the durable state.")
  }
  return verified.receipt
}

const decodeRecord = (bytes: Buffer, requestId: string): FirstmateJournalEntry => {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return fail(FirstmateJournalErrorCode.InvalidData, "a private record must contain valid UTF-8 JSON.")
  }
  const fields = recordFields(value)
  const request = checkedRequest(fields.request as FirstmateSubmissionRequestV1)
  if (fields.schemaVersion !== 1 || request.requestId !== requestId || fields.digest !== firstmateSubmissionDigest(request)) {
    return fail(FirstmateJournalErrorCode.InvalidData, "a private record does not match its request ID and digest.")
  }
  const status = fields.status
  if (status !== "prepared" && status !== "sending" && status !== "accepted" && status !== "rejected" && status !== "unknown") {
    return fail(FirstmateJournalErrorCode.InvalidData, "a private record has an invalid transport state.")
  }
  return {
    schemaVersion: 1,
    request,
    digest: fields.digest as string,
    status,
    receipt: checkedStoredReceipt(request, status, fields.receipt),
    message: checkedMessage(fields.message),
  }
}

const readBounded = async (handle: FileHandle, length: number): Promise<Buffer> => {
  const bytes = Buffer.alloc(length + 1)
  let offset = 0
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset !== length) fail(FirstmateJournalErrorCode.Changed, "a private file changed during the read.")
  return bytes.subarray(0, offset)
}

export const defaultFirstmateJournalPath = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const state = env.XDG_STATE_HOME
  const base = state === undefined || state === "" ? path.join(env.HOME ?? homedir(), ".local", "state") : state
  if (!path.isAbsolute(base)) fail(FirstmateJournalErrorCode.InvalidRoot, "XDG state must resolve to an absolute path.")
  return path.join(base, "trellage", "firstmate-submissions")
}

/**
 * A private transport journal, not a task scheduler. Locks are never stolen by age or PID.
 * An abandoned lock fails closed and requires owner inspection; no automatic resubmission is safe.
 */
export class FileFirstmateSubmissionJournal implements FirstmateSubmissionJournal {
  private readonly root: string
  private readonly uid: number
  private readonly directories = new Map<string, Identity>()

  constructor(root = defaultFirstmateJournalPath()) {
    if (
      typeof root !== "string" || root.length > 4096 || !path.isAbsolute(root) ||
      root.split(path.sep).includes("..") || controls.test(root) || path.resolve(root) === path.parse(root).root
    ) {
      fail(FirstmateJournalErrorCode.InvalidRoot, "the journal root must be a non-root absolute private directory.")
    }

    if (process.getuid === undefined) {
      fail(FirstmateJournalErrorCode.InvalidRoot, "the private journal requires a POSIX user identity.")
    }
    this.root = path.resolve(root)
    this.uid = process.getuid()
  }

  private checkDirectory(directory: string, status: Stats): void {
    privateDirectory(status, this.uid, directory === this.root || directory.startsWith(`${this.root}${path.sep}`))
    const previous = this.directories.get(directory)
    if (previous !== undefined && !sameIdentity(previous, status)) {
      fail(FirstmateJournalErrorCode.Changed, "a journal directory was replaced.")
    }
    this.directories.set(directory, { dev: status.dev, ino: status.ino })
  }

  private async directoryStatus(directory: string, create: boolean): Promise<{ status: Stats; created: boolean }> {
    try {
      return { status: await lstat(directory), created: false }
    } catch (cause) {
      if (!create || !errno(cause, "ENOENT")) throw cause
      if (this.directories.has(directory)) fail(FirstmateJournalErrorCode.Changed, "a known journal directory is missing.")
      let created = false
      try {
        await mkdir(directory, { mode: 0o700 })
        created = true
      } catch (createError) {
        if (!errno(createError, "EEXIST")) throw createError
      }
      return { status: await lstat(directory), created }
    }
  }

  private async inspectTree(directory = this.root, create = false): Promise<void> {
    for (const ancestor of ancestors(directory)) {
      const { status, created } = await this.directoryStatus(ancestor, create)
      this.checkDirectory(ancestor, status)
      if (created) await this.syncDirectory(path.dirname(ancestor))
    }
  }

  private async syncDirectory(directory = this.root): Promise<void> {
    await this.inspectTree(directory)
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      this.checkDirectory(directory, await handle.stat())
      await handle.sync()
      await this.inspectTree(directory)
    } finally {
      await handle.close()
    }
  }

  private async statusIfPresent(filename: string): Promise<Stats | undefined> {
    await this.inspectTree()
    try {
      return await lstat(filename)
    } catch (cause) {
      if (!errno(cause, "ENOENT")) throw cause
      await this.inspectTree()
      return undefined
    }
  }

  private async acquireLock(): Promise<{ assertHeld: AssertLock; release: AssertLock }> {
    const filename = path.join(this.root, ".journal.lock")
    for (let attempt = 0; attempt <= 100; attempt += 1) {
      await this.inspectTree()
      try {
        await mkdir(filename, { mode: 0o700 })
        const held = await lstat(filename)
        privateDirectory(held, this.uid, true)
        const assertHeld = async (): Promise<void> => {
          const current = await this.statusIfPresent(filename)
          if (current === undefined) fail(FirstmateJournalErrorCode.LockUnavailable, "the journal lock is missing.")
          privateDirectory(current, this.uid, true)
          if (!sameIdentity(held, current)) fail(FirstmateJournalErrorCode.Changed, "the journal lock was replaced.")
        }
        return {
          assertHeld,
          release: async () => {
            await assertHeld()
            await rmdir(filename)
            await this.syncDirectory()
          },
        }
      } catch (cause) {
        if (!errno(cause, "EEXIST")) throw cause
        const current = await this.statusIfPresent(filename)
        if (current !== undefined) privateDirectory(current, this.uid, true)
      }
      if (attempt < 100) await delay(25)
    }
    return fail(
      FirstmateJournalErrorCode.LockUnavailable,
      "another writer or an abandoned lock blocks the journal. The lock was not stolen; inspect it before retrying.",
    )
  }

  private locked<T>(operation: (assertHeld: AssertLock) => Promise<T>): Promise<T> {
    return io("access the private journal", async () => {
      await this.inspectTree(this.root, true)
      const lock = await this.acquireLock()
      try {
        await lock.assertHeld()
        const result = await operation(lock.assertHeld)
        await lock.assertHeld()
        return result
      } finally {
        await lock.release()
      }
    })
  }

  private filename(requestId: string): string {
    if (typeof requestId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(requestId)) {
      return fail(FirstmateJournalErrorCode.InvalidData, "request filenames must be bounded opaque identifiers.")
    }
    return path.join(this.root, `${requestId}.json`)
  }

  private async readEntry(requestId: string): Promise<StoredEntry | undefined> {
    const filename = this.filename(requestId)
    const before = await this.statusIfPresent(filename)
    if (before === undefined) return undefined
    privateFile(before, this.uid)
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await handle.stat()
      privateFile(opened, this.uid)
      if (!sameFile(before, opened)) fail(FirstmateJournalErrorCode.Changed, "a private record changed while opening it.")
      const bytes = await readBounded(handle, opened.size)
      const after = await handle.stat()
      privateFile(after, this.uid)
      const current = await this.statusIfPresent(filename)
      if (current === undefined || !sameFile(opened, after) || !sameFile(after, current)) {
        fail(FirstmateJournalErrorCode.Changed, "a private record changed during the read.")
      }
      privateFile(current, this.uid)
      return { entry: decodeRecord(bytes, requestId), stamp: current }
    } finally {
      await handle.close()
    }
  }

  private async checkUnchanged(filename: string, expected: Stats | undefined): Promise<void> {
    const current = await this.statusIfPresent(filename)
    if (current !== undefined) privateFile(current, this.uid)
    if (current === undefined && expected === undefined) return
    if (current === undefined || expected === undefined || !sameFile(current, expected)) {
      fail(FirstmateJournalErrorCode.Changed, "a private record changed; publication was refused.")
    }
  }

  private async writeStaged(filename: string, bytes: Buffer, created: (identity: Identity) => void): Promise<Stats> {
    const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      const initial = await handle.stat()
      privateFile(initial, this.uid)
      created(initial)
      await handle.writeFile(bytes)
      await handle.sync()
      const written = await handle.stat()
      privateFile(written, this.uid)
      if (written.size !== bytes.length) fail(FirstmateJournalErrorCode.Changed, "a staged write is incomplete.")
      await this.checkUnchanged(filename, written)
      return written
    } finally {
      await handle.close()
    }
  }

  private async removeStaged(filename: string, identity: Identity, assertHeld: AssertLock): Promise<void> {
    await assertHeld()
    const current = await this.statusIfPresent(filename)
    if (current === undefined) return
    privateFile(current, this.uid)
    if (!sameIdentity(identity, current)) fail(FirstmateJournalErrorCode.Changed, "a staged file was replaced; it was not removed.")
    await unlink(filename)
    await this.syncDirectory()
  }

  private async publish(
    entry: FirstmateJournalEntry,
    expected: Stats | undefined,
    assertHeld: AssertLock,
  ): Promise<FirstmateJournalEntry> {
    const filename = this.filename(entry.request.requestId)
    const bytes = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8")
    if (bytes.length > FIRSTMATE_JOURNAL_MAX_FILE_BYTES) {
      fail(FirstmateJournalErrorCode.InvalidData, "serialized journal state exceeds its byte limit.")
    }
    await this.checkUnchanged(filename, expected)
    const staged = path.join(this.root, `.write-${randomUUID()}.json`)
    let created: Identity | undefined
    let published = false
    try {
      const stamp = await this.writeStaged(staged, bytes, (identity) => { created = identity })
      await assertHeld()
      await this.checkUnchanged(staged, stamp)
      await this.checkUnchanged(filename, expected)
      await rename(staged, filename)
      published = true
      const saved = await this.statusIfPresent(filename)
      if (saved === undefined || !sameIdentity(saved, stamp)) {
        fail(FirstmateJournalErrorCode.Changed, "published journal state was replaced.")
      }
      privateFile(saved, this.uid)
      await this.syncDirectory()
      return entry
    } finally {
      if (!published && created !== undefined) await this.removeStaged(staged, created, assertHeld)
    }
  }

  private requireSameRequest(stored: StoredEntry, request: FirstmateSubmissionRequestV1): void {
    if (
      stored.entry.digest !== firstmateSubmissionDigest(request) ||
      canonicalFirstmateJson(stored.entry.request) !== canonicalFirstmateJson(request)
    ) {
      fail(FirstmateJournalErrorCode.Conflict, "this request ID already has different content; it cannot be replaced.")
    }
  }

  private async requireEntry(request: FirstmateSubmissionRequestV1): Promise<StoredEntry> {
    const stored = await this.readEntry(request.requestId)
    if (stored === undefined) fail(FirstmateJournalErrorCode.MissingRequest, "prepare the durable request before transport.")
    this.requireSameRequest(stored, request)
    return stored
  }

  async prepare(original: FirstmateSubmissionRequestV1): Promise<FirstmateJournalEntry> {
    const request = checkedRequest(original)
    return this.locked(async (assertHeld) => {
      const stored = await this.readEntry(request.requestId)
      if (stored !== undefined) {
        this.requireSameRequest(stored, request)
        return stored.entry
      }
      return this.publish({
        schemaVersion: 1,
        request,
        digest: firstmateSubmissionDigest(request),
        status: "prepared",
        receipt: null,
        message: "The original request is saved locally. It has not been submitted.",
      }, undefined, assertHeld)
    })
  }

  async get(requestId: string): Promise<FirstmateJournalEntry | undefined> {
    this.filename(requestId)
    return this.locked(async () => (await this.readEntry(requestId))?.entry)
  }

  async begin(original: FirstmateSubmissionRequestV1): Promise<FirstmateJournalEntry> {
    const request = checkedRequest(original)
    return this.locked(async (assertHeld) => {
      const stored = await this.requireEntry(request)
      if (stored.entry.status !== "prepared") {
        fail(FirstmateJournalErrorCode.AttemptProtected, "this request cannot be sent again; inspect the same-ID receipt.")
      }
      return this.publish({
        ...stored.entry,
        status: "sending",
        message: "Submission may be in progress. Inspect the same-ID receipt before any further transport.",
      }, stored.stamp, assertHeld)
    })
  }

  async record(original: FirstmateSubmissionRequestV1, outcome: FirstmateSubmissionOutcome): Promise<FirstmateJournalEntry> {
    const request = checkedRequest(original)
    const result = checkedOutcome(request, outcome)
    return this.locked(async (assertHeld) => {
      const stored = await this.requireEntry(request)
      if (stored.entry.status === "accepted") {
        if (result.status !== "accepted") return stored.entry
        if (stored.entry.receipt!.noteId !== result.receipt!.noteId) {
          fail(FirstmateJournalErrorCode.Conflict, "an accepted request cannot acquire a different note ID.")
        }
      }
      return this.publish({
        ...stored.entry,
        ...result,
        receipt: result.receipt ?? stored.entry.receipt,
      }, stored.stamp, assertHeld)
    })
  }

  private async pendingEntry(filename: string): Promise<StoredEntry | undefined> {
    if (filename === ".journal.lock") return undefined
    if (/^\.write-[a-f0-9-]{36}\.json$/u.test(filename)) {
      const staged = await this.statusIfPresent(path.join(this.root, filename))
      if (staged === undefined) fail(FirstmateJournalErrorCode.Changed, "a staged journal record is missing.")
      privateFile(staged, this.uid)
      return undefined
    }
    if (!filename.endsWith(".json")) fail(FirstmateJournalErrorCode.InvalidData, "the journal contains an unexpected filename.")
    const stored = await this.readEntry(filename.slice(0, -5))
    if (stored === undefined) fail(FirstmateJournalErrorCode.Changed, "a listed journal record is missing.")
    return stored.entry.status === "accepted" || stored.entry.status === "rejected" ? undefined : stored
  }

  async listPending(): Promise<ReadonlyArray<FirstmateJournalEntry>> {
    return this.locked(async (assertHeld) => {
      const entries: FirstmateJournalEntry[] = []
      let count = 0
      let bytes = 0
      const directory = await opendir(this.root)
      for await (const item of directory) {
        count += 1
        if (count > maximumListEntries) fail(FirstmateJournalErrorCode.InvalidData, "the journal listing exceeds its entry limit.")
        const stored = await this.pendingEntry(item.name)
        if (stored === undefined) continue
        bytes += stored.stamp.size
        if (bytes > maximumListBytes) fail(FirstmateJournalErrorCode.InvalidData, "pending journal records exceed the listing byte limit.")
        entries.push(stored.entry)
      }
      await assertHeld()
      return entries.sort((left, right) => left.request.requestId < right.request.requestId ? -1 : 1)
    })
  }
}

class InstanceSubmissionJournal implements FirstmateSubmissionJournal {
  constructor(
    private readonly reference: FirstmateInstanceReferenceV1,
    private readonly journal: FirstmateSubmissionJournal,
  ) {}

  private matches(entry: FirstmateJournalEntry): boolean {
    const fleet = entry.request.expectedFleet
    const matches = fleet.profile === this.reference.profile && fleet.instanceId === this.reference.instanceId
    if (!matches && this.reference.mode === "named") {
      fail(FirstmateJournalErrorCode.Conflict, "a named journal record belongs to another instance.")
    }
    return matches
  }

  private check(request: FirstmateSubmissionRequestV1): void {
    try {
      validateFirstmateInstanceFleet(this.reference, request.expectedFleet)
    } catch {
      fail(FirstmateJournalErrorCode.Conflict, "the request does not belong to this instance journal.")
    }
  }

  async prepare(request: FirstmateSubmissionRequestV1): Promise<FirstmateJournalEntry> {
    this.check(request)
    return this.journal.prepare(request)
  }

  async get(requestId: string): Promise<FirstmateJournalEntry | undefined> {
    const entry = await this.journal.get(requestId)
    return entry !== undefined && this.matches(entry) ? entry : undefined
  }

  async begin(request: FirstmateSubmissionRequestV1): Promise<FirstmateJournalEntry> {
    this.check(request)
    return this.journal.begin(request)
  }

  async record(request: FirstmateSubmissionRequestV1, outcome: FirstmateSubmissionOutcome): Promise<FirstmateJournalEntry> {
    this.check(request)
    return this.journal.record(request, outcome)
  }

  async listPending(): Promise<ReadonlyArray<FirstmateJournalEntry>> {
    return (await this.journal.listPending()).filter((entry) => this.matches(entry))
  }
}

export const scopeFirstmateJournal = (
  reference: FirstmateInstanceReferenceV1, journal: FirstmateSubmissionJournal,
): FirstmateSubmissionJournal => new InstanceSubmissionJournal(parseFirstmateInstanceReferenceV1(reference), journal)

export const createFirstmateJournalFactory = (legacyRoot = defaultFirstmateJournalPath()): FirstmateJournalFactory => {
  const journals = new Map<string, FirstmateSubmissionJournal>()
  return (value) => {
    const reference = parseFirstmateInstanceReferenceV1(value)
    const key = `${reference.mode}:${firstmateInstanceKey(reference)}`
    let journal = journals.get(key)
    if (journal === undefined) {
      const root = reference.mode === "legacy" ? legacyRoot
        : path.join(path.dirname(legacyRoot), "firstmate-instance-submissions", reference.profile, reference.instanceId)
      journal = scopeFirstmateJournal(reference, new FileFirstmateSubmissionJournal(root))
      journals.set(key, journal)
    }
    return journal
  }
}
