import path from "node:path"
import { fileURLToPath } from "node:url"

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
  sourceDirectory: "/cache/source",
}))

vi.mock("../src/github-cache.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolveGitHubSource: (_cache: string, request: GitHubSourceRequest) => {
      mocks.requests.push(request)
      return Effect.succeed({
        ...request,
        commit: "a".repeat(40),
        directory: mocks.sourceDirectory,
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

vi.mock("../src/oci-image.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolveOciImage: (reference: string) =>
      Effect.succeed({
        reference,
        digest:
          `sha256:${reference.startsWith("quay.io/") ? "d" : reference.startsWith("docker.io/") ? "b" : "a"}`.padEnd(
            71,
            reference.startsWith("quay.io/") ? "d" : reference.startsWith("docker.io/") ? "b" : "a",
          ),
      }),
  }
})

vi.mock("../src/node-release.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolveNodeRelease: () =>
      Effect.succeed({
        name: "node",
        version: "24.8.0",
        integrity: `sha256:${"a".repeat(64)}`,
        url: "https://nodejs.org/dist/v24.8.0/node-v24.8.0-linux-arm64.tar.gz",
      }),
  }
})

vi.mock("../src/uv-release.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolveUvRelease: () =>
      Effect.succeed({
        name: "uv",
        version: "0.11.22",
        integrity: `sha256:${"c".repeat(64)}`,
        url: "https://github.com/astral-sh/uv/releases/download/0.11.22/uv-aarch64-unknown-linux-musl.tar.gz",
        size: 1,
      }),
  }
})

vi.mock("../src/python-release.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolvePythonRelease: () =>
      Effect.succeed({
        name: "python",
        version: "3.13.14",
        integrity: `sha256:${"e".repeat(64)}`,
        url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260728/cpython-3.13.14%2B20260728-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
        size: 1,
      }),
  }
})

vi.mock("../src/python-constraints.js", async () => {
  const { Effect } = await import("effect")
  return {
    compilePythonConstraints: () => Effect.succeed(`example==1.0.0 \\\n    --hash=sha256:${"f".repeat(64)}\n`),
  }
})

vi.mock("../src/debian-packages.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolveDebianPackages: (packages: ReadonlyArray<string>) =>
      Effect.succeed({
        direct: packages,
        runtime: packages.map((name, index) => ({
          name,
          version: `1.${index}`,
          integrity: `sha256:${String((index % 9) + 1).repeat(64)}`,
          size: index + 1,
          url: `https://deb.debian.org/debian/pool/${name}.deb`,
          direct: true,
        })),
      }),
  }
})

vi.mock("../src/tool-artifacts.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolveToolArtifacts: (_cacheHome: string, _platform: string, names: ReadonlyArray<string>) =>
      Effect.succeed(
        names.flatMap((name) =>
          name === "codex"
            ? [
                {
                  name: "codex",
                  version: "0.149.1",
                  integrity: `sha256:${"6".repeat(64)}`,
                  url: "https://github.com/openai/codex/releases/download/rust-v0.149.1/codex-aarch64-unknown-linux-musl.tar.gz",
                  size: 1,
                },
                {
                  name: "codex-code-mode-host",
                  version: "0.149.1",
                  integrity: `sha256:${"7".repeat(64)}`,
                  url: "https://github.com/openai/codex/releases/download/rust-v0.149.1/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
                  size: 1,
                },
              ]
            : [
                {
                  name,
                  version: "1.0.0",
                  integrity: `sha256:${"8".repeat(64)}`,
                  url: `https://github.com/example/${name}/releases/download/v1.0.0/${name}-linux-arm64`,
                  size: 1,
                },
              ],
        ),
      ),
  }
})

vi.mock("../src/rust-release.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolveRustToolchain: () =>
      Effect.succeed([
        {
          name: "rust",
          version: "1.96.0",
          integrity: `sha256:${"4".repeat(64)}`,
          url: "https://static.rust-lang.org/dist/2026-05-28/rust-1.96.0-aarch64-unknown-linux-gnu.tar.gz",
          size: 1,
        },
        {
          name: "rust-std-musl",
          version: "1.96.0",
          integrity: `sha256:${"5".repeat(64)}`,
          url: "https://static.rust-lang.org/dist/2026-05-28/rust-std-1.96.0-aarch64-unknown-linux-musl.tar.gz",
          size: 1,
        },
      ]),
  }
})

