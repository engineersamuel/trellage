import { createHash } from "node:crypto"

import { Data, Effect } from "effect"

import type { HarnessPackageLock } from "./lock.js"

export interface PrimeReleaseClient {
  readonly text: (url: string) => Effect.Effect<string, unknown>
  readonly artifactSize: (url: string, expectedSha256: string) => Effect.Effect<number, unknown>
}

export class PrimeReleaseError extends Data.TaggedError("PrimeReleaseError")<{
  readonly message: string
}> {}

const releaseOrigin = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev"
const stableUrl = `${releaseOrigin}/stable`
const exactStableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const sha256Digest = /^[0-9a-f]{64}$/
const maximumFallbackBytes = 64 * 1024 * 1024

const fail = (message: string): Effect.Effect<never, PrimeReleaseError> =>
  Effect.fail(new PrimeReleaseError({ message }))

const fetchExact = (url: string, init: RequestInit, label: string): Effect.Effect<Response, PrimeReleaseError> =>
  Effect.tryPromise({
    try: () => fetch(url, { ...init, redirect: "error" }),
    catch: () => new PrimeReleaseError({ message: `${label} request failed` }),
  }).pipe(
    Effect.flatMap((response) => {
      if (response.redirected) return fail(`${label} response was redirected`)
      if (response.url !== url) return fail(`${label} response identity is invalid`)
      return Effect.succeed(response)
    }),
  )

const contentLength = (response: Response, label: string): Effect.Effect<number | undefined, PrimeReleaseError> => {
  const value = response.headers.get("content-length")
  if (value === null) return Effect.succeed(undefined)
  if (!/^[1-9]\d*$/.test(value)) return fail(`${label} Content-Length is invalid`)
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size <= 0) return fail(`${label} Content-Length is invalid`)
  return Effect.succeed(size)
}

const streamVerifiedSize = (
  response: Response,
  expectedSha256: string,
  declaredSize: number | undefined,
): Effect.Effect<number, PrimeReleaseError> =>
  Effect.tryPromise({
    try: async () => {
      if (response.body === null) throw new PrimeReleaseError({ message: "Prime artifact response body is missing" })
      if (declaredSize !== undefined && declaredSize > maximumFallbackBytes) {
        throw new PrimeReleaseError({ message: "Prime artifact fallback exceeds the size limit" })
      }
      const hash = createHash("sha256")
      const reader = response.body.getReader()
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maximumFallbackBytes) {
          await reader.cancel()
          throw new PrimeReleaseError({ message: "Prime artifact fallback exceeds the size limit" })
        }
        hash.update(value)
      }
      if (size === 0) throw new PrimeReleaseError({ message: "Prime artifact fallback is empty" })
      if (declaredSize !== undefined && size !== declaredSize) {
        throw new PrimeReleaseError({ message: "Prime artifact fallback size does not match Content-Length" })
      }
      if (hash.digest("hex") !== expectedSha256) {
        throw new PrimeReleaseError({ message: "Prime artifact fallback digest does not match SHA256SUMS" })
      }
      return size
    },
    catch: (cause) =>
      cause instanceof PrimeReleaseError
        ? cause
        : new PrimeReleaseError({ message: "Prime artifact fallback could not be read" }),
  })

export const PrimeReleaseHttpClient: PrimeReleaseClient = {
  text: (url) =>
    Effect.gen(function* () {
      const response = yield* fetchExact(url, { method: "GET" }, "Prime release text")
      if (!response.ok) return yield* fail(`Prime release text request failed (${response.status})`)
      return yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () => new PrimeReleaseError({ message: "Prime release text response could not be read" }),
      })
    }),
  artifactSize: (url, expectedSha256) =>
    Effect.gen(function* () {
      if (!sha256Digest.test(expectedSha256)) return yield* fail("Prime artifact expected digest is invalid")
      const head = yield* fetchExact(url, { method: "HEAD" }, "Prime artifact HEAD")
      if (head.ok) {
        const size = yield* contentLength(head, "Prime artifact")
        if (size !== undefined) return size
      } else if (head.status !== 405 && head.status !== 501) {
        return yield* fail(`Prime artifact HEAD request failed (${head.status})`)
      }

      const response = yield* fetchExact(url, { method: "GET" }, "Prime artifact fallback")
      if (!response.ok) return yield* fail(`Prime artifact fallback request failed (${response.status})`)
      const size = yield* contentLength(response, "Prime artifact fallback")
      return yield* streamVerifiedSize(response, expectedSha256, size)
    }),
}

export const resolvePrimeRelease = (
  selector: string,
  _platform: "linux/arm64" | "linux/amd64",
  client: PrimeReleaseClient = PrimeReleaseHttpClient,
): Effect.Effect<HarnessPackageLock, PrimeReleaseError> =>
  Effect.gen(function* () {
    if (selector !== "latest" && !exactStableVersion.test(selector)) {
      return yield* fail("Prime release selector is not an exact version")
    }

    let version = selector
    if (selector === "latest") {
      const channel = yield* client
        .text(stableUrl)
        .pipe(Effect.mapError(() => new PrimeReleaseError({ message: "Prime stable channel lookup failed" })))
      const normalized = channel.trim()
      version = normalized.startsWith("v") ? normalized.slice(1) : normalized
      if (!exactStableVersion.test(version)) return yield* fail("Prime stable channel version is invalid")
    }

    const filename = `prime-agent-${version}.tgz`
    const root = `${releaseOrigin}/releases/v${version}`
    const checksumText = yield* client
      .text(`${root}/SHA256SUMS`)
      .pipe(Effect.mapError(() => new PrimeReleaseError({ message: "Prime checksum lookup failed" })))
    const rows = checksumText.split(/\r?\n/).filter((row) => row.length > 0)
    const parsedRows = rows.map((row) => /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(row))
    if (parsedRows.length === 0 || parsedRows.some((row) => row === null)) {
      return yield* fail("Prime checksum response is invalid or ambiguous")
    }
    const matches = parsedRows.filter((row): row is RegExpExecArray => row !== null && row[2] === filename)
    if (matches.length !== 1) return yield* fail("Prime checksum response is invalid or ambiguous")
    const digest = matches[0]![1]!
    const url = `${root}/${filename}`
    const size = yield* client
      .artifactSize(url, digest)
      .pipe(Effect.mapError(() => new PrimeReleaseError({ message: "Prime artifact size lookup failed" })))
    if (!Number.isSafeInteger(size) || size <= 0) return yield* fail("Prime artifact size is invalid")

    return {
      kind: "prime",
      selector,
      version,
      integrity: `sha256:${digest}`,
      url,
      size,
    }
  })
