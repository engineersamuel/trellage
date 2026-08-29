import { Data, Effect } from "effect"

import { cacheArtifact, type CachedArtifact } from "./artifact-cache.js"
import type { ArtifactLock } from "./lock.js"

export interface NpmArtifactResolution {
  readonly artifact: ArtifactLock
  readonly cached: CachedArtifact
  readonly dependencies: Readonly<Record<string, string>>
}

export class NpmArtifactError extends Data.TaggedError("NpmArtifactError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export const npmArtifactIdentity = (name: string, version: string): string =>
  `npm:${encodeURIComponent(name)}@${version}`

export const parseNpmArtifactIdentity = (
  identity: string,
): { readonly name: string; readonly version: string } | undefined => {
  if (!identity.startsWith("npm:")) return undefined
  const separator = identity.lastIndexOf("@")
  if (separator <= "npm:".length) return undefined
  try {
    const name = decodeURIComponent(identity.slice("npm:".length, separator))
    const version = identity.slice(separator + 1)
    return /^@?[A-Za-z0-9._/-]+$/.test(name) && exactVersion.test(version) ? { name, version } : undefined
  } catch {
    return undefined
  }
}

export const npmTarballUrl = (registry: string, name: string, version: string): string => {
  const base = new URL(registry)
  if (base.protocol !== "https:" || base.username !== "" || base.password !== "") {
    throw new Error("npm registry is unsafe")
  }
  const packageName = name.split("/").at(-1)!
  const encoded = name.startsWith("@") ? name.replace("/", "%2f") : name
  return new URL(`${encoded}/-/${packageName}-${version}.tgz`, base.toString().replace(/\/?$/, "/")).toString()
}

const metadataUrl = (registry: string, name: string): string => {
  const base = new URL(registry)
  if (base.protocol !== "https:" || base.username !== "" || base.password !== "") {
    throw new Error("npm registry is unsafe")
  }
  const encoded = name.startsWith("@") ? name.replace("/", "%2f") : name
  return new URL(encoded, base.toString().replace(/\/?$/, "/")).toString()
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

interface PackageMetadata {
  readonly name: string
  readonly version: string
  readonly dependencies: Readonly<Record<string, string>>
  readonly tarball: string
}

const selectedVersion = (packument: Record<string, unknown>, selector: string): string => {
  if (selector === "latest") {
    const tags = packument["dist-tags"]
    if (!isRecord(tags) || typeof tags.latest !== "string" || !exactVersion.test(tags.latest)) {
      throw new Error("npm latest dist-tag is invalid")
    }
    return tags.latest
  }
  if (!exactVersion.test(selector)) throw new Error("npm selector is not exact")
  return selector
}

const selectedMetadata = (
  packument: Record<string, unknown>,
  expectedName: string,
  selector: string,
): PackageMetadata => {
  if (packument.name !== expectedName) throw new Error("npm packument name does not match")
  const version = selectedVersion(packument, selector)
  const versions = packument.versions
  if (!isRecord(versions) || !Object.hasOwn(versions, version) || !isRecord(versions[version])) {
    throw new Error(`npm packument version is missing: ${version}`)
  }
  const metadata = versions[version]
  if (
    metadata.name !== expectedName ||
    metadata.version !== version ||
    !isRecord(metadata.dist) ||
    typeof metadata.dist.tarball !== "string"
  ) {
    throw new Error("npm selected package metadata is invalid")
  }
  const dependencies = metadata.dependencies
  if (dependencies !== undefined && !isRecord(dependencies)) {
    throw new Error("npm package dependencies are invalid")
  }
  const entries = Object.entries(dependencies ?? {})
  if (entries.some(([name, requirement]) => name.length === 0 || typeof requirement !== "string")) {
    throw new Error("npm package dependencies are invalid")
  }
  return {
    name: expectedName,
    version,
    dependencies: Object.fromEntries(entries) as Readonly<Record<string, string>>,
    tarball: metadata.dist.tarball,
  }
}

export const resolveNpmArtifact = (request: {
  readonly cacheHome: string
  readonly registry: string
  readonly name: string
  readonly selector: string
  readonly artifactName: string
  readonly requireStable: boolean
}): Effect.Effect<NpmArtifactResolution, NpmArtifactError> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => metadataUrl(request.registry, request.name),
      catch: (cause) => new NpmArtifactError({ message: "npm package request is invalid", cause }),
    })
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(url, { redirect: "error", signal }),
      catch: (cause) => new NpmArtifactError({ message: `cannot resolve npm package: ${request.name}`, cause }),
    })
    if (!response.ok) {
      return yield* Effect.fail(
        new NpmArtifactError({ message: `cannot resolve npm package ${request.name}: HTTP ${response.status}` }),
      )
    }
    const packument = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) => new NpmArtifactError({ message: "npm package metadata is invalid", cause }),
    })
    const metadata = yield* Effect.try({
      try: () => {
        if (!isRecord(packument)) throw new Error("npm packument is invalid")
        return selectedMetadata(packument, request.name, request.selector)
      },
      catch: (cause) => new NpmArtifactError({ message: `npm package metadata is invalid: ${request.name}`, cause }),
    })
    const { version, dependencies } = metadata
    if (request.requireStable && version.includes("-")) {
      return yield* Effect.fail(new NpmArtifactError({ message: `npm package metadata is invalid: ${request.name}` }))
    }
    const downloadUrl = yield* Effect.try({
      try: () => npmTarballUrl(request.registry, request.name, version),
      catch: (cause) => new NpmArtifactError({ message: "npm package download URL is invalid", cause }),
    })
    const cached = yield* cacheArtifact({ cacheHome: request.cacheHome, url: downloadUrl }).pipe(
      Effect.mapError((cause) => new NpmArtifactError({ message: `cannot hash npm package: ${request.name}`, cause })),
    )
    return {
      artifact: {
        name: request.artifactName,
        version,
        integrity: cached.integrity,
        url: npmArtifactIdentity(request.name, version),
        size: cached.size,
      },
      cached,
      dependencies,
    }
  })
