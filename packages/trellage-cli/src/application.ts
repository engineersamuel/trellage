import { execFile, spawn } from "node:child_process"
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { Cause, Data, Effect, Exit } from "effect"
import lockfile from "proper-lockfile"

import { resolveGitHubSource } from "./github-cache.js"
import { resolveSandboxHeadlessCapabilities, sandboxHeadlessRuntimeAdapter } from "./headless-capabilities.js"
import { parseLock, renderLock } from "./lock-file.js"
import {
  attachedSidecar,
  compileLock,
  hasLegacyPackageProvenance,
  harnessPackageRevision,
  lockIsReady,
  packageResolutionInputsMatch,
  packageResolutionRequest,
  profileHash,
  requireLocked,
  requireResolvedLock,
  withAttachedSidecar,
  withFinalDigest,
  type ArtifactLock,
  type HarnessPackageLock,
  type LockResolvers,
  type ProfileLock,
} from "./lock.js"
import { createBuildContext, type PluginGenerator, type RuntimeSupport } from "./materialize.js"
import { claudePypiToolNames, isClaudeProfile, parseProfile, type ProfileDocument } from "./profile.js"
import { platformIdentity, platformLockPath, type Platform } from "./platform.js"
import { productionResolvers } from "./resolvers.js"
import { sourceIncludes, sourceInventoryPolicy } from "./source-policy.js"
import { createRuntimeSupportSnapshot, type RuntimeSupportSnapshot } from "./runtime-support.js"
import { dockerHostArguments, dockerSocketPath, verifyDockerTarget, type DockerTarget } from "./docker-target.js"
import { managedClaudeFiles } from "./claude-materialize.js"
import {
  loadResolutionReceipt,
  readResolutionReceiptBytes,
  removeResolutionReceipt,
  resolutionReceiptPath,
  writeResolutionReceipt,
  writeResolutionReceiptBytes,
} from "./resolution-receipt.js"
import { loadResolutionSidecar, writeResolutionSidecar } from "./resolution-sidecar-storage.js"
import type { ResolutionSidecar } from "./resolution-sidecar.js"
import { discoverPypiIndex, sanitizePypiIndex } from "./package-feeds.js"

export {
  discoverPypiIndex,
  microsoftProtectedPypiIndex,
  pypiIndexFromNpmRegistry,
  sanitizeNpmRegistry,
  sanitizePypiIndex,
  type CommandOutputRunner,
} from "./package-feeds.js"

const execFilePromise = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const compatibilityAdapter = path.join(repositoryRoot, "prototypes", "trellage", "adapt-agent-kit.sh")
const floatingSkillsManager = path.join(repositoryRoot, "scripts", "floating-skills.mjs")
const floatingSkillsCatalog = path.join(repositoryRoot, "skills.json")
const skillsCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/skills/bin/cli.mjs")

export class ApplicationError extends Data.TaggedError("ApplicationError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface UpgradeServices {
  readonly buildCandidate: (
    document: ProfileDocument,
    lock: ProfileLock,
    image: string,
    npmRegistry?: string,
  ) => Effect.Effect<string, ApplicationError>
  readonly imageExists: (image: string) => Effect.Effect<boolean, ApplicationError>
  readonly tagImage: (source: string, destination: string) => Effect.Effect<void, ApplicationError>
  readonly removeImage: (image: string) => Effect.Effect<void, ApplicationError>
}

const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const safeLockedVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const sha256Pattern = /^sha256:[0-9a-f]{64}$/

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`

/** Host env vars forwarded into the profile builder container. */
const builderForwardedEnvKeys = [
  "UV_DEFAULT_INDEX",
  "UV_INDEX",
  "UV_INDEX_URL",
  "UV_EXTRA_INDEX_URL",
  "PIP_INDEX_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const

/** Docker `--env KEY=value` pairs for builder-network configuration from the host. */
export const builderNetworkEnv = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options?: { readonly pypiIndex?: string },
): Array<string> => {
  const args: Array<string> = []
  const seen = new Set<string>()
  for (const key of builderForwardedEnvKeys) {
    const value = environment[key]
    if (value === undefined || value === "") continue
    // Refuse values that would break docker argv or shell scripts.
    if (value.includes("\0") || value.includes("\r") || value.includes("\n")) continue
    args.push("--env", `${key}=${value}`)
    seen.add(key)
  }
  // Inject a discovered corporate/simple index when the host did not set UV/PIP index env vars.
  // uv (Prime kernel bootstrap) reads UV_DEFAULT_INDEX; pip tools read PIP_INDEX_URL.
  const discovered = options?.pypiIndex === undefined ? undefined : sanitizePypiIndex(options.pypiIndex)
  if (discovered !== undefined) {
    if (!seen.has("UV_DEFAULT_INDEX")) {
      args.push("--env", `UV_DEFAULT_INDEX=${discovered}`)
      seen.add("UV_DEFAULT_INDEX")
    }
    if (!seen.has("PIP_INDEX_URL")) {
      args.push("--env", `PIP_INDEX_URL=${discovered}`)
    }
  }
  return args
}

const impossibleBuilderInput = (message: string): never => {
  throw new ApplicationError({ message })
}

const requiredArtifact = (lock: ProfileLock, name: string): ArtifactLock => {
  const artifact = lock.packages.artifacts?.find((candidate) => candidate.name === name)
  return artifact ?? impossibleBuilderInput(`builder requires an exact locked artifact: ${name}`)
}

const validSizedArtifact = (artifact: ArtifactLock | undefined): artifact is ArtifactLock =>
  artifact !== undefined &&
  sha256Pattern.test(artifact.integrity) &&
  Number.isSafeInteger(artifact.size) &&
  (artifact.size ?? 0) > 0

const resolveHeadlongRustArtifacts = (
  lock: ProfileLock,
): { readonly rust: ArtifactLock; readonly rustStandardLibrary: ArtifactLock } => {
  const rust = lock.packages.artifacts?.find((artifact) => artifact.name === "rust")
  if (
    !validSizedArtifact(rust) ||
    !/^\d+\.\d+\.\d+$/.test(rust.version) ||
    !/^https:\/\/static\.rust-lang\.org\/dist\/\d{4}-\d{2}-\d{2}\/rust-\d+\.\d+\.\d+-aarch64-unknown-linux-gnu\.tar\.gz$/.test(
      rust.url,
    )
  ) {
    return impossibleBuilderInput("Headlong builder requires the exact locked Rust toolchain artifact")
  }
  const rustStandardLibrary = lock.packages.artifacts?.find((artifact) => artifact.name === "rust-std-musl")
  if (
    !validSizedArtifact(rustStandardLibrary) ||
    rustStandardLibrary.version !== rust.version ||
    !/^https:\/\/static\.rust-lang\.org\/dist\/\d{4}-\d{2}-\d{2}\/rust-std-\d+\.\d+\.\d+-aarch64-unknown-linux-musl\.tar\.gz$/.test(
      rustStandardLibrary.url,
    )
  ) {
    return impossibleBuilderInput("Headlong builder requires the exact locked musl standard library artifact")
  }
  return { rust, rustStandardLibrary }
}

const headlongBuilderScript = (
  lock: ProfileLock,
  harness: Extract<HarnessPackageLock, { readonly kind: "headlong" }>,
  build: string,
): string => {
  if (!/^[0-9a-f]{40}$/.test(harness.commit)) {
    return impossibleBuilderInput("Headlong builder requires an exact locked commit")
  }
  const { rust, rustStandardLibrary } = resolveHeadlongRustArtifacts(lock)
  const target = "aarch64-unknown-linux-musl"
  const archive = `/src/rust-${rust.version}-aarch64-unknown-linux-gnu.tar.gz`
  const standardLibraryArchive = `/src/rust-std-${rust.version}-${target}.tar.gz`
  const stage = "/tmp/trellage-headlong-rust"
  const standardLibraryStage = "/tmp/trellage-headlong-rust-std"
  const toolchain = "/tmp/trellage-headlong-rust-toolchain"
  return [
    "rm -f /mise/config.toml",
    "mise install --locked",
    `curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output ${shellQuote(archive)} ${shellQuote(rust.url)}`,
    `[ "$(wc -c < ${shellQuote(archive)})" -eq ${rust.size} ]`,
    `printf '%s  %s\\n' ${shellQuote(rust.integrity.slice("sha256:".length))} ${shellQuote(archive)} | sha256sum --check --strict -`,
    `curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output ${shellQuote(standardLibraryArchive)} ${shellQuote(rustStandardLibrary.url)}`,
    `[ "$(wc -c < ${shellQuote(standardLibraryArchive)})" -eq ${rustStandardLibrary.size} ]`,
    `printf '%s  %s\\n' ${shellQuote(rustStandardLibrary.integrity.slice("sha256:".length))} ${shellQuote(standardLibraryArchive)} | sha256sum --check --strict -`,
    `rm -rf ${shellQuote(stage)} ${shellQuote(standardLibraryStage)} ${shellQuote(toolchain)}`,
    `mkdir -p ${shellQuote(stage)} ${shellQuote(standardLibraryStage)} ${shellQuote(toolchain)}`,
    `tar --no-same-owner --no-same-permissions -xzf ${shellQuote(archive)} -C ${shellQuote(stage)}`,
    `tar --no-same-owner --no-same-permissions -xzf ${shellQuote(standardLibraryArchive)} -C ${shellQuote(standardLibraryStage)}`,
    `${shellQuote(`${stage}/rust-${rust.version}-aarch64-unknown-linux-gnu/install.sh`)} --prefix=${shellQuote(toolchain)} --disable-ldconfig --without=rust-docs`,
    `${shellQuote(`${standardLibraryStage}/rust-std-${rust.version}-${target}/install.sh`)} --prefix=${shellQuote(toolchain)} --disable-ldconfig`,
    `PATH=${shellQuote(`${toolchain}/bin`)}:$PATH CARGO_HOME=/tmp/trellage-headlong-cargo RUSTC=${shellQuote(`${toolchain}/bin/rustc`)} RUSTC_WRAPPER= RUSTC_WORKSPACE_WRAPPER= cargo build --locked --release --target ${target} --manifest-path /src/headlong-seed/tui/headlong/Cargo.toml`,
    `cp /src/headlong-seed/tui/headlong/target/${target}/release/headlong-tui /src/headlong-tui`,
    "chmod 0755 /src/headlong-tui",
    "rm -rf /src/headlong-seed/tui/headlong/target",
    `rm -f ${shellQuote(archive)} ${shellQuote(standardLibraryArchive)}`,
    build,
  ].join("; ")
}

const codexBuilderScript = (lock: ProfileLock, tool: string, build: string): string => {
  const harness = lock.packages.harness
  if (harness.kind !== "codex") return impossibleBuilderInput("Codex builder requires a Codex package")
  if (hasLegacyPackageProvenance(lock)) {
    // Legacy Codex locks predate the code-mode-host companion binary; install just the CLI.
    return [
      `mise install --locked ${tool}`,
      `codex_dir=\"$(mise where ${tool})\"`,
      'rm -f "$codex_dir/metadata.json"',
      build,
    ].join("; ")
  }
  const artifacts = lock.packages.artifacts ?? []
  const codeModeHostArtifact = artifacts.find((artifact) => artifact.name === "codex-code-mode-host")
  if (
    codeModeHostArtifact === undefined ||
    artifacts.filter((artifact) => artifact.name === "codex-code-mode-host").length !== 1 ||
    codeModeHostArtifact.version !== harness.version ||
    !sha256Pattern.test(codeModeHostArtifact.integrity) ||
    !Number.isSafeInteger(codeModeHostArtifact.size ?? 0) ||
    (codeModeHostArtifact.size ?? 0) <= 0
  ) {
    return impossibleBuilderInput("Codex builder requires an exact locked code-mode host artifact")
  }
  const codeModeHostMember =
    lock.platform === "linux/arm64"
      ? "codex-code-mode-host-aarch64-unknown-linux-musl"
      : "codex-code-mode-host-x86_64-unknown-linux-musl"
  const expectedCodeModeHostUrl = `https://github.com/openai/codex/releases/download/rust-v${harness.version}/${codeModeHostMember}.tar.gz`
  if (codeModeHostArtifact.url !== expectedCodeModeHostUrl) {
    return impossibleBuilderInput("Codex builder requires an exact locked code-mode host artifact")
  }
  const codeModeHostArchive = "/src/codex-code-mode-host.tar.gz"
  const codeModeHostStage = "/tmp/trellage-codex-code-mode-host"
  return [
    `mise install --locked ${tool}`,
    `codex_dir=\"$(mise where ${tool})\"`,
    'rm -f "$codex_dir/metadata.json"',
    `curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output ${shellQuote(codeModeHostArchive)} ${shellQuote(codeModeHostArtifact.url)}`,
    `[ "$(wc -c < ${shellQuote(codeModeHostArchive)})" -eq ${codeModeHostArtifact.size} ]`,
    `printf '%s  %s\\n' ${shellQuote(codeModeHostArtifact.integrity.slice("sha256:".length))} ${shellQuote(codeModeHostArchive)} | sha256sum --check --strict -`,
    `rm -rf ${shellQuote(codeModeHostStage)}`,
    `mkdir -p ${shellQuote(codeModeHostStage)}`,
    `tar --no-same-owner --no-same-permissions -xzf ${shellQuote(codeModeHostArchive)} -C ${shellQuote(codeModeHostStage)}`,
    `[ "$(find ${shellQuote(codeModeHostStage)} -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ]`,
    `mv ${shellQuote(`${codeModeHostStage}/${codeModeHostMember}`)} \"$codex_dir/codex-code-mode-host\"`,
    'chmod 0755 "$codex_dir/codex-code-mode-host"',
    build,
  ].join("; ")
}

