import type { ArtifactLock, ProfileLock } from "./lock.js"
import type { Platform } from "./platform.js"
import { parseNpmArtifactIdentity } from "./npm-artifact.js"
import {
  claudeGithubReleaseTools,
  claudeHasSerena,
  claudePypiToolNames,
  isClaudeProfile,
  isGraphOfLoopsProfile,
  type ProfileDocument,
} from "./profile.js"
import { graphRustArtifactNames, graphRustUrlIdentity } from "./rust-release.js"

export const extraClaudeMarketplaceArtifactNames = (document: ProfileDocument): ReadonlyArray<string> => {
  if (!isClaudeProfile(document.profile) || document.profile.plugins[0]?.adapter === "hyperresearch") return []
  return [...new Set(claudeGithubReleaseTools(document.profile).map((tool) => tool.name))]
}

const resolvedToolError = (
  lock: ProfileLock,
  name: "node" | "uv",
  expectedUrl: (version: string) => string,
): string | undefined => {
  const artifact = lock.packages.artifacts?.find((candidate) => candidate.name === name)
  if (artifact === undefined) return `required artifact is missing: ${name}`
  if (!/^\d+\.\d+\.\d+$/.test(artifact.version)) return `artifact version is invalid: ${name}`
  if (artifact.url !== expectedUrl(artifact.version)) return `artifact URL is invalid: ${name}`
  return undefined
}

const resolvedNodeError = (lock: ProfileLock): string | undefined =>
  resolvedToolError(
    lock,
    "node",
    (version) => `https://nodejs.org/dist/v${version}/node-v${version}-linux-arm64.tar.gz`,
  )

const resolvedUvError = (lock: ProfileLock): string | undefined =>
  resolvedToolError(
    lock,
    "uv",
    (version) => `https://github.com/astral-sh/uv/releases/download/${version}/uv-aarch64-unknown-linux-musl.tar.gz`,
  )

const resolvedPythonError = (lock: ProfileLock): string | undefined => {
  const artifact = lock.packages.artifacts?.find((candidate) => candidate.name === "python")
  if (artifact === undefined) return "required artifact is missing: python"
  if (!/^3\.13\.\d+$/.test(artifact.version)) return "artifact version is invalid: python"
  const expected = new RegExp(
    `^https://github\\.com/astral-sh/python-build-standalone/releases/download/\\d{8}/cpython-${artifact.version.replaceAll(
      ".",
      "\\.",
    )}(?:\\+|%2[Bb])\\d{8}-aarch64-unknown-linux-gnu-install_only_stripped\\.tar\\.gz$`,
  )
  return expected.test(artifact.url) ? undefined : "artifact URL is invalid: python"
}

const dynamicClaudeArtifactNames = (document: ProfileDocument): ReadonlyArray<string> => {
  if (document.profile.plugins[0]?.adapter === "hyperresearch") {
    return ["playwright-mcp", "playwright", "playwright-core", "chromium", "chromium-headless-shell", "obscura"]
  }
  const names = extraClaudeMarketplaceArtifactNames(document)
  const withCodex = names.includes("codex") ? [...names, "codex-code-mode-host"] : names
  return isGraphOfLoopsProfile(document.profile) ? [...withCodex, ...graphRustArtifactNames] : withCodex
}

const graphRustArtifactUrlValid = (artifact: ArtifactLock): boolean =>
  graphRustUrlIdentity(artifact.name, artifact.url)?.version === artifact.version

const playwrightArtifactUrlValid = (artifact: ArtifactLock): boolean => {
  if (artifact.name === "playwright-mcp") {
    const identity = parseNpmArtifactIdentity(artifact.url)
    return identity?.name === "@playwright/mcp" && identity.version === artifact.version
  }
  if (artifact.name === "playwright" || artifact.name === "playwright-core") {
    const identity = parseNpmArtifactIdentity(artifact.url)
    return identity?.name === artifact.name && identity.version === artifact.version
  }
  if (artifact.name === "chromium") {
    return (
      artifact.url ===
      `https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${artifact.version}/chromium-linux-arm64.zip`
    )
  }
  if (artifact.name === "chromium-headless-shell") {
    return (
      artifact.url ===
      `https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${artifact.version}/chromium-headless-shell-linux-arm64.zip`
    )
  }
  return false
}

