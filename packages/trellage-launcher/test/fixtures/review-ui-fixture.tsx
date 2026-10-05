import { appendFile } from "node:fs/promises"
import path from "node:path"
import React from "react"
import { render } from "ink"
import { bunExecutable } from "@trellage/runtime"
import { runInteractiveCommand } from "../../src/guide-launch.ts"
import { createInitialGuideRenderHandler } from "../../src/guide-terminal.ts"
import { reviewChoices } from "../../src/review-catalog.ts"
import { ReviewApp, type ReviewContinuation, type ReviewUiProps } from "../../src/review-ui.tsx"

const root = process.argv[2]
if (!root) throw new Error("Review UI fixture needs a temporary root")
const emit = (event: unknown): Promise<void> => appendFile(path.join(root, "events.jsonl"), `${JSON.stringify(event)}\n`)

const run: ReviewUiProps["run"] = async (selected, snapshot, signal, onProgress, onOutput) => {
  await emit({ kind: "run", selected, head: snapshot.headSha })
  selected.forEach((id) => onProgress(id, "running"))
  if (process.env.REVIEW_FIXTURE_SLOW === "1") {
    if (selected.includes("ponytail")) {
      onOutput("ponytail", { kind: "activity", text: "Skill loaded." })
      onOutput("ponytail", { kind: "text", source: "Reviewer", text: "Checking abstractions in the branch." })
    }
    if (selected.includes("fleet")) {
      onOutput("fleet", { kind: "activity", text: "Specialist 1 started." })
      onOutput("fleet", { kind: "text", source: "Specialist 1",
        text: Array.from({ length: 80 }, (_, index) => `Fleet line ${index}`).join("\n") })
    }
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, Number(process.env.REVIEW_FIXTURE_DELAY_MS ||
      (process.env.REVIEW_FIXTURE_SLOW === "1" ? 15_000 : 300)))
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(new Error("Partial results saved after cancellation"))
    }, { once: true })
  })
  const partial = process.env.REVIEW_FIXTURE_PARTIAL === "1"
  selected.forEach((id) => onProgress(id, partial && id === "fleet" ? "partial" : "complete"))
  onProgress("synthesis", "running")
  onOutput("synthesis", { kind: "activity", text: "Combining review findings." })
  return {
    markdown: `# Combined review\n\n${Array.from({ length: 40 }, (_, index) => `Synthesis finding ${index}`).join("\n\n")}`,
    markdownPath: "/tmp/review.md", jsonPath: "/tmp/review.json", complete: !partial,
    reviews: selected.map((id) => ({
      id,
      status: partial && id === "fleet" ? "partial" as const : "complete" as const,
      markdown: `# ${id} report\n\n${process.env.REVIEW_FIXTURE_DIFF === "1"
        ? "```diff\n@@ -1 +1 @@\n-before\n+after\n unchanged\n```\n\n" : ""}` +
        Array.from({ length: 40 }, (_, index) => `${id} finding ${index}`).join("\n\n"),
      markdownPath: `/tmp/${id}.md`,
    })),
  }
}

const handoff = process.env.REVIEW_FIXTURE_HANDOFF === "1"
const input = process.stdin
const output = handoff ? process.stderr : process.stdout
const instance = render(
  <ReviewApp
    choices={reviewChoices}
    herdrAvailable={process.env.REVIEW_FIXTURE_HERDR === "1"}
    prepare={async () => ({
      branch: "fixture-review",
      baseRef: "refs/remotes/origin/main",
      baseRefSha: process.env.REVIEW_FIXTURE_BEHIND === "1" ? "c".repeat(40) : "a".repeat(40),
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      changedFiles: ["review.js"],
      workingTreeFiles: process.env.REVIEW_FIXTURE_CLEAN === "1" ? [] : ["uncommitted.js"],
      diffBytes: 173384,
    })}
    run={run}
  />,
  {
    stdin: input, stdout: output, alternateScreen: true, exitOnCtrlC: false,
    kittyKeyboard: { mode: "disabled" },
    onRender: createInitialGuideRenderHandler((text) => output.write(text), process.env.INK_SCREEN_READER !== "true"),
    maxFps: 30,
  },
)
const result = await instance.waitUntilExit() as ReviewContinuation | undefined
if (result !== undefined) await emit(result)
if (handoff && result?.action === "continue" && result.destination === "current-terminal") {
  input.pause()
  await runInteractiveCommand({
    executable: bunExecutable(),
    args: ["-e", 'process.stdout.write("HANDOFF_READY\\n"); process.stdin.once("data", (data) => process.stdout.write(`HANDOFF_INPUT:${data.toString().trim()}\\n`, () => process.exit(0)))'],
  })
  await emit({ kind: "handed-off" })
}