const claudeMarketplaceCommands = (
  document: ProfileDocument,
  lock: ProfileLock,
  nativeEnvironment: string,
): ReadonlyArray<string> => {
  if (document.profile.plugins.length !== lock.sources.length) {
    return impossibleBuilderInput("Claude builder requires exact locked marketplace plugins")
  }
  const commands: Array<string> = []
  for (let index = 0; index < document.profile.plugins.length; index += 1) {
    const marketplacePlugin = document.profile.plugins[index]!
    const marketplaceSource = lock.sources[index]
    const versions =
      marketplaceSource?.plugin_versions === undefined ? [] : Object.entries(marketplaceSource.plugin_versions)
    if (
      marketplacePlugin.adapter !== "claude-marketplace" ||
      marketplaceSource?.adapter !== "claude-marketplace" ||
      marketplaceSource.marketplace !== marketplacePlugin.marketplace ||
      marketplaceSource.repository !== marketplacePlugin.repository ||
      marketplaceSource.ref !== marketplacePlugin.ref ||
      JSON.stringify(marketplaceSource.select) !== JSON.stringify(marketplacePlugin.select) ||
      versions.length !== marketplacePlugin.select.length ||
      versions.some(([name, version]) => !safeIdentifierPattern.test(name) || !safeLockedVersionPattern.test(version))
    ) {
      return impossibleBuilderInput("Claude builder requires exact locked marketplace plugins")
    }
    commands.push(
      `${nativeEnvironment} "$claude_bin" plugin marketplace add /src/claude-marketplace-${index}`,
      ...marketplacePlugin.select.map(
        (selection) =>
          `${nativeEnvironment} "$claude_bin" plugin install ${selection}@${marketplacePlugin.marketplace} --scope user`,
      ),
    )
  }
  return commands
}

const hyperresearchBuilderScript = (
  lock: ProfileLock,
  claudeDirectory: string,
  normalizeClaudeMetadata: string,
  build: string,
): string => {
  const node = requiredArtifact(lock, "node")
  const uv = requiredArtifact(lock, "uv")
  const python = requiredArtifact(lock, "python")
  const mcp = requiredArtifact(lock, "playwright-mcp")
  const playwright = requiredArtifact(lock, "playwright")
  const core = requiredArtifact(lock, "playwright-core")
  const packageCheck =
    'const root="/src/playwright-mcp-prefix/lib/node_modules/";const expected=JSON.parse(process.argv[1]);for(const [name,version] of Object.entries(expected)){const actual=require(root+name+"/package.json").version;if(actual!==version)process.exit(1)}'
  const pythonVersion = python.version.split(".").slice(0, 2).join(".")
  const materializePythonSite = `mkdir -p /src/hyperresearch-site; mise x --locked uv@${uv.version} -- uv pip install --target /src/hyperresearch-site --python-version ${pythonVersion} --python-platform aarch64-manylinux_2_28 --require-hashes --no-deps -r /src/python-constraints.lock; cp -R /src/hyperresearch-package/hyperresearch /src/hyperresearch-site/hyperresearch`
  return [
    "mise install --locked",
    `node_dir="$(mise where node@${node.version})"`,
    "rm -rf /src/playwright-mcp-prefix",
    `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 "$node_dir/bin/npm" install --global --prefix /src/playwright-mcp-prefix --ignore-scripts --omit=optional --offline --no-audit --no-fund --loglevel=error /src/npm-artifacts/playwright-mcp.tgz /src/npm-artifacts/playwright.tgz /src/npm-artifacts/playwright-core.tgz`,
    `"$node_dir/bin/node" -e ${shellQuote(packageCheck)} ${shellQuote(
      JSON.stringify({
        "@playwright/mcp": mcp.version,
        playwright: playwright.version,
        "playwright-core": core.version,
      }),
    )}`,
    materializePythonSite,
    claudeDirectory,
    normalizeClaudeMetadata,
    build,
  ].join("; ")
}

const claudeMarketplaceBuilderScript = (
  document: ProfileDocument,
  lock: ProfileLock,
  tool: string,
  build: string,
  harnessVersion: string,
  claudeDirectory: string,
  normalizeClaudeMetadata: string,
): string => {
  const node = requiredArtifact(lock, "node")
  const nativeEnvironment =
    "HOME=/src/claude-builder-home CLAUDE_CONFIG_DIR=/src/claude-seed DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 NO_COLOR=1 TERM=dumb"
  const marketplaceCommands = claudeMarketplaceCommands(document, lock, nativeEnvironment)
  const extraPython = isClaudeProfile(document.profile) && claudePypiToolNames(document.profile).length > 0
  const uv = extraPython ? requiredArtifact(lock, "uv") : undefined
  const python = extraPython ? requiredArtifact(lock, "python") : undefined
  const pythonVersion = python?.version.split(".").slice(0, 2).join(".")
  return [
    extraPython ? "mise install --locked" : `mise install --locked node@${node.version} ${tool}`,
    claudeDirectory,
    'claude_bin="$claude_dir/claude"',
    '[ -x "$claude_bin" ]',
    `node_bin="$(mise where node@${node.version})/bin/node"`,
    '[ -x "$node_bin" ]',
    normalizeClaudeMetadata,
    ...marketplaceCommands,
    `"$node_bin" /src/finalize-claude-seed.mjs /src/claude-seed /src/claude-marketplaces.json ${harnessVersion}`,
    ...(extraPython
      ? [
          "mkdir -p /src/graph-tools-site",
          `mise x --locked uv@${uv!.version} -- uv pip install --target /src/graph-tools-site --python-version ${pythonVersion} --python-platform aarch64-manylinux_2_28 --require-hashes --no-deps -r /src/graph-of-loops-requirements.lock`,
        ]
      : []),
    build,
  ].join("; ")
}

const claudeBuilderScript = (document: ProfileDocument, lock: ProfileLock, tool: string, build: string): string => {
  const harness = lock.packages.harness
  if (harness.kind !== "claude") return impossibleBuilderInput("Claude builder requires a Claude package")
  const claudeDirectory = `claude_dir="$(mise where ${tool})"`
  const normalizeClaudeMetadata = [
    'claude_metadata="$claude_dir/metadata.json"',
    '[ -f "$claude_metadata" ]',
    `grep -Eq '^  "extracted_at": [0-9]+,$' "$claude_metadata"`,
    `sed -i -E "s/^  \\"extracted_at\\": [0-9]+,$/  \\"extracted_at\\": $SOURCE_DATE_EPOCH,/" "$claude_metadata"`,
    `grep -Fqx "  \\"extracted_at\\": $SOURCE_DATE_EPOCH," "$claude_metadata"`,
    `find /mise/installs -name metadata.json -type f ! -path "$claude_metadata" -delete`,
  ].join("; ")
  if (document.profile.plugins.length === 0) {
    const isolateCoreTools =
      document.profile.harness.kind === "claude" && document.profile.harness.claude.mode === "core"
        ? "rm -f /mise/config.toml; "
        : ""
    return `${isolateCoreTools}mise install --locked; ${claudeDirectory}; ${normalizeClaudeMetadata}; ${build}`
  }
  const plugin = document.profile.plugins[0]
  const source = lock.sources[0]
  if (
    plugin?.adapter === "hyperresearch" &&
    source?.adapter === "hyperresearch" &&
    document.profile.plugins.length === 1 &&
    lock.sources.length === 1
  ) {
    return hyperresearchBuilderScript(lock, claudeDirectory, normalizeClaudeMetadata, build)
  }
  return claudeMarketplaceBuilderScript(
    document,
    lock,
    tool,
    build,
    harness.version,
    claudeDirectory,
    normalizeClaudeMetadata,
  )
}

