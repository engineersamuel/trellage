import { Effect } from "effect"

import { CopilotPluginError, readCopilotMarketplace } from "./copilot-plugin.js"
import { resolveCopilotRelease } from "./copilot-release.js"
import { resolveGitHubSource } from "./github-cache.js"
import type { LockResolvers } from "./lock.js"
import { resolvePiRelease } from "./pi-release.js"
import { sourceIncludes, sourceInventoryPolicy } from "./source-policy.js"

const versions: Readonly<Record<string, string>> = {
  bash: "5.2.15-2+b13",
  "ca-certificates": "20230311+deb12u1",
  curl: "7.88.1-10+deb12u15",
  fish: "3.6.0-3.1+deb12u1",
  git: "1:2.39.5-0+deb12u3",
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
  libnss3: "2:3.87.1-1+deb12u3",
  "libpango-1.0-0": "1.50.12+ds-1",
  "libx11-6": "2:1.8.4-2+deb12u2",
  libxcb1: "1.15-1",
  libxcomposite1: "1:0.4.5-1",
  libxdamage1: "1:1.1.6-1",
  libxext6: "2:1.3.4-1+b1",
  libxfixes3: "1:6.0.0-2",
  libxkbcommon0: "1.5.0-1",
  libxrandr2: "2:1.5.2-2+b1",
  zsh: "5.9-4+b15",
}

const integrities: Readonly<Record<string, string>> = {
  bash: "sha256:fdb470b5ec1773b90014138bfc1deda4505c1c23e7f5731e8b527c636ac03385",
  "ca-certificates": "sha256:0d5f444f594e48c1e16a41d8fc628a09b24c658916a1274025c2330f2a802bed",
  curl: "sha256:880d20cb636d2c36b2f57c58ab284b442a1680365b488d3e696c147c4d84ef25",
  fish: "sha256:d55844785d95a3ba9f128c87ad319ae4f4fe4a10d4463f3555cbc3293995840a",
  git: "sha256:435176549a9f5c8bbadaa126b64a036b38ea34ad9f3eb128dc40b8407a5b5620",
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
  libnss3: "sha256:0b5bc3d95e6c18cf6685e6688875bb7077607b8715a9edf3194b0afe83f7f157",
  "libpango-1.0-0": "sha256:88afa1481f9e520a3068e85dad776ed09a3751c7638a877333af6cec927db3ee",
  "libx11-6": "sha256:d1d533e983582282a9ea82c87ac5ce715a9b67bd6d1acbd2439a11c63c36549b",
  libxcb1: "sha256:041d9a68415c3ccf3ce8f4f8b88e4bbfb5dc1f0d97013c6ef8423e620ea50f84",
  libxcomposite1: "sha256:cfe39326fdb822e9d060ed5eb3f95b14459dd6b73793c5290000f9b27f8bad37",
  libxdamage1: "sha256:489d20cf78c8ee4428f3e26c5b3edcd87a71b5beb6bed992c45f47c6d01a1c92",
  libxext6: "sha256:5e9c0ad606eb4674c645fe8e0e64330c47d2729f7a59ed569848610efd5d5b62",
  libxfixes3: "sha256:d47bda8fed01b19b41d503e2df05d9166c58e30e2376f2f8784ceb7a834befe6",
  libxkbcommon0: "sha256:ec518d8a19796a399ab95e7bc4dfbb6bd2ed8e151f77b222df26208db412d852",
  libxrandr2: "sha256:f0bc7f79fee182caae176652fdb1bf349d13b9591b10ad4dc1c896521da8e49f",
  zsh: "sha256:c6ef58b84ecc669776024866821c89d2247307f1fb6b174fcbe281ad58bfba90",
}

