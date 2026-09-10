import { createHash, randomUUID } from "node:crypto"
import { constants, lstatSync, rmdirSync, type Stats } from "node:fs"
import { lstat, mkdir, open, rename, rmdir, unlink, type FileHandle } from "node:fs/promises"
import path from "node:path"
import lockfile from "proper-lockfile"
import {
  ContinuationActionStatus,
  conversationLimits,
  conversationSourceKey,
  validateContinuationDraft,
  validateConversationSnapshot,
  type ContinuationActionDraft,
  type ContinuationDraft,
  type ContinuationLaunchReceipt,
  type ConversationSnapshot,
  type ConversationSource,
} from "../../trellage-guide-core/dist/index.js"

export const continuationStateEnvironmentVariable = "HERDR_PLUGIN_STATE_DIR"
export const continuationRequestDirectory = "continuations/requests"

export enum ContinuationStoreErrorCode {
  InvalidRoot = "invalid-root",
  UnsafePath = "unsafe-path",
  PermissionDenied = "permission-denied",
  InvalidData = "invalid-data",
  MissingDraft = "missing-draft",
  MissingRequest = "missing-request",
  Changed = "changed",
  RevisionConflict = "revision-conflict",
  AttemptProtected = "attempt-protected",
  LockUnavailable = "lock-unavailable",
  IoFailure = "io-failure",
}

export class ContinuationStoreError extends Error {
  constructor(
    readonly code: ContinuationStoreErrorCode,
    message: string,
  ) {
    super(`Continuation state: ${message}`)
    this.name = "ContinuationStoreError"
  }
}

export class ContinuationRevisionConflictError extends ContinuationStoreError {
  constructor() {
    super(ContinuationStoreErrorCode.RevisionConflict, "draft revision conflict; reload before saving or launching.")
    this.name = "ContinuationRevisionConflictError"
  }
}

export interface ContinuationLaunchEvent extends Pick<
  ContinuationLaunchReceipt,
  "attemptId" | "status" | "paneId" | "workspaceId" | "cwd"
> {
  readonly actionId: string
}

interface Identity {
  readonly dev: number
  readonly ino: number
}

interface PrivateFile {
  readonly bytes: Buffer
  readonly stamp: Stats
}

interface ConsumedRequest {
  readonly stamp: Stats
  readonly digest: string
}

interface SourceIndex {
  readonly schemaVersion: 1
  readonly sourceKey: string
  readonly draftId: string
}

interface StoredLaunchEvent extends ContinuationLaunchEvent {
  readonly schemaVersion: 1
  readonly draftId: string
  readonly recordedAt: string
}

type AssertLock = () => Promise<void>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u
const controlPattern = /\p{Cc}/u
const sourceIndexBytes = 1024
const privateDirectories = ["requests", "drafts", "sources", "launch-events"] as const

function fail(code: ContinuationStoreErrorCode, message: string): never {
  throw new ContinuationStoreError(code, message)
}

const errno = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code

const ioFailure = (operation: string, error: unknown): never => {
  if (error instanceof ContinuationStoreError) throw error
  if (errno(error, "EACCES") || errno(error, "EPERM")) {
    return fail(
      ContinuationStoreErrorCode.PermissionDenied,
      `permission denied while attempting to ${operation}; nothing was acknowledged.`,
    )
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return fail(ContinuationStoreErrorCode.IoFailure, `could not ${operation}; private state was not confirmed saved.`)
  }
  throw error
}

const io = async <T>(operation: string, action: () => Promise<T>): Promise<T> => {
  try {
    return await action()
  } catch (error) {
    return ioFailure(operation, error)
  }
}

const sameIdentity = (left: Identity, right: Identity): boolean => left.dev === right.dev && left.ino === right.ino
const sameFile = (left: Stats, right: Stats): boolean =>
  sameIdentity(left, right) &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs

const fileStatus = (status: Stats, uid: number, maximum: number): void => {
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.uid !== uid ||
    (status.mode & 0o7777) !== 0o600 ||
    status.nlink !== 1
  ) {
    fail(ContinuationStoreErrorCode.UnsafePath, "files must be owned, single-link, mode-0600 regular files.")
  }
  if (status.size > maximum) fail(ContinuationStoreErrorCode.InvalidData, "private file exceeds its byte limit.")
}

