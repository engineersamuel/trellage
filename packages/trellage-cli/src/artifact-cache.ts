import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { link, mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

import { Data, Effect } from "effect"

export interface CachedArtifact {
  readonly integrity: string
  readonly size: number
  readonly path: string
}

export class ArtifactCacheError extends Data.TaggedError("ArtifactCacheError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const sha256Pattern = /^sha256:[0-9a-f]{64}$/

const safeUrl = (source: string): boolean => {
  try {
    const url = new URL(source)
    return url.protocol === "https:" && url.username === "" && url.password === ""
  } catch {
    return false
  }
}

const artifactPath = (cacheHome: string, integrity: string): string =>
  path.join(cacheHome, "trellage", "artifacts", "sha256", integrity.slice("sha256:".length))

const inspectArtifact = (candidate: string): Effect.Effect<CachedArtifact, ArtifactCacheError> =>
  Effect.tryPromise({
    try: async () => {
      const hash = createHash("sha256")
      let size = 0
      await pipeline(
        createReadStream(candidate),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk)
            size += chunk.length
            callback(null, chunk)
          },
        }),
        new Transform({
          transform(_chunk, _encoding, callback) {
            callback()
          },
        }),
      )
      return { integrity: `sha256:${hash.digest("hex")}`, size, path: candidate }
    },
    catch: (cause) => new ArtifactCacheError({ message: `cannot verify cached artifact: ${candidate}`, cause }),
  })

let stagingSequence = 0

export const cacheArtifact = (request: {
  readonly cacheHome: string
  readonly url: string
  readonly expectedIntegrity?: string
  readonly expectedSize?: number
}): Effect.Effect<CachedArtifact, ArtifactCacheError> => {
  if (!safeUrl(request.url)) {
    return Effect.fail(new ArtifactCacheError({ message: `artifact URL is unsafe: ${request.url}` }))
  }
  if (request.expectedIntegrity !== undefined && !sha256Pattern.test(request.expectedIntegrity)) {
    return Effect.fail(new ArtifactCacheError({ message: "expected artifact integrity is invalid" }))
  }
  const expectedPath =
    request.expectedIntegrity === undefined ? undefined : artifactPath(request.cacheHome, request.expectedIntegrity)
  const reuse =
    expectedPath === undefined
      ? Effect.succeed(undefined)
      : Effect.promise(async () => {
          try {
            return (await stat(expectedPath)).isFile() ? expectedPath : undefined
          } catch {
            return undefined
          }
        }).pipe(
          Effect.flatMap((candidate) =>
            candidate === undefined
              ? Effect.succeed(undefined)
              : inspectArtifact(candidate).pipe(
                  Effect.flatMap((cached) =>
                    cached.integrity === request.expectedIntegrity &&
                    (request.expectedSize === undefined || cached.size === request.expectedSize)
                      ? Effect.succeed(cached)
                      : Effect.fail(new ArtifactCacheError({ message: `cached artifact is invalid: ${candidate}` })),
                  ),
                ),
          ),
        )
  return reuse.pipe(
    Effect.flatMap((cached) => {
      if (cached !== undefined) return Effect.succeed(cached)
      return Effect.acquireUseRelease(
        Effect.tryPromise({
          try: async () => {
            const stagingRoot = path.join(request.cacheHome, "trellage", "artifacts", "staging")
            await mkdir(stagingRoot, { recursive: true })
            return path.join(stagingRoot, `artifact-${process.pid}-${stagingSequence++}`)
          },
          catch: (cause) => new ArtifactCacheError({ message: "cannot create artifact cache staging", cause }),
        }),
        (temporary) =>
          Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(request.url, { redirect: "follow", signal })
              if (
                !response.ok ||
                response.body === null ||
                new URL(response.url || request.url).protocol !== "https:"
              ) {
                throw new Error(`HTTP ${response.status}`)
              }
              const hash = createHash("sha256")
              let size = 0
              const source = Readable.fromWeb(response.body as never)
              await pipeline(
                source,
                new Transform({
                  transform(chunk: Buffer, _encoding, callback) {
                    hash.update(chunk)
                    size += chunk.length
                    callback(null, chunk)
                  },
                }),
                createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
              )
              const integrity = `sha256:${hash.digest("hex")}`
              if (request.expectedIntegrity !== undefined && integrity !== request.expectedIntegrity) {
                throw new Error(
                  `artifact integrity mismatch: expected ${request.expectedIntegrity}, actual ${integrity}`,
                )
              }
              if (request.expectedSize !== undefined && size !== request.expectedSize) {
                throw new Error(`artifact size mismatch: expected ${request.expectedSize}, actual ${size}`)
              }
              const destination = artifactPath(request.cacheHome, integrity)
              await mkdir(path.dirname(destination), { recursive: true })
              try {
                await link(temporary, destination)
              } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause
                const published = await Effect.runPromise(inspectArtifact(destination))
                if (published.integrity !== integrity || published.size !== size) {
                  throw new Error("artifact cache collision has different bytes", { cause })
                }
              }
              return { integrity, size, path: destination }
            },
            catch: (cause) => new ArtifactCacheError({ message: `cannot cache artifact: ${request.url}`, cause }),
          }),
        (temporary) => Effect.promise(() => rm(temporary, { force: true })).pipe(Effect.orDie),
      )
    }),
  )
}

export const cachedArtifactPath = (cacheHome: string, integrity: string): string => artifactPath(cacheHome, integrity)
