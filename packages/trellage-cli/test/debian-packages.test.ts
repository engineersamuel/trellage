import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { resolveDebianPackages } from "../src/debian-packages.js"

const originalPath = process.env.PATH
const originalLog = process.env.FAKE_DOCKER_LOG

afterEach(() => {
  process.env.PATH = originalPath
  if (originalLog === undefined) delete process.env.FAKE_DOCKER_LOG
  else process.env.FAKE_DOCKER_LOG = originalLog
})

describe("Debian runtime package resolution", () => {
  it("records exact repository metadata against the resolved base image", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-debian-resolution-"))
    const bin = path.join(root, "bin")
    const log = path.join(root, "docker.log")
    await mkdir(bin)
    const docker = path.join(bin, "docker")
    await writeFile(
      docker,
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >"$FAKE_DOCKER_LOG"
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' PKG bash 5.2 '${"a".repeat(64)}' 123 https://deb.debian.org/debian/pool/main/b/bash/bash.deb true
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' PKG libdep 1.0 '${"c".repeat(64)}' 45 https://deb.debian.org/debian/pool/main/libd/libdep/libdep.deb false
`,
    )
    await chmod(docker, 0o755)
    process.env.PATH = `${bin}:${originalPath ?? ""}`
    process.env.FAKE_DOCKER_LOG = log

    await expect(
      Effect.runPromise(
        resolveDebianPackages(
          ["bash"],
          { reference: "node:bookworm-slim", digest: `sha256:${"b".repeat(64)}` },
          "linux/arm64",
        ),
      ),
    ).resolves.toEqual({
      direct: ["bash"],
      runtime: [
        {
          name: "bash",
          version: "5.2",
          integrity: `sha256:${"a".repeat(64)}`,
          size: 123,
          url: "https://deb.debian.org/debian/pool/main/b/bash/bash.deb",
          direct: true,
        },
        {
          name: "libdep",
          version: "1.0",
          integrity: `sha256:${"c".repeat(64)}`,
          size: 45,
          url: "https://deb.debian.org/debian/pool/main/libd/libdep/libdep.deb",
          direct: false,
        },
      ],
    })
    await expect(readFile(log, "utf8")).resolves.toContain(`docker.io/library/node@sha256:${"b".repeat(64)}`)
  })

  it("rejects unsafe package names before running Docker", async () => {
    await expect(
      Effect.runPromise(
        resolveDebianPackages(
          ["bash;false"],
          { reference: "node:bookworm-slim", digest: `sha256:${"b".repeat(64)}` },
          "linux/arm64",
        ),
      ),
    ).rejects.toThrow(/package name is invalid/)
  })
})