const primeBuilderScript = (lock: ProfileLock, build: string): string => {
  const harness = lock.packages.harness
  if (harness.kind !== "prime") return impossibleBuilderInput("Prime builder requires a Prime package")
  const node = requiredArtifact(lock, "node")
  const uv = requiredArtifact(lock, "uv")
  const filename = `prime-agent-${harness.version}.tgz`
  const expectedUrl = `https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v${harness.version}/${filename}`
  if (
    harness.url !== expectedUrl ||
    !sha256Pattern.test(harness.integrity) ||
    !Number.isSafeInteger(harness.size) ||
    harness.size <= 0
  ) {
    return impossibleBuilderInput("Prime builder requires an exact locked release tarball")
  }
  const artifact = `/src/${filename}`
  const kernelHome = "/home/agent/.trellage/prime-kernel"
  const kernelSeed = "/src/prime-kernel-seed.tar.gz"
  const packageCheck =
    'const p=require("/src/prime-agent-prefix/lib/node_modules/prime-agent/package.json");if(p.name!=="prime-agent"||p.version!==process.argv[1]||p.bin?.["prime-agent"]!=="dist/bundle/cli.js")process.exit(1)'
  const kernelBootstrap =
    'import { ensureKernelPython } from "file:///src/prime-agent-prefix/lib/node_modules/prime-agent/dist/core/kernel/bootstrap.js";await ensureKernelPython()'
  const constraintInstall =
    lock.packages.python_lock_integrity === undefined
      ? []
      : [
          `PYTHONDONTWRITEBYTECODE=1 mise x --locked uv@${uv.version} -- uv pip install --python "$prime_kernel_home/.prime/agent/kernel-venv/bin/python" --require-hashes --no-deps --reinstall -r /src/python-constraints.lock`,
        ]
  return [
    `prime_artifact=${shellQuote(artifact)}`,
    `curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output "$prime_artifact" ${shellQuote(harness.url)}`,
    `[ "$(wc -c < "$prime_artifact")" -eq ${harness.size} ]`,
    `printf '%s  %s\\n' ${shellQuote(harness.integrity.slice("sha256:".length))} "$prime_artifact" | sha256sum --check --strict -`,
    "rm -f /mise/config.toml",
    `mise install --locked node@${node.version}`,
    `prime_node_dir="$(mise where node@${node.version})"`,
    '[ -x "$prime_node_dir/bin/node" ]',
    '[ -x "$prime_node_dir/bin/npm" ]',
    `PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL=0 PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=0 PRIME_AGENT_INSTALL_UV=0 PATH="$prime_node_dir/bin:$PATH" "$prime_node_dir/bin/npm" install --global --prefix /src/prime-agent-prefix --no-fund --no-audit --loglevel=error --progress=false "$prime_artifact"`,
    `"$prime_node_dir/bin/node" -e ${shellQuote(packageCheck)} ${shellQuote(harness.version)}`,
    `prime_kernel_home=${shellQuote(kernelHome)}`,
    `prime_kernel_seed=${shellQuote(kernelSeed)}`,
    'rm -rf "$prime_kernel_home" "$prime_kernel_seed"',
    'mkdir -p "$prime_kernel_home"',
    // ensureKernelPython installs uv, Python 3.11, seed packages, and the runtime
    // over HTTPS (normally files.pythonhosted.org). Surface an actionable hint when
    // that CDN is unreachable; UV_DEFAULT_INDEX is forwarded from the host.
    "prime_kernel_status=0",
    `HOME="$prime_kernel_home" XDG_CACHE_HOME="$prime_kernel_home/.cache" PYTHONDONTWRITEBYTECODE=1 PRIME_AGENT_INSTALL_UV=1 PATH="$prime_node_dir/bin:$PATH" "$prime_node_dir/bin/node" --input-type=module -e ${shellQuote(kernelBootstrap)} || prime_kernel_status=$?`,
    '[ "$prime_kernel_status" -eq 0 ] || { printf \'%s\\n\' "trellage: Prime Python kernel bootstrap failed (exit $prime_kernel_status)." >&2; printf \'%s\\n\' "This step needs a reachable PyPI simple index for uv seed packages, ipykernel, and default runtime packages." >&2; printf \'%s\\n\' "On Microsoft-managed devices, public pypi.org / files.pythonhosted.org are blocked; use the CFS feed (UV_DEFAULT_INDEX=https://packagefeedproxy.microsoft.io/pypi/simple/) or configure pip global.index-url, then rebuild." >&2; printf \'%s\\n\' "Elsewhere, set UV_DEFAULT_INDEX or PIP_INDEX_URL to any reachable simple-index mirror." >&2; exit "$prime_kernel_status"; }',
    ...constraintInstall,
    'printf \'%s\\n\' "schema=1" > "$prime_kernel_home/.trellage-prime-kernel"',
    'find "$prime_kernel_home" -type d -name __pycache__ -prune -exec rm -rf {} +',
    'prime_runtime_record="$(find "$prime_kernel_home/.prime/agent/kernel-venv/lib" -path \'*/site-packages/prime_agent_runtime-*.dist-info/RECORD\' -type f -print -quit)"',
    '[ -n "$prime_runtime_record" ]',
    'prime_runtime_dist_info="$(dirname "$prime_runtime_record")"',
    'rm -f "$prime_runtime_dist_info/uv_cache.json"',
    "sed -i '/prime_agent_runtime-.*\\.dist-info\\/uv_cache\\.json,/d' \"$prime_runtime_record\"",
    'tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner -C "$prime_kernel_home" -cf - .trellage-prime-kernel .local/share/uv/python .prime/agent/kernel-venv | gzip -n > "$prime_kernel_seed"',
    'rm -rf "$prime_kernel_home"',
    build,
  ].join("; ")
}

interface CopilotPluginSelection {
  readonly marketplace: string
  readonly selected: string
  readonly repository: string
  readonly ref: string
}

const copilotPluginSelection = (
  plugin: ProfileDocument["profile"]["plugins"][number] | undefined,
): CopilotPluginSelection | undefined => {
  if (plugin === undefined || !("marketplace" in plugin) || plugin.select.length !== 1) return undefined
  const selected = plugin.select[0]
  return selected === undefined
    ? undefined
    : { marketplace: plugin.marketplace, selected, repository: plugin.repository, ref: plugin.ref }
}

const copilotSourceMatches = (
  source: ProfileLock["sources"][number] | undefined,
  selection: CopilotPluginSelection,
): boolean =>
  source !== undefined &&
  source.kind === "plugin" &&
  source.adapter === "copilot-marketplace" &&
  source.marketplace === selection.marketplace &&
  source.repository === selection.repository &&
  source.ref === selection.ref &&
  source.select.length === 1 &&
  source.select[0] === selection.selected

const copilotPluginVersion = (
  source: ProfileLock["sources"][number] | undefined,
  selection: CopilotPluginSelection,
  harnessVersion: string,
): string | undefined => {
  const versions = source?.plugin_versions === undefined ? [] : Object.entries(source.plugin_versions)
  const version = versions[0]?.[1]
  if (
    versions.length !== 1 ||
    versions[0]?.[0] !== selection.selected ||
    !exactVersionPattern.test(harnessVersion) ||
    !safeIdentifierPattern.test(selection.marketplace) ||
    !safeIdentifierPattern.test(selection.selected) ||
    version === undefined ||
    !exactVersionPattern.test(version)
  ) {
    return undefined
  }
  return version
}

const copilotPluginDetails = (
  document: ProfileDocument,
  lock: ProfileLock,
): { readonly marketplace: string; readonly selected: string; readonly version: string } => {
  const harness = lock.packages.harness
  if (harness.kind !== "copilot") {
    return impossibleBuilderInput("Copilot builder requires a Copilot package")
  }
  const source = lock.sources[0]
  const selection = copilotPluginSelection(document.profile.plugins[0])
  if (
    document.profile.plugins.length !== 1 ||
    lock.sources.length !== 1 ||
    selection === undefined ||
    !copilotSourceMatches(source, selection)
  ) {
    return impossibleBuilderInput("Copilot builder requires one exact locked marketplace plugin")
  }
  const version = copilotPluginVersion(source, selection, harness.version)
  if (version === undefined)
    return impossibleBuilderInput("Copilot builder requires one exact locked marketplace plugin")
  return { ...selection, version }
}

const copilotBuilderScript = (document: ProfileDocument, lock: ProfileLock, tool: string, build: string): string => {
  const harness = lock.packages.harness
  if (harness.kind !== "copilot") return impossibleBuilderInput("Copilot builder requires a Copilot package")
  const node = requiredArtifact(lock, "node")
  const { marketplace, selected, version } = copilotPluginDetails(document, lock)
  const plugin = `${selected}@${marketplace}`
  const nativeEnvironment = "COPILOT_HOME=/src/copilot-seed COPILOT_AUTO_UPDATE=false NO_COLOR=1 TERM=dumb"
  const expectedRow = `  • ${plugin} (v${version})`
  return [
    `mise install --locked node@${node.version} ${tool}`,
    `copilot_dir="$(mise where ${tool})"`,
    'copilot_bin="$copilot_dir/copilot"',
    '[ -x "$copilot_bin" ]',
    'rm -f "$copilot_dir/metadata.json"',
    `${nativeEnvironment} "$copilot_bin" plugin marketplace add /src/hve-core`,
    `${nativeEnvironment} "$copilot_bin" plugin install ${plugin}`,
    "plugin_list_status=0",
    `plugin_list="$(${nativeEnvironment} "$copilot_bin" plugin list)" || plugin_list_status=$?`,
    '[ "$plugin_list_status" -eq 0 ]',
    `printf '%s\\n' "$plugin_list" | awk -v expected='${expectedRow}' '$0 == expected || $0 == expected " (enabled)" { count++ } END { exit count == 1 ? 0 : 1 }'`,
    `node_bin="$(mise where node@${node.version})/bin/node"`,
    '[ -x "$node_bin" ]',
    `"$node_bin" /src/finalize-copilot-seed.mjs /src/copilot-seed ${marketplace} ${selected} ${version}`,
    build,
  ].join("; ")
}

export const builderScript = (document: ProfileDocument, lock: ProfileLock): string => {
  const harness = lock.packages.harness
  if (document.profile.harness.kind !== harness.kind) {
    return impossibleBuilderInput("profile and lock harness packages do not match")
  }
  const build = 'PATH=/src/build-support:$PATH mise oci build --locked --output "$OUTPUT_DIR" --tag "$IMAGE_REF"'
  if (harness.kind === "headlong") return headlongBuilderScript(lock, harness, build)
  if (!safeLockedVersionPattern.test(harness.version)) {
    return impossibleBuilderInput("profile and lock harness packages do not match")
  }
  const tool = `http:${harness.kind}@${harness.version}`
  if (harness.kind === "codex") return codexBuilderScript(lock, tool, build)
  if (harness.kind === "claude") return claudeBuilderScript(document, lock, tool, build)
  if (harness.kind === "pi") {
    return `mise install --locked ${tool}; pi_dir=\"$(mise where ${tool})\"; rm -f \"$pi_dir/metadata.json\"; ${build}`
  }
  if (harness.kind === "prime") return primeBuilderScript(lock, build)
  return copilotBuilderScript(document, lock, tool, build)
}

const io = <A>(message: string, operation: () => Promise<A>): Effect.Effect<A, ApplicationError> =>
  Effect.tryPromise({ try: operation, catch: (cause) => new ApplicationError({ message, cause }) })

export const adjacentLockPath = platformLockPath

