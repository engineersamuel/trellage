import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { Data, Effect } from "effect"

import { parseLock, renderLock } from "./lock-file.js"
import { attachedSidecar, profileHash, withAttachedSidecar, type ProfileLock } from "./lock.js"
import { platformIdentity, platformLockPath, type Platform } from "./platform.js"
import type { ProfileDocument } from "./profile.js"
import { loadResolutionSidecar, writeResolutionSidecar } from "./resolution-sidecar-storage.js"

export const developmentResolutionPolicy = "floating-stable" as const
export type DevelopmentResolutionPolicy = typeof developmentResolutionPolicy

export class ResolutionReceiptError extends Data.TaggedError("ResolutionReceiptError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const receiptKey = (document: ProfileDocument, platform: Platform): string =>
  createHash("sha256")
    .update(
      [
        "trellage-development-resolution-v1",
        document.profile.name,
        profileHash(document),
        platform,
        developmentResolutionPolicy,
      ].join("\0"),
    )
    .digest("hex")

export const resolutionReceiptPath = (document: ProfileDocument, platform: Platform, xdgCacheHome: string): string =>
  path.join(
    xdgCacheHome,
    "trellage",
    "resolutions",
    "v1",
    document.profile.name,
    platformIdentity(platform),
    receiptKey(document, platform),
    path.basename(platformLockPath(document.path, platform)),
  )

const readOptional = (receiptPath: string): Effect.Effect<string | undefined, ResolutionReceiptError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(receiptPath, "utf8")
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw cause
      }
    },
    catch: (cause) =>
      new ResolutionReceiptError({ message: `cannot read development resolution receipt: ${receiptPath}`, cause }),
  })

export const readResolutionReceiptBytes = (
  document: ProfileDocument,
  platform: Platform,
  xdgCacheHome: string,
): Effect.Effect<string | undefined, ResolutionReceiptError> =>
  readOptional(resolutionReceiptPath(document, platform, xdgCacheHome))

export const loadResolutionReceipt = (
  document: ProfileDocument,
  platform: Platform,
  xdgCacheHome: string,
): Effect.Effect<ProfileLock | undefined, ResolutionReceiptError> =>
  readResolutionReceiptBytes(document, platform, xdgCacheHome).pipe(
    Effect.flatMap((source) =>
      source === undefined
        ? Effect.succeed(undefined)
        : parseLock(source).pipe(
            Effect.map((lock) => lock as ProfileLock | undefined),
            Effect.mapError(
              (cause) =>
                new ResolutionReceiptError({
                  message: `invalid development resolution receipt: ${resolutionReceiptPath(
                    document,
                    platform,
                    xdgCacheHome,
                  )}: ${cause.message}`,
                  cause,
                }),
            ),
          ),
    ),
    Effect.flatMap((lock) => {
      if (lock?.sidecar === undefined) return Effect.succeed(lock)
      return loadResolutionSidecar(resolutionReceiptPath(document, platform, xdgCacheHome), lock).pipe(
        Effect.map((sidecar) => (sidecar === undefined ? lock : withAttachedSidecar(lock, sidecar))),
        Effect.mapError(
          (cause) =>
            new ResolutionReceiptError({
              message: `invalid development resolution sidecar: ${resolutionReceiptPath(
                document,
                platform,
                xdgCacheHome,
              )}`,
              cause,
            }),
        ),
      )
    }),
  )

let atomicWriteSequence = 0

export const writeResolutionReceiptBytes = (
  document: ProfileDocument,
  platform: Platform,
  xdgCacheHome: string,
  contents: string,
): Effect.Effect<void, ResolutionReceiptError> => {
  const destination = resolutionReceiptPath(document, platform, xdgCacheHome)
  const temporary = `${destination}.tmp-${process.pid}-${atomicWriteSequence++}`
  return Effect.tryPromise({
    try: async () => {
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(temporary, contents, { flag: "wx" })
      await rename(temporary, destination)
    },
    catch: (cause) =>
      new ResolutionReceiptError({ message: `cannot write development resolution receipt: ${destination}`, cause }),
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise({
        try: () => rm(temporary, { force: true }),
        catch: () => undefined,
      }).pipe(Effect.ignore),
    ),
  )
}

export const writeResolutionReceipt = (
  document: ProfileDocument,
  xdgCacheHome: string,
  lock: ProfileLock,
): Effect.Effect<void, ResolutionReceiptError> =>
  Effect.gen(function* () {
    const receiptPath = resolutionReceiptPath(document, lock.platform, xdgCacheHome)
    const sidecar = attachedSidecar(lock)
    if (sidecar !== undefined) {
      const reference = yield* writeResolutionSidecar(receiptPath, sidecar).pipe(
        Effect.mapError((cause) => new ResolutionReceiptError({ message: cause.message, cause })),
      )
      if (
        lock.sidecar === undefined ||
        reference.integrity !== lock.sidecar.integrity ||
        reference.size !== lock.sidecar.size
      ) {
        return yield* Effect.fail(new ResolutionReceiptError({ message: "resolution sidecar reference mismatch" }))
      }
    }
    yield* writeResolutionReceiptBytes(document, lock.platform, xdgCacheHome, renderLock(lock))
  })

export const removeResolutionReceipt = (
  document: ProfileDocument,
  platform: Platform,
  xdgCacheHome: string,
): Effect.Effect<void, ResolutionReceiptError> => {
  const receiptPath = resolutionReceiptPath(document, platform, xdgCacheHome)
  return Effect.tryPromise({
    try: () => rm(receiptPath, { force: true }),
    catch: (cause) =>
      new ResolutionReceiptError({ message: `cannot remove development resolution receipt: ${receiptPath}`, cause }),
  })
}
