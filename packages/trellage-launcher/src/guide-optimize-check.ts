import { realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { resolveGuideModelRouting } from "./guide-api.ts"
import { createNodeCommandRunner } from "./guide-launch.ts"
import { optimizeReviewersFor } from "./guide-optimize-review.ts"
import { OptimizeReviewStore } from "./guide-optimize-store.ts"
import {
  assertGuideOptimizeTargetCurrent,
  inspectGuideOptimizeTarget,
  type GuideOptimizeScope,
} from "./guide-optimize-target.ts"
import { runGuideOptimizeReview, type GuideOptimizeDependencies } from "./guide-optimize.ts"
import { text } from "./guide-text.ts"

interface OptimizeCheckInput {
  readonly cwd: string
  readonly scope: GuideOptimizeScope
}

const usage = "mise run trx-optimize-check -- --live [--cwd PATH] [--base REF | --uncommitted]"
const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export const parseOptimizeCheckArguments = (args: ReadonlyArray<string>): OptimizeCheckInput | undefined => {
  const { values } = parseArgs({
    args: [...args],
    options: {
      live: { type: "boolean" },
      help: { type: "boolean" },
      cwd: { type: "string" },
      base: { type: "string" },
      uncommitted: { type: "boolean" },
    },
    allowPositionals: false,
  })
  if (values.help) return undefined
  if (!values.live)
    throw new Error(
      `Explicit --live consent is required; this check sends source text to models and can consume paid quota. Usage: ${usage}`,
    )
  if (values.base !== undefined && values.uncommitted) throw new Error("Choose --base or --uncommitted, not both.")
  const scope: GuideOptimizeScope = values.uncommitted
    ? { kind: "uncommitted" }
    : values.base === undefined
      ? { kind: "current-branch" }
      : { kind: "branch", baseRef: text(values.base, "base", 4096, { preserve: true }) }
  return {
    cwd: path.resolve(text(values.cwd ?? process.cwd(), "cwd", 4096, { preserve: true })),
    scope,
  }
}

const sourceSkillEnvironment = async (env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> => {
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  const home = await realpath(os.homedir())
  return {
    ...env,
    TRELLAGE_GUIDE_SKILLS_MANAGER: path.join(root, "scripts/floating-skills.ts"),
    TRELLAGE_GUIDE_SKILLS_CATALOG: path.join(root, "skills.json"),
    TRELLAGE_GUIDE_OPTIMIZE_SKILLS_CACHE: path.join(
      home,
      ".local/share/trellage/common/guide-optimize-architecture-skills",
    ),
  }
}

export const checkGuideOptimization = async (
  input: OptimizeCheckInput,
  signal: AbortSignal,
  progress: (message: string) => void,
  dependencies: GuideOptimizeDependencies = {},
  env: NodeJS.ProcessEnv = process.env,
) => {
  const runner = createNodeCommandRunner()
  const target = await inspectGuideOptimizeTarget(runner, input.cwd, input.scope, signal)
  const paths = target.changes
    .filter((entry) => entry.kind === "file" || entry.kind === "deleted")
    .map((entry) => entry.path)
  if (paths.length === 0)
    throw new Error("No eligible changed files. The acceptance check cannot pass on an empty scope.")
  const routing = resolveGuideModelRouting({}, env)
  const reviewerIds = optimizeReviewersFor(routing).map((entry) => entry.id)
  const completed = await runGuideOptimizeReview(
    { runner, cwd: target.cwd, dependencies, env: await sourceSkillEnvironment(env) },
    routing,
    { target, paths, reviewerIds },
    signal,
    progress,
  )
  const store = new OptimizeReviewStore(target.gitDirectory)
  const review = await store.read(completed.id)
  const errors = review.error === null ? [] : [review.error]
  let worktreeUnchanged = false
  try {
    await assertGuideOptimizeTargetCurrent(runner, target, signal)
    worktreeUnchanged = true
  } catch (cause) {
    errors.push(`Worktree check failed: ${errorMessage(cause)}`)
  }
  if (review.approvedIds.length > 0 || review.execution !== "not-started")
    errors.push("The read-only acceptance review was approved or launched.")
  return {
    schemaVersion: 1,
    passed: review.status === "complete" && errors.length === 0 && worktreeUnchanged,
    reviewId: review.id,
    status: review.status,
    worktree: target.cwd,
    scope: target.scope,
    selectedPaths: paths,
    evidenceFingerprint: review.evidence.fingerprint,
    reviewers: review.reviewers.map(({ id, model }) => ({ id, ...model })),
    reports: review.reports.length,
    challenges: review.challenges.length,
    findings: review.reports.reduce((count, report) => count + report.findings.length, 0),
    decisions: review.decisions.length,
    calls: review.calls,
    approvedFindings: review.approvedIds.length,
    execution: review.execution,
    worktreeUnchanged,
    errors,
  }
}

const main = async (): Promise<void> => {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  try {
    const input = parseOptimizeCheckArguments(process.argv.slice(2))
    if (input === undefined) {
      process.stdout.write(
        `${usage}\nRuns all three reviewers and saves a read-only report. Never approves changes or starts an editor.\n`,
      )
      return
    }
    const result = await checkGuideOptimization(input, controller.signal, (message) =>
      process.stderr.write(`${message}\n`),
    )
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = result.passed ? 0 : controller.signal.aborted ? 130 : 1
  } catch (cause) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, passed: false, errors: [errorMessage(cause)] })}\n`)
    process.exitCode = controller.signal.aborted ? 130 : 1
  } finally {
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
  }
}

if (import.meta.main) await main()
