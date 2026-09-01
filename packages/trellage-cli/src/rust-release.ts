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

const stableRustManifest = (): Effect.Effect<unknown, RustReleaseError> =>
  Effect.gen(function* () {
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
    return yield* Effect.try({
      try: () => parse(source) as unknown,
      catch: (cause) => new RustReleaseError({ message: "stable Rust manifest is invalid", cause }),
    })
  })

export const resolveRustToolchain = (
  cacheHome: string,
  platform: Platform,
): Effect.Effect<ReadonlyArray<ArtifactLock>, RustReleaseError> =>
  Effect.gen(function* () {
    if (platform !== "linux/arm64") {
      return yield* Effect.fail(new RustReleaseError({ message: `Rust toolchain is unavailable for ${platform}` }))
    }
    const manifest = yield* stableRustManifest()
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

const graphRustPackages = [
  { name: "rust", packageName: "rust", target: "aarch64-unknown-linux-gnu", stem: "rust" },
  { name: "rustfmt", packageName: "rustfmt-preview", target: "aarch64-unknown-linux-gnu", stem: "rustfmt" },
  { name: "clippy", packageName: "clippy-preview", target: "aarch64-unknown-linux-gnu", stem: "clippy" },
  { name: "rust-std-aarch64-musl", packageName: "rust-std", target: "aarch64-unknown-linux-musl", stem: "rust-std" },
  { name: "rust-std-x86_64-musl", packageName: "rust-std", target: "x86_64-unknown-linux-musl", stem: "rust-std" },
  { name: "rust-std-i686-musl", packageName: "rust-std", target: "i686-unknown-linux-musl", stem: "rust-std" },
] as const

export const graphRustArtifactNames: ReadonlyArray<string> = graphRustPackages.map((entry) => entry.name)

export const graphRustArtifactUrl = (name: string, version: string, date: string): string | undefined => {
  const entry = graphRustPackages.find((candidate) => candidate.name === name)
  return entry === undefined
    ? undefined
    : `https://static.rust-lang.org/dist/${date}/${entry.stem}-${version}-${entry.target}.tar.gz`
}

export const graphRustUrlIdentity = (
  name: string,
  url: string,
): { readonly date: string; readonly version: string } | undefined => {
  const entry = graphRustPackages.find((candidate) => candidate.name === name)
  if (entry === undefined) return undefined
  const match = new RegExp(
    `^https://static\\.rust-lang\\.org/dist/(\\d{4}-\\d{2}-\\d{2})/${entry.stem}-(\\d+\\.\\d+\\.\\d+)-${entry.target}\\.tar\\.gz$`,
  ).exec(url)
  return match?.[1] === undefined || match[2] === undefined ? undefined : { date: match[1], version: match[2] }
}

// The Graph of Loops image compiles and cross-checks SIMD backends, so it needs
// rustfmt, Clippy, and every musl standard library the graph proves against.
export const resolveGraphRustToolchain = (
  cacheHome: string,
  platform: Platform,
): Effect.Effect<ReadonlyArray<ArtifactLock>, RustReleaseError> =>
  Effect.gen(function* () {
    if (platform !== "linux/arm64") {
      return yield* Effect.fail(new RustReleaseError({ message: `Rust toolchain is unavailable for ${platform}` }))
    }
    const manifest = yield* stableRustManifest()
    const packages = record(record(manifest)?.pkg)
    const version = /^(\d+\.\d+\.\d+)/.exec(text(record(packages?.rust)?.version) ?? "")?.[1]
    if (version === undefined)
      return yield* Effect.fail(new RustReleaseError({ message: "stable Rust version is missing" }))
    const selected = graphRustPackages.map((entry) => ({
      entry,
      artifact: targetArtifact(packages, entry.packageName, entry.target),
    }))
    for (const { entry, artifact } of selected) {
      if (artifact.url === undefined || !/^[0-9a-f]{64}$/.test(artifact.hash ?? "")) {
        return yield* Effect.fail(new RustReleaseError({ message: `stable Rust artifact is missing: ${entry.name}` }))
      }
    }
    const dates = new Set(
      selected.map(({ entry, artifact }) => graphRustUrlIdentity(entry.name, artifact.url!)?.date ?? ""),
    )
    if (dates.size !== 1 || dates.has("")) {
      return yield* Effect.fail(new RustReleaseError({ message: "stable Rust artifact set is inconsistent" }))
    }
    if (selected.some(({ entry, artifact }) => graphRustUrlIdentity(entry.name, artifact.url!)?.version !== version)) {
      return yield* Effect.fail(new RustReleaseError({ message: "stable Rust artifact set is inconsistent" }))
    }
    const sizes = yield* Effect.all(
      selected.map(({ artifact }) => artifactSize(cacheHome, artifact.url!, `sha256:${artifact.hash!}`)),
      { concurrency: 3 },
    )
    return selected.map(({ entry, artifact }, index) => ({
      name: entry.name,
      version,
      integrity: `sha256:${artifact.hash!}`,
      url: artifact.url!,
      size: sizes[index]!,
    }))
  })