export const productionResolvers = (xdgCacheHome: string): LockResolvers => ({
  resolveSource: (request) =>
    Effect.gen(function* () {
      const cached = yield* resolveGitHubSource(xdgCacheHome, {
        repository: request.repository,
        ref: request.ref,
        include: sourceIncludes(request),
        inventoryPolicy: sourceInventoryPolicy(request),
        ...(!request.update && request.previousCommit ? { lockedCommit: request.previousCommit } : {}),
      })
      const resolution = {
        commit: cached.commit,
        integrity: cached.integrity,
        files: cached.files,
      }
      if (request.adapter !== "copilot-marketplace") return resolution
      if (request.marketplace === undefined) {
        return yield* Effect.fail(new CopilotPluginError({ message: "Copilot marketplace selection is missing" }))
      }
      const plugin_versions = yield* readCopilotMarketplace(cached.directory, request.marketplace, request.select)
      return { ...resolution, plugin_versions }
    }),
  resolvePackages: ({ kind, selector, platform, packages, needsSkillsCli }) =>
    Effect.gen(function* () {
      const runtime = []
      for (const name of packages) {
        if (!Object.hasOwn(versions, name) || !Object.hasOwn(integrities, name)) {
          return yield* Effect.fail(`unsupported runtime package: ${name}`)
        }
        const version = versions[name]
        const integrity = integrities[name]
        if (!version || !integrity) return yield* Effect.fail(`unsupported runtime package: ${name}`)
        runtime.push({ name, version, integrity })
      }
      const harness =
        kind === "copilot"
          ? yield* resolveCopilotRelease(selector, platform)
          : kind === "pi"
            ? yield* resolvePiRelease(selector, platform)
            : kind === "claude"
              ? yield* Effect.gen(function* () {
                  if (selector !== "2.1.218") return yield* Effect.fail(`unsupported Claude version: ${selector}`)
                  if (platform !== "linux/arm64") return yield* Effect.fail(`unsupported Claude platform: ${platform}`)
                  return {
                    kind: "claude" as const,
                    selector,
                    version: selector,
                    integrity: "sha256:3a434c8bcb493e9ca87315d9aa6064835c5987e8fbc85c181bb76157dd5c45d8",
                    url: "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.218.tgz",
                    size: 22971,
                  }
                })
              : yield* Effect.gen(function* () {
                  if (selector !== "0.144.6") return yield* Effect.fail(`unsupported Codex version: ${selector}`)
                  if (platform !== "linux/arm64") return yield* Effect.fail(`unsupported Codex platform: ${platform}`)
                  return {
                    kind: "codex" as const,
                    selector,
                    version: selector,
                    integrity: "sha256:8eddae5e6c009dff9ba51ae1bfe3bdd9ff4c1ccc93a48cc6860db1cd9fdf11be",
                    url: "https://github.com/openai/codex/releases/download/rust-v0.144.6/codex-aarch64-unknown-linux-musl.tar.gz",
                    size: 101269986,
                  }
                })
      const artifacts =
        kind === "claude"
          ? [
              {
                name: "node",
                version: "22.17.0",
                integrity: "sha256:3e99df8b01b27dc8b334a2a30d1cd500442b3b0877d217b308fd61a9ccfc33d4",
                url: "https://nodejs.org/dist/v22.17.0/node-v22.17.0-linux-arm64.tar.gz",
              },
              {
                name: "python",
                version: "3.13.14",
                integrity: "sha256:1eaf979af6c6986553b91a9e3b03647f63ce52a888e00892d3bddc96f43748e9",
                url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260728/cpython-3.13.14+20260728-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
              },
              {
                name: "claude-code-linux-arm64",
                version: "2.1.218",
                integrity: "sha256:1d3cb5e12f0b653929e34ba046a7ba0a4f5c01eb25ea57b478dbac27e4af9619",
                url: "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64/-/claude-code-linux-arm64-2.1.218.tgz",
                size: 84159749,
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
          : undefined
      return {
        harness,
        ...(needsSkillsCli
          ? {
              skills_cli_version: "1.5.19",
              skills_cli_integrity:
                "sha512-SR05cbNk+R17GfaCFv94Hlq5EXDpUCbG0ZL9+EYi5UEHzUPAAl+kls2LxCT+67wAWlOAanUwzZekIVQvpCmp5w==",
            }
          : {}),
        runtime,
        ...(artifacts === undefined
          ? {}
          : {
              artifacts,
              python_lock_integrity: "sha256:3566ca82f16dceab7ef7c6afad8889991c3c0fa13e305e91e3eab30207a454c6",
            }),
      }
    }),
  resolveBase: ({ reference, platform }) => {
    if (reference === "node:22.17.0-bookworm-slim" && platform === "linux/arm64") {
      return Effect.succeed({
        reference,
        digest: "sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0",
      })
    }
    return Effect.fail(`unsupported base image resolution: ${reference} (${platform})`)
  },
})