const attachSkillBundlePolicy = (document: ProfileDocument): Effect.Effect<ProfileDocument, ApplicationError> => {
  if (document.profile.skill_bundles.length === 0) return Effect.succeed(document)
  return io("cannot read floating skill catalog", () => readFile(floatingSkillsCatalog, "utf8")).pipe(
    Effect.flatMap((source) =>
      Effect.try({
        try: () => JSON.parse(source) as unknown,
        catch: (cause) => new ApplicationError({ message: "floating skill catalog is invalid", cause }),
      }),
    ),
    Effect.flatMap((catalog) => {
      if (
        typeof catalog !== "object" ||
        catalog === null ||
        !("bundles" in catalog) ||
        typeof catalog.bundles !== "object" ||
        catalog.bundles === null
      ) {
        return Effect.fail(new ApplicationError({ message: "floating skill catalog has no bundles" }))
      }
      const bundles = catalog.bundles as Readonly<Record<string, unknown>>
      const unknown = document.profile.skill_bundles.find((bundle) => !Object.hasOwn(bundles, bundle))
      if (unknown !== undefined) {
        return Effect.fail(new ApplicationError({ message: `unknown skill bundle: ${unknown}` }))
      }
      if (!("sources" in catalog) || typeof catalog.sources !== "object" || catalog.sources === null) {
        return Effect.fail(new ApplicationError({ message: "floating skill catalog has no sources" }))
      }
      const sources = catalog.sources as Readonly<Record<string, unknown>>
      const sourceIds = [
        ...new Set(
          document.profile.skill_bundles.flatMap((bundle) => {
            const sourceIds = bundles[bundle]
            return Array.isArray(sourceIds) && sourceIds.every((sourceId) => typeof sourceId === "string")
              ? sourceIds
              : []
          }),
        ),
      ].sort((left, right) => left.localeCompare(right, "en"))
      const invalidBundle = document.profile.skill_bundles.find((bundle) => {
        const sourceIds = bundles[bundle]
        return !Array.isArray(sourceIds) || !sourceIds.every((sourceId) => typeof sourceId === "string")
      })
      if (invalidBundle !== undefined) {
        return Effect.fail(new ApplicationError({ message: `invalid skill bundle: ${invalidBundle}` }))
      }
      const missingSource = sourceIds.find((sourceId) => !Object.hasOwn(sources, sourceId))
      if (missingSource !== undefined) {
        return Effect.fail(new ApplicationError({ message: `unknown skill source: ${missingSource}` }))
      }
      const floatingSkillPolicy = JSON.stringify({
        bundles: [...document.profile.skill_bundles].sort((left, right) => left.localeCompare(right, "en")),
        sources: sourceIds.map((sourceId) => [sourceId, sources[sourceId]]),
      })
      return Effect.succeed({ ...document, floatingSkillPolicy })
    }),
  )
}

export const loadProfile = (profilePath: string): Effect.Effect<ProfileDocument, ApplicationError> =>
  io(`cannot read profile: ${profilePath}`, () => readFile(profilePath, "utf8")).pipe(
    Effect.flatMap((source) => parseProfile(source, profilePath)),
    Effect.flatMap(attachSkillBundlePolicy),
    Effect.mapError(
      (cause) => new ApplicationError({ message: "message" in cause ? String(cause.message) : String(cause), cause }),
    ),
  )

export const loadReleaseLock = (
  profilePath: string,
  platform: Platform,
): Effect.Effect<ProfileLock | undefined, ApplicationError> => {
  const lockPath = adjacentLockPath(profilePath, platform)
  return Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(lockPath, "utf8")
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw cause
      }
    },
    catch: (cause) => new ApplicationError({ message: `cannot read release lock: ${lockPath}`, cause }),
  }).pipe(
    Effect.flatMap((source) =>
      source === undefined
        ? Effect.succeed(undefined)
        : parseLock(source).pipe(Effect.map((lock) => lock as ProfileLock | undefined)),
    ),
    Effect.mapError(
      (cause) => new ApplicationError({ message: "message" in cause ? String(cause.message) : String(cause), cause }),
    ),
  )
}

export const loadLock = loadReleaseLock

let atomicWriteSequence = 0
const writeReleaseLockBytes = (
  profilePath: string,
  platform: Platform,
  contents: string,
): Effect.Effect<void, ApplicationError> => {
  const destination = adjacentLockPath(profilePath, platform)
  const temporary = `${destination}.tmp-${process.pid}-${atomicWriteSequence++}`
  return io(`cannot write release lock: ${destination}`, async () => {
    await writeFile(temporary, contents, { flag: "wx" })
    await rename(temporary, destination)
  }).pipe(Effect.ensuring(io("cannot clean temporary lock", () => rm(temporary, { force: true })).pipe(Effect.ignore)))
}

export const writeReleaseLock = (profilePath: string, lock: ProfileLock): Effect.Effect<void, ApplicationError> =>
  Effect.gen(function* () {
    const lockPath = adjacentLockPath(profilePath, lock.platform)
    const sidecar = attachedSidecar(lock)
    if (sidecar !== undefined) {
      const reference = yield* writeResolutionSidecar(lockPath, sidecar).pipe(
        Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
      )
      if (
        lock.sidecar === undefined ||
        reference.integrity !== lock.sidecar.integrity ||
        reference.size !== lock.sidecar.size
      ) {
        return yield* Effect.fail(new ApplicationError({ message: "resolution sidecar reference mismatch" }))
      }
    }
    yield* writeReleaseLockBytes(profilePath, lock.platform, renderLock(lock))
  })

export const writeLock = writeReleaseLock

export const compileProfileLock = (
  profilePath: string,
  update: boolean,
  xdgCacheHome: string,
  platform: Platform,
  npmRegistry?: string,
): Effect.Effect<ProfileLock, ApplicationError> =>
  Effect.gen(function* () {
    const document = yield* loadProfile(profilePath)
    const release = yield* loadReleaseLock(profilePath, platform)
    const receipt = yield* loadResolutionReceipt(document, platform, xdgCacheHome).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    )
    const current = receipt ?? release
    const lock = yield* compileLock(
      document,
      current,
      update,
      productionResolvers(xdgCacheHome, platform, npmRegistry),
    ).pipe(Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })))
    if (!lockIsReady(document, lock, platform)) {
      return yield* Effect.fail(
        new ApplicationError({
          message: "release snapshot is incomplete; run a development build before creating the release lock",
        }),
      )
    }
    if (lock === release) {
      yield* resolveLockSidecar(adjacentLockPath(profilePath, platform), lock)
      return lock
    }
    const sidecar =
      lock.sidecar === undefined
        ? undefined
        : yield* resolveLockSidecar(
            receipt === undefined
              ? adjacentLockPath(profilePath, platform)
              : resolutionReceiptPath(document, platform, xdgCacheHome),
            lock,
          )
    const snapshot = sidecar === undefined ? lock : withAttachedSidecar(lock, sidecar)
    yield* writeReleaseLock(profilePath, snapshot)
    return snapshot
  })

export const snapshotProfileReleaseLock = compileProfileLock

interface DevelopmentResolution {
  readonly receipt: ProfileLock | undefined
  readonly current: ProfileLock | undefined
}

const loadDevelopmentResolution = (
  document: ProfileDocument,
  xdgCacheHome: string,
  platform: Platform,
): Effect.Effect<DevelopmentResolution, ApplicationError> =>
  Effect.gen(function* () {
    const receipt = yield* loadResolutionReceipt(document, platform, xdgCacheHome).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    )
    return { receipt, current: receipt }
  })

const resolveLockSidecar = (
  lockPath: string,
  lock: ProfileLock,
): Effect.Effect<ResolutionSidecar | undefined, ApplicationError> => {
  const sidecar = attachedSidecar(lock)
  return sidecar === undefined
    ? loadResolutionSidecar(lockPath, lock).pipe(
        Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
      )
    : Effect.succeed(sidecar)
}

const publishAttachedSidecar = (lockPath: string, lock: ProfileLock): Effect.Effect<void, ApplicationError> => {
  const sidecar = attachedSidecar(lock)
  if (sidecar === undefined) return Effect.void
  return writeResolutionSidecar(lockPath, sidecar).pipe(
    Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    Effect.flatMap((reference) =>
      lock.sidecar !== undefined &&
      reference.integrity === lock.sidecar.integrity &&
      reference.size === lock.sidecar.size
        ? Effect.void
        : Effect.fail(new ApplicationError({ message: "resolution sidecar reference mismatch" })),
    ),
  )
}

interface CommandOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdio?: "inherit"
}

const run = (command: string, args: ReadonlyArray<string>, options?: CommandOptions) =>
  options?.stdio === "inherit"
    ? Effect.tryPromise({
        try: (signal) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(command, [...args], {
              ...(options.cwd ? { cwd: options.cwd } : {}),
              ...(options.env ? { env: options.env } : {}),
              stdio: "inherit",
            })
            const abort = () => child.kill("SIGTERM")
            signal.addEventListener("abort", abort, { once: true })
            child.once("error", reject)
            child.once("close", (code, childSignal) => {
              signal.removeEventListener("abort", abort)
              if (code === 0) resolve()
              else reject(new Error(`command exited with ${code ?? `signal ${childSignal ?? "unknown"}`}`))
            })
          }),
        catch: (cause) => new ApplicationError({ message: `command failed: ${command}`, cause }),
      })
    : Effect.tryPromise({
        try: async (signal) => {
          await execFilePromise(command, args, {
            ...(options?.cwd ? { cwd: options.cwd } : {}),
            ...(options?.env ? { env: options.env } : {}),
            maxBuffer: 32 * 1024 * 1024,
            signal,
          })
        },
        catch: (cause) => new ApplicationError({ message: `command failed: ${command}`, cause }),
      })

export const compatibilityPluginArguments = (
  sourceDirectory: string,
  selection: string,
  destination: string,
  uvVersion: string,
): ReadonlyArray<string> => [
  "--no-config",
  "x",
  `uv@${uvVersion}`,
  "--",
  "uv",
  "run",
  "--no-project",
  "--python",
  "3.13",
  "python",
  path.join(sourceDirectory, "tools", "generate.py"),
  "--harness",
  "codex",
  "--plugin",
  selection,
  "--output-root",
  destination,
]

const pluginGenerator: PluginGenerator = (sourceDirectory, selections, destination, uvVersion) =>
  Effect.forEach(
    selections,
    (selection) =>
      run("mise", compatibilityPluginArguments(sourceDirectory, selection, destination, uvVersion), {
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
        },
      }),
    { concurrency: 1 },
  ).pipe(Effect.zipRight(run("bash", [compatibilityAdapter, destination])), Effect.asVoid)

export type CommandRunner = typeof run

export interface DockerServices {
  readonly run: CommandRunner
  readonly verify: (target: DockerTarget) => Effect.Effect<void, ApplicationError>
}

