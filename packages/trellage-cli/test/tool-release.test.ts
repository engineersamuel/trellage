import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveNodeRelease } from "../src/node-release.js"
import { resolvePythonRelease } from "../src/python-release.js"
import { resolveRustToolchain } from "../src/rust-release.js"
import { resolveUvRelease } from "../src/uv-release.js"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("floating build tool resolution", () => {
  it("selects the newest stable Node LTS artifact and checksum", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith("/index.json")) {
        return new Response(
          JSON.stringify([
            { version: "v25.0.0", lts: false, files: ["linux-arm64"] },
            { version: "v24.8.0", lts: "Krypton", files: ["linux-arm64"] },
          ]),
        )
      }
      return new Response(`${"a".repeat(64)}  node-v24.8.0-linux-arm64.tar.gz\n`)
    }) as typeof fetch

    await expect(Effect.runPromise(resolveNodeRelease("linux/arm64"))).resolves.toEqual({
      name: "node",
      version: "24.8.0",
      integrity: `sha256:${"a".repeat(64)}`,
      url: "https://nodejs.org/dist/v24.8.0/node-v24.8.0-linux-arm64.tar.gz",
    })
  })

  it("selects an exact stable uv release asset", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            tag_name: "0.11.22",
            prerelease: false,
            draft: false,
            assets: [
              {
                name: "uv-aarch64-unknown-linux-musl.tar.gz",
                browser_download_url:
                  "https://github.com/astral-sh/uv/releases/download/0.11.22/uv-aarch64-unknown-linux-musl.tar.gz",
                digest: `sha256:${"b".repeat(64)}`,
                size: 123,
              },
            ],
          }),
        ),
    ) as typeof fetch

    await expect(Effect.runPromise(resolveUvRelease("linux/arm64"))).resolves.toEqual({
      name: "uv",
      version: "0.11.22",
      integrity: `sha256:${"b".repeat(64)}`,
      url: "https://github.com/astral-sh/uv/releases/download/0.11.22/uv-aarch64-unknown-linux-musl.tar.gz",
      size: 123,
    })
  })

  it("selects the newest Python 3.13 standalone artifact", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            tag_name: "20260728",
            prerelease: false,
            draft: false,
            assets: [
              {
                name: "cpython-3.13.14+20260728-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
                browser_download_url:
                  "https://github.com/astral-sh/python-build-standalone/releases/download/20260728/cpython-3.13.14%2B20260728-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
                digest: `sha256:${"c".repeat(64)}`,
                size: 456,
              },
            ],
          }),
        ),
    ) as typeof fetch

    await expect(Effect.runPromise(resolvePythonRelease("linux/arm64"))).resolves.toEqual({
      name: "python",
      version: "3.13.14",
      integrity: `sha256:${"c".repeat(64)}`,
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260728/cpython-3.13.14%2B20260728-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
      size: 456,
    })
  })

  it("selects exact stable Rust toolchain artifacts", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "123" } })
      if (url.endsWith("channel-rust-stable.toml")) {
        return new Response(`
[pkg.rust]
version = "1.97.0 (abcdef 2026-08-01)"
[pkg.rust.target.aarch64-unknown-linux-gnu]
url = "https://static.rust-lang.org/dist/2026-08-01/rust-1.97.0-aarch64-unknown-linux-gnu.tar.gz"
hash = "${"a".repeat(64)}"
[pkg.rust-std.target.aarch64-unknown-linux-musl]
url = "https://static.rust-lang.org/dist/2026-08-01/rust-std-1.97.0-aarch64-unknown-linux-musl.tar.gz"
hash = "${"b".repeat(64)}"
`)
      }
      return new Response("missing", { status: 404 })
    }) as typeof fetch

    await expect(Effect.runPromise(resolveRustToolchain("cache", "linux/arm64"))).resolves.toEqual([
      {
        name: "rust",
        version: "1.97.0",
        integrity: `sha256:${"a".repeat(64)}`,
        url: "https://static.rust-lang.org/dist/2026-08-01/rust-1.97.0-aarch64-unknown-linux-gnu.tar.gz",
        size: 123,
      },
      {
        name: "rust-std-musl",
        version: "1.97.0",
        integrity: `sha256:${"b".repeat(64)}`,
        url: "https://static.rust-lang.org/dist/2026-08-01/rust-std-1.97.0-aarch64-unknown-linux-musl.tar.gz",
        size: 123,
      },
    ])
  })

  it("rejects Rust host and standard-library artifacts from different releases", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(
      async () =>
        new Response(`
[pkg.rust]
version = "1.97.0 (abcdef 2026-08-01)"
[pkg.rust.target.aarch64-unknown-linux-gnu]
url = "https://static.rust-lang.org/dist/2026-08-01/rust-1.97.0-aarch64-unknown-linux-gnu.tar.gz"
hash = "${"a".repeat(64)}"
[pkg.rust-std.target.aarch64-unknown-linux-musl]
url = "https://static.rust-lang.org/dist/2026-08-02/rust-std-1.97.0-aarch64-unknown-linux-musl.tar.gz"
hash = "${"b".repeat(64)}"
`),
    ) as typeof fetch

    await expect(Effect.runPromise(resolveRustToolchain("cache", "linux/arm64"))).rejects.toThrow(
      /artifact pair is inconsistent/,
    )
  })
})
