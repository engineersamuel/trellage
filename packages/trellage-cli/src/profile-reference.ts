import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { Data, Effect } from "effect"

import { platformIdentity, type Platform } from "./platform.js"

export class ProfileReferenceError extends Data.TaggedError("ProfileReferenceError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const githubBlob = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\/)?profile\.toml$/

const fetchText = (url: string): Effect.Effect<string, ProfileReferenceError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, { redirect: "error", headers: { Accept: "application/vnd.github+json" } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.text()
    },
    catch: (cause) => new ProfileReferenceError({ message: `cannot fetch profile resource: ${url}`, cause }),
  })

export const resolveProfileReference = (
  reference: string,
  platform: Platform,
  cacheHome: string,
): Effect.Effect<string, ProfileReferenceError> => {
  const match = githubBlob.exec(reference)
  if (match === null) return Effect.succeed(reference)
  const [, owner, repository, revision, directory = ""] = match
  return Effect.gen(function* () {
    const commitDocument = yield* fetchText(
      `https://api.github.com/repos/${owner}/${repository}/commits/${encodeURIComponent(revision!)}`,
    )
    const commit = yield* Effect.try({
      try: () => {
        const sha = (JSON.parse(commitDocument) as { readonly sha?: unknown }).sha
        if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("invalid commit identity")
        return sha
      },
      catch: (cause) =>
        new ProfileReferenceError({ message: "GitHub profile revision did not resolve to a commit", cause }),
    })
    const rawRoot = `https://raw.githubusercontent.com/${owner}/${repository}/${commit}/${directory}`
    const [profile, lock] = yield* Effect.all(
      [fetchText(`${rawRoot}profile.toml`), fetchText(`${rawRoot}profile.${platformIdentity(platform)}.lock.toml`)],
      { concurrency: 2 },
    )
    const key = createHash("sha256")
      .update(`${reference}\0${commit}\0${platformIdentity(platform)}`)
      .digest("hex")
    const root = path.join(cacheHome, "trellage", "profiles", key)
    const parent = path.dirname(root)
    const temporary = yield* Effect.tryPromise({
      try: async () => {
        await mkdir(parent, { recursive: true })
        return mkdtemp(`${root}.tmp-`)
      },
      catch: (cause) => new ProfileReferenceError({ message: `cannot stage GitHub profile: ${reference}`, cause }),
    })
    yield* Effect.tryPromise({
      try: async () => {
        await writeFile(path.join(temporary, "profile.toml"), profile, { flag: "wx" })
        await writeFile(path.join(temporary, `profile.${platformIdentity(platform)}.lock.toml`), lock, { flag: "wx" })
        try {
          await rename(temporary, root)
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException).code
          if (code !== "EEXIST" && code !== "ENOTEMPTY") throw cause
          const [publishedProfile, publishedLock] = await Promise.all([
            readFile(path.join(root, "profile.toml"), "utf8"),
            readFile(path.join(root, `profile.${platformIdentity(platform)}.lock.toml`), "utf8"),
          ])
          if (publishedProfile !== profile || publishedLock !== lock) {
            throw new Error("cached GitHub profile collision has different bytes", { cause })
          }
        }
      },
      catch: (cause) => new ProfileReferenceError({ message: `cannot cache GitHub profile: ${reference}`, cause }),
    }).pipe(Effect.ensuring(Effect.promise(() => rm(temporary, { recursive: true, force: true })).pipe(Effect.ignore)))
    return path.join(root, "profile.toml")
  })
}