const buildOci = (
  context: string,
  imageTag: string,
  document: ProfileDocument,
  lock: ProfileLock,
  target: DockerTarget,
  docker: DockerServices,
  expectedDigest?: string,
  npmRegistry?: string,
): Effect.Effect<string, ApplicationError> =>
  Effect.gen(function* () {
    const output = path.join(context, "oci")
    const platform = lock.platform
    if (platform !== target.platform) {
      return yield* Effect.fail(new ApplicationError({ message: "lock platform does not match Docker target" }))
    }
    if (lock.build === undefined) {
      return yield* Effect.fail(
        new ApplicationError({
          message: "lock has no exact build helper images; create a new development receipt or release snapshot",
        }),
      )
    }
    const builderImage = `${lock.build.builder.reference}@${lock.build.builder.digest}`
    const importerImage = `${lock.build.importer.reference}@${lock.build.importer.digest}`
    yield* docker.verify(target)
    const pypiIndex = yield* Effect.promise(() =>
      discoverPypiIndex(npmRegistry === undefined ? {} : { npmRegistry }).catch(() => undefined),
    )
    yield* docker.run(
      "docker",
      dockerHostArguments(target, [
        "run",
        "--rm",
        "--platform",
        platform,
        "--user",
        "0:0",
        "--env",
        "MISE_EXPERIMENTAL=1",
        "--env",
        "MISE_GLOBAL_CONFIG_FILE=/dev/null",
        "--env",
        "MISE_CONFIG_DIR=/tmp/mise-config",
        "--env",
        "MISE_DATA_DIR=/tmp/mise-data",
        "--env",
        "MISE_CACHE_DIR=/tmp/mise-cache",
        "--env",
        "MISE_YES=1",
        "--env",
        "npm_config_fetch_retries=5",
        "--env",
        "npm_config_fetch_retry_factor=2",
        "--env",
        "npm_config_fetch_retry_mintimeout=1000",
        "--env",
        "npm_config_fetch_retry_maxtimeout=10000",
        ...(npmRegistry === undefined ? [] : ["--env", `npm_config_registry=${npmRegistry}`]),
        ...builderNetworkEnv(process.env, pypiIndex === undefined ? {} : { pypiIndex }),
        "--env",
        `SOURCE_DATE_EPOCH=${lock.source_date_epoch}`,
        "--env",
        "OUTPUT_DIR=/src/oci",
        "--env",
        `IMAGE_REF=${imageTag}`,
        "--mount",
        `type=bind,src=${context},dst=/src`,
        ...(document.profile.plugins.some((plugin) => plugin.adapter === "hyperresearch")
          ? ["--mount", "type=tmpfs,dst=/src/hyperresearch-site"]
          : []),
        "--workdir",
        "/src",
        "--entrypoint",
        "sh",
        builderImage,
        "-ceu",
        builderScript(document, lock),
      ]),
      { stdio: "inherit" },
    )
    const index = yield* io("cannot read built OCI index", () => readFile(path.join(output, "index.json"), "utf8"))
    const parsed = yield* Effect.try({
      try: () => JSON.parse(index) as { manifests?: Array<{ digest?: string }> },
      catch: (cause) => new ApplicationError({ message: "built OCI index is invalid", cause }),
    })
    const digest = parsed.manifests?.[0]?.digest
    if (!digest?.startsWith("sha256:"))
      return yield* Effect.fail(new ApplicationError({ message: "built OCI index has no manifest digest" }))
    if (expectedDigest !== undefined && digest !== expectedDigest) {
      return yield* Effect.fail(
        new ApplicationError({
          message: `locked OCI digest mismatch: expected ${expectedDigest}, actual ${digest}`,
        }),
      )
    }
    yield* docker.verify(target)
    yield* docker.run(
      "docker",
      dockerHostArguments(target, [
        "run",
        "--rm",
        "--platform",
        platform,
        "--mount",
        `type=bind,src=${context},dst=/work,readonly`,
        "--mount",
        `type=bind,src=${dockerSocketPath(target)},dst=/var/run/docker.sock`,
        importerImage,
        "copy",
        "oci:/work/oci",
        `docker-daemon:${imageTag}`,
      ]),
      { stdio: "inherit" },
    )
    return digest
  })

const floatingSkillDestination = (document: ProfileDocument, context: string): string =>
  document.profile.harness.kind === "codex"
    ? path.join(context, "assets", "skills")
    : document.profile.harness.kind === "copilot"
      ? path.join(context, "copilot-seed", "skills")
      : document.profile.harness.kind === "claude"
        ? path.join(context, "claude-seed", "skills")
        : document.profile.harness.kind === "headlong"
          ? path.join(context, "headlong-skills", "skills")
          : document.profile.harness.kind === "prime"
            ? path.join(context, "prime-seed", "skills")
            : path.join(context, "pi-seed", "skills")

const floatingInstructionDestination = (document: ProfileDocument, context: string): string =>
  document.profile.harness.kind === "codex"
    ? path.join(context, "assets", "AGENTS.md")
    : document.profile.harness.kind === "copilot"
      ? path.join(context, "copilot-seed", "copilot-instructions.md")
      : document.profile.harness.kind === "claude"
        ? path.join(context, "claude-seed", "CLAUDE.md")
        : document.profile.harness.kind === "prime"
          ? path.join(context, "prime-seed", "APPEND_SYSTEM.md")
          : path.join(context, "pi-seed", "APPEND_SYSTEM.md")

const readOptionalText = (candidate: string): Effect.Effect<string, ApplicationError> =>
  io(`cannot read optional build asset: ${candidate}`, async () => {
    try {
      return await readFile(candidate, "utf8")
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return ""
      throw cause
    }
  })

const readFloatingSkillNames = (snapshot: string): Effect.Effect<ReadonlyArray<string>, ApplicationError> =>
  Effect.gen(function* () {
    const manifest = yield* io("cannot read floating skill manifest", () =>
      readFile(path.join(snapshot, "managed-skills.txt"), "utf8"),
    )
    const names = manifest.split("\n").filter(Boolean)
    if (
      names.length === 0 ||
      names.some((name) => !safeIdentifierPattern.test(name)) ||
      new Set(names).size !== names.length
    ) {
      return yield* Effect.fail(new ApplicationError({ message: "floating skill manifest is invalid" }))
    }
    const root = path.join(snapshot, "skills")
    const actual = yield* io("cannot enumerate floating skill snapshot", () => readdir(root))
    actual.sort((left, right) => left.localeCompare(right, "en"))
    const expected = [...names].sort((left, right) => left.localeCompare(right, "en"))
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return yield* Effect.fail(new ApplicationError({ message: "floating skill snapshot does not match manifest" }))
    }
    return expected
  })

const copyFloatingSkills = (
  snapshot: string,
  destination: string,
  names: ReadonlyArray<string>,
): Effect.Effect<void, ApplicationError> =>
  Effect.forEach(
    names,
    (name) =>
      io(`cannot copy floating skill: ${name}`, async () => {
        const source = path.join(snapshot, "skills", name)
        const sourceStatus = await lstat(source)
        if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
          throw new Error("skill source is not a regular directory")
        }
        try {
          await lstat(path.join(destination, name))
          throw new Error("managed skill name collides")
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
        }
        await cp(source, path.join(destination, name), {
          recursive: true,
          force: false,
          errorOnExist: true,
          verbatimSymlinks: true,
        })
      }),
    { concurrency: 1, discard: true },
  )

const appendFloatingInstructions = (
  document: ProfileDocument,
  context: string,
  snapshot: string,
): Effect.Effect<void, ApplicationError> =>
  Effect.gen(function* () {
    if (document.profile.harness.kind === "headlong") return
    const incoming = yield* io("cannot read floating always-on instructions", () =>
      readFile(path.join(snapshot, "always-on.md"), "utf8"),
    )
    if (incoming.length === 0) return
    const destination = floatingInstructionDestination(document, context)
    const current = yield* readOptionalText(destination)
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : ""
    yield* io("cannot write floating always-on instructions", async () => {
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, `${current}${separator}${incoming}`)
    })
  })

const updateFloatingManagedManifests = (
  document: ProfileDocument,
  context: string,
  snapshot: string,
  names: ReadonlyArray<string>,
): Effect.Effect<void, ApplicationError> =>
  Effect.gen(function* () {
    const harness = document.profile.harness.kind
    if (harness === "headlong") {
      const alwaysOnInstructions = yield* io("cannot read floating always-on instructions", () =>
        readFile(path.join(snapshot, "always-on.md"), "utf8"),
      )
      const alwaysOn = new Set(
        [...alwaysOnInstructions.matchAll(/^# Trellage managed always-on skill: ([A-Za-z0-9][A-Za-z0-9._-]*)$/gm)].map(
          (match) => match[1]!,
        ),
      )
      if ([...alwaysOn].some((name) => !names.includes(name))) {
        return yield* Effect.fail(new ApplicationError({ message: "floating always-on skill manifest is invalid" }))
      }
      const manifest = names.map((name) => `${name}\t${alwaysOn.has(name) ? "1" : "0"}\n`).join("")
      yield* io("cannot write Headlong managed skill manifest", () =>
        writeFile(path.join(context, "headlong-skills", "managed-skills.tsv"), manifest),
      )
    }
    if (harness === "pi" || harness === "prime") {
      const seed = path.join(context, harness === "pi" ? "pi-seed" : "prime-seed")
      const manifest = path.join(seed, "managed-skills.txt")
      const existing = (yield* readOptionalText(manifest)).split("\n").filter(Boolean)
      const managed = [...new Set([...existing, ...names])].sort((left, right) => left.localeCompare(right, "en"))
      yield* io("cannot write floating managed skill manifest", () =>
        writeFile(manifest, managed.map((name) => `${name}\n`).join("")),
      )
    }
    if (harness === "claude") {
      const seed = path.join(context, "claude-seed")
      const managed = yield* io("cannot enumerate managed Claude seed", () => managedClaudeFiles(seed))
      yield* io("cannot write managed Claude seed manifest", () =>
        writeFile(path.join(seed, "managed-paths.txt"), `${managed.join("\n")}\n`),
      )
    }
  })

const injectFloatingSkills = (
  document: ProfileDocument,
  context: string,
  snapshot: string | undefined,
): Effect.Effect<void, ApplicationError> =>
  Effect.gen(function* () {
    if (snapshot === undefined) return
    const names = yield* readFloatingSkillNames(snapshot)
    const destination = floatingSkillDestination(document, context)
    yield* io("cannot initialize floating skill destination", () => mkdir(destination, { recursive: true }))
    yield* copyFloatingSkills(snapshot, destination, names)
    yield* appendFloatingInstructions(document, context, snapshot)
    yield* updateFloatingManagedManifests(document, context, snapshot, names)
  })

const floatingStageArguments = (document: ProfileDocument, snapshot: string): ReadonlyArray<string> => [
  floatingSkillsManager,
  "stage",
  "--catalog",
  floatingSkillsCatalog,
  ...document.profile.skill_bundles.flatMap((bundle) => ["--bundle", bundle]),
  "--output",
  snapshot,
  "--skills-cli",
  skillsCli,
]

const cleanupBuildDirectory = (
  candidate: string | undefined,
  message: string,
): Effect.Effect<void, ApplicationError> =>
  candidate === undefined ? Effect.void : io(message, () => rm(candidate, { recursive: true, force: true }))

const buildWithCurrentSkills = (
  document: ProfileDocument,
  lock: ProfileLock,
  sourceDirectories: ReadonlyArray<string>,
  runtimeSupport: RuntimeSupportSnapshot,
  temporaryParent: string,
  image: string,
  target: DockerTarget,
  docker: DockerServices,
  resolutionSidecar: ResolutionSidecar | undefined,
  expectedDigest?: string,
  npmRegistry?: string,
): Effect.Effect<string, ApplicationError> => {
  let context: string | undefined
  let floatingRoot: string | undefined
  const build = Effect.gen(function* () {
    let snapshot: string | undefined
    if (document.profile.skill_bundles.length > 0) {
      floatingRoot = yield* io("cannot create floating skill staging directory", () =>
        mkdtemp(path.join(temporaryParent, "trellage-floating-skills-")),
      )
      snapshot = path.join(floatingRoot, "snapshot")
      yield* run(process.execPath, floatingStageArguments(document, snapshot))
    }
    context = yield* createBuildContext(
      document,
      lock,
      sourceDirectories,
      runtimeSupport,
      temporaryParent,
      pluginGenerator,
      undefined,
      resolutionSidecar,
      path.dirname(path.dirname(temporaryParent)),
      npmRegistry,
    ).pipe(Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })))
    yield* injectFloatingSkills(document, context, snapshot)
    return yield* buildOci(context, image, document, lock, target, docker, expectedDigest, npmRegistry)
  })
  return build.pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        Effect.all(
          [
            cleanupBuildDirectory(context, "cannot clean build context"),
            cleanupBuildDirectory(floatingRoot, "cannot clean floating skill staging"),
          ],
          { discard: true },
        ).pipe(Effect.ignore),
      ),
    ),
  )
}