const githubToolArtifactUrlValid = (artifact: ArtifactLock): boolean => {
  const version = artifact.version.replaceAll(".", "\\.")
  if (artifact.name === "bd") {
    return new RegExp(
      `^https://github\\.com/gastownhall/beads/releases/download/v?${version}/beads_${version}_linux_arm64\\.tar\\.gz$`,
    ).test(artifact.url)
  }
  if (artifact.name === "bv") {
    return new RegExp(
      `^https://github\\.com/Dicklesworthstone/beads_viewer/releases/download/v?${version}/bv_linux_arm64\\.tar\\.gz$`,
    ).test(artifact.url)
  }
  if (artifact.name === "raindrop") {
    return new RegExp(
      `^https://github\\.com/raindrop-ai/workshop/releases/download/v?${version}/raindrop-bun-linux-arm64\\.gz$`,
    ).test(artifact.url)
  }
  if (artifact.name === "lefthook-linux-arm64") {
    return new RegExp(
      `^https://github\\.com/evilmartians/lefthook/releases/download/v?${version}/lefthook_${version}_Linux_arm64$`,
    ).test(artifact.url)
  }
  if (artifact.name === "obscura") {
    return new RegExp(
      `^https://github\\.com/h4ckf0r0day/obscura/releases/download/v?${version}/obscura-aarch64-linux-stealth\\.tar\\.gz$`,
    ).test(artifact.url)
  }
  if (artifact.name === "codex") {
    return new RegExp(
      `^https://github\\.com/openai/codex/releases/download/rust-v${version}/codex-aarch64-unknown-linux-musl\\.tar\\.gz$`,
    ).test(artifact.url)
  }
  if (artifact.name === "codex-code-mode-host") {
    return new RegExp(
      `^https://github\\.com/openai/codex/releases/download/rust-v${version}/codex-code-mode-host-aarch64-unknown-linux-musl\\.tar\\.gz$`,
    ).test(artifact.url)
  }
  return false
}

const dynamicArtifactUrlError = (
  expectedNames: ReadonlyArray<string>,
  actual: ReadonlyArray<ArtifactLock>,
): string | undefined => {
  for (const name of expectedNames) {
    const artifact = actual.find((candidate) => candidate.name === name)
    if (artifact !== undefined && playwrightArtifactUrlValid(artifact)) continue
    if (artifact !== undefined && graphRustArtifactUrlValid(artifact)) continue
    if (artifact === undefined || !githubToolArtifactUrlValid(artifact)) return `artifact URL is invalid: ${name}`
  }
}

const dynamicArtifactRelationshipError = (actual: ReadonlyArray<ArtifactLock>): string | undefined => {
  const codex = actual.find((artifact) => artifact.name === "codex")
  const host = actual.find((artifact) => artifact.name === "codex-code-mode-host")
  if (codex !== undefined && host?.version !== codex.version) return "Codex companion artifact version does not match"
  const playwright = actual.find((artifact) => artifact.name === "playwright")
  const core = actual.find((artifact) => artifact.name === "playwright-core")
  if (playwright !== undefined && core?.version !== playwright.version) {
    return "Playwright package versions do not match"
  }
  const chromium = actual.find((artifact) => artifact.name === "chromium")
  const headless = actual.find((artifact) => artifact.name === "chromium-headless-shell")
  if (chromium !== undefined && headless?.version !== chromium.version) {
    return "Playwright browser revisions do not match"
  }
  return graphRustRelationshipError(actual)
}

const graphRustRelationshipError = (actual: ReadonlyArray<ArtifactLock>): string | undefined => {
  const rust = actual.filter((artifact) => graphRustArtifactNames.includes(artifact.name))
  if (rust.length === 0) return undefined
  if (rust.length !== graphRustArtifactNames.length) return "Graph of Loops Rust artifact set is incomplete"
  const identities = rust.map((artifact) => graphRustUrlIdentity(artifact.name, artifact.url))
  const dates = new Set(identities.map((identity) => identity?.date))
  const versions = new Set(rust.map((artifact) => artifact.version))
  return dates.size === 1 && !dates.has(undefined) && versions.size === 1
    ? undefined
    : "Graph of Loops Rust artifact set is inconsistent"
}

const dynamicClaudeArtifactError = (document: ProfileDocument, lock: ProfileLock): string | undefined => {
  const expectedNames = dynamicClaudeArtifactNames(document)
  const artifacts = lock.packages.artifacts ?? []
  const actual = artifacts.filter((artifact) => expectedNames.includes(artifact.name))
  if (actual.length !== expectedNames.length) return "dynamic artifact set does not match profile tools"
  return dynamicArtifactUrlError(expectedNames, actual) ?? dynamicArtifactRelationshipError(actual)
}

