import { Data, Effect } from "effect"

import type { ArtifactLock, ProfileLock } from "./lock.js"
import type { Platform } from "./platform.js"
import { claudeGithubReleaseTools, claudePypiToolNames, isClaudeProfile, type ProfileDocument } from "./profile.js"

export class ArtifactCatalogError extends Data.TaggedError("ArtifactCatalogError")<{
  readonly message: string
}> {}

const runtimeVersions = {
  bash: "5.2.15-2+b13",
  "ca-certificates": "20230311+deb12u1",
  curl: "7.88.1-10+deb12u15",
  fish: "3.6.0-3.1+deb12u1",
  git: "1:2.39.5-0+deb12u3",
  gh: "2.23.0+dfsg1-1",
  jq: "1.6-2.1+deb12u2",
  libasound2: "1.2.8-1+b1",
  "libatk-bridge2.0-0": "2.46.0-5",
  "libatk1.0-0": "2.46.0-5",
  libcairo2: "1.16.0-7",
  libcups2: "2.4.2-3+deb12u9",
  "libdbus-1-3": "1.14.10-1~deb12u1",
  libgbm1: "22.3.6-1+deb12u2",
  "libglib2.0-0": "2.74.6-2+deb12u9",
  libnspr4: "2:4.35-1",
  libnss3: "2:3.87.1-1+deb12u4",
  "libpango-1.0-0": "1.50.12+ds-1",
  "libx11-6": "2:1.8.4-2+deb12u2",
  libxcb1: "1.15-1",
  libxcomposite1: "1:0.4.5-1",
  libxdamage1: "1:1.1.6-1",
  libxext6: "2:1.3.4-1+b1",
  libxfixes3: "1:6.0.0-2",
  libxkbcommon0: "1.5.0-1",
  libxrandr2: "2:1.5.2-2+b1",
  ripgrep: "13.0.0-4+b2",
  zsh: "5.9-4+b15",
} as const

const runtimeIntegrities = {
  bash: "sha256:fdb470b5ec1773b90014138bfc1deda4505c1c23e7f5731e8b527c636ac03385",
  "ca-certificates": "sha256:0d5f444f594e48c1e16a41d8fc628a09b24c658916a1274025c2330f2a802bed",
  curl: "sha256:880d20cb636d2c36b2f57c58ab284b442a1680365b488d3e696c147c4d84ef25",
  fish: "sha256:d55844785d95a3ba9f128c87ad319ae4f4fe4a10d4463f3555cbc3293995840a",
  git: "sha256:435176549a9f5c8bbadaa126b64a036b38ea34ad9f3eb128dc40b8407a5b5620",
  gh: "sha256:7aeed4b288718660cda8e18ea1b06b69da42f3072ec599343965b01cf01b4a12",
  jq: "sha256:c232e9407e0f47006dd6077804c1274fd2e4f8be02efc78822db748ed65bea99",
  libasound2: "sha256:9fa889400fcee4b92c8f4a2fafbb7f2cd33444d9ec1665a71002ab67c06114bb",
  "libatk-bridge2.0-0": "sha256:3f2229723e1f8337282f74c44f139eda2aab5829fc0bca9adb2976f3a8d83b44",
  "libatk1.0-0": "sha256:c7508adb33e42c35b516e8456d801d5d246e36f1ebb2f1ebb8d2ce7a70ce1d2b",
  libcairo2: "sha256:48b5c5ae1972ea0757c6285463d611d0ca32c9c808957961e5c7924126f30289",
  libcups2: "sha256:41c9220d57d9eb3b5245f17038c830053f12176f6eef611c6f6941fcbf6d507f",
  "libdbus-1-3": "sha256:2a423794f44ee756f70fda67c6e47b15afe3dd22cd69e51f5d14d2ec9538f806",
  libgbm1: "sha256:f5c8fdddbf365259d74af270fb10f30d7fddb3fbe7b2ff62f0fdd556f8db0dc8",
  "libglib2.0-0": "sha256:61d92fffada7e27fc0ed9d23e047b45bca3b2e3bfe1a918f4ec16559282859f4",
  libnspr4: "sha256:3aa6bc5a1a3f83627f735b9712eed74ed2c345ae9148e9d876887a97982ae28d",
  libnss3: "sha256:aaa1b291b6330590079a0eb1404650c7c4f6c788f9213ab6911149dc22b2b6d0",
  "libpango-1.0-0": "sha256:88afa1481f9e520a3068e85dad776ed09a3751c7638a877333af6cec927db3ee",
  "libx11-6": "sha256:d1d533e983582282a9ea82c87ac5ce715a9b67bd6d1acbd2439a11c63c36549b",
  libxcb1: "sha256:041d9a68415c3ccf3ce8f4f8b88e4bbfb5dc1f0d97013c6ef8423e620ea50f84",
  libxcomposite1: "sha256:cfe39326fdb822e9d060ed5eb3f95b14459dd6b73793c5290000f9b27f8bad37",
  libxdamage1: "sha256:489d20cf78c8ee4428f3e26c5b3edcd87a71b5beb6bed992c45f47c6d01a1c92",
  libxext6: "sha256:5e9c0ad606eb4674c645fe8e0e64330c47d2729f7a59ed569848610efd5d5b62",
  libxfixes3: "sha256:d47bda8fed01b19b41d503e2df05d9166c58e30e2376f2f8784ceb7a834befe6",
  libxkbcommon0: "sha256:ec518d8a19796a399ab95e7bc4dfbb6bd2ed8e151f77b222df26208db412d852",
  libxrandr2: "sha256:f0bc7f79fee182caae176652fdb1bf349d13b9591b10ad4dc1c896521da8e49f",
  ripgrep: "sha256:82bd2ff67cedf892c1906d7ecd2831605ec1f8ad74825f576f5519a9c82a02a3",
  zsh: "sha256:c6ef58b84ecc669776024866821c89d2247307f1fb6b174fcbe281ad58bfba90",
} as const