vi.mock("../src/playwright-release.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolvePlaywrightRelease: () =>
      Effect.succeed([
        {
          name: "playwright-mcp",
          version: "1.0.0",
          integrity: `sha256:${"a".repeat(64)}`,
          url: "https://registry.test/@playwright/mcp/-/mcp-1.0.0.tgz",
          size: 1,
        },
        {
          name: "playwright",
          version: "1.2.3",
          integrity: `sha256:${"b".repeat(64)}`,
          url: "https://registry.test/playwright/-/playwright-1.2.3.tgz",
          size: 1,
        },
        {
          name: "playwright-core",
          version: "1.2.3",
          integrity: `sha256:${"c".repeat(64)}`,
          url: "https://registry.test/playwright-core/-/playwright-core-1.2.3.tgz",
          size: 1,
        },
        {
          name: "chromium",
          version: "1234",
          integrity: `sha256:${"d".repeat(64)}`,
          url: "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1234/chromium-linux-arm64.zip",
          size: 1,
        },
        {
          name: "chromium-headless-shell",
          version: "1234",
          integrity: `sha256:${"e".repeat(64)}`,
          url: "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1234/chromium-headless-shell-linux-arm64.zip",
          size: 1,
        },
      ]),
  }
})

import { productionResolvers } from "../src/resolvers.js"