const directoryStatus = (status: Stats, uid: number, privateMode: boolean): void => {
  if (!status.isDirectory() || status.isSymbolicLink()) {
    fail(
      ContinuationStoreErrorCode.UnsafePath,
      "directories and every ancestor must be real directories, not symbolic links.",
    )
  }
  if (privateMode) {
    if (status.uid !== uid || (status.mode & 0o7777) !== 0o700) {
      fail(
        ContinuationStoreErrorCode.UnsafePath,
        "private directories must be owned mode-0700 directories; permissions were not changed.",
      )
    }
  } else if ((status.uid !== uid && status.uid !== 0) || (status.mode & 0o022) !== 0) {
    fail(ContinuationStoreErrorCode.UnsafePath, "a state ancestor has an unsafe owner or writable permissions.")
  }
}

const id = (value: unknown): string => {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    return fail(ContinuationStoreErrorCode.InvalidData, "draft and request names must be opaque UUIDs.")
  }
  return value
}

const jsonObject = (
  value: unknown,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
): Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    return fail(ContinuationStoreErrorCode.InvalidData, "metadata must be a plain JSON object.")
  }
  const allowed = new Set([...required, ...optional])
  const fields: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      return fail(
        ContinuationStoreErrorCode.InvalidData,
        "metadata contains unsupported fields; prompts and commands are not journal metadata.",
      )
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value") || descriptor.value === undefined) {
      return fail(ContinuationStoreErrorCode.InvalidData, "metadata must contain only defined JSON fields.")
    }
    fields[key] = descriptor.value
  }
  if (required.some((key) => !Object.hasOwn(fields, key))) {
    return fail(ContinuationStoreErrorCode.InvalidData, "metadata is missing required fields.")
  }
  return fields
}

const decode = (bytes: Buffer): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return fail(ContinuationStoreErrorCode.InvalidData, "private file must contain valid UTF-8.")
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return fail(ContinuationStoreErrorCode.InvalidData, "private file contains invalid JSON; content was not logged.")
  }
}

const checkedIndex = (value: unknown, sourceKey: string): SourceIndex => {
  const fields = jsonObject(value, ["schemaVersion", "sourceKey", "draftId"])
  if (fields.schemaVersion !== 1 || fields.sourceKey !== sourceKey) {
    return fail(ContinuationStoreErrorCode.InvalidData, "source index does not match the exact source.")
  }
  return { schemaVersion: 1, sourceKey, draftId: id(fields.draftId) }
}

const metadataIdentifier = (value: unknown): string => {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    return fail(ContinuationStoreErrorCode.InvalidData, "launch metadata contains an invalid identifier.")
  }
  return value
}

const metadataPath = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length > conversationLimits.pathChars ||
    !path.isAbsolute(value) ||
    controlPattern.test(value) ||
    value.split("/").includes("..")
  ) {
    return fail(ContinuationStoreErrorCode.InvalidData, "launch metadata contains an invalid destination path.")
  }
  return value
}

const launchEvent = (value: unknown): ContinuationLaunchEvent => {
  const fields = jsonObject(value, ["actionId", "attemptId", "status"], ["paneId", "workspaceId", "cwd"])
  const status = [
    ContinuationActionStatus.Launching,
    ContinuationActionStatus.Launched,
    ContinuationActionStatus.Failed,
    ContinuationActionStatus.Unknown,
  ].find((member) => member === fields.status)
  if (status === undefined)
    return fail(ContinuationStoreErrorCode.InvalidData, "journal status is not a launch outcome.")
  return {
    actionId: metadataIdentifier(fields.actionId),
    attemptId: id(fields.attemptId),
    status,
    ...(fields.paneId === undefined ? {} : { paneId: metadataIdentifier(fields.paneId) }),
    ...(fields.workspaceId === undefined ? {} : { workspaceId: metadataIdentifier(fields.workspaceId) }),
    ...(fields.cwd === undefined ? {} : { cwd: metadataPath(fields.cwd) }),
  }
}

const validateLaunchBinding = (draft: ContinuationDraft, event: ContinuationLaunchEvent): void => {
  const action = draft.actions.find(({ actionId }) => actionId === event.actionId)
  const launch = action?.launch
  if (
    action === undefined ||
    launch === undefined ||
    launch.attemptId !== event.attemptId ||
    action.status !== event.status
  ) {
    return fail(ContinuationStoreErrorCode.InvalidData, "journal event must match a durable action launch attempt.")
  }
  for (const key of ["paneId", "workspaceId", "cwd"] as const) {
    if (event[key] !== undefined && event[key] !== launch[key]) {
      fail(ContinuationStoreErrorCode.InvalidData, "journal destination must match the saved launch receipt.")
    }
  }
}

