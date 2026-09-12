import { constants, type Stats } from "node:fs"
import { lstat, open, realpath, type FileHandle } from "node:fs/promises"
import { createHash, type Hash } from "node:crypto"
import path from "node:path"

import { conversationCapturePolicy, type ConversationCapturePolicy } from "./conversation-policy.ts"
import { isIncompleteJson } from "./json-prefix.ts"

export interface ConversationRecord {
  readonly value: Record<string, unknown>
  readonly recordIndex: number
}

export class ConversationSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConversationSourceError"
  }
}

const inside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export const assertNoConversationSymlinks = async (target: string) => {
  if (!path.isAbsolute(target)) throw new ConversationSourceError("Conversation paths must be absolute.")
  let current = path.parse(target).root
  for (const component of path.resolve(target).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    if ((await lstat(current)).isSymbolicLink()) {
      throw new ConversationSourceError("Conversation paths must not contain symbolic links.")
    }
  }
}

const safeFile = (status: Stats) => {
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 ||
    (process.getuid !== undefined && status.uid !== process.getuid())) {
    throw new ConversationSourceError("The conversation source is not an owned regular file.")
  }
}

const unchangedFile = (initial: Stats, current: Stats, length: number) => {
  safeFile(current)
  if (initial.dev !== current.dev || initial.ino !== current.ino || current.size < length) {
    throw new ConversationSourceError("The conversation source was replaced or truncated during capture.")
  }
}

const recordValue = (source: string, recordIndex: number): ConversationRecord => {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new ConversationSourceError(`Conversation record ${recordIndex + 1} is malformed.`)
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversationSourceError(`Conversation record ${recordIndex + 1} is not an object.`)
  }
  return { value: value as Record<string, unknown>, recordIndex }
}

const decode = (buffer: Buffer, recordIndex: number, tail = false) => {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const text = decoder.decode(buffer, { stream: tail })
    if (tail) {
      try {
        decoder.decode()
      } catch {
        return { text, incomplete: true }
      }
    }
    return { text, incomplete: false }
  } catch {
    throw new ConversationSourceError(`Conversation record ${recordIndex + 1} has invalid UTF-8.`)
  }
}

const verifyFrozenPrefix = async (
  handle: FileHandle, filePath: string, initial: Stats, frozenBytes: number,
  digest: Hash, policy: ConversationCapturePolicy, signal: AbortSignal | undefined,
) => {
  await assertNoConversationSymlinks(filePath)
  unchangedFile(initial, await lstat(filePath), frozenBytes)
  unchangedFile(initial, await handle.stat(), frozenBytes)
  const verify = createHash("sha256")
  let offset = 0
  while (offset < frozenBytes) {
    signal?.throwIfAborted()
    const buffer = Buffer.alloc(Math.min(policy.readChunkBytes, frozenBytes - offset))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    if (bytesRead === 0) {
      throw new ConversationSourceError("The conversation source was truncated during capture.")
    }
    verify.update(buffer.subarray(0, bytesRead))
    offset += bytesRead
  }
  const prefixDigest = digest.digest("hex")
  if (verify.digest("hex") !== prefixDigest) {
    throw new ConversationSourceError("The conversation source prefix changed during capture.")
  }
  unchangedFile(initial, await lstat(filePath), frozenBytes)
  return prefixDigest
}

export const readStableConversationRecords = async (
  filePath: string,
  roots: ReadonlyArray<string>,
  {
    policy = conversationCapturePolicy,
    signal,
    afterPrefixRead,
  }: {
    readonly policy?: ConversationCapturePolicy
    readonly signal?: AbortSignal | undefined
    readonly afterPrefixRead?: () => Promise<void>
  } = {},
) => {
  signal?.throwIfAborted()
  await assertNoConversationSymlinks(filePath)
  const canonical = await realpath(filePath)
  if (!roots.some((root) => inside(root, canonical))) {
    throw new ConversationSourceError("The conversation source is outside the allowed session roots.")
  }
  const beforeOpen = await lstat(filePath)
  safeFile(beforeOpen)
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const initial = await handle.stat()
    unchangedFile(beforeOpen, initial, beforeOpen.size)
    const frozenBytes = initial.size
    if (frozenBytes > policy.maximumTranscriptBytes) {
      throw new ConversationSourceError("The full conversation exceeds the configured transcript byte limit.")
    }
    const records: ConversationRecord[] = []
    const notices: string[] = []
    const digest = createHash("sha256")
    let pending: Buffer[] = []
    let pendingBytes = 0
    let recordIndex = 0
    let offset = 0
    const append = (part: Buffer) => {
      pendingBytes += part.length
      if (pendingBytes > policy.maximumRecordBytes) {
        throw new ConversationSourceError(`Conversation record ${recordIndex + 1} exceeds the configured record byte limit.`)
      }
      pending.push(part)
    }
    const commit = (tail: boolean) => {
      if (++recordIndex > policy.maximumRecords) {
        throw new ConversationSourceError("The conversation exceeds the configured record count limit.")
      }
      const { text, incomplete } = decode(Buffer.concat(pending, pendingBytes), recordIndex - 1, tail)
      if (tail && (incomplete || isIncompleteJson(text))) {
        notices.push("One incomplete trailing transcript record was excluded.")
      } else if (text.trim().length > 0) {
        records.push(recordValue(text, recordIndex - 1))
      }
      pending = []
      pendingBytes = 0
    }
    while (offset < frozenBytes) {
      signal?.throwIfAborted()
      const buffer = Buffer.alloc(Math.min(policy.readChunkBytes, frozenBytes - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead === 0) {
        throw new ConversationSourceError("The conversation source was truncated during capture.")
      }
      const chunk = buffer.subarray(0, bytesRead)
      digest.update(chunk)
      offset += bytesRead
      let start = 0
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        append(chunk.subarray(start, end))
        commit(false)
        start = end + 1
      }
      if (start < chunk.length) append(chunk.subarray(start))
    }
    if (pendingBytes > 0) commit(true)
    await afterPrefixRead?.()
    signal?.throwIfAborted()
    const prefixDigest = await verifyFrozenPrefix(handle, filePath, initial, frozenBytes, digest, policy, signal)
    return { records, notices, prefixDigest, frozenBytes }
  } finally {
    await handle.close()
  }
}
