import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { writeReleaseLock } from "../src/application.ts"
import { renderLock } from "../src/lock-file.ts"
import { profileHash, withAttachedSidecar, type ProfileLock } from "../src/lock.ts"
import { platformLockPath } from "../src/platform.ts"
import { parseProfile, type ProfileDocument } from "../src/profile.ts"
import { resolutionReceiptPath, writeResolutionReceipt } from "../src/resolution-receipt.ts"
import { resolutionSidecarPath } from "../src/resolution-sidecar-storage.ts"
import {
  createPythonConstraintsSidecar,
  renderResolutionSidecar,
  resolutionSidecarReference,
} from "../src/resolution-sidecar.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const writers: ReadonlyArray<{
  readonly name: string
  readonly destination: (document: ProfileDocument, root: string) => string
  readonly write: (document: ProfileDocument, root: string, lock: ProfileLock) => Effect.Effect<void, unknown>
}> = [
  {
    name: "release lock",
    destination: (document: ProfileDocument, _root: string) => platformLockPath(document.path, "linux/arm64"),
    write: (document: ProfileDocument, _root: string, lock: ProfileLock) => writeReleaseLock(document.path, lock),
  },
  {
    name: "development receipt",
    destination: (document: ProfileDocument, root: string) => resolutionReceiptPath(document, "linux/arm64", root),
    write: (document: ProfileDocument, root: string, lock: ProfileLock) => writeResolutionReceipt(document, root, lock),
  },
]

const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-sidecar-publication-"))
  roots.push(root)
  const document = await Effect.runPromise(
    parseProfile(
      `schema = 1
name = "sidecar-publication"
description = "Sidecar publication contract"
[harness]
kind = "codex"
version = "latest"
[harness.codex]
model = "gpt-5.6-sol"
reasoning_effort = "medium"
model_provider = "proxy"
[harness.codex.providers.proxy]
base_url = "http://proxy:8080/v1"
wire_api = "responses"
[image]
base = "node:bookworm-slim"
shell = "bash"
packages = ["bash"]
`,
      path.join(root, "profile.toml"),
    ),
  )
  const lock: ProfileLock = {
    schema: 1,
    platform: "linux/arm64",
    source_date_epoch: 1784379906,
    profile_hash: profileHash(document),
    sources: [],
    packages: {
      harness: {
        kind: "codex",
        selector: "latest",
        version: "0.146.1",
        integrity: `sha256:${"a".repeat(64)}`,
        url: "https://example.test/codex.tar.gz",
        size: 1,
      },
      runtime: [],
    },
    image: { base: "node:bookworm-slim", base_digest: `sha256:${"b".repeat(64)}` },
  }
  const sidecar = createPythonConstraintsSidecar(lock.profile_hash, lock.platform, "example==1.0.0\n")
  const reference = resolutionSidecarReference(sidecar)
  return { root, document, lock, sidecar, reference }
}

describe.each(writers)("$name sidecar publication", ({ destination, write }) => {
  it("publishes exact bytes and reuses identical content-addressed sidecars", async () => {
    const { root, document, lock, sidecar, reference } = await fixture()
    const resolved = withAttachedSidecar({ ...lock, sidecar: reference }, sidecar)
    const lockPath = destination(document, root)
    const sidecarPath = resolutionSidecarPath(lockPath, reference)

    await Effect.runPromise(write(document, root, resolved))
    await Effect.runPromise(write(document, root, resolved))

    await expect(readFile(lockPath, "utf8")).resolves.toBe(renderLock(resolved))
    await expect(readFile(sidecarPath, "utf8")).resolves.toBe(renderResolutionSidecar(sidecar))
    await expect(readdir(`${lockPath}.d`)).resolves.toEqual([path.basename(sidecarPath)])
  })

  it.each(["missing", "integrity", "size"] as const)(
    "preserves the previous lock when the attached sidecar reference has a %s mismatch",
    async (mode) => {
      const { root, document, lock, sidecar, reference } = await fixture()
      await Effect.runPromise(write(document, root, lock))
      const sidecarReference =
        mode === "missing"
          ? undefined
          : mode === "integrity"
            ? { ...reference, integrity: `sha256:${"f".repeat(64)}` }
            : { ...reference, size: reference.size + 1 }
      const mismatched = withAttachedSidecar(
        { ...lock, ...(sidecarReference === undefined ? {} : { sidecar: sidecarReference }) },
        sidecar,
      )

      await expect(Effect.runPromise(write(document, root, mismatched))).rejects.toThrow(
        "resolution sidecar reference mismatch",
      )
      await expect(readFile(destination(document, root), "utf8")).resolves.toBe(renderLock(lock))
    },
  )

  it("refuses a sidecar collision without replacing the lock or leaving temporary files", async () => {
    const { root, document, lock, sidecar, reference } = await fixture()
    const resolved = withAttachedSidecar({ ...lock, sidecar: reference }, sidecar)
    await Effect.runPromise(write(document, root, resolved))
    const lockPath = destination(document, root)
    const sidecarPath = resolutionSidecarPath(lockPath, reference)
    await writeFile(sidecarPath, "corrupt bytes")
    const replacement = withAttachedSidecar({ ...resolved, source_date_epoch: resolved.source_date_epoch + 1 }, sidecar)

    await expect(Effect.runPromise(write(document, root, replacement))).rejects.toThrow(
      "cannot publish resolution sidecar",
    )
    await expect(readFile(lockPath, "utf8")).resolves.toBe(renderLock(resolved))
    await expect(readFile(sidecarPath, "utf8")).resolves.toBe("corrupt bytes")
    await expect(readdir(`${lockPath}.d`)).resolves.toEqual([path.basename(sidecarPath)])
  })

  it("leaves unattached sidecar references alone", async () => {
    const { root, document, lock, reference } = await fixture()
    const detached = { ...lock, sidecar: reference }

    await Effect.runPromise(write(document, root, detached))

    const lockPath = destination(document, root)
    await expect(readFile(lockPath, "utf8")).resolves.toBe(renderLock(detached))
    await expect(readdir(`${lockPath}.d`)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
