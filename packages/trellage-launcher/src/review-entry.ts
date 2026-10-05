import { execFile } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { createNodeCommandRunner } from "./guide-launch.ts"
import { reviewChoices } from "./review-catalog.ts"
import { captureReviewSnapshot, runReviews, type ReviewSnapshot as GitReviewSnapshot } from "./review-run.ts"
import type { ReviewUiProps } from "./review-ui.tsx"

export { reviewChoices } from "./review-catalog.ts"

const exec = promisify(execFile)
const baseRef = "refs/remotes/origin/main"

const git = async (cwd: string, signal: AbortSignal, ...args: string[]): Promise<string> =>
  (await exec("git", args, {
    cwd, signal, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })).stdout.trimEnd()

const runtimePaths = (): { managerPath: string; catalogPath: string; cachePath: string } => {
  const managerPath = process.env.TRELLAGE_GUIDE_SKILLS_MANAGER
  const catalogPath = process.env.TRELLAGE_GUIDE_SKILLS_CATALOG
  const cachePath = process.env.TRELLAGE_GUIDE_NATIVE_SKILLS_CACHE
  if (!managerPath || !catalogPath || !cachePath) {
    throw new Error("Review skill runtime paths are missing. Reinstall trx, then reopen Review.")
  }
  return { managerPath, catalogPath, cachePath }
}

export const reviewFailureMessage = (cause: unknown, directory: string): string => {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return `Review stopped: ${detail}${/[.!?]$/u.test(detail) ? "" : "."} ` +
    `Inspect retained partial reports in ${directory}.`
}

export const createReviewUiProps = (cwd: string): ReviewUiProps => {
  let confirmedSnapshot: GitReviewSnapshot | undefined
  const skills = { ...runtimePaths(), runner: createNodeCommandRunner() }
  return {
    choices: reviewChoices,
    prepare: async (signal) => {
      const root = await git(cwd, signal, "rev-parse", "--show-toplevel")
      const snapshot = await captureReviewSnapshot(root, baseRef, signal)
      const branch = await git(root, signal, "symbolic-ref", "--quiet", "--short", "HEAD")
        .catch((error: unknown) => {
          if (!signal.aborted && error instanceof Error && "code" in error && error.code === 1) {
            return `(detached at ${snapshot.head.slice(0, 12)})`
          }
          throw error
        })
      confirmedSnapshot = snapshot
      return {
        branch,
        baseRef,
        baseRefSha: snapshot.baseRefSha,
        baseSha: snapshot.base,
        headSha: snapshot.head,
        changedFiles: snapshot.changedFiles,
        workingTreeFiles: snapshot.workingTreeFiles,
        diffBytes: Buffer.byteLength(snapshot.diff, "utf8"),
      }
    },
    run: async (selected, displayed, signal, onProgress, onOutput) => {
      if (!confirmedSnapshot || confirmedSnapshot.base !== displayed.baseSha ||
        confirmedSnapshot.head !== displayed.headSha || confirmedSnapshot.baseRef !== displayed.baseRef ||
        confirmedSnapshot.baseRefSha !== displayed.baseRefSha ||
        Buffer.byteLength(confirmedSnapshot.diff, "utf8") !== displayed.diffBytes) {
        throw new Error("The confirmed review target has changed. Reopen Review.")
      }
      let directory: string | undefined
      try {
        const result = await runReviews({
          repository: confirmedSnapshot.repository,
          baseRef,
          snapshot: confirmedSnapshot,
          selected,
          confirmed: true,
          signal,
          skills,
          onWorkspace: (root) => { directory = root },
          onProgress,
          onOutput,
        })
        const markdownPath = path.join(result.directory, "combined-review.md")
        const jsonPath = path.join(result.directory, "combined-review.json")
        const master = JSON.parse(await readFile(path.join(result.directory, "work", "docs", "review", "synthesis.json"), "utf8")) as unknown
        const markdown = result.cleanupError
          ? `**Incomplete: review session cleanup failed.** ${result.cleanupError}\n\n${result.synthesis}`
          : result.synthesis
        await writeFile(markdownPath, markdown, { flag: "wx", mode: 0o600 })
        await writeFile(jsonPath, JSON.stringify({
          schemaVersion: 1,
          baseRefSha: result.snapshot.baseRefSha,
          baseSha: result.snapshot.base,
          headSha: result.snapshot.head,
          workingTreeFiles: result.snapshot.workingTreeFiles,
          scope: "committed-and-working-tree",
          incomplete: result.incomplete,
          ...(result.cleanupError ? { cleanupError: result.cleanupError } : {}),
          reviews: result.reports,
          master,
        }, null, 2), { flag: "wx", mode: 0o600 })
        return {
          markdown, markdownPath, jsonPath, complete: !result.incomplete,
          reviews: result.reports.map((report) => ({
            id: report.id,
            markdown: report.error
              ? `Review failed: ${report.error}\n\n${report.raw}`
              : report.fleet?.reportMarkdown ?? report.raw,
            ...(report.markdownPath ? { markdownPath: report.markdownPath } : {}),
            status: report.error ? "failed" as const :
              report.fleet?.status === "partial" ? "partial" as const : "complete" as const,
          })),
        }
      } catch (cause) {
        if (directory === undefined) throw cause
        throw new Error(reviewFailureMessage(cause, directory), { cause })
      }
    },
  }
}
