import { createHash } from "node:crypto"

import { Data, Effect } from "effect"

import type { Platform } from "./platform.js"

export interface OciImageResolution {
  readonly reference: string
  readonly digest: string
}

export class OciImageError extends Data.TaggedError("OciImageError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

interface ParsedReference {
  readonly reference: string
  readonly registry: "docker.io" | "quay.io"
  readonly repository: string
  readonly selector: string
}

const sha256Pattern = /^sha256:[0-9a-f]{64}$/
const safeComponent = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const safeSelector = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const parseReference = (reference: string): ParsedReference => {
  const normalized = reference.includes("/") ? reference : `docker.io/library/${reference}`
  const slash = normalized.indexOf("/")
  const registry = normalized.slice(0, slash)
  if (registry !== "docker.io" && registry !== "quay.io") {
    throw new OciImageError({ message: `unsupported OCI registry: ${registry}` })
  }
  const remainder = normalized.slice(slash + 1)
  const separator = remainder.lastIndexOf(":")
  const repository = separator < 0 ? remainder : remainder.slice(0, separator)
  const selector = separator < 0 ? "latest" : remainder.slice(separator + 1)
  if (!safeComponent.test(repository) || !safeSelector.test(selector)) {
    throw new OciImageError({ message: `invalid OCI image reference: ${reference}` })
  }
  return { reference, registry, repository, selector }
}

const request = (url: string, headers: Readonly<Record<string, string>>): Effect.Effect<Response, OciImageError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { headers, redirect: "error", signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response
    },
    catch: (cause) => new OciImageError({ message: `cannot resolve OCI image: ${url}`, cause }),
  })

const dockerAuthorization = (repository: string): Effect.Effect<string, OciImageError> =>
  request(
    `https://auth.docker.io/token?service=registry.docker.io&scope=${encodeURIComponent(
      `repository:${repository}:pull`,
    )}`,
    { Accept: "application/json" },
  ).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: () => response.json() as Promise<{ readonly token?: unknown }>,
        catch: (cause) => new OciImageError({ message: "Docker registry token response is invalid", cause }),
      }),
    ),
    Effect.flatMap(({ token }) =>
      typeof token === "string" && token.length > 0
        ? Effect.succeed(`Bearer ${token}`)
        : Effect.fail(new OciImageError({ message: "Docker registry token is missing" })),
    ),
  )

const manifestHeaders = (authorization?: string): Readonly<Record<string, string>> => ({
  Accept: [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ].join(", "),
  ...(authorization === undefined ? {} : { Authorization: authorization }),
})

interface ManifestDescriptor {
  readonly digest?: unknown
  readonly platform?: { readonly os?: unknown; readonly architecture?: unknown }
}

const registryHost = (registry: ParsedReference["registry"]): string =>
  registry === "docker.io" ? "registry-1.docker.io" : "quay.io"

const resolveManifest = (
  parsed: ParsedReference,
  selector: string,
  platform: Platform,
  authorization?: string,
): Effect.Effect<string, OciImageError> =>
  request(
    `https://${registryHost(parsed.registry)}/v2/${parsed.repository}/manifests/${encodeURIComponent(selector)}`,
    manifestHeaders(authorization),
  ).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: async () => {
          const bytes = new Uint8Array(await response.arrayBuffer())
          const calculated = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
          if (sha256Pattern.test(selector) && calculated !== selector) {
            throw new Error(`manifest digest mismatch: expected ${selector}, actual ${calculated}`)
          }
          const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
            readonly manifests?: ReadonlyArray<ManifestDescriptor>
          }
          if (manifest.manifests === undefined) return calculated
          const architecture = platform === "linux/arm64" ? "arm64" : "amd64"
          const descriptor = manifest.manifests.find(
            (candidate) => candidate.platform?.os === "linux" && candidate.platform.architecture === architecture,
          )
          if (typeof descriptor?.digest !== "string" || !sha256Pattern.test(descriptor.digest)) {
            throw new Error(`OCI image has no ${platform} manifest`)
          }
          return descriptor.digest
        },
        catch: (cause) => new OciImageError({ message: `OCI manifest is invalid: ${parsed.reference}`, cause }),
      }),
    ),
    Effect.flatMap((digest) =>
      selector === digest || sha256Pattern.test(selector)
        ? Effect.succeed(digest)
        : resolveManifest(parsed, digest, platform, authorization),
    ),
  )

export const resolveOciImage = (
  reference: string,
  platform: Platform,
): Effect.Effect<OciImageResolution, OciImageError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseReference(reference),
      catch: (cause) =>
        cause instanceof OciImageError
          ? cause
          : new OciImageError({ message: `invalid OCI image reference: ${reference}`, cause }),
    })
    const authorization = parsed.registry === "docker.io" ? yield* dockerAuthorization(parsed.repository) : undefined
    const digest = yield* resolveManifest(parsed, parsed.selector, platform, authorization)
    return { reference, digest }
  })
