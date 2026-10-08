import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { resolveDebianPackages } from "../src/debian-packages.ts"

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

  it("records upgrades of packages already installed in the base image", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-debian-upgrade-resolution-"))
    const bin = path.join(root, "bin")
    await mkdir(bin)
    await writeFile(
      path.join(bin, "docker"),
      `#!/bin/sh
set -eu
while [ "$1" != sh ]; do shift; done
exec "$@"
`,
    )
    await writeFile(
      path.join(bin, "apt-get"),
      `#!/bin/sh
set -eu
case "$*" in
  update) exit 0 ;;
  "--simulate --no-install-recommends install git")
    printf '%s\\n' \
      'Inst perl-base [5.36.0-7+deb12u3] (5.36.0-7+deb12u4 Debian-Security:12/oldstable-security [arm64])' \
      'Inst perl (5.36.0-7+deb12u4 Debian-Security:12/oldstable-security [arm64])' \
      'Inst git (1:2.39.5-0+deb12u3 Debian:12.15/oldstable [arm64])'
    ;;
  "--print-uris download "*)
    package="\${3%%=*}"
    printf "'https://deb.debian.org/debian/pool/main/%s/%s.deb'\\n" "$package" "$package"
    ;;
esac
`,
    )
    await writeFile(
      path.join(bin, "apt-cache"),
      `#!/bin/sh
set -eu
package="\${3%%=*}"
case "$package" in
  git) sha='${"d".repeat(64)}'; size=789 ;;
  perl-base) sha='${"a".repeat(64)}'; size=123 ;;
  perl) sha='${"c".repeat(64)}'; size=456 ;;
  *) exit 1 ;;
esac
printf 'SHA256: %s\\nSize: %s\\n' "$sha" "$size"
`,
    )
    await writeFile(
      path.join(bin, "dpkg-query"),
      `#!/bin/sh
exit 1
`,
    )
    await Promise.all(
      ["docker", "apt-get", "apt-cache", "dpkg-query"].map((name) => chmod(path.join(bin, name), 0o755)),
    )
    process.env.PATH = `${bin}:${originalPath ?? ""}`

    await expect(
      Effect.runPromise(
        resolveDebianPackages(
          ["git"],
          { reference: "node:bookworm-slim", digest: `sha256:${"b".repeat(64)}` },
          "linux/arm64",
        ),
      ),
    ).resolves.toEqual({
      direct: ["git"],
      runtime: [
        {
          name: "git",
          version: "1:2.39.5-0+deb12u3",
          integrity: `sha256:${"d".repeat(64)}`,
          size: 789,
          url: "https://deb.debian.org/debian/pool/main/git/git.deb",
          direct: true,
        },
        {
          name: "perl",
          version: "5.36.0-7+deb12u4",
          integrity: `sha256:${"c".repeat(64)}`,
          size: 456,
          url: "https://deb.debian.org/debian/pool/main/perl/perl.deb",
          direct: false,
        },
        {
          name: "perl-base",
          version: "5.36.0-7+deb12u4",
          integrity: `sha256:${"a".repeat(64)}`,
          size: 123,
          url: "https://deb.debian.org/debian/pool/main/perl-base/perl-base.deb",
          direct: false,
        },
      ],
    })
  })
})