const fixedArtifacts: ReadonlyArray<ArtifactLock> = [
  {
    name: "node",
    version: "22.17.0",
    integrity: "sha256:3e99df8b01b27dc8b334a2a30d1cd500442b3b0877d217b308fd61a9ccfc33d4",
    url: "https://nodejs.org/dist/v22.17.0/node-v22.17.0-linux-arm64.tar.gz",
  },
  {
    name: "builder-oci",
    version: "jdxcode/mise",
    integrity: "sha256:b8f8c20fc3308f8b1d00ccca2bc968e4e208af1c5c1069e1ad9753baa099acff",
    url: "oci://docker.io/jdxcode/mise",
  },
  {
    name: "skopeo-oci",
    version: "stable",
    integrity: "sha256:47853bb9fb24202af9110531ebd6e43c5f97701254ca290596640290d17942f4",
    url: "oci://quay.io/skopeo/stable",
  },
]

const hyperresearchArtifacts: ReadonlyArray<ArtifactLock> = [
  {
    name: "python",
    version: "3.13.14",
    integrity: "sha256:1eaf979af6c6986553b91a9e3b03647f63ce52a888e00892d3bddc96f43748e9",
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260728/cpython-3.13.14+20260728-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
  },
  {
    name: "playwright-mcp",
    version: "0.0.78",
    integrity: "sha256:cfff0fd8eae3ac3bcb39827861298cb6b483a8d72e3c558e7991658ed3d22562",
    url: "https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.78.tgz",
    size: 22503,
  },
  {
    name: "playwright",
    version: "1.62.0-alpha-1783623505000",
    integrity: "sha256:738aa4e5602f023b68dbad49cf6bd93e8f2aa14277831109458de1262fad557a",
    url: "https://registry.npmjs.org/playwright/-/playwright-1.62.0-alpha-1783623505000.tgz",
    size: 892437,
  },
  {
    name: "playwright-core",
    version: "1.62.0-alpha-1783623505000",
    integrity: "sha256:a5412aee4ac779f1c662272f77fd5fe716218cf555c222a301f089447f49b24c",
    url: "https://registry.npmjs.org/playwright-core/-/playwright-core-1.62.0-alpha-1783623505000.tgz",
    size: 2866354,
  },
  {
    name: "chromium",
    version: "1228",
    integrity: "sha256:ec044b50ed065adeb4c5ffdb42d1529901cbaf897cdf542bfef8af01d6e0cc79",
    url: "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1228/chromium-linux-arm64.zip",
    size: 196280473,
  },
  {
    name: "chromium-headless-shell",
    version: "1228",
    integrity: "sha256:1652929a70f4afb17aca36fce073fb7ed22262d16825be761b0801972f43ac4f",
    url: "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1228/chromium-headless-shell-linux-arm64.zip",
    size: 115342043,
  },
  {
    name: "obscura",
    version: "v0.1.11",
    integrity: "sha256:d535324d44724cdfec16e500d0335903bca5c6a446e736b351691ee7e39debb4",
    url: "https://github.com/h4ckf0r0day/obscura/releases/download/v0.1.11/obscura-aarch64-linux-stealth.tar.gz",
    size: 52716812,
  },
]

const pythonStandaloneArtifact = hyperresearchArtifacts.find((artifact) => artifact.name === "python")!

