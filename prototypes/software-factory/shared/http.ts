// Typed HTTP for every shared UI part. Each response is decoded with a Schema, so a wrong payload
// fails as an HttpError at the boundary instead of as an undefined field deep in a render.
// No DOM use at module load: the coordinator and its tests import this file too.
import { Data, Effect, Schema } from "effect"

export class HttpError extends Data.TaggedError("HttpError")<{ readonly url: string; readonly reason: string }> {}

const call = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(url, { ...init, signal })
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`)
      return res
    },
    catch: (e) => new HttpError({ url, reason: e instanceof Error ? e.message : String(e) }),
  })

/** Decode an unknown value; a mismatch becomes an HttpError for `url`. */
export const decodeAt = <S extends Schema.Top & { readonly DecodingServices: never }>(url: string, schema: S) => (u: unknown) =>
  Schema.decodeUnknownEffect(schema)(u).pipe(Effect.mapError((e) => new HttpError({ url, reason: e.message })))

/** GET (or any method) and decode the JSON body. */
export const json = <S extends Schema.Top & { readonly DecodingServices: never }>(
  url: string,
  schema: S,
  init?: RequestInit,
): Effect.Effect<S["Type"], HttpError> =>
  call(url, init).pipe(
    Effect.flatMap((res) => Effect.tryPromise({ try: () => res.json() as Promise<unknown>, catch: (e) => new HttpError({ url, reason: String(e) }) })),
    Effect.flatMap(decodeAt(url, schema)),
  )

/** Send a request whose response body is not needed. `body` is sent as JSON. */
export const send = (url: string, method: string, body?: unknown): Effect.Effect<void, HttpError> =>
  call(url, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }).pipe(Effect.asVoid)

/** Run from plain DOM code. Failures are logged and resolve to `fallback`, so a UI handler never throws. */
export const runOr = <A, B>(effect: Effect.Effect<A, HttpError>, fallback: B): Promise<A | B> =>
  Effect.runPromise(
    effect.pipe(Effect.catch((e: HttpError) => Effect.logWarning(`${e.url}: ${e.reason}`).pipe(Effect.as(fallback)))),
  )

/** Fire and forget from a click handler; a failure is logged. */
export const fire = (effect: Effect.Effect<unknown, HttpError>): void => void runOr(effect, undefined)