const hyperresearchFixtures = fileURLToPath(new URL("./fixtures/hyperresearch", import.meta.url))

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
    mocks.sourceDirectory = "/cache/source"
  })

  it("records floating base and helper image resolutions as exact digests", async () => {
    const resolvers = productionResolvers("/tmp/cache", "linux/arm64")

    await expect(
      Effect.runPromise(resolvers.resolveBase({ reference: "node:bookworm-slim", platform: "linux/arm64" })),
    ).resolves.toEqual({
      reference: "node:bookworm-slim",
      digest: `sha256:${"a".repeat(64)}`,
    })
    await expect(Effect.runPromise(resolvers.resolveBuild({ platform: "linux/arm64" }))).resolves.toEqual({
      builder: {
        reference: "docker.io/jdxcode/mise:latest",
        digest: `sha256:${"b".repeat(64)}`,
      },
      importer: {
        reference: "quay.io/skopeo/stable:latest",
        digest: `sha256:${"d".repeat(64)}`,
      },
    })
  })

  it("locks Debian package archive SHA-256 values rather than synthetic name hashes", async () => {
    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64", "https://registry.test/").resolvePackages({
        kind: "codex",
        selector: "0.144.6",
        platform: "linux/arm64",
        packages: ["bash", "gh", "jq"],
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
        version: "1.0",
        integrity: `sha256:${"1".repeat(64)}`,
        size: 1,
        url: "https://deb.debian.org/debian/pool/bash.deb",
        direct: true,
      },
      {
        name: "gh",
        version: "1.1",
        integrity: `sha256:${"2".repeat(64)}`,
        size: 2,
        url: "https://deb.debian.org/debian/pool/gh.deb",
        direct: true,
      },
      {
        name: "jq",
        version: "1.2",
        integrity: `sha256:${"3".repeat(64)}`,
        size: 3,
        url: "https://deb.debian.org/debian/pool/jq.deb",
        direct: true,
      },
    ])
    expect(result.runtime_direct).toEqual(["bash", "gh", "jq"])
    expect(result.runtime_closure_integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("locks the Prime ripgrep search helper from Debian", async () => {
    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolvePackages({
        kind: "prime",
        selector: "0.7.0",
        platform: "linux/arm64",
        packages: ["ripgrep"],
      }),
    )

    expect(result.runtime).toEqual([
      {
        name: "ripgrep",
        version: "1.0",
        integrity: `sha256:${"1".repeat(64)}`,
        size: 1,
        url: "https://deb.debian.org/debian/pool/ripgrep.deb",
        direct: true,
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
      }),
    )

    expect(result).toMatchObject({
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
          version: "1.0",
          integrity: `sha256:${"1".repeat(64)}`,
          size: 1,
          url: "https://deb.debian.org/debian/pool/bash.deb",
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
    expect(result.artifacts?.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: "node", version: "24.8.0" },
      { name: "uv", version: "0.11.22" },
    ])
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
      productionResolvers("/tmp/cache", "linux/arm64", "https://registry.test/").resolvePackages({
        kind: "claude",
        selector: "2.1.218",
        platform: "linux/arm64",
        packages: ["bash", ...browserPackages],
        claudeAdapter: "hyperresearch",
        needsPython: true,
        pythonRequirements: ["hyperresearch"],
      }),
    )

    expect(result.harness).toMatchObject({
      kind: "claude",
      selector: "2.1.218",
      version: "2.1.218",
    })
    expect(mocks.claudeReleaseRequests).toEqual([{ selector: "2.1.218", platform: "linux/arm64" }])

    expect(result.python_lock_integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.runtime.map(({ name }) => name)).toEqual(["bash", ...browserPackages])
    expect(
      result.runtime.every(
        ({ integrity, size, url }) =>
          /^sha256:[0-9a-f]{64}$/.test(integrity) &&
          Number.isSafeInteger(size) &&
          (size ?? 0) > 0 &&
          url?.startsWith("https://deb.debian.org/"),
      ),
    ).toBe(true)
    expect(result.artifacts?.map(({ name }) => name)).toEqual([
      "node",
      "uv",
      "playwright-mcp",
      "playwright",
      "playwright-core",
      "chromium",
      "chromium-headless-shell",
      "obscura",
      "python",
    ])
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "playwright-mcp", version: "1.0.0" }),
        expect.objectContaining({ name: "chromium", version: "1234" }),
        expect.objectContaining({ name: "obscura", version: "1.0.0" }),
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
        claudeAdapter: "claude-marketplace",
      }),
    )

    expect(result.artifacts?.map(({ name }) => name)).toEqual(["node", "uv"])
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
        }),
      ),
    ).rejects.toThrow(new RegExp(`unsupported runtime package: ${name}`))
  })

  it("resolves Codex plugin sources through the strict source cache", async () => {
    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolveSource({
        kind: "plugin",
        adapter: "codex-native",
        repository: "https://github.com/obra/superpowers.git",
        ref: "v6.2.0",
        select: ["example"],
        update: false,
      }),
    )

    expect(result.commit).toBe("a".repeat(40))
    expect(mocks.requests).toEqual([
      expect.objectContaining({
        include: ["plugins/example/.codex"],
        inventoryPolicy: {},
      }),
    ])
  })

  it("resolves Headlong as a complete source-backed harness without a release lookup", async () => {
    const source = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolveSource({
        kind: "harness",
        adapter: "headlong",
        repository: "https://github.com/laude-institute/headlong.git",
        ref: "main",
        select: [],
        update: false,
      }),
    )
    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolvePackages({
        kind: "headlong",
        selector: "latest",
        platform: "linux/arm64",
        packages: ["bash"],
        headlongSource: source,
      }),
    )

    expect(mocks.requests).toEqual([
      expect.objectContaining({
        repository: "https://github.com/laude-institute/headlong.git",
        ref: "main",
        include: [],
        inventoryPolicy: {},
      }),
    ])
    expect(result.harness).toEqual({
      kind: "headlong",
      selector: "latest",
      commit: "a".repeat(40),
      integrity: `sha256:${"b".repeat(64)}`,
    })
    expect(result.artifacts?.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: "node", version: "24.8.0" },
      { name: "uv", version: "0.11.22" },
      { name: "rust", version: "1.96.0" },
      { name: "rust-std-musl", version: "1.96.0" },
    ])
    expect([
      ...mocks.releaseRequests,
      ...mocks.piReleaseRequests,
      ...mocks.primeReleaseRequests,
      ...mocks.claudeReleaseRequests,
      ...mocks.codexReleaseRequests,
    ]).toEqual([])
  })

  it("locks the exact Hyperresearch package version from the resolved commit", async () => {
    mocks.sourceDirectory = path.join(hyperresearchFixtures, "valid")

    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolveSource({
        kind: "plugin",
        adapter: "hyperresearch",
        repository: "https://github.com/jordan-gibbs/hyperresearch.git",
        ref: "main",
        select: ["light"],
        update: false,
      }),
    )

    expect(result).toMatchObject({
      commit: "a".repeat(40),
      package_version: "0.9.1",
    })
  })

  it.each([
    ["missing", /package version is missing/],
    ["invalid", /package version is not exact/],
  ])("rejects a Hyperresearch pyproject with a %s package version", async (fixture, message) => {
    mocks.sourceDirectory = path.join(hyperresearchFixtures, fixture)

    await expect(
      Effect.runPromise(
        productionResolvers("/tmp/cache", "linux/arm64").resolveSource({
          kind: "plugin",
          adapter: "hyperresearch",
          repository: "https://github.com/jordan-gibbs/hyperresearch.git",
          ref: "main",
          select: ["light"],
          update: false,
        }),
      ),
    ).rejects.toThrow(message)
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
      plugin_versions: { "social-media-skills": "0.0.0-commit.aaaaaaaaaaaa" },
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
        versionFallback: "0.0.0-commit.aaaaaaaaaaaa",
      },
    ])
  })

  it("generates an exact commit-tied version for a versionless floating marketplace source", async () => {
    const result = await Effect.runPromise(
      productionResolvers("/tmp/cache", "linux/arm64").resolveSource({
        kind: "plugin",
        adapter: "claude-marketplace",
        marketplace: "caveman",
        repository: "https://github.com/JuliusBrussee/caveman.git",
        ref: "main",
        select: ["caveman"],
        update: false,
      }),
    )

    expect(result).toMatchObject({
      commit: "a".repeat(40),
      plugin_versions: { caveman: "0.0.0-commit.aaaaaaaaaaaa" },
    })
    expect(mocks.claudeMarketplaceRequests).toEqual([
      {
        directory: "/cache/source",
        marketplace: "caveman",
        selections: ["caveman"],
        versionFallback: "0.0.0-commit.aaaaaaaaaaaa",
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
