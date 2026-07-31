import { createHash } from "node:crypto"
import { chmod, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  CacheError,
  resolveGitHubSource,
  selectCommitFromLsRemote,
  type CachePublisher,
  type GitClient,
} from "../src/github-cache.js"

const cacheRoot = () =>
  import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "harness-cache-")))

const client = (calls: Array<string>, commit = "a".repeat(40)): GitClient => ({
  resolveRef: (repository, ref) =>
    Effect.sync(() => {
      calls.push(`resolve:${repository}@${ref}`)
      return commit
    }),
  checkout: (_repository, resolvedCommit, destination) =>
    Effect.tryPromise({
      try: async () => {
        calls.push(`checkout:${resolvedCommit}`)
        await mkdir(path.join(destination, "skills", "one"), { recursive: true })
        await writeFile(path.join(destination, "skills", "one", "SKILL.md"), "# One\n")
      },
      catch: (cause) => cause,
    }),
})

describe("GitHub source cache", () => {
  it("peels annotated tags to their commit", () => {
    expect(
      selectCommitFromLsRemote(
        [
          "0e5cc50e782429b95f933e46443898435b8b37a8\trefs/tags/v6.2.0",
          "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9\trefs/tags/v6.2.0^{}",
        ].join("\n"),
      ),
    ).toBe("3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9")
  })

  it("materializes an exact commit atomically and verifies cache hits", async () => {
    const root = await cacheRoot()
    const calls: Array<string> = []
    const request = { repository: "https://github.com/example/skills.git", ref: "v1" }

    const first = await Effect.runPromise(resolveGitHubSource(root, request, client(calls)))
    const second = await Effect.runPromise(resolveGitHubSource(root, request, client(calls)))

    expect(first).toEqual(second)
    expect(calls.filter((entry) => entry.startsWith("checkout"))).toHaveLength(1)
    expect(first.commit).toBe("a".repeat(40))
  })

  it("does not reuse cache metadata from before executable bits were locked", async () => {
    const root = await cacheRoot()
    const calls: Array<string> = []
    const repository = "https://github.com/example/skills.git"
    const request = { repository, ref: "v1" }
    const commit = "a".repeat(40)
    const legacyKey = createHash("sha256")
      .update(
        JSON.stringify({
          repository,
          include: [],
          allowSymlinks: false,
        }),
      )
      .digest("hex")
    const legacyBundle = path.join(root, "harness", "github", legacyKey, commit)
    const legacyFile = path.join(legacyBundle, "checkout", "skills", "one", "SKILL.md")
    const content = "# One\n"
    await mkdir(path.dirname(legacyFile), { recursive: true })
    await writeFile(legacyFile, content)
    await chmod(legacyFile, 0o755)
    await writeFile(
      path.join(legacyBundle, "inventory.json"),
      JSON.stringify([
        {
          kind: "file",
          path: "skills/one/SKILL.md",
          sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        },
      ]),
    )

    const resolved = await Effect.runPromise(resolveGitHubSource(root, request, client(calls)))

    expect(resolved.directory).not.toBe(path.join(legacyBundle, "checkout"))
    expect(calls.filter((entry) => entry.startsWith("checkout"))).toHaveLength(1)
  })

  it("adopts a verified winner when concurrent cold publications collide", async () => {
    const root = await cacheRoot()
    const request = { repository: "https://github.com/example/skills.git", ref: "v1" }
    let arrivals = 0
    let release: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const concurrent: GitClient = {
      resolveRef: () => Effect.succeed("a".repeat(40)),
      checkout: (_repository, _commit, destination) =>
        Effect.tryPromise({
          try: async () => {
            await mkdir(path.join(destination, "skills", "one"), { recursive: true })
            await writeFile(path.join(destination, "skills", "one", "SKILL.md"), "# One\n")
            arrivals += 1
            if (arrivals === 2) release?.()
            await barrier
          },
          catch: (cause) => cause,
        }),
    }

    const [first, second] = await Promise.all([
      Effect.runPromise(resolveGitHubSource(root, request, concurrent)),
      Effect.runPromise(resolveGitHubSource(root, request, concurrent)),
    ])

    expect(first.directory).toBe(second.directory)
    expect(first.commit).toBe("a".repeat(40))
    expect(first.files).toEqual(second.files)
    const parent = path.dirname(path.dirname(first.directory))
    const entries = await readdir(parent, { recursive: true })
    expect(entries.some((entry) => entry.includes(".materialize-"))).toBe(false)
  })

  it.each(["metadata", "publish"] as const)(
    "leaves no visible cache entry after an injected %s failure and recovers",
    async (failure) => {
      const root = await cacheRoot()
      const calls: Array<string> = []
      const request = { repository: "https://github.com/example/skills.git", ref: "v1" }
      const publisher: CachePublisher = {
        writeMetadata: async (metadataPath, files) => {
          if (failure === "metadata") throw new Error("injected metadata failure")
          await writeFile(metadataPath, `${JSON.stringify(files)}\n`, { flag: "wx" })
        },
        publishBundle: async (temporary, destination) => {
          if (failure === "publish") throw new Error("injected publish failure")
          await rename(temporary, destination)
        },
      }

      await expect(Effect.runPromise(resolveGitHubSource(root, request, client(calls), publisher))).rejects.toThrow(
        /cannot publish cache atomically/,
      )
      const entries = await readdir(path.join(root, "harness", "github"), { recursive: true })
      expect(entries.some((entry) => entry.includes("a".repeat(40)))).toBe(false)

      const recovered = await Effect.runPromise(resolveGitHubSource(root, request, client(calls)))
      expect(recovered.directory).toMatch(/\/checkout$/)
      expect(calls.filter((entry) => entry.startsWith("checkout"))).toHaveLength(2)
    },
  )

  it("cleans a legacy partial checkout and sidecar before rematerializing", async () => {
    const root = await cacheRoot()
    const calls: Array<string> = []
    const request = { repository: "https://github.com/example/skills.git", ref: "v1" }
    const initial = await Effect.runPromise(resolveGitHubSource(root, request, client(calls)))
    const bundle = path.dirname(initial.directory)
    const parent = path.dirname(bundle)
    await rm(bundle, { recursive: true })
    await mkdir(path.join(bundle, "skills"), { recursive: true })
    await writeFile(path.join(bundle, "skills", "partial.txt"), "partial\n")
    await writeFile(path.join(parent, `${initial.commit}.inventory.json`), "[]\n")

    const recovered = await Effect.runPromise(resolveGitHubSource(root, request, client(calls)))

    expect(recovered.directory).toMatch(/\/checkout$/)
    expect(calls.filter((entry) => entry.startsWith("checkout"))).toHaveLength(2)
  })

  it("preserves contained symlinks through permissive cache creation and verification", async () => {
    const root = await cacheRoot()
    const calls: Array<string> = []
    const linked: GitClient = {
      resolveRef: () => Effect.succeed("f".repeat(40)),
      checkout: (_repository, resolvedCommit, destination) =>
        Effect.tryPromise({
          try: async () => {
            calls.push(`checkout:${resolvedCommit}`)
            await mkdir(path.join(destination, "plugin"), { recursive: true })
            await writeFile(path.join(destination, "plugin", "marketplace.json"), "{}\n")
            await symlink("marketplace.json", path.join(destination, "plugin", "current.json"))
          },
          catch: (cause) => cause,
        }),
    }
    const request = {
      repository: "https://github.com/example/marketplace.git",
      ref: "main",
      inventoryPolicy: { allowSymlinks: true },
    } as const

    const first = await Effect.runPromise(resolveGitHubSource(root, request, linked))
    const second = await Effect.runPromise(resolveGitHubSource(root, request, linked))

    expect(first.files).toContainEqual({
      kind: "symlink",
      path: "plugin/current.json",
      target: "marketplace.json",
    })
    expect(second).toEqual(first)
    expect(calls).toEqual([`checkout:${"f".repeat(40)}`])
  })

  it("does not alias strict and permissive cache entries", async () => {
    const root = await cacheRoot()
    const calls: Array<string> = []
    const linked: GitClient = {
      resolveRef: () => Effect.succeed("f".repeat(40)),
      checkout: (_repository, resolvedCommit, destination) =>
        Effect.tryPromise({
          try: async () => {
            calls.push(`checkout:${resolvedCommit}`)
            await writeFile(path.join(destination, "target.txt"), "target\n")
            await symlink("target.txt", path.join(destination, "link.txt"))
          },
          catch: (cause) => cause,
        }),
    }
    const base = { repository: "https://github.com/example/marketplace.git", ref: "main" }

    await Effect.runPromise(
      resolveGitHubSource(
        root,
        {
          ...base,
          inventoryPolicy: { allowSymlinks: true },
        },
        linked,
      ),
    )

    await expect(Effect.runPromise(resolveGitHubSource(root, base, linked))).rejects.toThrow(/source inventory failed/)
    expect(calls).toHaveLength(2)
  })

  it("uses a compatible locked commit without resolving a moving ref", async () => {
    const root = await cacheRoot()
    const calls: Array<string> = []

    const result = await Effect.runPromise(
      resolveGitHubSource(
        root,
        {
          repository: "https://github.com/example/skills.git",
          ref: "main",
          lockedCommit: "b".repeat(40),
        },
        client(calls, "c".repeat(40)),
      ),
    )

    expect(result.commit).toBe("b".repeat(40))
    expect(calls.some((entry) => entry.startsWith("resolve"))).toBe(false)
  })

  it("treats an exact commit ref as already resolved", async () => {
    const root = await cacheRoot()
    const calls: Array<string> = []
    const exact = "e".repeat(40)

    const result = await Effect.runPromise(
      resolveGitHubSource(
        root,
        {
          repository: "https://github.com/example/skills.git",
          ref: exact,
        },
        client(calls),
      ),
    )

    expect(result.commit).toBe(exact)
    expect(calls.some((entry) => entry.startsWith("resolve"))).toBe(false)
  })

  it("rejects a locked commit that differs from an exact ref before checkout", async () => {
    const root = await cacheRoot()
    const calls: Array<string> = []

    await expect(
      Effect.runPromise(
        resolveGitHubSource(
          root,
          {
            repository: "https://github.com/example/skills.git",
            ref: "a".repeat(40),
            lockedCommit: "b".repeat(40),
          },
          client(calls),
        ),
      ),
    ).rejects.toThrow(/exact ref does not match locked commit/)
    expect(calls).toEqual([])
  })

  it("rejects modified cache content", async () => {
    const root = await cacheRoot()
    const calls: Array<string> = []
    const request = { repository: "https://github.com/example/skills.git", ref: "v1" }
    const resolved = await Effect.runPromise(resolveGitHubSource(root, request, client(calls)))
    await writeFile(path.join(resolved.directory, "skills", "one", "SKILL.md"), "tampered\n")

    await expect(Effect.runPromise(resolveGitHubSource(root, request, client(calls)))).rejects.toThrow(
      /cache verification failed/,
    )
  })

  it("rejects a modified cache executable bit", async () => {
    const root = await cacheRoot()
    const calls: Array<string> = []
    const request = { repository: "https://github.com/example/skills.git", ref: "v1" }
    const resolved = await Effect.runPromise(resolveGitHubSource(root, request, client(calls)))
    await chmod(path.join(resolved.directory, "skills", "one", "SKILL.md"), 0o755)

    await expect(Effect.runPromise(resolveGitHubSource(root, request, client(calls)))).rejects.toThrow(
      /cache verification failed/,
    )
  })

  it.each([
    ["wrong root", {}],
    ["wrong kind", [{ kind: "directory", path: "skills", sha256: "not-used" }]],
    ["missing field", [{ kind: "file", path: "skills/one/SKILL.md" }]],
  ])("rejects malformed cache metadata as CacheError: %s", async (_label, malformed) => {
    const root = await cacheRoot()
    const calls: Array<string> = []
    const request = { repository: "https://github.com/example/skills.git", ref: "v1" }
    const resolved = await Effect.runPromise(resolveGitHubSource(root, request, client(calls)))
    await writeFile(path.join(path.dirname(resolved.directory), "inventory.json"), JSON.stringify(malformed))

    const result = await Effect.runPromise(Effect.either(resolveGitHubSource(root, request, client(calls))))

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(CacheError)
  })

  it("inventories only declared source paths", async () => {
    const root = await cacheRoot()
    const scoped: GitClient = {
      resolveRef: () => Effect.succeed("d".repeat(40)),
      checkout: (_repository, _commit, destination) =>
        Effect.tryPromise({
          try: async () => {
            await mkdir(path.join(destination, "skills", "one"), { recursive: true })
            await writeFile(path.join(destination, "skills", "one", "SKILL.md"), "# One\n")
            await symlink("README.md", path.join(destination, "AGENTS.md"))
          },
          catch: (cause) => cause,
        }),
    }

    const result = await Effect.runPromise(
      resolveGitHubSource(
        root,
        {
          repository: "https://github.com/example/skills.git",
          ref: "v1",
          include: ["skills"],
        },
        scoped,
      ),
    )

    expect(result.files.map((entry) => entry.path)).toEqual(["skills/one/SKILL.md"])
  })

  it("rejects invalid GitHub repositories and commits", async () => {
    const root = await cacheRoot()
    await expect(
      Effect.runPromise(
        resolveGitHubSource(
          root,
          {
            repository: "https://example.test/repo.git",
            ref: "main",
          },
          client([]),
        ),
      ),
    ).rejects.toThrow(/GitHub/)
    await expect(
      Effect.runPromise(
        resolveGitHubSource(
          root,
          {
            repository: "https://github.com/example/repo.git",
            ref: "main",
          },
          client([], "not-a-commit"),
        ),
      ),
    ).rejects.toThrow(/commit/)
    await expect(
      Effect.runPromise(
        resolveGitHubSource(
          root,
          {
            repository: "https://token@github.com/example/repo.git",
            ref: "main",
          },
          client([]),
        ),
      ),
    ).rejects.toThrow(/credential/i)
  })
})