const claudeManagedToolError = (document: ProfileDocument, lock: ProfileLock): string | undefined => {
  const nodeError = resolvedNodeError(lock)
  if (nodeError !== undefined) return nodeError
  const needsUv =
    document.profile.plugins[0]?.adapter === "hyperresearch" ||
    (isClaudeProfile(document.profile) &&
      (claudePypiToolNames(document.profile).length > 0 || claudeHasSerena(document.profile)))
  if (needsUv) {
    const uvError = resolvedUvError(lock)
    if (uvError !== undefined) return uvError
  }
  const needsPython =
    document.profile.plugins[0]?.adapter === "hyperresearch" ||
    (isClaudeProfile(document.profile) && claudePypiToolNames(document.profile).length > 0)
  return needsPython ? resolvedPythonError(lock) : undefined
}

const claudeArtifactSetError = (document: ProfileDocument, lock: ProfileLock): string | undefined => {
  const managedToolError = claudeManagedToolError(document, lock)
  if (managedToolError !== undefined) return managedToolError
  const dynamicArtifactError = dynamicClaudeArtifactError(document, lock)
  if (dynamicArtifactError !== undefined) return dynamicArtifactError
  const dynamicNames = dynamicClaudeArtifactNames(document)
  const unexpected = (lock.packages.artifacts ?? []).find(
    (artifact) =>
      artifact.name !== "node" &&
      artifact.name !== "uv" &&
      artifact.name !== "python" &&
      artifact.name !== "builder-oci" &&
      artifact.name !== "skopeo-oci" &&
      !dynamicNames.includes(artifact.name),
  )
  return unexpected === undefined ? undefined : `unexpected Claude artifact: ${unexpected.name}`
}

const rustUrlIdentity = (
  url: string,
  kind: "rust" | "rust-std",
): { readonly date: string; readonly version: string } | undefined => {
  const target = kind === "rust" ? "aarch64-unknown-linux-gnu" : "aarch64-unknown-linux-musl"
  const match = new RegExp(
    `^https://static\\.rust-lang\\.org/dist/(\\d{4}-\\d{2}-\\d{2})/${kind}-(\\d+\\.\\d+\\.\\d+)-${target}\\.tar\\.gz$`,
  ).exec(url)
  return match?.[1] === undefined || match[2] === undefined ? undefined : { date: match[1], version: match[2] }
}

const headlongArtifactSetError = (lock: ProfileLock): string | undefined => {
  const nodeError = resolvedNodeError(lock)
  if (nodeError !== undefined) return nodeError
  const uvError = resolvedUvError(lock)
  if (uvError !== undefined) return uvError
  const artifacts = lock.packages.artifacts ?? []
  const rust = artifacts.find((artifact) => artifact.name === "rust")
  const standardLibrary = artifacts.find((artifact) => artifact.name === "rust-std-musl")
  if (artifacts.length !== 4 || rust === undefined || standardLibrary === undefined) {
    return "Headlong artifact set is invalid"
  }
  if (rust.version !== standardLibrary.version || !/^\d+\.\d+\.\d+$/.test(rust.version)) {
    return "Headlong Rust versions do not match"
  }
  const rustIdentity = rustUrlIdentity(rust.url, "rust")
  const standardLibraryIdentity = rustUrlIdentity(standardLibrary.url, "rust-std")
  return rustIdentity?.version === rust.version &&
    standardLibraryIdentity?.version === rust.version &&
    rustIdentity.date === standardLibraryIdentity.date
    ? undefined
    : "Headlong Rust artifact pair is inconsistent"
}

const primeArtifactSetError = (lock: ProfileLock): string | undefined => {
  if (lock.packages.artifacts === undefined) return undefined
  return resolvedNodeError(lock) ?? resolvedUvError(lock)
}

const harnessArtifactError = (document: ProfileDocument, lock: ProfileLock): string | undefined => {
  if (lock.packages.harness.kind === "claude") return claudeArtifactSetError(document, lock)
  if (lock.packages.harness.kind === "headlong") return headlongArtifactSetError(lock)
  if (lock.packages.harness.kind === "prime") return primeArtifactSetError(lock)
  if (lock.packages.harness.kind === "copilot" && lock.packages.artifacts !== undefined) {
    return resolvedNodeError(lock)
  }
  if (lock.packages.harness.kind === "codex" && lock.packages.artifacts?.some((artifact) => artifact.name === "uv")) {
    return resolvedUvError(lock)
  }
  return undefined
}

export const lockedArtifactError = (
  document: ProfileDocument,
  lock: ProfileLock,
  platform: Platform,
): string | undefined => {
  if (platform !== "linux/arm64") return `production artifacts are unavailable for ${platform}`
  if (!/^node:(?:bookworm-slim|\d+\.\d+\.\d+-bookworm-slim)$/.test(lock.image.base))
    return "base image artifact is unsupported"
  const artifactError = harnessArtifactError(document, lock)
  if (artifactError !== undefined) return artifactError
  if (document.profile.image.base !== lock.image.base) return "profile base image is unsupported for platform"
  return undefined
}
