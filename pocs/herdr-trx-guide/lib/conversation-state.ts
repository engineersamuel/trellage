import fs, { constants } from "node:fs"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import properLockfile from "proper-lockfile"

import type { FocusedConversationBinding } from "./conversation-capture.ts"
import type { ConversationSnapshot } from "./conversation-contract.ts"
import { conversationCapturePolicy } from "./conversation-policy.ts"
import { assertNoConversationSymlinks } from "./conversation-reader.ts"
import { parseConversationBinding, parseConversationSnapshot } from "./conversation-validation.ts"

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const choicePrefix = "trellage-guide-conversation-choice:v1:"

const stateRoot = (value: string) => {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value ||
    value.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error("HERDR_PLUGIN_STATE_DIR must be an absolute normalized path.")
  }
  return value
}

const owned = (status, mode: number) =>
  !status.isSymbolicLink() && (status.mode & 0o7777) === mode &&
  (process.getuid === undefined || status.uid === process.getuid())

const safeStateAncestors = async (directory: string) => {
  let current = path.parse(directory).root
  const ancestors = path.dirname(directory).slice(current.length).split(path.sep).filter(Boolean)
  for (const component of ["", ...ancestors]) {
    current = path.join(current, component)
    const status = await lstat(current)
    const owner = process.getuid === undefined || status.uid === 0 || status.uid === process.getuid()
    if (!status.isDirectory() || status.isSymbolicLink() || !owner || (status.mode & 0o022) !== 0) {
      throw new Error("The conversation state has an unsafe ancestor directory.")
    }
  }
}

const privateDirectory = async (directory: string, create: boolean) => {
  try {
    const status = await lstat(directory)
    if (!status.isDirectory() || !owned(status, 0o700)) {
      throw new Error("The conversation state directory is not private and owned.")
    }
  } catch (error) {
    if (!create || error?.code !== "ENOENT") throw error
    await assertNoConversationSymlinks(path.dirname(directory))
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (creationError) {
      if (creationError?.code !== "EEXIST") throw creationError
    }
    return privateDirectory(directory, false)
  }
  await assertNoConversationSymlinks(directory)
}

const stateDirectories = async (stateDir: string, bucket: string, create: boolean) => {
  const root = stateRoot(stateDir)
  await safeStateAncestors(root)
  const continuations = path.join(root, "continuations")
  const directory = path.join(continuations, bucket)
  for (const current of [root, continuations, directory]) {
    await privateDirectory(current, create)
  }
  return directory
}

const checkedFile = (status) => {
  if (!status.isFile() || !owned(status, 0o600) || status.nlink !== 1 ||
    status.size === 0 || status.size > conversationCapturePolicy.maximumRequestBytes) {
    throw new Error("The conversation request must be a bounded private owned regular file with one link.")
  }
}

const sameFile = (before, after) => {
  checkedFile(after)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error("The private conversation record changed while it was being read.")
  }
}

const readPrivateJson = async (target: string, consume = false): Promise<unknown> => {
  await assertNoConversationSymlinks(target)
  const beforeOpen = await lstat(target)
  checkedFile(beforeOpen)
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    sameFile(beforeOpen, before)
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) throw new Error("The private conversation record was truncated.")
      offset += bytesRead
    }
    sameFile(before, await handle.stat())
    sameFile(before, await lstat(target))
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    } catch {
      throw new Error("The private conversation record is not valid JSON.")
    }
    if (consume) await unlink(target)
    return value
  } finally {
    await handle.close()
  }
}

const writeLockedJson = async (directory: string, value: unknown) => {
  const content = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(content) > conversationCapturePolicy.maximumRequestBytes) {
    throw new Error("The conversation request exceeds the configured private storage limit.")
  }
  const lockPath = path.join(directory, ".write.lock")
  try {
    await privateDirectory(lockPath, false)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  let compromised = false
  const release = await properLockfile.lock(directory, {
    realpath: false,
    lockfilePath: lockPath,
    stale: 300_000,
    update: 30_000,
    retries: { retries: 20, factor: 1, minTimeout: 25, maxTimeout: 50 },
    fs: {
      ...fs,
      mkdir: (target, callback) => fs.mkdir(target, { mode: 0o700 }, callback),
    },
    onCompromised: () => { compromised = true },
  })
  const target = path.join(directory, `${randomUUID()}.json`)
  const staging = path.join(directory, `.${randomUUID()}.part`)
  let stagingExists = false
  try {
    if (compromised) throw new Error("The conversation state lock was compromised.")
    await privateDirectory(directory, false)
    const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    stagingExists = true
    try {
      await handle.writeFile(content, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (compromised) throw new Error("The conversation state lock was compromised.")
    await privateDirectory(directory, false)
    await rename(staging, target)
    stagingExists = false
    return target
  } finally {
    if (stagingExists) {
      const status = await lstat(staging)
      if (status.isFile() && owned(status, 0o600) && status.nlink === 1) await unlink(staging)
    }
    await release()
    if (compromised) throw new Error("The conversation state lock was compromised.")
  }
}

export const writeConversationRequest = async (stateDir: string, snapshot: ConversationSnapshot): Promise<string> =>
  writeLockedJson(
    await stateDirectories(stateDir, "requests", true), parseConversationSnapshot(snapshot),
  )

const assertRequestLocation = (stateDir: string, target: string) => {
  const base = path.join(stateRoot(stateDir), "continuations")
  if (typeof target !== "string" || !path.isAbsolute(target) || target !== path.resolve(target)) {
    throw new Error("The conversation request path is invalid.")
  }
  const parts = path.relative(base, target).split(path.sep)
  if (parts.length === 2 && parts[0] === "requests" &&
    parts[1].endsWith(".json") && uuid.test(parts[1].slice(0, -5))) return
  throw new Error("The conversation request path is outside the owned continuation store.")
}

export const readConversationRequest = async (stateDir: string, target: string): Promise<ConversationSnapshot> => {
  assertRequestLocation(stateDir, target)
  await stateDirectories(stateDir, "requests", false)
  return parseConversationSnapshot(await readPrivateJson(target))
}

export const writeConversationChoice = async (stateDir: string, source: FocusedConversationBinding): Promise<string> => {
  const target = await writeLockedJson(
    await stateDirectories(stateDir, "choices", true),
    { schemaVersion: 1, source: parseConversationBinding(source) },
  )
  return `${choicePrefix}${path.basename(target, ".json")}`
}

const choicePath = async (stateDir: string, token: string) => {
  if (typeof token !== "string" || !token.startsWith(choicePrefix) || !uuid.test(token.slice(choicePrefix.length))) {
    throw new Error("The focused conversation choice token is invalid.")
  }
  return path.join(
    await stateDirectories(stateDir, "choices", false),
    `${token.slice(choicePrefix.length)}.json`,
  )
}

export const consumeConversationChoice = async (stateDir: string, token: string): Promise<FocusedConversationBinding> => {
  const value = await readPrivateJson(await choicePath(stateDir, token), true)
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    value["schemaVersion"] !== 1 || Object.keys(value).some((key) => !["schemaVersion", "source"].includes(key))) {
    throw new Error("The focused conversation choice is invalid.")
  }
  return parseConversationBinding(value["source"])
}

export const removeConversationChoice = async (stateDir: string, token: string) => {
  await readPrivateJson(await choicePath(stateDir, token), true)
}