const buildCandidateImage = (
  document: ProfileDocument,
  lock: ProfileLock,
  image: string,
  xdgCacheHome: string,
  runtimeSupport: RuntimeSupportSnapshot,
  target: DockerTarget,
  docker: DockerServices,
  npmRegistry?: string,
): Effect.Effect<string, ApplicationError> =>
  Effect.gen(function* () {
    const directories = yield* Effect.forEach(
      lock.sources,
      (source) =>
        resolveGitHubSource(xdgCacheHome, {
          repository: source.repository,
          ref: source.ref,
          lockedCommit: source.commit,
          include: sourceIncludes(source),
          inventoryPolicy: sourceInventoryPolicy(source),
        }).pipe(
          Effect.map((resolved) => resolved.directory),
          Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
        ),
      { concurrency: 1 },
    )
    const temporaryParent = path.join(xdgCacheHome, "trellage", "build")
    yield* io("cannot create build cache", () => mkdir(temporaryParent, { recursive: true }))
    const resolutionSidecar = yield* resolveLockSidecar(
      resolutionReceiptPath(document, lock.platform, xdgCacheHome),
      lock,
    )
    return yield* buildWithCurrentSkills(
      document,
      lock,
      directories,
      runtimeSupport,
      temporaryParent,
      image,
      target,
      docker,
      resolutionSidecar,
      undefined,
      npmRegistry,
    )
  })

const isMissingImageError = (cause: unknown): boolean => {
  const candidate = cause as { readonly stderr?: unknown; readonly message?: unknown }
  const detail = `${String(candidate.stderr ?? "")}\n${String(candidate.message ?? "")}`
  return /No such image|No such object|does not exist/i.test(detail)
}

const liveImageExists = (target: DockerTarget, image: string): Effect.Effect<boolean, ApplicationError> =>
  Effect.tryPromise({
    try: async (signal) => {
      try {
        await Effect.runPromise(verifyDockerTarget(target))
        await execFilePromise("docker", dockerHostArguments(target, ["image", "inspect", image]), {
          maxBuffer: 32 * 1024 * 1024,
          signal,
        })
        return true
      } catch (cause) {
        if (isMissingImageError(cause)) return false
        throw cause
      }
    },
    catch: (cause) => new ApplicationError({ message: `cannot inspect owned image: ${image}`, cause }),
  })

const defaultRuntimeSupport: RuntimeSupport = {
  codexEntry: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prototypes/trellage/runtime-entry.sh",
  ),
  copilotEntry: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prototypes/trellage/runtime-copilot-entry.sh",
  ),
  headlongEntry: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prototypes/trellage/runtime-headlong-entry.sh",
  ),
  piEntry: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prototypes/trellage/runtime-pi-entry.sh",
  ),
  primeEntry: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prototypes/trellage/runtime-prime-entry.sh",
  ),
  finalizeCopilotSeed: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prototypes/trellage/finalize-copilot-seed.mjs",
  ),
  finalizeClaudeSeed: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prototypes/trellage/finalize-claude-seed.mjs",
  ),
  claudeEntry: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prototypes/trellage/runtime-claude-entry.sh",
  ),
  claudeBrowserAgent: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../assets/hyperresearch-browser-fetcher.md",
  ),
  claudeOutputStyleRundown: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prototypes/trellage/assets/rundown/rundown.md",
  ),
  copilotInstructionRundown: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prototypes/trellage/assets/rundown/rundown.instructions.md",
  ),
}

const defaultCacheHome = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
const claudeRuntimeMode = (document: ProfileDocument): "core" | "hyperresearch" =>
  document.profile.harness.kind === "claude"
    ? (document.profile.harness.claude.mode ?? "hyperresearch")
    : "hyperresearch"

const runtimeAdapter = (document: ProfileDocument): "claude-marketplace" | "hyperresearch" | undefined => {
  if (document.profile.harness.kind !== "claude") return undefined
  const adapter = document.profile.plugins[0]?.adapter
  return adapter === "claude-marketplace" || adapter === "hyperresearch" ? adapter : undefined
}

const liveDockerServices: DockerServices = {
  run,
  verify: (target) =>
    verifyDockerTarget(target).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    ),
}

const liveUpgradeServices = (target: DockerTarget): UpgradeServices => ({
  buildCandidate: (document, lock, image, npmRegistry) =>
    createRuntimeSupportSnapshot(
      document.profile.harness.kind,
      defaultRuntimeSupport,
      runtimeAdapter(document),
      claudeRuntimeMode(document),
    ).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
      Effect.flatMap((snapshot) =>
        buildCandidateImage(document, lock, image, defaultCacheHome, snapshot, target, liveDockerServices, npmRegistry),
      ),
    ),
  imageExists: (image) => liveImageExists(target, image),
  tagImage: (source, destination) =>
    liveDockerServices
      .verify(target)
      .pipe(Effect.zipRight(run("docker", dockerHostArguments(target, ["image", "tag", source, destination])))),
  removeImage: (image) =>
    Effect.tryPromise({
      try: async (signal) => {
        try {
          await Effect.runPromise(verifyDockerTarget(target))
          await execFilePromise("docker", dockerHostArguments(target, ["image", "rm", "--force", image]), {
            maxBuffer: 32 * 1024 * 1024,
            signal,
          })
        } catch (cause) {
          if (!isMissingImageError(cause)) throw cause
        }
      },
      catch: (cause) => new ApplicationError({ message: `cannot remove owned image: ${image}`, cause }),
    }),
})

const applicationError = (cause: unknown): ApplicationError =>
  cause instanceof ApplicationError
    ? cause
    : new ApplicationError({ message: String((cause as { readonly message?: unknown })?.message ?? cause), cause })

const transientUpgradeError = (cause: unknown): boolean => {
  const seen = new Set<unknown>()
  const details: Array<string> = []
  const visit = (candidate: unknown): void => {
    if (candidate === null || candidate === undefined || seen.has(candidate)) return
    seen.add(candidate)
    if (typeof candidate === "string") {
      details.push(candidate)
      return
    }
    if (typeof candidate !== "object") return
    const record = candidate as Record<string, unknown>
    for (const key of ["message", "code", "stderr", "stdout"]) {
      if (typeof record[key] === "string") details.push(record[key])
    }
    visit(record.cause)
  }
  visit(cause)
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|socket (?:disconnected|hang up)|network|TLS connection|HTTP (?:408|425|429|5\d\d)|temporary failure|timed out/i.test(
    details.join("\n"),
  )
}

const retryUpgradeStep = <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  operation.pipe(Effect.retry({ times: 2, while: transientUpgradeError }))

const upgradeResolvers = (
  document: ProfileDocument,
  current: ProfileLock | undefined,
  base: LockResolvers,
  fallbacks: Array<string>,
): LockResolvers => {
  const canFallback = current !== undefined && lockIsReady(document, current, base.platform)
  const currentPackageRequest =
    current === undefined
      ? undefined
      : packageResolutionRequest(document, base.platform, current.sources, {
          reference: current.image.base,
          digest: current.image.base_digest,
        })
  return {
    ...base,
    resolveSource: (request) =>
      retryUpgradeStep(base.resolveSource(request)).pipe(
        Effect.catchAll((cause) => {
          if (!canFallback || !request.update || request.previousCommit === undefined) return Effect.fail(cause)
          return retryUpgradeStep(base.resolveSource({ ...request, update: false })).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                fallbacks.push(`source ${request.repository}@${request.ref} -> ${request.previousCommit}`)
              }),
            ),
          )
        }),
      ),
    resolvePackages: (request) =>
      retryUpgradeStep(base.resolvePackages(request)).pipe(
        Effect.catchAll((cause) => {
          if (
            !canFallback ||
            currentPackageRequest === undefined ||
            !packageResolutionInputsMatch(currentPackageRequest, request) ||
            current.packages.harness.kind !== request.kind ||
            current.packages.harness.selector !== request.selector
          ) {
            return Effect.fail(cause)
          }
          return Effect.sync(() => {
            fallbacks.push(
              `harness ${request.kind}@${request.selector} -> ${harnessPackageRevision(current.packages.harness)}`,
            )
            return current.packages
          })
        }),
      ),
    resolveBase: (request) =>
      retryUpgradeStep(base.resolveBase(request)).pipe(
        Effect.catchAll((cause) => {
          if (!canFallback || current.image.base !== request.reference) return Effect.fail(cause)
          return Effect.sync(() => {
            fallbacks.push(`base ${request.reference} -> ${current.image.base_digest}`)
            return { reference: current.image.base, digest: current.image.base_digest }
          })
        }),
      ),
  }
}

const collectCauses = (
  operations: ReadonlyArray<Effect.Effect<void, ApplicationError>>,
): Effect.Effect<ReadonlyArray<Cause.Cause<ApplicationError>>, never> =>
  Effect.forEach(operations, (operation) => Effect.exit(operation), { concurrency: 1 }).pipe(
    Effect.map((exits) => exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))),
  )

const sequentialCauses = (
  causes: ReadonlyArray<Cause.Cause<ApplicationError>>,
): Cause.Cause<ApplicationError> | undefined =>
  causes.reduce<Cause.Cause<ApplicationError> | undefined>(
    (combined, cause) => (combined === undefined ? cause : Cause.sequential(combined, cause)),
    undefined,
  )