const graphOfLoopsArtifacts: ReadonlyArray<ArtifactLock> = [
  pythonStandaloneArtifact,
  {
    name: "bd",
    version: "1.2.2",
    integrity: "sha256:501f38a1070d4b9b3b6261a86a3c92c4a52366869021560430a4bb0036afd83a",
    url: "https://github.com/gastownhall/beads/releases/download/v1.2.2/beads_1.2.2_linux_arm64.tar.gz",
    size: 45556402,
  },
  {
    name: "bv",
    version: "0.22.0",
    integrity: "sha256:23d451b87bb9dccfb94fab416b0243d107919d9d56458087475afda5a617aa89",
    url: "https://github.com/Dicklesworthstone/beads_viewer/releases/download/v0.22.0/bv_linux_arm64.tar.gz",
    size: 12981421,
  },
  {
    name: "raindrop",
    version: "0.1.21",
    integrity: "sha256:04e0b57073d9be1d7059dbc23f10212c503c2252aa26f60ce9e5ab215ebd0522",
    url: "https://github.com/raindrop-ai/workshop/releases/download/v0.1.21/raindrop-bun-linux-arm64.gz",
    size: 41964676,
  },
  {
    name: "codex",
    version: "0.149.1",
    integrity: "sha256:14df6802e39a956de994e844b90d51d8254bcc8057b6e66f0f3e3b8f7e2da5b0",
    url: "https://github.com/openai/codex/releases/download/rust-v0.149.1/codex-aarch64-unknown-linux-musl.tar.gz",
    size: 91899352,
  },
  {
    name: "codex-code-mode-host",
    version: "0.149.1",
    integrity: "sha256:962e029df772b53cb977a0204ec4284d0c693207a25a491106e8294aae8dfa04",
    url: "https://github.com/openai/codex/releases/download/rust-v0.149.1/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
    size: 19857866,
  },
  {
    name: "lefthook-linux-arm64",
    version: "2.1.10",
    integrity: "sha256:9e4e2eac3f72eb6757eb01ff147622dd16a4805d3a5c2c7a701982df79eb1bd5",
    url: "https://github.com/evilmartians/lefthook/releases/download/v2.1.10/lefthook_2.1.10_Linux_arm64",
    size: 13435042,
  },
]

const headlongArtifacts: ReadonlyArray<ArtifactLock> = [
  fixedArtifacts[0]!,
  {
    name: "uv",
    version: "0.11.21",
    integrity: "sha256:e71badaed2a2c3a404a0a00974b51c7ed5f5bc7be947916846005b739c68a5a2",
    url: "https://github.com/astral-sh/uv/releases/download/0.11.21/uv-aarch64-unknown-linux-musl.tar.gz",
  },
  {
    name: "rust",
    version: "1.96.0",
    integrity: "sha256:20d5ebe3916fe489891fc577574e47fc679cdf62080c1bb1be6b6905ff4e275b",
    url: "https://static.rust-lang.org/dist/2026-05-28/rust-1.96.0-aarch64-unknown-linux-gnu.tar.gz",
    size: 325287063,
  },
  {
    name: "rust-std-musl",
    version: "1.96.0",
    integrity: "sha256:1c32fdbdc25f86cf62c8fe8d35ddd252e4ecf3d22efefb00d885bc86030318ea",
    url: "https://static.rust-lang.org/dist/2026-05-28/rust-std-1.96.0-aarch64-unknown-linux-musl.tar.gz",
    size: 42333691,
  },
]

export const extraClaudeMarketplaceArtifacts = (document: ProfileDocument): ReadonlyArray<ArtifactLock> => {
  if (!isClaudeProfile(document.profile) || document.profile.plugins[0]?.adapter === "hyperresearch") return []
  const artifacts: ArtifactLock[] = []
  if (claudePypiToolNames(document.profile).length > 0) artifacts.push(pythonStandaloneArtifact)
  for (const tool of claudeGithubReleaseTools(document.profile)) {
    const match = graphOfLoopsArtifacts.find((artifact) => artifact.name === tool.name)
    if (match === undefined) continue
    if (!artifacts.some((artifact) => artifact.name === match.name)) artifacts.push(match)
    if (tool.name === "codex") {
      const host = graphOfLoopsArtifacts.find((artifact) => artifact.name === "codex-code-mode-host")!
      if (!artifacts.some((artifact) => artifact.name === host.name)) artifacts.push(host)
    }
  }
  return artifacts
}

