import { chmod, mkdtemp, mkdir, open, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import {
  createRuntimeSupportSnapshot,
  type RuntimeSupportPaths,
  type RuntimeSupportSnapshot,
  writeRuntimeSupportSnapshot,
} from "../src/runtime-support.js"

const temporaryRoots = new Set<string>()

const cleanupTemporaryRoots = async (): Promise<void> => {
  const roots = [...temporaryRoots]
  temporaryRoots.clear()
  const results = await Promise.allSettled(roots.map((root) => rm(root, { recursive: true, force: true })))
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failure !== undefined) throw failure.reason
}

afterEach(cleanupTemporaryRoots)

const fixtures = async (): Promise<{ readonly root: string; readonly paths: RuntimeSupportPaths }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-runtime-support-"))
  temporaryRoots.add(root)
  const paths = {
    codexEntry: path.join(root, "runtime-entry.sh"),
    copilotEntry: path.join(root, "runtime-copilot-entry.sh"),
    piEntry: path.join(root, "runtime-pi-entry.sh"),
    finalizeCopilotSeed: path.join(root, "finalize-copilot-seed.mjs"),
    claudeEntry: path.join(root, "runtime-claude-entry.sh"),
    hyperresearchRequirements: path.join(root, "hyperresearch-requirements.lock"),
    claudeBrowserAgent: path.join(root, "hyperresearch-browser-fetcher.md"),
  }
  await Promise.all([
    writeFile(paths.codexEntry, "codex-entry\n"),
    writeFile(paths.copilotEntry, "copilot-entry\n"),
    writeFile(paths.piEntry, "pi-entry\n"),
    writeFile(paths.finalizeCopilotSeed, "copilot-finalizer\n"),
    writeFile(paths.claudeEntry, "claude-entry\n"),
    writeFile(paths.hyperresearchRequirements, "requirements\n"),
    writeFile(paths.claudeBrowserAgent, "browser-agent\n"),
  ])
  return { root, paths }
}

