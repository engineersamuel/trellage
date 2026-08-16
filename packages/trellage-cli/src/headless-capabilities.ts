import { Data, Effect, ParseResult, Schema } from "effect"

import type { Profile } from "./profile.js"

const NonEmpty = Schema.String.pipe(Schema.minLength(1))

const HeadlessOutputFormatSchema = Schema.Literal("text", "json", "jsonl")
const HeadlessEventContractSchema = Schema.Union(Schema.Null, NonEmpty)
const TrellageHeadlessEventContractSchema = Schema.Union(Schema.Null, Schema.Literal("trellage-headless-v1"))
const HeadlessSessionIdSchema = Schema.Literal("native", "trellage", "none")
const HeadlessQuestionToolControlSchema = Schema.Literal("hard-deny", "prompt-only", "none")
const HeadlessChangedFilesSchema = Schema.Literal("native", "git-diff", "none")

export const HeadlessCapabilitiesV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  prompt: Schema.Boolean,
  outputFormats: Schema.Array(HeadlessOutputFormatSchema),
  eventContract: HeadlessEventContractSchema,
  trellageEventContract: TrellageHeadlessEventContractSchema,
  sessionId: HeadlessSessionIdSchema,
  resume: Schema.Boolean,
  resumeWithPrompt: Schema.Boolean,
  questionToolControl: HeadlessQuestionToolControlSchema,
  changedFiles: HeadlessChangedFilesSchema,
  usage: Schema.Boolean,
  cost: Schema.Boolean,
  modelOverride: Schema.Boolean,
  effortOverride: Schema.Boolean,
  testedHarnessVersion: Schema.Union(Schema.Null, NonEmpty),
})

export type HeadlessCapabilitiesV1 = Schema.Schema.Type<typeof HeadlessCapabilitiesV1Schema>

export class HeadlessCapabilitiesError extends Data.TaggedError("HeadlessCapabilitiesError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const freezeHeadlessCapabilitiesV1 = (capabilities: HeadlessCapabilitiesV1): HeadlessCapabilitiesV1 =>
  Object.freeze({
    ...capabilities,
    outputFormats: Object.freeze([...capabilities.outputFormats]),
  })

export const decodeHeadlessCapabilitiesV1 = (
  value: unknown,
): Effect.Effect<HeadlessCapabilitiesV1, HeadlessCapabilitiesError> =>
  Schema.decodeUnknown(HeadlessCapabilitiesV1Schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new HeadlessCapabilitiesError({
          message: ParseResult.TreeFormatter.formatErrorSync(cause),
          cause,
        }),
    ),
    Effect.flatMap((decoded) =>
      new Set(decoded.outputFormats).size === decoded.outputFormats.length
        ? Effect.succeed(decoded)
        : Effect.fail(new HeadlessCapabilitiesError({ message: "headless outputFormats must be unique" })),
    ),
  )

const checkedHeadlessCapabilitiesV1 = (value: HeadlessCapabilitiesV1): HeadlessCapabilitiesV1 =>
  freezeHeadlessCapabilitiesV1(Effect.runSync(decodeHeadlessCapabilitiesV1(value)))

export const conservativeHeadlessCapabilitiesV1 = checkedHeadlessCapabilitiesV1({
  schemaVersion: 1,
  prompt: false,
  outputFormats: ["text"],
  eventContract: null,
  trellageEventContract: null,
  sessionId: "none",
  resume: false,
  resumeWithPrompt: false,
  questionToolControl: "none",
  changedFiles: "none",
  usage: false,
  cost: false,
  modelOverride: false,
  effortOverride: false,
  testedHarnessVersion: null,
})

export type SandboxHeadlessRuntimeAdapter =
  | "codex"
  | "copilot"
  | "claude-core"
  | "claude-marketplace"
  | "claude-hyperresearch"
  | "pi"
  | "prime"

const verifiedClaudeHarnessVersion = "2.1.229"
const verifiedClaudeHeadlessCapabilities = {
  schemaVersion: 1 as const,
  prompt: true,
  outputFormats: ["text", "jsonl"] as const,
  eventContract: "claude-stream-json-v1" as const,
  trellageEventContract: "trellage-headless-v1" as const,
  sessionId: "native" as const,
  resume: true,
  resumeWithPrompt: true,
  questionToolControl: "hard-deny" as const,
  changedFiles: "git-diff" as const,
  usage: true,
  cost: true,
  effortOverride: false,
  testedHarnessVersion: verifiedClaudeHarnessVersion,
}

export const sandboxHeadlessCapabilityDeclarations = {
  codex: conservativeHeadlessCapabilitiesV1,
  copilot: conservativeHeadlessCapabilitiesV1,
  "claude-core": checkedHeadlessCapabilitiesV1({
    ...verifiedClaudeHeadlessCapabilities,
    modelOverride: false,
  }),
  "claude-marketplace": checkedHeadlessCapabilitiesV1({
    ...verifiedClaudeHeadlessCapabilities,
    modelOverride: true,
  }),
  "claude-hyperresearch": checkedHeadlessCapabilitiesV1({
    ...verifiedClaudeHeadlessCapabilities,
    modelOverride: true,
  }),
  pi: conservativeHeadlessCapabilitiesV1,
  prime: conservativeHeadlessCapabilitiesV1,
} as const satisfies Readonly<Record<SandboxHeadlessRuntimeAdapter, HeadlessCapabilitiesV1>>

const conservativeSandboxHeadlessCapabilities = Object.fromEntries(
  Object.entries(sandboxHeadlessCapabilityDeclarations).map(([adapter, capabilities]) => [
    adapter,
    checkedHeadlessCapabilitiesV1({
      ...conservativeHeadlessCapabilitiesV1,
      testedHarnessVersion: capabilities.testedHarnessVersion,
    }),
  ]),
) as Readonly<Record<SandboxHeadlessRuntimeAdapter, HeadlessCapabilitiesV1>>

export const sandboxHeadlessRuntimeAdapter = (profile: Profile): SandboxHeadlessRuntimeAdapter => {
  if (profile.harness.kind === "claude") {
    if (profile.plugins.some(({ adapter }) => adapter === "hyperresearch")) return "claude-hyperresearch"
    if (profile.plugins.some(({ adapter }) => adapter === "claude-marketplace")) return "claude-marketplace"
    return (profile.harness.claude.mode ?? "hyperresearch") === "core" ? "claude-core" : "claude-hyperresearch"
  }
  return profile.harness.kind
}

export const resolveSandboxHeadlessCapabilities = (
  adapter: SandboxHeadlessRuntimeAdapter,
  resolvedHarnessVersion: string | null,
): HeadlessCapabilitiesV1 =>
  resolvedHarnessVersion === sandboxHeadlessCapabilityDeclarations[adapter].testedHarnessVersion
    ? sandboxHeadlessCapabilityDeclarations[adapter]
    : conservativeSandboxHeadlessCapabilities[adapter]