export const arm64ArtifactCatalog = {
  platform: "linux/arm64" as const,
  base: {
    reference: "node:22.17.0-bookworm-slim",
    digest: "sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0",
  },
  runtimeVersions,
  runtimeIntegrities,
  fixedArtifacts,
  hyperresearchArtifacts,
  graphOfLoopsArtifacts,
  headlongArtifacts,
  hyperresearchPythonLockIntegrity: "sha256:3566ca82f16dceab7ef7c6afad8889991c3c0fa13e305e91e3eab30207a454c6",
  graphOfLoopsPythonLockIntegrity: "sha256:4f384d281b261fb57077b5f99fc2d17310b6562fa26be0b76c1fac516eb43460",
} as const

export const productionArtifactCatalog = (platform: Platform) =>
  platform === "linux/arm64"
    ? Effect.succeed(arm64ArtifactCatalog)
    : Effect.fail(new ArtifactCatalogError({ message: `production artifacts are unavailable for ${platform}` }))

const sameArtifact = (actual: ArtifactLock, expected: ArtifactLock): boolean =>
  actual.name === expected.name &&
  actual.version === expected.version &&
  actual.integrity === expected.integrity &&
  actual.url === expected.url &&
  actual.size === expected.size

const artifactSetError = (lock: ProfileLock, expectedArtifacts: ReadonlyArray<ArtifactLock>): string | undefined => {
  const actual = new Map((lock.packages.artifacts ?? []).map((artifact) => [artifact.name, artifact]))
  if (actual.size !== expectedArtifacts.length) return "artifact set does not match platform catalog"
  for (const expected of expectedArtifacts) {
    const artifact = actual.get(expected.name)
    if (artifact === undefined || !sameArtifact(artifact, expected)) {
      return `artifact does not match platform catalog: ${expected.name}`
    }
  }
  return undefined
}

const runtimeCatalogError = (lock: ProfileLock): string | undefined => {
  const catalog = arm64ArtifactCatalog
  for (const runtime of lock.packages.runtime) {
    const name = runtime.name as keyof typeof runtimeVersions
    if (catalog.runtimeVersions[name] !== runtime.version || catalog.runtimeIntegrities[name] !== runtime.integrity) {
      return `runtime package does not match platform catalog: ${runtime.name}`
    }
  }
  return undefined
}

const expectedClaudeArtifacts = (document: ProfileDocument): ReadonlyArray<ArtifactLock> => {
  const catalog = arm64ArtifactCatalog
  if (document.profile.plugins[0]?.adapter === "hyperresearch") {
    return [...catalog.fixedArtifacts, ...catalog.hyperresearchArtifacts]
  }
  return [...catalog.fixedArtifacts, ...extraClaudeMarketplaceArtifacts(document)]
}

const claudeArtifactSetError = (document: ProfileDocument, lock: ProfileLock): string | undefined => {
  const catalog = arm64ArtifactCatalog
  const actual = new Map((lock.packages.artifacts ?? []).map((artifact) => [artifact.name, artifact]))
  const expectedArtifacts = expectedClaudeArtifacts(document)
  if (actual.size !== expectedArtifacts.length) return "artifact set does not match platform catalog"
  for (const expected of expectedArtifacts) {
    const artifact = actual.get(expected.name)
    if (artifact === undefined || !sameArtifact(artifact, expected)) {
      return `artifact does not match platform catalog: ${expected.name}`
    }
  }
  const extraArtifacts = extraClaudeMarketplaceArtifacts(document)
  const pythonIntegrity =
    document.profile.plugins[0]?.adapter === "hyperresearch"
      ? catalog.hyperresearchPythonLockIntegrity
      : extraArtifacts.some((artifact) => artifact.name === "python")
        ? catalog.graphOfLoopsPythonLockIntegrity
        : undefined
  if (pythonIntegrity !== undefined && lock.packages.python_lock_integrity !== pythonIntegrity) {
    return "Python dependency lock does not match platform catalog"
  }
  return undefined
}

export const lockedArtifactError = (
  document: ProfileDocument,
  lock: ProfileLock,
  platform: Platform,
): string | undefined => {
  if (platform !== "linux/arm64") return `production artifacts are unavailable for ${platform}`
  const catalog = arm64ArtifactCatalog
  if (lock.image.base !== catalog.base.reference || lock.image.base_digest !== catalog.base.digest) {
    return "base image artifact does not match platform catalog"
  }
  const runtimeError = runtimeCatalogError(lock)
  if (runtimeError !== undefined) return runtimeError
  if (lock.packages.harness.kind === "claude") {
    const claudeError = claudeArtifactSetError(document, lock)
    if (claudeError !== undefined) return claudeError
  }
  if (lock.packages.harness.kind === "headlong") {
    const headlongError = artifactSetError(lock, catalog.headlongArtifacts)
    if (headlongError !== undefined) return headlongError
  }
  if (document.profile.image.base !== catalog.base.reference) return "profile base image is unsupported for platform"
  return undefined
}