describe("runtime support snapshots", () => {
  it("captures only the selected harness files with a stable framed digest", async () => {
    const { paths } = await fixtures()

    const codex = await Effect.runPromise(createRuntimeSupportSnapshot("codex", paths))
    const copilot = await Effect.runPromise(createRuntimeSupportSnapshot("copilot", paths))
    const claude = await Effect.runPromise(createRuntimeSupportSnapshot("claude", paths))
    const pi = await Effect.runPromise(createRuntimeSupportSnapshot("pi", paths))

    expect(codex.files.map((file) => file.role)).toEqual(["runtime-entry"])
    expect(copilot.files.map((file) => file.role)).toEqual(["runtime-copilot-entry", "finalize-copilot-seed"])
    expect(claude.files.map((file) => file.role)).toEqual([
      "runtime-claude-entry",
      "hyperresearch-requirements",
      "claude-browser-agent",
    ])
    expect(pi.files.map((file) => file.role)).toEqual(["runtime-pi-entry"])
    expect(claude.files[1]?.destination).toBe("/src/.runtime-support/hyperresearch-requirements.lock")
    expect(codex.hash).toBe("sha256:ef6c9fce95dcc3ccd9eaeb94b9611f332d30e539e8570cc99b4d0dd07c652b64")
    expect((await Effect.runPromise(createRuntimeSupportSnapshot("codex", paths))).hash).toBe(codex.hash)

    const original = codex.hash
    await writeFile(paths.copilotEntry, "changed but irrelevant\n")
    expect((await Effect.runPromise(createRuntimeSupportSnapshot("codex", paths))).hash).toBe(original)
    await writeFile(paths.codexEntry, "changed and relevant\n")
    expect((await Effect.runPromise(createRuntimeSupportSnapshot("codex", paths))).hash).not.toBe(original)
  })

  it("keeps captured bytes immutable after source mutation", async () => {
    const { paths } = await fixtures()
    const snapshot = await Effect.runPromise(createRuntimeSupportSnapshot("codex", paths))

    await writeFile(paths.codexEntry, "mutated after capture\n")

    expect(snapshot.files[0]?.bytes.toString("utf8")).toBe("codex-entry\n")
    expect(await readFile(paths.codexEntry, "utf8")).toBe("mutated after capture\n")
  })

  it("opens each selected path once and reads that same file handle", async () => {
    const { root, paths } = await fixtures()
    const first = path.join(root, "runtime-first.sh")
    const replacement = path.join(root, "runtime-replacement.sh")
    const selected = path.join(root, "runtime-selected.sh")
    await writeFile(first, "first inode\n")
    await writeFile(replacement, "replacement inode\n")
    await symlink(first, selected)
    let swapped = false

    const snapshot = await Effect.runPromise(
      createRuntimeSupportSnapshot("codex", { ...paths, codexEntry: selected }, async (candidate, flags) => {
        const handle = await open(candidate, flags)
        await unlink(selected)
        await symlink(replacement, selected)
        swapped = true
        return handle
      }),
    )

    expect(swapped).toBe(true)
    expect(snapshot.files[0]?.bytes.toString("utf8")).toBe("first inode\n")
  })

  it("does not expose mutable bytes or metadata used for hashing and baking", async () => {
    const { root, paths } = await fixtures()
    const snapshot = await Effect.runPromise(createRuntimeSupportSnapshot("codex", paths))
    const originalHash = snapshot.hash
    snapshot.files[0]!.bytes.fill(0x78)
    expect(() => {
      ;(snapshot.files[0] as { role: string }).role = "forged-role"
    }).toThrow(/read only|Cannot assign/)
    expect(() => {
      ;(snapshot.files as Array<unknown>).push({})
    }).toThrow(/not extensible/)
    expect(() => {
      ;(snapshot as { hash: string }).hash = `sha256:${"0".repeat(64)}`
    }).toThrow(/read only|Cannot assign/)

    const context = path.join(root, "captured-context")
    await Effect.runPromise(writeRuntimeSupportSnapshot(snapshot, context))

    expect(snapshot.hash).toBe(originalHash)
    await expect(readFile(path.join(context, "runtime-entry.sh"), "utf8")).resolves.toBe("codex-entry\n")
    await expect(
      Effect.runPromise(
        writeRuntimeSupportSnapshot(
          { harnessKind: "codex", hash: originalHash, files: snapshot.files } as RuntimeSupportSnapshot,
          path.join(root, "forged-context"),
        ),
      ),
    ).rejects.toThrow(/snapshot is not trusted/)
  })

  it("changes each harness hash for every selected file mutation", async () => {
    const cases = [
      ["codex", ["codexEntry"]],
      ["copilot", ["copilotEntry", "finalizeCopilotSeed"]],
      ["claude", ["claudeEntry", "hyperresearchRequirements", "claudeBrowserAgent"]],
      ["pi", ["piEntry"]],
    ] as const
    for (const [kind, properties] of cases) {
      for (const property of properties) {
        const { paths } = await fixtures()
        const original = await Effect.runPromise(createRuntimeSupportSnapshot(kind, paths))
        await writeFile(paths[property]!, `mutated ${property}\n`)
        const changed = await Effect.runPromise(createRuntimeSupportSnapshot(kind, paths))
        expect(changed.hash, `${kind}.${property}`).not.toBe(original.hash)
      }
    }
  })

  it("uses length-delimited framing rather than ambiguous byte concatenation", async () => {
    const { paths } = await fixtures()
    await writeFile(paths.copilotEntry, "ab")
    await writeFile(paths.finalizeCopilotSeed, "c")
    const left = await Effect.runPromise(createRuntimeSupportSnapshot("copilot", paths))
    await writeFile(paths.copilotEntry, "a")
    await writeFile(paths.finalizeCopilotSeed, "bc")
    const right = await Effect.runPromise(createRuntimeSupportSnapshot("copilot", paths))

    expect(Buffer.concat(left.files.map((file) => file.bytes))).toEqual(
      Buffer.concat(right.files.map((file) => file.bytes)),
    )
    expect(left.hash).not.toBe(right.hash)
  })

  it("rejects missing, directory, and unreadable selected inputs", async () => {
    const { root, paths } = await fixtures()
    await expect(
      Effect.runPromise(createRuntimeSupportSnapshot("codex", { ...paths, codexEntry: path.join(root, "missing") })),
    ).rejects.toThrow(/regular readable file.*missing/)

    const directory = path.join(root, "directory")
    await mkdir(directory)
    await expect(
      Effect.runPromise(createRuntimeSupportSnapshot("codex", { ...paths, codexEntry: directory })),
    ).rejects.toThrow(/regular readable file.*directory/)

    await chmod(paths.codexEntry, 0o000)
    try {
      await expect(Effect.runPromise(createRuntimeSupportSnapshot("codex", paths))).rejects.toThrow(
        /regular readable file.*runtime-entry/,
      )
    } finally {
      await chmod(paths.codexEntry, 0o600)
    }
  })

  it("removes every tracked fixture root during cleanup", async () => {
    const { root } = await fixtures()

    await cleanupTemporaryRoots()

    await expect(readFile(path.join(root, "runtime-entry.sh"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
