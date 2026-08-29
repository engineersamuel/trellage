import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { Data, Effect } from "effect"

import type { ProfileLock } from "./lock.js"
import {
  parseResolutionSidecar,
  renderResolutionSidecar,
  resolutionSidecarReference,
  verifyResolutionSidecarReference,
  type ResolutionSidecar,
  type ResolutionSidecarReference,
} from "./resolution-sidecar.js"

export class ResolutionSidecarStorageError extends Data.TaggedError("ResolutionSidecarStorageError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const resolutionSidecarPath = (lockPath: string, reference: ResolutionSidecarReference): string =>
  path.join(`${lockPath}.d`, `${reference.integrity.slice("sha256:".length)}.json`)

let stagingSequence = 0

export const writeResolutionSidecar = (
  lockPath: string,
  sidecar: ResolutionSidecar,
): Effect.Effect<ResolutionSidecarReference, ResolutionSidecarStorageError> => {
  const reference = resolutionSidecarReference(sidecar)
  const destination = resolutionSidecarPath(lockPath, reference)
  const source = renderResolutionSidecar(sidecar)
  const temporary = `${destination}.tmp-${process.pid}-${stagingSequence++}`
  return Effect.tryPromise({
    try: async () => {
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(temporary, source, { flag: "wx" })
      try {
        await link(temporary, destination)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause
        if ((await readFile(destination, "utf8")) !== source) {
          throw new Error("resolution sidecar collision has different bytes", { cause })
        }
      }
      return reference
    },
    catch: (cause) =>
      new ResolutionSidecarStorageError({ message: `cannot publish resolution sidecar: ${destination}`, cause }),
  }).pipe(Effect.ensuring(Effect.promise(() => rm(temporary, { force: true })).pipe(Effect.ignore)))
}

export const loadResolutionSidecar = (
  lockPath: string,
  lock: ProfileLock,
): Effect.Effect<ResolutionSidecar | undefined, ResolutionSidecarStorageError> => {
  if (lock.sidecar === undefined) return Effect.succeed(undefined)
  const sidecarPath = resolutionSidecarPath(lockPath, lock.sidecar)
  return Effect.tryPromise({
    try: () => readFile(sidecarPath, "utf8"),
    catch: (cause) =>
      new ResolutionSidecarStorageError({ message: `cannot read resolution sidecar: ${sidecarPath}`, cause }),
  }).pipe(
    Effect.tap((source) =>
      verifyResolutionSidecarReference(source, lock.sidecar!).pipe(
        Effect.mapError(
          (cause) =>
            new ResolutionSidecarStorageError({ message: `invalid resolution sidecar: ${sidecarPath}`, cause }),
        ),
      ),
    ),
    Effect.flatMap((source) =>
      parseResolutionSidecar(source).pipe(
        Effect.mapError(
          (cause) =>
            new ResolutionSidecarStorageError({ message: `invalid resolution sidecar: ${sidecarPath}`, cause }),
        ),
      ),
    ),
    Effect.flatMap((sidecar) =>
      sidecar.profile_hash === lock.profile_hash &&
      sidecar.platform === lock.platform &&
      (lock.packages.python_lock_integrity === undefined ||
        sidecar.files.some(
          (file) => file.role === "python-constraints" && file.integrity === lock.packages.python_lock_integrity,
        ))
        ? Effect.succeed(sidecar)
        : Effect.fail(
            new ResolutionSidecarStorageError({ message: `resolution sidecar does not match lock: ${sidecarPath}` }),
          ),
    ),
  )
}
