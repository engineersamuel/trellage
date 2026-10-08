import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CopilotReviewProvider, type ReviewClientFactory } from "../src/copilot-review-provider.ts"
import { optimizeDigest } from "../src/guide-optimize-evidence.ts"
import { reviewCatalog } from "../src/review-catalog.ts"
import type { ReviewSlice } from "../src/review-snapshot.ts"
import { fixtureOptimizeModelInfo } from "./fixtures/guide-optimize-model.ts"

const roots: string[] = []
const readRanges = async (
  read: (args: Record<string, unknown>, sessionId: string) => Promise<unknown>,
  ranges: ReadonlyArray<ReviewSlice>,
  sessionId: string,
) => {
  for (const range of ranges)
    for (let offset = range.start; offset < range.end; offset += 16000)
      await read({ source: range.source, offset, length: Math.min(16000, range.end - offset) }, sessionId)
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe("real skill adapter with frozen batches (offline SDK)", () => {
  it.each(["complete", "unread", "missing-metadata", "cancelled", "worker-budgets", "cleanup-failed"] as const)(
    "keeps coverage and cross-file completion honest: %s",
    async (mode) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "review-batches-"))
      roots.push(root)
      const work = path.join(root, "work")
      await mkdir(work, { mode: 0o700 })
      const controller = new AbortController()
      const content = "+const value = 1\n".repeat(6000)
      const evidence = {
        sources: [{ id: "@diff/net", content }],
        excluded: [],
        fingerprint: optimizeDigest(content),
      }
      let leaves = 0
      let crossFile = 0
      const crossFilePrompts: string[] = []
      let workerReads = 0
      let allReads = ""
      const factory: ReviewClientFactory = () => ({
        start: async () => {},
        forceStop: async () => {
          if (mode === "cleanup-failed" && leaves > 0) throw new Error("Batch cleanup failed.")
        },
        deleteSession: async () => {},
        listModels: async () =>
          ["claude-opus-5.5", "gpt-6-sol", "gpt-6.1-sol", "grok-4.7"].map((id) => ({
            id,
            ...(mode === "missing-metadata"
              ? {}
              : {
                  capabilities: {
                    ...fixtureOptimizeModelInfo.capabilities,
                    limits: {
                      max_context_window_tokens: 100_000,
                      max_prompt_tokens: 100_000,
                      max_output_tokens: 8192,
                    },
                  },
                }),
          })),
        createSession: async (config) => ({
          sessionId: config.sessionId!,
          on: () => () => {},
          abort: async () => {},
          disconnect: async () => {},
          sendAndWait: async ({ prompt }) => {
            expect(prompt).not.toContain(content)
            if (!config.enableSkills) {
              crossFile++
              crossFilePrompts.push(prompt)
              return { data: { content: "No additional cross-file findings." } }
            }
            leaves++
            const context = { sessionId: config.sessionId! }
            const skill = {
              toolName: "builtin:skill",
              toolArgs: { name: mode === "worker-budgets" ? "fleet-review" : "ponytail-review" },
              sessionId: config.sessionId!,
              timestamp: new Date(),
              workingDirectory: work,
            }
            await config.hooks!.onPreToolUse!(skill, context)
            await config.hooks!.onPostToolUse!(
              { ...skill, toolResult: { resultType: "success", textResultForLlm: "Loaded." } },
              context,
            )
            const tool = config.tools!.find((entry) => entry.name === "read_snapshot")!
            const read = async (args: Record<string, unknown>, sessionId = context.sessionId) => {
              const output = await tool.handler!(args, {
                sessionId,
                toolName: tool.name,
                toolCallId: "read",
                arguments: args,
              })
              if (typeof output !== "object" || output === null || !("textResultForLlm" in output))
                throw new Error("Missing tool result.")
              return JSON.parse(String(output.textResultForLlm)) as {
                remainingRequired: ReviewSlice[]
                text?: string
              }
            }
            if (mode === "cancelled") controller.abort(new Error("cancelled in batch"))
            if (mode === "worker-budgets") {
              const ranges = (await read({})).remainingRequired
              for (const sessionId of [context.sessionId, "worker-1", "worker-2", "worker-3"]) {
                await readRanges(read, ranges, sessionId)
                workerReads++
              }
            }
            if (mode === "complete") {
              let page = await read({})
              while (page.remainingRequired.length) {
                const range = page.remainingRequired[0]!
                page = await read({
                  source: range.source,
                  offset: range.start,
                  length: Math.min(16000, range.end - range.start),
                })
                allReads += page.text
              }
            }
            return { data: { content: `Batch ${leaves}: no removable complexity.` } }
          },
        }),
      })
      const provider = new CopilotReviewProvider(
        {
          root,
          work,
          runtime: path.join(root, "runtime"),
          dispose: async () => {},
          skills: new Map([
            ["ponytail", path.join(root, "ponytail-review")],
            ["fleet", path.join(root, "fleet-review")],
          ]),
          references: new Map([["ponytail-review/SKILL.md", "Review complexity."]]),
        },
        {
          repository: root,
          baseRef: "HEAD",
          baseRefSha: "a".repeat(40),
          base: "a".repeat(40),
          head: "a".repeat(40),
          diff: "Frozen sources",
          sourceIds: ["@diff/net"],
          primarySourceIds: ["@diff/net"],
          changedFiles: ["code.ts"],
          workingTreeFiles: ["code.ts"],
          standards: [],
          commitList: "",
        },
        factory,
        1000,
        undefined,
        { evidence },
      )
      try {
        const result = await provider.review(
          reviewCatalog.find((entry) => entry.id === (mode === "worker-budgets" ? "fleet" : "ponytail"))!,
          controller.signal,
        )
        const complete = mode === "complete"
        expect(Boolean(result.error)).toBe(!complete)
        expect(leaves > 1).toBe(complete)
        expect(leaves === 0).toBe(mode === "missing-metadata")
        expect(crossFile).toBe(complete ? 1 : 0)
        expect(result.batches?.length ?? 0).toBe(complete ? leaves + 1 : 0)
        expect(allReads).toBe(complete ? content : "")
        expect(workerReads).toBe(mode === "worker-budgets" ? 4 : 0)
        expect(crossFilePrompts.every((prompt) => prompt.includes("ALL completed batches"))).toBe(true)
      } finally {
        const cleanupFailed = await provider.close().then(
          () => false,
          () => true,
        )
        expect(cleanupFailed).toBe(mode === "cleanup-failed")
      }
    },
  )
})
