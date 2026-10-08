import { constants } from "node:fs"
import { lstat, open, readdir } from "node:fs/promises"
import path from "node:path"
import { optimizeDigest } from "./guide-optimize-evidence.ts"
import type { ReviewArtifact } from "./review-contracts.ts"
import { reviewCheckCatalog } from "./review-catalog.ts"

export const readPrivateReviewArtifact = async (file: string): Promise<string> => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > 1024 * 1024
    )
      throw new Error("Report artifact must be an owned, single-link mode-0600 file within 1 MiB.")
    const data = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < data.length) {
      const read = await handle.read(data, length, data.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    const after = await lstat(file)
    if (
      length !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("Report artifact changed during capture.")
    return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, length))
  } finally {
    await handle.close()
  }
}

const artifactNames = async (directory: string): Promise<string[]> => {
  let names: string[]
  try {
    await assertArtifactDirectory(path.dirname(directory))
    await assertArtifactDirectory(directory)
    names = await readdir(directory)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
  if (names.length > 4096) throw new Error("Review exceeded 4096 intermediate report artifacts.")
  return names.sort()
}

const assertArtifactDirectory = async (directory: string): Promise<void> => {
  const metadata = await lstat(directory)
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o700
  )
    throw new Error("Unsafe report artifact directory.")
}

export const captureIntermediateReviewArtifacts = async (
  work: string,
  owner: string | ReadonlyMap<string, string>,
): Promise<ReadonlyArray<ReviewArtifact>> => {
  const directory = path.join(work, "docs", "review")
  const names = await artifactNames(directory)
  const artifacts: ReviewArtifact[] = []
  let bytes = 0
  for (const name of names) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:json|md|txt)$/u.test(name)) throw new Error("Unsafe report artifact name.")
    const content = await readPrivateReviewArtifact(path.join(directory, name))
    bytes += Buffer.byteLength(content)
    if (bytes > 32_000_000) throw new Error("Intermediate report artifacts exceed the 32 MB storage safety limit.")
    const requested = typeof owner === "string" ? owner : owner.get(name)
    const checkId = requested === "synthesis" ? requested : reviewCheckCatalog.find((check) => check.id === requested)?.id
    if (!checkId) throw new Error(`Report artifact lacks an explicit check owner: ${name}.`)
    artifacts.push({ id: `${checkId}:${name}`, checkId, name, content, digest: optimizeDigest(content) })
  }
  return artifacts
}
