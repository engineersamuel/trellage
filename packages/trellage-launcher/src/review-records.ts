import { randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import path from "node:path"
import lockfile from "proper-lockfile"
import { optimizeDigest } from "./review-source.ts"
import { exactKeys, record, text } from "./guide-text.ts"

export interface OptimizeReviewSummary {
  readonly id: string
  readonly createdAt: string
  readonly status: "running" | "complete" | "incomplete" | "cancelled"
  readonly summary: string
}

export const reviewRecordId = (value: unknown): string => {
  const id = text(value, "review ID", 36)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id))
    throw new Error("Invalid review ID.")
  return id
}
const uuid = reviewRecordId
const missing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT"
const privateFile = (metadata: Stats): void => {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o600
  )
    throw new Error("Optimize records require owned, single-link mode-0600 files.")
}
export class PrivateReviewRecords {
  readonly directory: string
  constructor(protected readonly gitDirectory: string, namespace: "trellage-reviews") {
    this.directory = path.join(gitDirectory, namespace)
  }

  protected async ensure(): Promise<void> {
    const git = await lstat(this.gitDirectory)
    if (
      !git.isDirectory() ||
      git.isSymbolicLink() ||
      git.uid !== process.getuid?.() ||
      (await realpath(this.gitDirectory)) !== this.gitDirectory
    )
      throw new Error("Unsafe Optimize Git metadata directory.")
    try {
      await mkdir(this.directory, { mode: 0o700 })
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause
    }
    const info = await lstat(this.directory)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700
    )
      throw new Error("Optimize state directory must be owned, real, and mode 0700.")
  }

  async hasRecord(id: string): Promise<boolean> {
    const filename = `${uuid(id)}.json`
    await this.ensure()
    try {
      privateFile(await lstat(path.join(this.directory, filename)))
      return true
    } catch (cause) {
      if (missing(cause)) return false
      throw cause
    }
  }

  protected async readData(filename: string, maximum = 2_000_000): Promise<unknown> {
    await this.ensure()
    const handle = await open(
      path.join(this.directory, filename),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const before = await handle.stat()
      privateFile(before)
      if (before.size > maximum) throw new Error("Optimize record exceeds its byte limit.")
      const buffer = Buffer.alloc(before.size + 1)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
        if (result.bytesRead === 0) break
        bytesRead += result.bytesRead
      }
      const after = await handle.stat()
      const current = await lstat(path.join(this.directory, filename))
      privateFile(current)
      if (
        bytesRead !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error("Optimize record changed while reading.")
      if (current.ino !== before.ino || current.dev !== before.dev)
        throw new Error("Optimize record was replaced while reading.")
      const envelope = record(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))),
        "record",
      )
      exactKeys(envelope, "record", ["digest", "data"])
      if (envelope.digest !== optimizeDigest(envelope.data)) throw new Error("Saved Optimize record was changed.")
      return envelope.data
    } finally {
      await handle.close()
    }
  }

  protected async writeData(filename: string, data: unknown, maximum = 2_000_000): Promise<void> {
    await this.ensure()
    const encoded = `${JSON.stringify({ digest: optimizeDigest(data), data })}\n`
    if (Buffer.byteLength(encoded) > maximum)
      throw new Error("Optimize record exceeds its byte limit; it was not published.")
    const destination = path.join(this.directory, filename)
    try {
      privateFile(await lstat(destination))
    } catch (cause) {
      if (!missing(cause)) throw cause
    }
    const temporary = `${destination}.${randomUUID()}.tmp`
    const handle = await open(temporary, "wx", 0o600)
    try {
      try {
        await handle.writeFile(encoded)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.ensure()
      await rename(temporary, destination)
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch (cause) {
      try {
        await unlink(temporary)
      } catch (cleanup) {
        if (!missing(cleanup))
          throw new AggregateError([cause, cleanup], "Optimize save and cleanup failed.", { cause: cleanup })
      }
      throw cause
    }
  }

  protected async locked<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensure()
    try {
      const info = await lstat(`${this.directory}.lock`)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
        throw new Error("Unsafe Optimize record lock.")
    } catch (cause) {
      if (!missing(cause)) throw cause
    }
    const release = await lockfile.lock(this.directory, { realpath: false, retries: 0 })
    try {
      return await operation()
    } finally {
      await release()
    }
  }

}