const runAll = (
  operations: ReadonlyArray<Effect.Effect<void, ApplicationError>>,
): Effect.Effect<void, ApplicationError> =>
  collectCauses(operations).pipe(
    Effect.flatMap((causes) => {
      const combined = sequentialCauses(causes)
      return combined === undefined ? Effect.void : Effect.failCause(combined)
    }),
  )

interface UpgradeLease {
  readonly path: string
  readonly release: () => Promise<void>
  readonly compromised: Promise<never>
}

const acquireUpgradeLease = (
  xdgCacheHome: string,
  profileName: string,
): Effect.Effect<UpgradeLease, ApplicationError> => {
  const directory = path.join(xdgCacheHome, "trellage", "upgrade-locks")
  const leasePath = path.join(directory, profileName)
  return Effect.tryPromise({
    try: async () => {
      await mkdir(directory, { recursive: true })
      let compromise!: (cause: unknown) => void
      const compromised = new Promise<never>((_resolve, reject) => {
        compromise = reject
      })
      try {
        const release = await lockfile.lock(leasePath, {
          realpath: false,
          stale: 10_000,
          update: 5_000,
          retries: 0,
          onCompromised: compromise,
        })
        return { path: leasePath, release, compromised }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ELOCKED") {
          throw new ApplicationError({ message: `upgrade already active for profile: ${profileName}`, cause })
        }
        throw cause
      }
    },
    catch: applicationError,
  })
}

const releaseUpgradeLease = (lease: UpgradeLease): Effect.Effect<void, ApplicationError> =>
  io(`cannot release upgrade lock: ${lease.path}`, async () => {
    try {
      await lease.release()
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ERELEASED") throw cause
    }
  })

const awaitUpgradeLeaseCompromise = (lease: UpgradeLease): Effect.Effect<never, ApplicationError> =>
  Effect.tryPromise({
    try: () => lease.compromised,
    catch: (cause) => new ApplicationError({ message: `upgrade lock compromised: ${lease.path}`, cause }),
  })

export const upgradeProfile = (
  profilePath: string,
  xdgCacheHome: string,
  runtimeSupport: RuntimeSupport,
  target: DockerTarget,
  services?: UpgradeServices,
  npmRegistry?: string,
): Effect.Effect<
  { readonly image: string; readonly digest: string; readonly fallbacks: ReadonlyArray<string> },
  ApplicationError
> =>
  Effect.gen(function* () {
    const platform = target.platform
    const document = yield* loadProfile(profilePath)
    const runtimeSnapshot = yield* createRuntimeSupportSnapshot(
      document.profile.harness.kind,
      runtimeSupport,
      runtimeAdapter(document),
      claudeRuntimeMode(document),
    ).pipe(Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })))
    const identity = `${document.profile.name}-${platformIdentity(platform)}`
    const canonical = `trellage-profile-${identity}:locked`
    const candidate = `trellage-profile-${identity}:candidate-${process.pid}`
    const backup = `trellage-profile-${identity}:backup-${process.pid}`
    const activeServices =
      services === undefined
        ? {
            ...liveUpgradeServices(target),
            buildCandidate: (profile: ProfileDocument, lock: ProfileLock, image: string, registry?: string) =>
              buildCandidateImage(
                profile,
                lock,
                image,
                xdgCacheHome,
                runtimeSnapshot,
                target,
                liveDockerServices,
                registry,
              ),
          }
        : services

    return yield* Effect.acquireUseRelease(
      acquireUpgradeLease(xdgCacheHome, `${document.profile.name}-${platformIdentity(platform)}`),
      (lease) =>
        Effect.raceFirst(
          Effect.gen(function* () {
            const originalReceiptBytes = yield* readResolutionReceiptBytes(document, platform, xdgCacheHome).pipe(
              Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
            )
            const receipt = yield* originalReceiptBytes === undefined
              ? Effect.succeed(undefined)
              : parseLock(originalReceiptBytes).pipe(
                  Effect.map((lock) => lock as ProfileLock | undefined),
                  Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
                )
            const current = receipt
            const fallbacks: Array<string> = []
            const resolvers = upgradeResolvers(
              document,
              current,
              productionResolvers(xdgCacheHome, platform, npmRegistry),
              fallbacks,
            )
            const candidateLock = yield* compileLock(document, current, true, resolvers).pipe(
              Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
            )
            const persistedCandidate = yield* parseLock(renderLock(candidateLock)).pipe(
              Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
            )
            yield* requireResolvedLock(document, persistedCandidate, platform).pipe(
              Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
            )
            let candidateAttempted = false
            let backupAttempted = false
            let backupSucceeded = false
            let canonicalExisted = false
            let canonicalAttempted = false
            let alias: string | undefined
            let aliasExisted = false
            let aliasBackup: string | undefined
            let aliasBackupAttempted = false
            let aliasBackupSucceeded = false
            let aliasAttempted = false
            let lockWriteAttempted = false
            let committed = false

            const transaction = Effect.gen(function* () {
              candidateAttempted = true
              const digest = yield* retryUpgradeStep(
                activeServices.buildCandidate(document, candidateLock, candidate, npmRegistry),
              )
              const candidateSidecar = attachedSidecar(candidateLock)
              const unresolvedFinalLock: ProfileLock =
                document.profile.skill_bundles.length > 0
                  ? candidateLock
                  : {
                      ...candidateLock,
                      image: { ...candidateLock.image, final_digest: digest },
                    }
              const finalLock =
                candidateSidecar === undefined || unresolvedFinalLock === candidateLock
                  ? unresolvedFinalLock
                  : withAttachedSidecar(unresolvedFinalLock, candidateSidecar)
              const persistedFinal = yield* parseLock(renderLock(finalLock)).pipe(
                Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
              )
              yield* requireLocked(document, persistedFinal, platform).pipe(
                Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
              )
              yield* publishAttachedSidecar(resolutionReceiptPath(document, platform, xdgCacheHome), finalLock)
              if (document.profile.skill_bundles.length === 0) {
                alias = profileImageAlias(document.profile.name, platform, finalLock.profile_hash, runtimeSnapshot.hash)
                aliasBackup = `${alias}-backup-${process.pid}`
                aliasExisted = yield* activeServices.imageExists(alias)
              }
              canonicalExisted = yield* activeServices.imageExists(canonical)
              return yield* Effect.uninterruptibleMask(() =>
                Effect.gen(function* () {
                  if (alias !== undefined && aliasBackup !== undefined && aliasExisted) {
                    aliasBackupAttempted = true
                    yield* activeServices.tagImage(alias, aliasBackup)
                    aliasBackupSucceeded = true
                  }
                  if (canonicalExisted) {
                    backupAttempted = true
                    yield* activeServices.tagImage(canonical, backup)
                    backupSucceeded = true
                  }
                  canonicalAttempted = true
                  yield* activeServices.tagImage(candidate, canonical)
                  if (alias !== undefined) {
                    aliasAttempted = true
                    yield* activeServices.tagImage(canonical, alias)
                  }
                  lockWriteAttempted = true
                  yield* writeResolutionReceiptBytes(document, platform, xdgCacheHome, renderLock(finalLock)).pipe(
                    Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
                  )
                  committed = true
                  return { image: canonical, digest, fallbacks }
                }).pipe(
                  Effect.catchAllCause((primaryCause) => {
                    if (!canonicalAttempted && !aliasAttempted && !lockWriteAttempted) {
                      return Effect.failCause(primaryCause)
                    }
                    const compensation: Array<Effect.Effect<void, ApplicationError>> = []
                    if (lockWriteAttempted) {
                      compensation.push(
                        originalReceiptBytes === undefined
                          ? removeResolutionReceipt(document, platform, xdgCacheHome).pipe(
                              Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
                            )
                          : writeResolutionReceiptBytes(document, platform, xdgCacheHome, originalReceiptBytes).pipe(
                              Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
                            ),
                      )
                    }
                    if (aliasAttempted && alias !== undefined) {
                      compensation.push(
                        aliasExisted && aliasBackupSucceeded && aliasBackup !== undefined
                          ? activeServices.tagImage(aliasBackup, alias)
                          : activeServices.removeImage(alias),
                      )
                    }
                    if (canonicalAttempted) {
                      compensation.push(
                        canonicalExisted && backupSucceeded
                          ? activeServices.tagImage(backup, canonical)
                          : activeServices.removeImage(canonical),
                      )
                    }
                    return collectCauses(compensation).pipe(
                      Effect.flatMap((compensationCauses) => {
                        const combinedCompensation = sequentialCauses(compensationCauses)
                        return Effect.failCause(
                          combinedCompensation === undefined
                            ? primaryCause
                            : Cause.sequential(primaryCause, combinedCompensation),
                        )
                      }),
                    )
                  }),
                ),
              )
            })

            const cleanup = () => {
              const operations: Array<Effect.Effect<void, ApplicationError>> = []
              if (candidateAttempted) operations.push(activeServices.removeImage(candidate))
              if (backupAttempted) operations.push(activeServices.removeImage(backup))
              if (aliasBackupAttempted && aliasBackup !== undefined) {
                operations.push(activeServices.removeImage(aliasBackup))
              }
              return runAll(operations).pipe(
                Effect.catchAllCause((cause) =>
                  committed
                    ? Effect.fail(new ApplicationError({ message: "upgrade committed but cleanup failed", cause }))
                    : Effect.failCause(cause),
                ),
              )
            }

            return yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const transactionExit = yield* restore(Effect.exit(transaction))
                const cleanupExit = yield* Effect.exit(Effect.suspend(cleanup))
                if (Exit.isFailure(transactionExit)) {
                  return yield* Effect.failCause(
                    Exit.isFailure(cleanupExit)
                      ? Cause.sequential(transactionExit.cause, cleanupExit.cause)
                      : transactionExit.cause,
                  )
                }
                if (Exit.isFailure(cleanupExit)) return yield* Effect.failCause(cleanupExit.cause)
                return transactionExit.value
              }),
            )
          }),
          awaitUpgradeLeaseCompromise(lease),
        ),
      (lease) => releaseUpgradeLease(lease).pipe(Effect.orDie),
    )
  })

/**
 * Canonical production tag. Keyed on profile name and platform, so a worktree
 * profile and the deployed profile of the same name share it.
 */
const profileImage = (name: string, platform: Platform): string =>
  `trellage-profile-${name}-${platformIdentity(platform)}:locked`

const shortDigest = (value: string): string => value.replace(/^sha256:/, "").slice(0, 12)

/**
 * Content-addressed alias for the same image.
 *
 * The launcher rejects an image whose `dev.trellage.profile.hash` or
 * `dev.trellage.runtime.hash` label disagrees with the profile it is about to run, so
 * two variants sharing only the canonical tag evict each other on every context
 * switch. Keying an additional tag on both hashes lets each variant keep its own
 * image, while `:locked` stays the published pointer to the most recent build.
 */
