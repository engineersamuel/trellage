import { parse } from "smol-toml"
import { Data, Effect } from "effect"

import { cacheArtifact } from "./artifact-cache.js"
import type { ArtifactLock } from "./lock.js"
import type { Platform } from "./platform.js"

export class RustReleaseError extends Data.TaggedError("RustReleaseError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const targetArtifact = (
  packages: Record<string, unknown> | undefined,
  packageName: string,
  targetName: string,
): { readonly url?: string; readonly hash?: string } => {
  const packageEntry = record(packages?.[packageName])
  const target = record(record(packageEntry?.target)?.[targetName])
  const url = text(target?.url)
  const hash = text(target?.hash)
  return { ...(url === undefined ? {} : { url }), ...(hash === undefined ? {} : { hash }) }
}

const rustManifestArtifacts = (manifest: unknown) => {
  const root = record(manifest)
  const packages = record(root?.pkg)
  const rust = record(packages?.rust)
  return {
    version: /^(\d+\.\d+\.\d+)/.exec(text(rust?.version) ?? "")?.[1],
    rust: targetArtifact(packages, "rust", "aarch64-unknown-linux-gnu"),
    standardLibrary: targetArtifact(packages, "rust-std", "aarch64-unknown-linux-musl"),
  }
}

const rustPairIsConsistent = (version: string, rustUrl: string, standardLibraryUrl: string): boolean => {
  const rustIdentity =
    /^https:\/\/static\.rust-lang\.org\/dist\/(\d{4}-\d{2}-\d{2})\/rust-(\d+\.\d+\.\d+)-aarch64-unknown-linux-gnu\.tar\.gz$/.exec(
      rustUrl,
    )
  const standardLibraryIdentity =
    /^https:\/\/static\.rust-lang\.org\/dist\/(\d{4}-\d{2}-\d{2})\/rust-std-(\d+\.\d+\.\d+)-aarch64-unknown-linux-musl\.tar\.gz$/.exec(
      standardLibraryUrl,
    )
  return (
    rustIdentity?.[1] === standardLibraryIdentity?.[1] &&
    rustIdentity?.[2] === version &&
    standardLibraryIdentity?.[2] === version
  )
}

const artifactSize = (cacheHome: string, url: string, integrity: string): Effect.Effect<number, RustReleaseError> =>
  Effect.promise(async (signal) => {
    try {
      const response = await fetch(url, { method: "HEAD", redirect: "error", signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const size = Number(response.headers.get("content-length"))
      return Number.isSafeInteger(size) && size > 0 ? size : undefined
    } catch {
      return undefined
    }
  }).pipe(
    Effect.flatMap((size) =>
      size === undefined
        ? cacheArtifact({ cacheHome, url, expectedIntegrity: integrity }).pipe(
            Effect.map((cached) => cached.size),
            Effect.mapError((cause) => new RustReleaseError({ message: "cannot determine Rust artifact size", cause })),
          )
        : Effect.succeed(size),
    ),
  )

export const resolveRustToolchain = (
  cacheHome: string,
  platform: Platform,
): Effect.Effect<ReadonlyArray<ArtifactLock>, RustReleaseError> =>
  Effect.gen(function* () {
    if (platform !== "linux/arm64") {
      return yield* Effect.fail(new RustReleaseError({ message: `Rust toolchain is unavailable for ${platform}` }))
    }
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch("https://static.rust-lang.org/dist/channel-rust-stable.toml", { redirect: "error", signal }),
      catch: (cause) => new RustReleaseError({ message: "cannot resolve stable Rust toolchain", cause }),
    })
    if (!response.ok) {
      return yield* Effect.fail(
        new RustReleaseError({ message: `cannot resolve stable Rust toolchain: HTTP ${response.status}` }),
      )
    }
    const source = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new RustReleaseError({ message: "cannot read stable Rust manifest", cause }),
    })
    const manifest = yield* Effect.try({
      try: () => parse(source) as unknown,
      catch: (cause) => new RustReleaseError({ message: "stable Rust manifest is invalid", cause }),
    })
    const resolved = rustManifestArtifacts(manifest)
    const { version } = resolved
    const { url: rustUrl, hash: rustHash } = resolved.rust
    const { url: standardLibraryUrl, hash: standardLibraryHash } = resolved.standardLibrary
    if (
      version === undefined ||
      rustUrl === undefined ||
      standardLibraryUrl === undefined ||
      !/^[0-9a-f]{64}$/.test(rustHash ?? "") ||
      !/^[0-9a-f]{64}$/.test(standardLibraryHash ?? "")
    ) {
      return yield* Effect.fail(new RustReleaseError({ message: "stable Rust artifacts are missing" }))
    }
    if (!rustPairIsConsistent(version, rustUrl, standardLibraryUrl)) {
      return yield* Effect.fail(new RustReleaseError({ message: "stable Rust artifact pair is inconsistent" }))
    }
    const [rustSize, standardLibrarySize] = yield* Effect.all(
      [
        artifactSize(cacheHome, rustUrl, `sha256:${rustHash}`),
        artifactSize(cacheHome, standardLibraryUrl, `sha256:${standardLibraryHash}`),
      ],
      { concurrency: 2 },
    )
    return [
      {
        name: "rust",
        version,
        integrity: `sha256:${rustHash}`,
        url: rustUrl,
        size: rustSize,
      },
      {
        name: "rust-std-musl",
        version,
        integrity: `sha256:${standardLibraryHash}`,
        url: standardLibraryUrl,
        size: standardLibrarySize,
      },
    ]
  })