const protectedLaunchStates = new Set([
  ContinuationActionStatus.Launching,
  ContinuationActionStatus.Launched,
  ContinuationActionStatus.Unknown,
])

const launchOutcomeStates = new Set([...protectedLaunchStates, ContinuationActionStatus.Failed])

const preparedActionIdentity = (action: ContinuationActionDraft): string => {
  const { selected: _selected, status: _status, launch: _launch, ...prepared } = action
  return JSON.stringify(prepared)
}

const protectLaunchReceipt = (current: ContinuationActionDraft, next: ContinuationActionDraft): void => {
  if (current.launch === undefined || next.launch === undefined || current.launch.attemptId !== next.launch.attemptId) {
    fail(ContinuationStoreErrorCode.AttemptProtected, "a saved launch attempt cannot be removed or replaced.")
  }
  for (const key of ["paneId", "workspaceId", "cwd"] as const) {
    if (current.launch[key] !== undefined && current.launch[key] !== next.launch[key]) {
      fail(ContinuationStoreErrorCode.AttemptProtected, "a saved launch destination cannot be changed or cleared.")
    }
  }
}

const protectStartedAction = (current: ContinuationActionDraft, next: ContinuationActionDraft | undefined): void => {
  if (next === undefined || preparedActionIdentity(current) !== preparedActionIdentity(next)) {
    fail(
      ContinuationStoreErrorCode.AttemptProtected,
      "a started or unknown action cannot be removed or edited; inspect its receipt.",
    )
  }
  const allowed =
    current.status === ContinuationActionStatus.Launching
      ? launchOutcomeStates.has(next.status)
      : current.status === next.status
  if (!allowed) {
    fail(ContinuationStoreErrorCode.AttemptProtected, "a started or unknown attempt cannot be reset or resent.")
  }
  protectLaunchReceipt(current, next)
}

const protectSavedAttempts = (current: ContinuationDraft, next: ContinuationDraft): void => {
  for (const action of current.actions) {
    const updated = next.actions.find(({ actionId }) => actionId === action.actionId)
    if (protectedLaunchStates.has(action.status)) {
      protectStartedAction(action, updated)
    } else if (
      updated?.status === ContinuationActionStatus.Launching &&
      action.launch !== undefined &&
      action.launch.attemptId === updated.launch?.attemptId
    ) {
      fail(ContinuationStoreErrorCode.AttemptProtected, "an explicit retry requires a fresh launch attempt identity.")
    }
  }
}

const storedLaunchEvent = (value: unknown, draftId: string): StoredLaunchEvent => {
  const fields = jsonObject(
    value,
    ["schemaVersion", "draftId", "recordedAt", "actionId", "attemptId", "status"],
    ["paneId", "workspaceId", "cwd"],
  )
  if (
    fields.schemaVersion !== 1 ||
    fields.draftId !== draftId ||
    typeof fields.recordedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(fields.recordedAt) ||
    !Number.isFinite(Date.parse(fields.recordedAt))
  ) {
    return fail(ContinuationStoreErrorCode.InvalidData, "journal record has invalid identity or time metadata.")
  }
  if (new Date(fields.recordedAt).toISOString() !== fields.recordedAt) {
    return fail(ContinuationStoreErrorCode.InvalidData, "journal timestamp is not a valid calendar time.")
  }
  const { schemaVersion: _version, draftId: _id, recordedAt, ...event } = fields
  return { schemaVersion: 1, draftId, recordedAt: recordedAt as string, ...launchEvent(event) }
}

const validateJournal = (bytes: Buffer, draftId: string): void => {
  const text = decode(bytes)
  if (text.length === 0) return
  if (!text.endsWith("\n"))
    fail(
      ContinuationStoreErrorCode.InvalidData,
      "launch journal has an incomplete record; automatic append is blocked.",
    )
  for (const line of text.slice(0, -1).split("\n")) {
    if (Buffer.byteLength(line, "utf8") > conversationLimits.journalEventBytes) {
      fail(ContinuationStoreErrorCode.InvalidData, "launch journal record exceeds its byte limit.")
    }
    storedLaunchEvent(parseJson(line), draftId)
  }
}

const ancestorPaths = (directory: string): ReadonlyArray<string> => {
  const root = path.parse(directory).root
  const result = [root]
  for (const component of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    result.push(path.join(result[result.length - 1]!, component))
  }
  return result
}

