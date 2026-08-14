import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GitHubSourceRequest } from "../src/github-cache.js"

const mocks = vi.hoisted(() => ({
  requests: [] as Array<GitHubSourceRequest>,
  releaseRequests: [] as Array<{ readonly selector: string; readonly platform: string }>,
  piReleaseRequests: [] as Array<{ readonly selector: string; readonly platform: string }>,
  primeReleaseRequests: [] as Array<{ readonly selector: string; readonly platform: string }>,
  claudeReleaseRequests: [] as Array<{ readonly selector: string; readonly platform: string }>,
  codexReleaseRequests: [] as Array<{ readonly selector: string; readonly platform: string }>,
  marketplaceRequests: [] as Array<{
    readonly directory: string
    readonly marketplace: string
    readonly selections: ReadonlyArray<string>
  }>,
  claudeMarketplaceRequests: [] as Array<{
    readonly directory: string
    readonly marketplace: string
    readonly selections: ReadonlyArray<string>
    readonly versionFallback?: string
  }>,
}))

vi.mock("../src/github-cache.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolveGitHubSource: (_cache: string, request: GitHubSourceRequest) => {
      mocks.requests.push(request)
      return Effect.succeed({
        ...request,
        commit: "a".repeat(40),
        directory: "/cache/source",
        integrity: `sha256:${"b".repeat(64)}`,
        files: [],
      })
    },
  }
})

vi.mock("../src/copilot-release.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolveCopilotRelease: (selector: string, platform: string) => {
      mocks.releaseRequests.push({ selector, platform })
      return Effect.succeed({
        kind: "copilot" as const,
        selector,
        version: "1.0.75",
        integrity: "sha256:0911f12dd816f612d27c4a360d4f00b62d933845a98d6c913e8d7400a69c6809",
        url: "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
        size: 106111479,
      })
    },
  }
})

vi.mock("../src/pi-release.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolvePiRelease: (selector: string, platform: string) => {
      mocks.piReleaseRequests.push({ selector, platform })
      return Effect.succeed({
        kind: "pi" as const,
        selector,
        version: "17.2.6",
        integrity: "sha256:65cd7f5e7d537b0b41f277191c1b95b53d509f8147c3d1bd508503dc048f1453",
        url: "https://github.com/can1357/oh-my-pi/releases/download/v17.2.6/omp-linux-arm64",
        size: 157526160,
      })
    },
  }
})

vi.mock("../src/prime-release.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolvePrimeRelease: (selector: string, platform: string) => {
      mocks.primeReleaseRequests.push({ selector, platform })
      return Effect.succeed({
        kind: "prime" as const,
        selector,
        version: "0.7.0",
        integrity: "sha256:88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b",
        url: "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.0/prime-agent-0.7.0.tgz",
        size: 9323789,
      })
    },
  }
})

vi.mock("../src/claude-release.js", async () => {
  const { Effect: EffectModule } = await import("effect")
  return {
    resolveClaudeRelease: (selector: string, platform: string) => {
      mocks.claudeReleaseRequests.push({ selector, platform })
      const version = selector === "latest" ? "2.1.222" : selector
      return EffectModule.succeed({
        kind: "claude" as const,
        selector,
        version,
        integrity: `sha256:${"c".repeat(64)}`,
        url: `https://github.com/anthropics/claude-code/releases/download/v${version}/claude-linux-arm64.tar.gz`,
        size: 88123930,
      })
    },
  }
})

vi.mock("../src/codex-release.js", async () => {
  const { Effect: EffectModule } = await import("effect")
  return {
    resolveCodexRelease: (selector: string, platform: string) => {
      mocks.codexReleaseRequests.push({ selector, platform })
      const version = selector === "latest" ? "0.146.1" : selector
      return EffectModule.succeed({
        harness: {
          kind: "codex" as const,
          selector,
          version,
          integrity: `sha256:${"d".repeat(64)}`,
          url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-aarch64-unknown-linux-musl.tar.gz`,
          size: 105647055,
        },
        artifacts: [
          {
            name: "codex-code-mode-host",
            version,
            integrity: `sha256:${"e".repeat(64)}`,
            url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz`,
            size: 17260137,
          },
        ],
      })
    },
  }
})

vi.mock("../src/copilot-plugin.js", async () => {
  const { Effect } = await import("effect")
  return {
    readCopilotMarketplace: (directory: string, marketplace: string, selections: ReadonlyArray<string>) => {
      mocks.marketplaceRequests.push({ directory, marketplace, selections })
      return Effect.succeed(Object.freeze(Object.assign(Object.create(null), { "hve-core": "3.3.101" })))
    },
  }
})