const profileImageAlias = (name: string, platform: Platform, profileHash: string, runtimeHash: string): string =>
  `trellage-profile-${name}-${platformIdentity(platform)}:h-${shortDigest(profileHash)}-${shortDigest(runtimeHash)}`

export const buildProfile = (
  profilePath: string,
  locked: boolean,
  xdgCacheHome: string,
  runtimeSupport: RuntimeSupport,
  target: DockerTarget,
  docker: DockerServices = liveDockerServices,
  npmRegistry?: string,
): Effect.Effect<{ readonly image: string; readonly digest: string }, ApplicationError> =>
  Effect.gen(function* () {
    const platform = target.platform
    const document = yield* loadProfile(profilePath)
    const runtimeSnapshot = yield* createRuntimeSupportSnapshot(
      document.profile.harness.kind,
      runtimeSupport,
      runtimeAdapter(document),
      claudeRuntimeMode(document),
    ).pipe(Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })))
    let lock: ProfileLock
    let receipt: ProfileLock | undefined
    if (locked) {
      const release = yield* loadReleaseLock(profilePath, platform)
      lock = yield* requireLocked(document, release, platform).pipe(
        Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
      )
    } else {
      const development = yield* loadDevelopmentResolution(document, xdgCacheHome, platform)
      receipt = development.receipt
      lock = yield* compileLock(
        document,
        development.current,
        false,
        productionResolvers(xdgCacheHome, platform, npmRegistry),
      ).pipe(Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })))
    }
    const directories = yield* Effect.forEach(
      lock.sources,
      (source) =>
        resolveGitHubSource(xdgCacheHome, {
          repository: source.repository,
          ref: source.ref,
          lockedCommit: source.commit,
          include: sourceIncludes(source),
          inventoryPolicy: sourceInventoryPolicy(source),
        }).pipe(
          Effect.map((resolved) => resolved.directory),
          Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
        ),
      { concurrency: 1 },
    )
    const temporaryParent = path.join(xdgCacheHome, "trellage", "build")
    yield* io("cannot create build cache", () => mkdir(temporaryParent, { recursive: true }))
    const image = profileImage(document.profile.name, platform)
    const floatingSkills = document.profile.skill_bundles.length > 0
    const digest = yield* buildWithCurrentSkills(
      document,
      lock,
      directories,
      runtimeSnapshot,
      temporaryParent,
      image,
      target,
      docker,
      yield* resolveLockSidecar(
        locked ? adjacentLockPath(profilePath, platform) : resolutionReceiptPath(document, platform, xdgCacheHome),
        lock,
      ),
      locked && !floatingSkills ? lock.image.final_digest : undefined,
      npmRegistry,
    )
    if (!floatingSkills) {
      yield* docker.run(
        "docker",
        dockerHostArguments(target, [
          "image",
          "tag",
          image,
          profileImageAlias(document.profile.name, platform, lock.profile_hash, runtimeSnapshot.hash),
        ]),
      )
    }
    if (!locked) {
      const finalLock = !floatingSkills && digest !== lock.image.final_digest ? withFinalDigest(lock, digest) : lock
      if (finalLock !== receipt) {
        yield* writeResolutionReceipt(document, xdgCacheHome, finalLock).pipe(
          Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
        )
      }
    }
    return { image, digest }
  })

/**
 * Release gate: assert that a profile and its core lock agree without resolving
 * anything or touching Docker. Profiles without floating skills must also lock
 * the final OCI digest.
 */
export const verifyProfile = (
  profilePath: string,
  platform: Platform,
): Effect.Effect<
  {
    readonly image: string
    readonly profile_hash: string
    readonly digest: string | null
    readonly skills_mode: "floating" | "locked"
  },
  ApplicationError
> =>
  Effect.gen(function* () {
    const document = yield* loadProfile(profilePath)
    const current = yield* loadReleaseLock(profilePath, platform)
    const lock = yield* requireLocked(document, current, platform).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    )
    yield* resolveLockSidecar(adjacentLockPath(profilePath, platform), lock)
    const digest = lock.image.final_digest
    const skillsMode = document.profile.skill_bundles.length > 0 ? "floating" : "locked"
    if (digest === undefined && skillsMode === "locked") {
      return yield* Effect.fail(new ApplicationError({ message: "lock has no final OCI digest" }))
    }
    return {
      image: profileImage(document.profile.name, platform),
      profile_hash: lock.profile_hash,
      digest: digest ?? null,
      skills_mode: skillsMode,
    }
  })

type ProfileHarnessKind = ProfileDocument["profile"]["harness"]["kind"]

const metadataHarnessExecutable = (kind: ProfileHarnessKind): string => {
  if (kind === "headlong") return "headlong-init"
  if (kind === "prime") return "prime-agent"
  if (kind === "pi") return "omp"
  return kind
}

const metadataRuntimeEntry = (kind: ProfileHarnessKind): string => {
  if (kind === "headlong") return "runtime-headlong-entry"
  if (kind === "copilot") return "trellage-copilot-entry"
  if (kind === "claude") return "trellage-claude-entry"
  if (kind === "pi") return "trellage-pi-entry"
  if (kind === "prime") return "trellage-prime-entry"
  return "trellage-codex-entry"
}

const metadataDefaultNetwork = (kind: ProfileHarnessKind): string =>
  kind === "copilot" || kind === "pi" ? "bridge" : "copilot-proxy-rs_default"

const metadataAuthPolicy = (document: ProfileDocument): string => {
  const harness = document.profile.harness
  if (harness.kind === "headlong") return "proxy"
  if (harness.kind === "copilot") return harness.copilot.auth
  if (harness.kind === "pi") return harness.pi.auth
  if (harness.kind === "claude") return "claude-explicit"
  if (harness.kind === "prime") return "proxy"
  return "profile-secrets"
}

const metadataSecretEnvironment = (document: ProfileDocument): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = Object.fromEntries(
    document.profile.secrets.required.map((name) => [name, name]),
  )
  for (const mcp of document.profile.mcps) {
    if (mcp.transport === "stdio") Object.assign(environment, mcp.env_from_secret ?? {})
  }
  return environment
}

const metadataResolvedVersion = (
  document: ProfileDocument,
  lock: ProfileLock | undefined,
  ready: boolean,
): string | null =>
  ready && lock?.packages.harness.kind === document.profile.harness.kind
    ? harnessPackageRevision(lock.packages.harness)
    : null

const harnessSpecificMetadata = (document: ProfileDocument): Readonly<Record<string, unknown>> => {
  const harness = document.profile.harness
  if (harness.kind === "claude") {
    return {
      claude_mode: harness.claude.mode ?? "hyperresearch",
      claude_gateway: harness.claude.gateway,
      claude_opus_model: harness.claude.opus_model ?? "claude-opus-5",
      claude_sonnet_model: harness.claude.sonnet_model ?? "claude-sonnet-5",
      claude_haiku_model: harness.claude.haiku_model ?? "claude-haiku-4.5",
    }
  }
  if (harness.kind === "prime") {
    return {
      prime_provider: harness.prime.provider,
      prime_model: harness.prime.model,
      prime_base_url: harness.prime.base_url,
    }
  }
  return {}
}

const assembleProfileMetadata = (
  document: ProfileDocument,
  receipt: ProfileLock | undefined,
  platform: Platform,
  hash: string,
  locallyResolved: boolean,
  releaseLockAvailable: boolean,
  runtimeHash: string,
): Readonly<Record<string, unknown>> => {
  const harnessKind = document.profile.harness.kind
  const floatingSkills = document.profile.skill_bundles.length > 0
  const resolvedVersion = metadataResolvedVersion(document, receipt, locallyResolved)
  const headlong = harnessKind === "headlong"
  return {
    profile_path: document.path,
    profile_name: document.profile.name,
    profile_hash: hash,
    tmpfs_size: document.profile.runtime.tmpfs_size,
    runtime_hash: runtimeHash,
    platform,
    image: profileImage(document.profile.name, platform),
    image_alias: floatingSkills ? null : profileImageAlias(document.profile.name, platform, hash, runtimeHash),
    schema_version: 2,
    resolution_policy: document.profile.resolution,
    resolution_channel: "stable",
    locally_resolved: locallyResolved,
    release_lock_available: releaseLockAvailable,
    locked: locallyResolved,
    skills_mode: floatingSkills ? "floating" : "locked",
    final_digest_locked: !floatingSkills,
    build_command: `trellage build ${document.path}`,
    release_build_command: `trellage build --locked ${document.path}`,
    refresh_command: `trellage upgrade ${document.path}`,
    harness_args: document.profile.harness.args ?? [],
    secrets_provider: document.profile.secrets.provider,
    required_secrets: document.profile.secrets.required,
    secret_environment: metadataSecretEnvironment(document),
    resolved_varlock_path: document.resolvedVarlockPath ?? null,
    has_initial_prompt: document.resolvedInitialPrompt !== undefined,
    harness_kind: harnessKind,
    container_lifecycle: headlong ? "persistent" : "ephemeral",
    container_restart_policy: headlong ? "unless-stopped" : "no",
    container_command: headlong ? ["runtime-headlong-entry", "service"] : [],
    published_ports: headlong
      ? [{ host_ip: "127.0.0.1", host_port: 18080, container_port: 8080, protocol: "tcp" }]
      : [],
    optional_secrets: [],
    harness_executable: metadataHarnessExecutable(harnessKind),
    runtime_entry: metadataRuntimeEntry(harnessKind),
    default_network: metadataDefaultNetwork(harnessKind),
    auth_policy: metadataAuthPolicy(document),
    headless: resolveSandboxHeadlessCapabilities(sandboxHeadlessRuntimeAdapter(document.profile), resolvedVersion),
    resolved_version: resolvedVersion,
    ...harnessSpecificMetadata(document),
  }
}

export const profileMetadata = (
  profilePath: string,
  platform: Platform,
  xdgCacheHome: string = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
): Effect.Effect<Readonly<Record<string, unknown>>, ApplicationError> =>
  Effect.gen(function* () {
    const document = yield* loadProfile(profilePath)
    const receipt = yield* loadResolutionReceipt(document, platform, xdgCacheHome).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    )
    const release = yield* loadReleaseLock(profilePath, platform).pipe(Effect.orElseSucceed(() => undefined))
    const hash = profileHash(document)
    const locallyResolved = lockIsReady(document, receipt, platform)
    const releaseSidecarReady =
      release?.sidecar === undefined
        ? true
        : yield* loadResolutionSidecar(adjacentLockPath(profilePath, platform), release).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
    const releaseLockAvailable = lockIsReady(document, release, platform) && releaseSidecarReady
    const harnessKind = document.profile.harness.kind
    const runtimeSnapshot = yield* createRuntimeSupportSnapshot(
      harnessKind,
      defaultRuntimeSupport,
      runtimeAdapter(document),
      claudeRuntimeMode(document),
    ).pipe(Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })))
    return assembleProfileMetadata(
      document,
      receipt,
      platform,
      hash,
      locallyResolved,
      releaseLockAvailable,
      runtimeSnapshot.hash,
    )
  })