const readBounded = async (handle: FileHandle, length: number): Promise<Buffer> => {
  const bytes = Buffer.allocUnsafe(length + 1)
  let offset = 0
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  if (offset !== length)
    fail(ContinuationStoreErrorCode.Changed, "private file changed during the read; reopen the request or draft.")
  return bytes.subarray(0, offset)
}

const lockGuard = (filename: string, uid: number, verifyTree: AssertLock, verifyTreeSync: () => void) => {
  let held: Identity | undefined
  const checkedStatus = (status: Stats): Stats => {
    directoryStatus(status, uid, true)
    if (held !== undefined && !sameIdentity(status, held)) {
      fail(ContinuationStoreErrorCode.Changed, "lock directory was replaced; no state operation can continue.")
    }
    return status
  }
  const stat = async (): Promise<Stats> => {
    await verifyTree()
    return checkedStatus(await lstat(filename))
  }
  const remove = async (): Promise<void> => {
    await stat()
    await rmdir(filename)
    held = undefined
  }
  const touch = async (atime: Date, mtime: Date): Promise<void> => {
    const before = await stat()
    const handle = await open(filename, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const opened = checkedStatus(await handle.stat())
      if (!sameIdentity(before, opened)) fail(ContinuationStoreErrorCode.Changed, "lock changed while opening it.")
      await handle.utimes(atime, mtime)
      await stat()
    } finally {
      await handle.close()
    }
  }
  type Callback = (error: Error | null) => void
  return {
    fs: {
      mkdir: (_target: string, callback: Callback) => {
        void (async () => {
          await verifyTree()
          await mkdir(filename, { mode: 0o700 })
          held = checkedStatus(await lstat(filename))
        })().then(() => callback(null), callback)
      },
      stat: (_target: string, callback: (error: Error | null, status?: Stats) => void) => {
        void stat().then((status) => callback(null, status), callback)
      },
      utimes: (_target: string, atime: Date, mtime: Date, callback: Callback) => {
        void touch(atime, mtime).then(() => callback(null), callback)
      },
      rmdir: (_target: string, callback: Callback) => {
        void remove().then(() => callback(null), callback)
      },
      rmdirSync: () => {
        verifyTreeSync()
        checkedStatus(lstatSync(filename))
        rmdirSync(filename)
      },
    },
    assertHeld: async () => {
      if (held === undefined) fail(ContinuationStoreErrorCode.LockUnavailable, "private state lock is no longer held.")
      await stat()
    },
  }
}

export class ContinuationStore {
  private readonly root: string
  private readonly directory: string
  private readonly uid: number
  private readonly directories = new Map<string, Identity>()
  private readonly consumed = new Map<string, ConsumedRequest>()
  private readonly stagedRequests = new Map<string, ConsumedRequest>()

  constructor(root: string) {
    if (
      typeof root !== "string" ||
      root.length > conversationLimits.pathChars ||
      !path.isAbsolute(root) ||
      root.split(path.sep).includes("..") ||
      controlPattern.test(root) ||
      path.resolve(root) === path.parse(root).root
    ) {
      fail(
        ContinuationStoreErrorCode.InvalidRoot,
        "HERDR_PLUGIN_STATE_DIR must be a non-root absolute private directory.",
      )
    }
    if (process.getuid === undefined)
      fail(ContinuationStoreErrorCode.InvalidRoot, "private continuation state requires a POSIX user identity.")
    this.root = path.resolve(root)
    this.directory = path.join(this.root, "continuations")
    this.uid = process.getuid()
  }

  private checkDirectory(directory: string, status: Stats): void {
    const privateMode = directory === this.root || directory.startsWith(`${this.root}${path.sep}`)
    directoryStatus(status, this.uid, privateMode)
    const previous = this.directories.get(directory)
    if (previous !== undefined && !sameIdentity(previous, status)) {
      fail(ContinuationStoreErrorCode.Changed, "a state directory was replaced; reopen the continuation.")
    }
    this.directories.set(directory, { dev: status.dev, ino: status.ino })
  }

  private async directoryStatus(directory: string, create: boolean): Promise<{ status: Stats; created: boolean }> {
    try {
      return { status: await lstat(directory), created: false }
    } catch (error) {
      if (!create || !errno(error, "ENOENT")) return ioFailure("inspect a state directory", error)
      if (this.directories.has(directory)) {
        return fail(ContinuationStoreErrorCode.Changed, "a known state directory is missing; it was not recreated.")
      }
      let created = false
      try {
        await mkdir(directory, { mode: 0o700 })
        created = true
      } catch (createError) {
        if (!errno(createError, "EEXIST")) return ioFailure("create a private state directory", createError)
      }
      return { status: await io("inspect a new state directory", () => lstat(directory)), created }
    }
  }