vi.mock("../src/claude-plugin.js", async () => {
  const { Effect } = await import("effect")
  const actual = await vi.importActual<typeof import("../src/claude-plugin.js")>("../src/claude-plugin.js")
  return {
    ...actual,
    readClaudeMarketplace: (
      directory: string,
      marketplace: string,
      selections: ReadonlyArray<string>,
      options?: { readonly versionFallback?: string },
    ) => {
      mocks.claudeMarketplaceRequests.push({
        directory,
        marketplace,
        selections,
        ...(options?.versionFallback === undefined ? {} : { versionFallback: options.versionFallback }),
      })
      const version = options?.versionFallback ?? "1.0.0"
      const name = selections[0] ?? "social-media-skills"
      return Effect.succeed(Object.freeze(Object.assign(Object.create(null), { [name]: version })))
    },
  }
})

import { productionResolvers } from "../src/resolvers.js"

describe("production package resolutions", () => {
  beforeEach(() => {
    mocks.requests.length = 0
    mocks.releaseRequests.length = 0
    mocks.piReleaseRequests.length = 0
    mocks.primeReleaseRequests.length = 0
    mocks.claudeReleaseRequests.length = 0
    mocks.codexReleaseRequests.length = 0
    mocks.marketplaceRequests.length = 0
    mocks.claudeMarketplaceRequests.length = 0
  })

  it("locks Debian package archive SHA-256 values rather than synthetic name hashes", async () => {
    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolvePackages({
        kind: "codex",
        selector: "0.144.6",
        platform: "linux/arm64",
        packages: ["bash", "gh", "jq"],
        needsSkillsCli: true,
      }),
    )

    expect(result.harness).toEqual({
      kind: "codex",
      selector: "0.144.6",
      version: "0.144.6",
      integrity: `sha256:${"d".repeat(64)}`,
      url: "https://github.com/openai/codex/releases/download/rust-v0.144.6/codex-aarch64-unknown-linux-musl.tar.gz",
      size: 105647055,
    })
    expect(result.runtime).toEqual([
      {
        name: "bash",
        version: "5.2.15-2+b13",
        integrity: "sha256:fdb470b5ec1773b90014138bfc1deda4505c1c23e7f5731e8b527c636ac03385",
      },
      {
        name: "gh",
        version: "2.23.0+dfsg1-1",
        integrity: "sha256:7aeed4b288718660cda8e18ea1b06b69da42f3072ec599343965b01cf01b4a12",
      },
      {
        name: "jq",
        version: "1.6-2.1+deb12u2",
        integrity: "sha256:c232e9407e0f47006dd6077804c1274fd2e4f8be02efc78822db748ed65bea99",
      },
    ])
  })

  it("locks the Prime ripgrep search helper from Debian", async () => {
    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolvePackages({
        kind: "prime",
        selector: "0.7.0",
        platform: "linux/arm64",
        packages: ["ripgrep"],
        needsSkillsCli: false,
      }),
    )

    expect(result.runtime).toEqual([
      {
        name: "ripgrep",
        version: "13.0.0-4+b2",
        integrity: "sha256:82bd2ff67cedf892c1906d7ecd2831605ec1f8ad74825f576f5519a9c82a02a3",
      },
    ])
  })

  it("resolves an exact Copilot release and preserves runtime package locks", async () => {
    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolvePackages({
        kind: "copilot",
        selector: "latest",
        platform: "linux/arm64",
        packages: ["bash"],
        needsSkillsCli: false,
      }),
    )

    expect(result).toEqual({
      deja: {
        name: "deja",
        version: "0.17.0",
        integrity: "sha256:e6b21fdd9953b8428bd9464fc1cd6c9bbb1ad9396db31727a96903f60598b0e1",
        url: "https://github.com/vshulcz/deja-vu/releases/download/v0.17.0/deja-vu_0.17.0_linux_arm64.tar.gz",
        size: 4364290,
      },
      harness: {
        kind: "copilot",
        selector: "latest",
        version: "1.0.75",
        integrity: "sha256:0911f12dd816f612d27c4a360d4f00b62d933845a98d6c913e8d7400a69c6809",
        url: "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
        size: 106111479,
      },
      runtime: [
        {
          name: "bash",
          version: "5.2.15-2+b13",
          integrity: "sha256:fdb470b5ec1773b90014138bfc1deda4505c1c23e7f5731e8b527c636ac03385",
        },
      ],
    })
    expect(mocks.releaseRequests).toEqual([{ selector: "latest", platform: "linux/arm64" }])
  })

  it("resolves only the Prime release and preserves declared runtime package order", async () => {
    const packages = ["bash", "ca-certificates", "curl", "fish", "gh", "git", "jq", "zsh"]

    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolvePackages({
        kind: "prime",
        selector: "latest",
        platform: "linux/arm64",
        packages,
        needsSkillsCli: false,
      }),
    )

    expect(result.harness).toEqual({
      kind: "prime",
      selector: "latest",
      version: "0.7.0",
      integrity: "sha256:88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b",
      url: "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.0/prime-agent-0.7.0.tgz",
      size: 9323789,
    })
    expect(result.runtime.map(({ name }) => name)).toEqual(packages)
    expect(
      result.runtime.every(({ version, integrity }) => version.length > 0 && /^sha256:[0-9a-f]{64}$/.test(integrity)),
    ).toBe(true)
    expect(mocks.primeReleaseRequests).toEqual([{ selector: "latest", platform: "linux/arm64" }])
    expect(mocks.releaseRequests).toEqual([])
    expect(mocks.piReleaseRequests).toEqual([])
    expect(mocks.claudeReleaseRequests).toEqual([])
    expect(mocks.codexReleaseRequests).toEqual([])
  })

  it("locks the verified Claude, Python, browser, Obscura, and OCI artifacts", async () => {
    const browserPackages = [
      "libasound2",
      "libatk-bridge2.0-0",
      "libatk1.0-0",
      "libcairo2",
      "libcups2",
      "libdbus-1-3",
      "libgbm1",
      "libglib2.0-0",
      "libnspr4",
      "libnss3",
      "libpango-1.0-0",
      "libx11-6",
      "libxcb1",
      "libxcomposite1",
      "libxdamage1",
      "libxext6",
      "libxfixes3",
      "libxkbcommon0",
      "libxrandr2",
    ]
    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolvePackages({
        kind: "claude",
        selector: "2.1.218",
        platform: "linux/arm64",
        packages: ["bash", ...browserPackages],
        needsSkillsCli: false,
        claudeAdapter: "hyperresearch",
      }),
    )

    expect(result.harness).toMatchObject({
      kind: "claude",
      selector: "2.1.218",
      version: "2.1.218",
    })
    expect(mocks.claudeReleaseRequests).toEqual([{ selector: "2.1.218", platform: "linux/arm64" }])

    expect(result.python_lock_integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.runtime).toEqual(
      expect.arrayContaining([
        {
          name: "libglib2.0-0",
          version: "2.74.6-2+deb12u9",
          integrity: "sha256:61d92fffada7e27fc0ed9d23e047b45bca3b2e3bfe1a918f4ec16559282859f4",
        },
        {
          name: "libnss3",
          version: "2:3.87.1-1+deb12u4",
          integrity: "sha256:aaa1b291b6330590079a0eb1404650c7c4f6c788f9213ab6911149dc22b2b6d0",
        },
        {
          name: "libgbm1",
          version: "22.3.6-1+deb12u2",
          integrity: "sha256:f5c8fdddbf365259d74af270fb10f30d7fddb3fbe7b2ff62f0fdd556f8db0dc8",
        },
      ]),
    )
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "node",
          version: "22.17.0",
          integrity: "sha256:3e99df8b01b27dc8b334a2a30d1cd500442b3b0877d217b308fd61a9ccfc33d4",
        }),
        expect.objectContaining({
          name: "python",
          version: "3.13.14",
          integrity: "sha256:1eaf979af6c6986553b91a9e3b03647f63ce52a888e00892d3bddc96f43748e9",
        }),
        expect.objectContaining({ name: "playwright-mcp", version: "0.0.78" }),
        expect.objectContaining({
          name: "chromium",
          version: "1228",
          integrity: "sha256:ec044b50ed065adeb4c5ffdb42d1529901cbaf897cdf542bfef8af01d6e0cc79",
        }),
        expect.objectContaining({
          name: "chromium-headless-shell",
          version: "1228",
          integrity: "sha256:1652929a70f4afb17aca36fce073fb7ed22262d16825be761b0801972f43ac4f",
          url: "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1228/chromium-headless-shell-linux-arm64.zip",
          size: 115342043,
        }),
        expect.objectContaining({
          name: "obscura",
          version: "v0.1.11",
          integrity: "sha256:d535324d44724cdfec16e500d0335903bca5c6a446e736b351691ee7e39debb4",
        }),
        expect.objectContaining({
          name: "builder-oci",
          integrity: "sha256:b8f8c20fc3308f8b1d00ccca2bc968e4e208af1c5c1069e1ad9753baa099acff",
        }),
        expect.objectContaining({
          name: "skopeo-oci",
          integrity: "sha256:47853bb9fb24202af9110531ebd6e43c5f97701254ca290596640290d17942f4",
        }),
      ]),
    )
  })

  it("locks only common Claude artifacts for a native marketplace profile", async () => {
    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolvePackages({
        kind: "claude",
        selector: "2.1.218",
        platform: "linux/arm64",
        packages: ["bash", "git", "jq"],
        needsSkillsCli: false,
        claudeAdapter: "claude-marketplace",
      }),
    )

    expect(result.artifacts?.map(({ name }) => name)).toEqual(["node", "builder-oci", "skopeo-oci"])
    expect(result.python_lock_integrity).toBeUndefined()
  })

  it.each(["constructor", "toString", "__proto__"])("rejects prototype runtime package key %j", async (name) => {
    await expect(
      Effect.runPromise(
        productionResolvers("/tmp/cache", "linux/arm64").resolvePackages({
          kind: "codex",
          selector: "0.144.6",
          platform: "linux/arm64",
          packages: [name],
          needsSkillsCli: false,
        }),
      ),
    ).rejects.toThrow(new RegExp(`unsupported runtime package: ${name}`))
  })

  it("resolves Codex sources through the strict source cache", async () => {
    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolveSource({
        kind: "skill",
        repository: "https://github.com/obra/superpowers.git",
        ref: "v6.2.0",
        select: ["*"],
        update: false,
      }),
    )

    expect(result.commit).toBe("a".repeat(40))
    expect(mocks.requests).toEqual([
      expect.objectContaining({
        include: ["skills", ".agents/skills", ".claude/skills"],
        inventoryPolicy: {},
      }),
    ])
  })

  it("resolves Copilot source through the full cache before reading marketplace metadata", async () => {
    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolveSource({
        kind: "plugin",
        adapter: "copilot-marketplace",
        marketplace: "hve-core",
        repository: "https://github.com/microsoft/hve-core.git",
        ref: "main",
        select: ["hve-core"],
        update: false,
      }),
    )

    expect(result).toMatchObject({
      commit: "a".repeat(40),
      plugin_versions: { "hve-core": "3.3.101" },
    })

    expect(mocks.requests).toEqual([
      expect.objectContaining({
        include: [],
        inventoryPolicy: { allowSymlinks: true },
      }),
    ])
    expect(mocks.marketplaceRequests).toEqual([
      {
        directory: "/cache/source",
        marketplace: "hve-core",
        selections: ["hve-core"],
      },
    ])
  })

  it("resolves Claude marketplace source through the full strict cache", async () => {
    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolveSource({
        kind: "plugin",
        adapter: "claude-marketplace",
        marketplace: "social-media-skills",
        repository: "https://github.com/charlie947/social-media-skills.git",
        ref: "main",
        select: ["social-media-skills"],
        update: false,
      }),
    )

    expect(result).toMatchObject({
      commit: "a".repeat(40),
      plugin_versions: { "social-media-skills": "1.0.0" },
    })
    expect(mocks.requests).toEqual([
      expect.objectContaining({
        include: [],
        inventoryPolicy: { allowSymlinks: true },
      }),
    ])
    expect(mocks.claudeMarketplaceRequests).toEqual([
      {
        directory: "/cache/source",
        marketplace: "social-media-skills",
        selections: ["social-media-skills"],
      },
    ])
  })

  it("passes a ref-derived version fallback for pinned Claude marketplace tags", async () => {
    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolveSource({
        kind: "plugin",
        adapter: "claude-marketplace",
        marketplace: "caveman",
        repository: "https://github.com/JuliusBrussee/caveman.git",
        ref: "v1.10.0",
        select: ["caveman"],
        update: false,
      }),
    )

    expect(result).toMatchObject({
      commit: "a".repeat(40),
      plugin_versions: { caveman: "1.10.0" },
    })
    expect(mocks.claudeMarketplaceRequests).toEqual([
      {
        directory: "/cache/source",
        marketplace: "caveman",
        selections: ["caveman"],
        versionFallback: "1.10.0",
      },
    ])
  })
})
