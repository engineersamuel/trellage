// Manual test guide of one sub-coordinator's change: setup commands, steps a human does, cleanup.
// Pure: no DOM, no fs. The coordinator writes it (coordinator/src/testGuide.ts); the header pin shows it.
import { Schema } from "effect"

const Step = Schema.Struct({
  do: Schema.NonEmptyString,
  command: Schema.optional(Schema.String),
  expect: Schema.NonEmptyString,
})
const Body = Schema.Struct({
  setup: Schema.Array(Schema.String),
  steps: Schema.NonEmptyArray(Step),
  cleanup: Schema.Array(Schema.String),
})
export type TestStep = typeof Step.Type

/** GET /api/threads/<id>/test-guide: the newest guide, `stale` when the worktree HEAD moved past its commit. */
export const TestGuideView = Schema.NullOr(
  Schema.Struct({
    status: Schema.Literals(["writing", "ready", "failed"]),
    commit: Schema.String,
    setup: Schema.Array(Schema.String),
    steps: Schema.Array(Step),
    cleanup: Schema.Array(Schema.String),
    error: Schema.optional(Schema.String),
    stale: Schema.Boolean,
  }),
)

export type TestGuide = {
  id: string
  scopeId: string
  threadId: string | null
  workdir: string
  status: "writing" | "ready" | "failed"
  /** Worktree HEAD the guide was written for. */
  commit: string
  setup: readonly string[]
  steps: readonly TestStep[]
  cleanup: readonly string[]
  error?: string
  at: number
}

/** The writer's reply (JSON, maybe in a ```json fence). Throws an Error that says why. */
export const decodeGuide = (reply: string): typeof Body.Type => {
  const body = reply.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/)?.[1] ?? reply
  let v: unknown
  try {
    v = JSON.parse(body)
  } catch (e) {
    throw new Error(`test guide reply is not JSON: ${(e as Error).message}`, { cause: e })
  }
  try {
    return Schema.decodeUnknownSync(Body)(v)
  } catch (e) {
    throw new Error(`test guide reply has the wrong shape: ${(e as Error).message}`, { cause: e })
  }
}

const block = (lines: readonly string[]) => "```sh\n" + lines.join("\n") + "\n```"

export const guideMarkdown = (g: Pick<TestGuide, "setup" | "steps" | "cleanup" | "commit">): string =>
  [
    `For commit \`${g.commit.slice(0, 7)}\`.`,
    ...(g.setup.length ? ["**Setup**", block(g.setup)] : []),
    "**Steps**",
    g.steps
      .map(
        (s, i) => `${i + 1}. ${s.do}${s.command ? `\n   \`${s.command.replaceAll("`", "'")}\`` : ""}\n   → ${s.expect}`,
      )
      .join("\n"),
    ...(g.cleanup.length ? ["**Cleanup**", block(g.cleanup)] : []),
  ].join("\n\n")

/** The setup commands as a bash script: stop at the first failure and echo each command. */
export const setupScript = (setup: readonly string[]): string =>
  ["#!/usr/bin/env bash", "set -ex", ...setup, ""].join("\n")
