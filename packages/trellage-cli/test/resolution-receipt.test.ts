import { access, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { renderLock } from "../src/lock-file.js"
import { attachedSidecar, profileHash, withAttachedSidecar, type ProfileLock } from "../src/lock.js"
import { platformLockPath } from "../src/platform.js"
import { parseProfile } from "../src/profile.js"
import {
  loadResolutionReceipt,
  resolutionReceiptPath,
  resolutionReceiptTransferBundle,
  writeResolutionReceipt,
} from "../src/resolution-receipt.js"
import {
  createPythonConstraintsSidecar,
  pythonConstraints,
  resolutionSidecarReference,
} from "../src/resolution-sidecar.js"
import { resolutionSidecarPath, writeResolutionSidecar } from "../src/resolution-sidecar-storage.js"

const source = (description: string) => `
schema = 1
name = "receipt-test"
description = "${description}"
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
`

const lock = (hash: string): ProfileLock => ({
  schema: 1,
  platform: "linux/arm64",
  source_date_epoch: 1784379906,
  profile_hash: hash,
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
    runtime: [{ name: "bash", version: "1", integrity: `sha256:${"b".repeat(64)}` }],
  },
  build: {
    builder: { reference: "docker.io/jdxcode/mise:latest", digest: `sha256:${"d".repeat(64)}` },
    importer: { reference: "quay.io/skopeo/stable:latest", digest: `sha256:${"e".repeat(64)}` },
  },
  image: { base: "node:bookworm-slim", base_digest: `sha256:${"c".repeat(64)}` },
})

describe("development resolution receipts", () => {
  it("stores exact lock data under XDG cache without creating an adjacent release lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-resolution-receipt-"))
    const profilePath = path.join(root, "profile.toml")
    const profileSource = source("Receipt test")
    await writeFile(profilePath, profileSource)
    const document = await Effect.runPromise(parseProfile(profileSource, profilePath))
    const resolved = lock(profileHash(document))

    await Effect.runPromise(writeResolutionReceipt(document, root, resolved))

    const receiptPath = resolutionReceiptPath(document, "linux/arm64", root)
    expect(receiptPath).toContain(path.join(root, "trellage", "resolutions", "v1", "receipt-test"))
    await expect(readFile(receiptPath, "utf8")).resolves.toBe(renderLock(resolved))
    await expect(Effect.runPromise(loadResolutionReceipt(document, "linux/arm64", root))).resolves.toMatchObject({
      profile_hash: resolved.profile_hash,
      build: {
        builder: { digest: `sha256:${"d".repeat(64)}` },
        importer: { digest: `sha256:${"e".repeat(64)}` },
      },
      packages: { harness: { version: "0.146.1" } },
    })
    await expect(access(platformLockPath(profilePath, "linux/arm64"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keys receipts by profile content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-resolution-receipt-key-"))
    const profilePath = path.join(root, "profile.toml")
    const first = await Effect.runPromise(parseProfile(source("First"), profilePath))
    const second = await Effect.runPromise(parseProfile(source("Second"), profilePath))

    expect(resolutionReceiptPath(first, "linux/arm64", root)).not.toBe(
      resolutionReceiptPath(second, "linux/arm64", root),
    )
  })

  it("publishes and verifies generated constraints before the receipt lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-resolution-sidecar-"))
    const profilePath = path.join(root, "profile.toml")
    const profileSource = source("Sidecar test")
    await writeFile(profilePath, profileSource)
    const document = await Effect.runPromise(parseProfile(profileSource, profilePath))
    const constraints = `example==1.0.0 \\\n    --hash=sha256:${"f".repeat(64)}\n`
    const sidecar = createPythonConstraintsSidecar(profileHash(document), "linux/arm64", constraints)
    const resolved = withAttachedSidecar(
      { ...lock(profileHash(document)), sidecar: resolutionSidecarReference(sidecar) },
      sidecar,
    )

    await Effect.runPromise(writeResolutionReceipt(document, root, resolved))

    const receiptPath = resolutionReceiptPath(document, "linux/arm64", root)
    await expect(readFile(resolutionSidecarPath(receiptPath, resolved.sidecar!), "utf8")).resolves.toContain(
      "python-constraints",
    )
    const reloaded = await Effect.runPromise(loadResolutionReceipt(document, "linux/arm64", root))
    expect(pythonConstraints(attachedSidecar(reloaded!))).toBe(constraints)
    expect(resolutionReceiptTransferBundle(document, reloaded!, root)).toEqual({
      schema_version: 1,
      cache_relative_directory: path.relative(root, path.dirname(receiptPath)),
      files: [
        {
          source: receiptPath,
          relative: path.basename(receiptPath),
        },
        {
          source: resolutionSidecarPath(receiptPath, resolved.sidecar!),
          relative: path.relative(path.dirname(receiptPath), resolutionSidecarPath(receiptPath, resolved.sidecar!)),
        },
      ],
    })
  })

  it("does not adopt a staged sidecar until the receipt lock changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-resolution-sidecar-staged-"))
    const profilePath = path.join(root, "profile.toml")
    const profileSource = source("Sidecar staging test")
    await writeFile(profilePath, profileSource)
    const document = await Effect.runPromise(parseProfile(profileSource, profilePath))
    const oldConstraints = `old==1.0.0 \\\n    --hash=sha256:${"a".repeat(64)}\n`
    const oldSidecar = createPythonConstraintsSidecar(profileHash(document), "linux/arm64", oldConstraints)
    const resolved = withAttachedSidecar(
      { ...lock(profileHash(document)), sidecar: resolutionSidecarReference(oldSidecar) },
      oldSidecar,
    )
    await Effect.runPromise(writeResolutionReceipt(document, root, resolved))
    const receiptPath = resolutionReceiptPath(document, "linux/arm64", root)
    const candidate = createPythonConstraintsSidecar(
      profileHash(document),
      "linux/arm64",
      `new==2.0.0 \\\n    --hash=sha256:${"b".repeat(64)}\n`,
    )

    await Effect.runPromise(writeResolutionSidecar(receiptPath, candidate))

    const reloaded = await Effect.runPromise(loadResolutionReceipt(document, "linux/arm64", root))
    expect(pythonConstraints(attachedSidecar(reloaded!))).toBe(oldConstraints)
  })
})