  private async inspectDirectory(directory: string, create = false): Promise<void> {
    for (const ancestor of ancestorPaths(directory)) {
      const { status, created } = await this.directoryStatus(ancestor, create)
      this.checkDirectory(ancestor, status)
      if (created) await this.syncDirectory(path.dirname(ancestor))
    }
  }

  private inspectDirectorySync(directory: string): void {
    for (const ancestor of ancestorPaths(directory)) this.checkDirectory(ancestor, lstatSync(ancestor))
  }

  private async initialize(): Promise<void> {
    await this.inspectDirectory(this.directory, true)
    for (const name of privateDirectories) await this.inspectDirectory(path.join(this.directory, name), true)
  }

  private async locked<T>(operation: (assertLock: AssertLock) => Promise<T>): Promise<T> {
    await this.initialize()
    const lockPath = path.join(this.directory, ".store.lock")
    const existingLock = await this.statusIfPresent(lockPath)
    if (existingLock !== undefined) directoryStatus(existingLock, this.uid, true)
    const guard = lockGuard(
      lockPath,
      this.uid,
      () => this.inspectDirectory(this.directory),
      () => this.inspectDirectorySync(this.directory),
    )
    let compromised = false
    let release: () => Promise<void>
    try {
      release = await lockfile.lock(this.directory, {
        realpath: false,
        lockfilePath: path.join(this.directory, ".store.lock"),
        fs: guard.fs,
        stale: 30_000,
        update: 10_000,
        retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 50, randomize: true },
        onCompromised: () => {
          compromised = true
        },
      })
    } catch (error) {
      if (errno(error, "ELOCKED")) {
        return fail(
          ContinuationStoreErrorCode.LockUnavailable,
          "another window holds the private state lock; retry after it finishes.",
        )
      }
      return ioFailure("acquire the private state lock", error)
    }
    const assertLock = async (): Promise<void> => {
      if (compromised)
        fail(ContinuationStoreErrorCode.LockUnavailable, "private state lock was compromised; saving is blocked.")
      await guard.assertHeld()
    }
    try {
      await assertLock()
      const result = await operation(assertLock)
      await assertLock()
      return result
    } finally {
      await io("release the private state lock", release)
    }
  }

  private async statusIfPresent(filename: string): Promise<Stats | undefined> {
    await this.inspectDirectory(path.dirname(filename))
    try {
      return await lstat(filename)
    } catch (error) {
      if (!errno(error, "ENOENT")) return ioFailure("inspect a private file", error)
      await this.inspectDirectory(path.dirname(filename))
      return undefined
    }
  }

  private async readPrivate(filename: string, maximum: number): Promise<PrivateFile | undefined> {
    const before = await this.statusIfPresent(filename)
    if (before === undefined) return undefined
    fileStatus(before, this.uid, maximum)
    const handle = await io("open a private file safely", () =>
      open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    )
    try {
      const opened = await handle.stat()
      fileStatus(opened, this.uid, maximum)
      if (!sameFile(before, opened)) fail(ContinuationStoreErrorCode.Changed, "private file changed while opening it.")
      const bytes = await io("read a bounded private file", () => readBounded(handle, opened.size))
      const after = await handle.stat()
      fileStatus(after, this.uid, maximum)
      const current = await this.statusIfPresent(filename)
      if (current === undefined || !sameFile(opened, after) || !sameFile(after, current)) {
        fail(ContinuationStoreErrorCode.Changed, "private file changed during the read.")
      }
      fileStatus(current, this.uid, maximum)
      return { bytes, stamp: current }
    } finally {
      await handle.close()
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    await this.inspectDirectory(directory)
    await io("sync the private state directory", async () => {
      const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        this.checkDirectory(directory, await handle.stat())
        await handle.sync()
        await this.inspectDirectory(directory)
      } finally {
        await handle.close()
      }
    })
  }

  private async checkUnchanged(filename: string, expected: Stats | undefined, maximum: number): Promise<void> {
    const current = await this.statusIfPresent(filename)
    if (current !== undefined) fileStatus(current, this.uid, maximum)
    if (current === undefined && expected === undefined) return
    if (current === undefined || expected === undefined || !sameFile(current, expected)) {
      fail(ContinuationStoreErrorCode.Changed, "private file was replaced or changed; saving is blocked.")
    }
  }

  private async removePrivate(filename: string, expected: Stats, assertLock: AssertLock): Promise<void> {
    await assertLock()
    await this.checkUnchanged(filename, expected, Number.MAX_SAFE_INTEGER)
    await io("remove verified private state", () => unlink(filename))
    await this.syncDirectory(path.dirname(filename))
  }

  private async writeStaged(filename: string, bytes: Buffer, onCreated: (stamp: Identity) => void): Promise<Stats> {
    const handle = await io("create a private staging file", () =>
      open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600),
    )
    try {
      const initial = await handle.stat()
      fileStatus(initial, this.uid, bytes.length)
      onCreated(initial)
      await io("write and sync private state", async () => {
        await handle.writeFile(bytes)
        await handle.sync()
      })
      const written = await handle.stat()
      fileStatus(written, this.uid, bytes.length)
      const current = await this.statusIfPresent(filename)
      if (current === undefined || !sameFile(current, written))
        fail(ContinuationStoreErrorCode.Changed, "staged state changed while saving.")
      return current
    } finally {
      await handle.close()
    }
  }

  private async cleanStaged(filename: string, expected: Identity, assertLock: AssertLock): Promise<void> {
    const current = await this.statusIfPresent(filename)
    if (current === undefined) return
    fileStatus(current, this.uid, conversationLimits.draftBytes)
    if (!sameIdentity(current, expected))
      fail(ContinuationStoreErrorCode.Changed, "staging file was replaced; it was not removed.")
    await this.removePrivate(filename, current, assertLock)
  }

  private async writeJson(
    filename: string,
    value: object,
    maximum: number,
    expected: Stats | undefined,
    assertLock: AssertLock,
  ): Promise<PrivateFile> {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8")
    if (bytes.length > maximum)
      fail(ContinuationStoreErrorCode.InvalidData, "serialized private state exceeds its byte limit.")
    await this.checkUnchanged(filename, expected, maximum)
    const staged = path.join(path.dirname(filename), `.write-${randomUUID()}.json`)
    let stamp: Stats | undefined
    let created: Identity | undefined
    let published = false
    try {
      stamp = await this.writeStaged(staged, bytes, (identity) => {
        created = identity
      })
      await assertLock()
      await this.checkUnchanged(staged, stamp, maximum)
      await this.checkUnchanged(filename, expected, maximum)
      await io("publish private state atomically", () => rename(staged, filename))
      published = true
      const saved = await this.statusIfPresent(filename)
      if (saved === undefined || !sameIdentity(saved, stamp))
        fail(ContinuationStoreErrorCode.Changed, "published state was replaced.")
      fileStatus(saved, this.uid, maximum)
      await this.syncDirectory(path.dirname(filename))
      return { bytes, stamp: saved }
    } finally {
      if (!published && created !== undefined) await this.cleanStaged(staged, created, assertLock)
    }
  }

  private requestPath(filename: string): string {
    if (typeof filename !== "string" || !path.isAbsolute(filename) || filename.split(path.sep).includes("..")) {
      return fail(
        ContinuationStoreErrorCode.UnsafePath,
        "request must be an absolute path under continuations/requests.",
      )
    }
    const normalized = path.resolve(filename)
    if (path.dirname(normalized) !== path.join(this.directory, "requests") || !normalized.endsWith(".json")) {
      return fail(ContinuationStoreErrorCode.UnsafePath, "request path is outside the private requests directory.")
    }
    id(path.basename(normalized, ".json"))
    return normalized
  }

  private draftPath(draftId: string): string {
    return path.join(this.directory, "drafts", `${id(draftId)}.json`)
  }

  private sourcePath(sourceKey: string): string {
    return path.join(this.directory, "sources", `${sourceKey}.json`)
  }

  private async readDraft(draftId: string): Promise<{ readonly draft: ContinuationDraft; readonly stamp: Stats }> {
    const file = await this.readPrivate(this.draftPath(draftId), conversationLimits.draftBytes)
    if (file === undefined)
      return fail(ContinuationStoreErrorCode.MissingDraft, "saved draft is missing; no empty replacement was created.")
    const draft = validateContinuationDraft(parseJson(decode(file.bytes)))
    if (draft.id !== draftId)
      return fail(ContinuationStoreErrorCode.InvalidData, "saved draft identity does not match its filename.")
    return { draft, stamp: file.stamp }
  }

  private async findDraft(sourceKey: string): Promise<ContinuationDraft | undefined> {
    const file = await this.readPrivate(this.sourcePath(sourceKey), sourceIndexBytes)
    if (file === undefined) return undefined
    const index = checkedIndex(parseJson(decode(file.bytes)), sourceKey)
    const { draft } = await this.readDraft(index.draftId)
    if (conversationSourceKey(draft.snapshot.source) !== sourceKey) {
      return fail(ContinuationStoreErrorCode.InvalidData, "saved draft does not belong to the exact focused source.")
    }
    return draft
  }

  private assertRequestReceipts(request: string, file: PrivateFile): void {
    const receipts = [this.consumed.get(request), this.stagedRequests.get(request)].filter(
      (receipt) => receipt !== undefined,
    )
    if (receipts.length === 0) return
    const digest = createHash("sha256").update(file.bytes).digest("hex")
    if (receipts.some((receipt) => !sameFile(receipt.stamp, file.stamp) || receipt.digest !== digest)) {
      fail(
        ContinuationStoreErrorCode.Changed,
        "conversation request changed after it was staged or read; it was not deleted.",
      )
    }
  }

  /** This instance can acknowledge its private freshness probes without creating a draft. */
  async stageRequest(snapshot: ConversationSnapshot): Promise<string> {
    const parsed = validateConversationSnapshot(snapshot)
    return this.locked(async (assertLock) => {
      const request = path.join(this.directory, "requests", `${randomUUID()}.json`)
      const file = await this.writeJson(request, parsed, conversationLimits.snapshotBytes, undefined, assertLock)
      this.stagedRequests.set(request, {
        stamp: file.stamp,
        digest: createHash("sha256").update(file.bytes).digest("hex"),
      })
      return request
    })
  }

  /** Imported handoffs require a durable source-bound draft before acknowledgment. */
  async consumeRequest(filename: string): Promise<ConversationSnapshot> {
    const request = this.requestPath(filename)
    return this.locked(async () => {
      const file = await this.readPrivate(request, conversationLimits.snapshotBytes)
      if (file === undefined)
        return fail(
          ContinuationStoreErrorCode.MissingRequest,
          "conversation request is missing; reopen the source picker.",
        )
      this.assertRequestReceipts(request, file)
      const snapshot = validateConversationSnapshot(parseJson(decode(file.bytes)))
      this.consumed.set(request, { stamp: file.stamp, digest: createHash("sha256").update(file.bytes).digest("hex") })
      return snapshot
    })
  }

  async acknowledgeRequest(filename: string): Promise<void> {
    const request = this.requestPath(filename)
    return this.locked(async (assertLock) => {
      const file = await this.readPrivate(request, conversationLimits.snapshotBytes)
      if (file === undefined)
        return fail(
          ContinuationStoreErrorCode.MissingRequest,
          "conversation request is missing; acknowledgment was not repeated.",
        )
      const snapshot = validateConversationSnapshot(parseJson(decode(file.bytes)))
      this.assertRequestReceipts(request, file)
      if (
        !this.stagedRequests.has(request) &&
        (await this.findDraft(conversationSourceKey(snapshot.source))) === undefined
      ) {
        fail(
          ContinuationStoreErrorCode.MissingDraft,
          "create a durable source-bound draft before acknowledging its request.",
        )
      }
      await this.removePrivate(request, file.stamp, assertLock)
      this.consumed.delete(request)
      this.stagedRequests.delete(request)
    })
  }

  async create(snapshot: ConversationSnapshot, model: string, effort: string): Promise<ContinuationDraft> {
    const draft = validateContinuationDraft({
      schemaVersion: 1,
      id: randomUUID(),
      revision: 0,
      snapshot,
      model,
      effort,
      summaries: [],
      actions: [],
    })
    return this.locked(async (assertLock) => {
      const sourceKey = conversationSourceKey(draft.snapshot.source)
      const previous = await this.readPrivate(this.sourcePath(sourceKey), sourceIndexBytes)
      if (previous !== undefined) await this.findDraft(sourceKey)
      await this.writeJson(this.draftPath(draft.id), draft, conversationLimits.draftBytes, undefined, assertLock)
      await this.writeJson(
        this.sourcePath(sourceKey),
        { schemaVersion: 1, sourceKey, draftId: draft.id },
        sourceIndexBytes,
        previous?.stamp,
        assertLock,
      )
      return draft
    })
  }

  async find(source: ConversationSource): Promise<ContinuationDraft | undefined> {
    const sourceKey = conversationSourceKey(source)
    return this.locked(() => this.findDraft(sourceKey))
  }

  async load(draftId: string): Promise<ContinuationDraft> {
    id(draftId)
    return this.locked(async () => (await this.readDraft(draftId)).draft)
  }

  async save(value: ContinuationDraft, expectedRevision: number): Promise<ContinuationDraft> {
    const draft = validateContinuationDraft(value)
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER ||
      draft.revision !== expectedRevision
    )
      throw new ContinuationRevisionConflictError()
    return this.locked(async (assertLock) => {
      const current = await this.readDraft(draft.id)
      if (current.draft.revision !== expectedRevision) throw new ContinuationRevisionConflictError()
      if (JSON.stringify(current.draft.snapshot) !== JSON.stringify(draft.snapshot)) {
        fail(ContinuationStoreErrorCode.Changed, "draft snapshots are immutable; create a new draft to analyze latest.")
      }
      protectSavedAttempts(current.draft, draft)
      const saved = validateContinuationDraft({ ...draft, revision: expectedRevision + 1 })
      await this.writeJson(this.draftPath(draft.id), saved, conversationLimits.draftBytes, current.stamp, assertLock)
      return saved
    })
  }

  /** The snapshot is embedded in the draft. The separate append-only journal is retained. */
  async discard(draftId: string): Promise<void> {
    id(draftId)
    return this.locked(async (assertLock) => {
      const current = await this.readDraft(draftId)
      const sourceKey = conversationSourceKey(current.draft.snapshot.source)
      const sourceFile = await this.readPrivate(this.sourcePath(sourceKey), sourceIndexBytes)
      const index = sourceFile === undefined ? undefined : checkedIndex(parseJson(decode(sourceFile.bytes)), sourceKey)
      if (index?.draftId === draftId && sourceFile !== undefined) {
        await this.removePrivate(this.sourcePath(sourceKey), sourceFile.stamp, assertLock)
      }
      await this.removePrivate(this.draftPath(draftId), current.stamp, assertLock)
    })
  }

  private async appendJournal(
    filename: string,
    bytes: Buffer,
    previous: PrivateFile | undefined,
    assertLock: AssertLock,
  ): Promise<void> {
    await assertLock()
    await this.checkUnchanged(filename, previous?.stamp, conversationLimits.journalBytes)
    const flags =
      constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      (previous === undefined ? constants.O_CREAT | constants.O_EXCL : 0)
    await io("append and sync launch metadata", async () => {
      const handle = await open(filename, flags, 0o600)
      try {
        const opened = await handle.stat()
        fileStatus(opened, this.uid, conversationLimits.journalBytes)
        if (previous !== undefined && !sameFile(opened, previous.stamp)) {
          fail(ContinuationStoreErrorCode.Changed, "launch journal changed while opening it.")
        }
        await handle.writeFile(bytes)
        await handle.sync()
        const saved = await handle.stat()
        fileStatus(saved, this.uid, conversationLimits.journalBytes)
        const current = await this.statusIfPresent(filename)
        if (current === undefined || !sameFile(current, saved) || saved.size !== opened.size + bytes.length) {
          fail(ContinuationStoreErrorCode.Changed, "launch journal changed while appending metadata.")
        }
      } finally {
        await handle.close()
      }
    })
    await this.syncDirectory(path.dirname(filename))
  }

  async appendLaunchEvent(draftId: string, value: ContinuationLaunchEvent): Promise<void> {
    id(draftId)
    const event = launchEvent(value)
    return this.locked(async (assertLock) => {
      const { draft } = await this.readDraft(draftId)
      validateLaunchBinding(draft, event)
      const filename = path.join(this.directory, "launch-events", `${draftId}.jsonl`)
      const previous = await this.readPrivate(filename, conversationLimits.journalBytes)
      if (previous !== undefined) validateJournal(previous.bytes, draftId)
      const record: StoredLaunchEvent = { schemaVersion: 1, draftId, recordedAt: new Date().toISOString(), ...event }
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8")
      if (
        bytes.length > conversationLimits.journalEventBytes ||
        (previous?.bytes.length ?? 0) + bytes.length > conversationLimits.journalBytes
      ) {
        fail(ContinuationStoreErrorCode.InvalidData, "launch journal byte limit reached; metadata was not truncated.")
      }
      await this.appendJournal(filename, bytes, previous, assertLock)
    })
  }
}
