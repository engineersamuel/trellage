import { createHash } from "node:crypto"
import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises"
import path from "node:path"

import { Data, Effect } from "effect"

import type { Profile } from "./profile.js"

export interface RuntimeSupportPaths {
  readonly codexEntry: string
  readonly copilotEntry: string
  readonly headlongEntry?: string
  readonly piEntry?: string
  readonly primeEntry?: string
  readonly finalizeCopilotSeed: string
  readonly finalizeClaudeSeed?: string
  readonly claudeEntry?: string
  readonly claudeBrowserAgent?: string
  readonly claudeOutputStyleRundown?: string
  readonly copilotInstructionRundown?: string
}

export type RuntimeSupportOpener = (candidate: string, flags: "r") => Promise<FileHandle>

export interface RuntimeSupportFile {
  readonly role: string
  readonly destination: string
  readonly buildContextPath: string
  readonly mode: number
  /** Returns a defensive copy. Snapshot-owned bytes never escape this module. */
  readonly bytes: Buffer
}

export interface RuntimeSupportSnapshot {
  readonly harnessKind: Profile["harness"]["kind"]
  readonly hash: string
  readonly files: ReadonlyArray<RuntimeSupportFile>
}

export class RuntimeSupportError extends Data.TaggedError("RuntimeSupportError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

interface SelectedFile {
  readonly property: keyof RuntimeSupportPaths
  readonly role: string
  readonly destination: string
  readonly buildContextPath: string
  readonly mode: number
}

interface CapturedFile extends Omit<RuntimeSupportFile, "bytes"> {
  readonly bytes: Buffer
}

interface CapturedSnapshot {
  readonly files: ReadonlyArray<CapturedFile>
}

const capturedSnapshots = new WeakMap<RuntimeSupportSnapshot, CapturedSnapshot>()
type ClaudeRuntimeAdapter = "claude-marketplace" | "hyperresearch"

const selectedFiles = (
  harnessKind: Profile["harness"]["kind"],
  claudeAdapter?: ClaudeRuntimeAdapter,
  claudeMode: "core" | "hyperresearch" = "hyperresearch",
): ReadonlyArray<SelectedFile> => {
  switch (harnessKind) {
    case "codex":
      return [
        {
          property: "codexEntry",
          role: "runtime-entry",
          destination: "/usr/local/bin/trellage-codex-entry",
          buildContextPath: "runtime-entry.sh",
          mode: 0o755,
        },
      ]
    case "copilot":
      return [
        {
          property: "copilotEntry",
          role: "runtime-copilot-entry",
          destination: "/usr/local/bin/trellage-copilot-entry",
          buildContextPath: "runtime-copilot-entry.sh",
          mode: 0o755,
        },
        {
          property: "finalizeCopilotSeed",
          role: "finalize-copilot-seed",
          destination: "/src/finalize-copilot-seed.mjs",
          buildContextPath: "finalize-copilot-seed.mjs",
          mode: 0o644,
        },
        {
          property: "copilotInstructionRundown",
          role: "copilot-instruction-rundown",
          destination: "/usr/local/share/trellage/copilot-seed/instructions/rundown.instructions.md",
          buildContextPath: ".runtime-support/instruction-rundown.md",
          mode: 0o644,
        },
      ]
    case "headlong":
      return [
        {
          property: "headlongEntry",
          role: "runtime-headlong-entry",
          destination: "/usr/local/bin/runtime-headlong-entry",
          buildContextPath: "runtime-headlong-entry.sh",
          mode: 0o755,
        },
      ]
    case "claude":
      const entry: SelectedFile = {
        property: "claudeEntry",
        role: "runtime-claude-entry",
        destination: "/usr/local/bin/trellage-claude-entry",
        buildContextPath: "runtime-claude-entry.sh",
        mode: 0o755,
      }
      const outputStyle: SelectedFile = {
        property: "claudeOutputStyleRundown",
        role: "claude-output-style-rundown",
        destination: "/usr/local/share/trellage/claude-seed/output-styles/rundown.md",
        buildContextPath: ".runtime-support/output-style-rundown.md",
        mode: 0o644,
      }
      if (claudeMode === "core" && claudeAdapter === undefined) return [entry, outputStyle]
      return [
        entry,
        outputStyle,
        {
          property: "finalizeClaudeSeed",
          role: "finalize-claude-seed",
          destination: "/src/finalize-claude-seed.mjs",
          buildContextPath: "finalize-claude-seed.mjs",
          mode: 0o644,
        },
        ...(claudeAdapter === "claude-marketplace"
          ? []
          : [
              {
                property: "claudeBrowserAgent" as const,
                role: "claude-browser-agent",
                destination: "/usr/local/share/trellage/claude-seed/agents/hyperresearch-browser-fetcher.md",
                buildContextPath: ".runtime-support/hyperresearch-browser-fetcher.md",
                mode: 0o644,
              },
            ]),
      ]
    case "pi":
      return [
        {
          property: "piEntry",
          role: "runtime-pi-entry",
          destination: "/usr/local/bin/trellage-pi-entry",
          buildContextPath: "runtime-pi-entry.sh",
          mode: 0o755,
        },
      ]
    case "prime":
      return [
        {
          property: "primeEntry",
          role: "runtime-prime-entry",
          destination: "/usr/local/bin/trellage-prime-entry",
          buildContextPath: "runtime-prime-entry.sh",
          mode: 0o755,
        },
      ]
  }
}

const uint32 = (value: number): Buffer => {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

const uint64 = (value: number): Buffer => {
  const bytes = Buffer.allocUnsafe(8)
  bytes.writeBigUInt64BE(BigInt(value))
  return bytes
}

const framedText = (value: string): ReadonlyArray<Buffer> => {
  const bytes = Buffer.from(value, "utf8")
  return [uint32(bytes.length), bytes]
}

const harnessLabels: Readonly<Record<Profile["harness"]["kind"], string>> = {
  codex: "Codex",
  copilot: "Copilot",
  claude: "Claude",
  pi: "Pi",
  prime: "Prime",
  headlong: "Headlong",
}

const runtimeHash = (files: ReadonlyArray<CapturedFile>): string => {
  const hash = createHash("sha256")
  hash.update(Buffer.from("trellage-runtime-support", "utf8"))
  hash.update(uint32(1))
  hash.update(uint32(files.length))
  for (const file of files) {
    for (const frame of framedText(file.role)) hash.update(frame)
    for (const frame of framedText(file.destination)) hash.update(frame)
    hash.update(uint32(file.mode))
    hash.update(uint64(file.bytes.length))
    hash.update(file.bytes)
  }
  return `sha256:${hash.digest("hex")}`
}

export const createRuntimeSupportSnapshot = (
  harnessKind: Profile["harness"]["kind"],
  paths: RuntimeSupportPaths,
  selection: RuntimeSupportOpener | ClaudeRuntimeAdapter | undefined = open,
  claudeMode: "core" | "hyperresearch" = "hyperresearch",
): Effect.Effect<RuntimeSupportSnapshot, RuntimeSupportError> =>
  Effect.gen(function* () {
    const opener = typeof selection === "function" ? selection : open
    const claudeAdapter = typeof selection === "string" ? selection : undefined
    const label = harnessLabels[harnessKind]
    const files = yield* Effect.forEach(
      selectedFiles(harnessKind, claudeAdapter, claudeMode),
      (selected) => {
        const candidate = paths[selected.property]
        const message = `${label} runtime support ${selected.property} must be a regular readable file: ${candidate ?? "missing"}`
        return Effect.tryPromise({
          try: async () => {
            if (candidate === undefined) throw new Error(message)
            const handle = await opener(candidate, "r")
            try {
              if (!(await handle.stat()).isFile()) throw new Error(message)
              return {
                role: selected.role,
                destination: selected.destination,
                buildContextPath: selected.buildContextPath,
                mode: selected.mode,
                bytes: await handle.readFile(),
              }
            } finally {
              await handle.close()
            }
          },
          catch: (cause) => new RuntimeSupportError({ message, cause }),
        })
      },
      { concurrency: 1 },
    )
    const publicFiles = Object.freeze(
      files.map((file) =>
        Object.freeze({
          role: file.role,
          destination: file.destination,
          buildContextPath: file.buildContextPath,
          mode: file.mode,
          get bytes(): Buffer {
            return Buffer.from(file.bytes)
          },
        }),
      ),
    )
    const snapshot = Object.freeze({ harnessKind, files: publicFiles, hash: runtimeHash(files) })
    capturedSnapshots.set(snapshot, { files })
    return snapshot
  })

export const isRuntimeSupportSnapshot = (candidate: unknown): candidate is RuntimeSupportSnapshot =>
  typeof candidate === "object" && candidate !== null && capturedSnapshots.has(candidate as RuntimeSupportSnapshot)

const capturedSnapshot = (snapshot: RuntimeSupportSnapshot): CapturedSnapshot => {
  const captured = capturedSnapshots.get(snapshot)
  if (captured === undefined) throw new RuntimeSupportError({ message: "runtime support snapshot is not trusted" })
  return captured
}

export const writeRuntimeSupportSnapshot = (
  snapshot: RuntimeSupportSnapshot,
  context: string,
): Effect.Effect<void, RuntimeSupportError> =>
  Effect.tryPromise({
    try: async () => {
      for (const file of capturedSnapshot(snapshot).files) {
        const destination = path.join(context, file.buildContextPath)
        await mkdir(path.dirname(destination), { recursive: true })
        await writeFile(destination, file.bytes, { mode: file.mode })
      }
    },
    catch: (cause) =>
      cause instanceof RuntimeSupportError
        ? cause
        : new RuntimeSupportError({ message: "cannot write captured runtime support", cause }),
  })

export const runtimeSupportFile = (snapshot: RuntimeSupportSnapshot, role: string): RuntimeSupportFile => {
  capturedSnapshot(snapshot)
  const file = snapshot.files.find((candidate) => candidate.role === role)
  if (file === undefined) throw new RuntimeSupportError({ message: `runtime support snapshot is missing ${role}` })
  return file
}
