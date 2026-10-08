import { appendFileSync, closeSync, openSync } from "node:fs"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual, parseArgs } from "node:util"
import { resolveGuideModelRouting } from "./guide-api.ts"
import { createNodeCommandRunner, type CommandRunner } from "./guide-launch.ts"
import { createGuideOptimizeServices } from "./guide-optimize.ts"
import {
  assertGuideOptimizeTargetCurrent,
  type GuideOptimizeScope,
  type GuideOptimizeTarget,
} from "./guide-optimize-target.ts"
import { reviewCheckCatalog, selectReviewChecks } from "./review-catalog.ts"
import { reviewSynthesisStatus, type ReviewEvent, type ReviewRun } from "./review-contracts.ts"
import { SharedReviewStore } from "./review-store.ts"

const usage =
  "mise run trx-review-test -- --live (--fixture [--fixture-bytes N] | --cwd PATH) [--all | --check ID ...] [--path FILE ...] [--base REF | --uncommitted] [--output DIR] [--timeout-seconds N]"
const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const liveTarget = (values: { cwd?: string; fixture?: boolean; base?: string; uncommitted?: boolean }) => {
  if (Boolean(values.fixture) === (values.cwd !== undefined))
    throw new Error("Choose exactly one of --fixture or --cwd PATH.")
  if (values.cwd !== undefined && !values.cwd.trim()) throw new Error("--cwd must not be empty.")
  if (values.base !== undefined && (values.uncommitted || values.fixture))
    throw new Error("--base cannot be combined with --uncommitted or --fixture.")
  if (values.base !== undefined && !values.base.trim()) throw new Error("--base must not be empty.")
  const scope: GuideOptimizeScope =
    values.fixture || values.uncommitted
      ? { kind: "uncommitted" }
      : values.base === undefined
        ? { kind: "current-branch" }
        : { kind: "branch", baseRef: values.base }
  return { cwd: values.cwd === undefined ? undefined : path.resolve(values.cwd), scope }
}

const liveTimeout = (value: string | undefined): number => {
  const seconds = Number(value ?? 1800)
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 7200)
    throw new Error("--timeout-seconds must be an integer from 1 to 7200.")
  return seconds * 1000
}

const fixtureSize = (value: string | undefined, fixture: boolean | undefined): number | undefined => {
  if (value === undefined) return undefined
  const bytes = Number(value)
  if (!fixture || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 8_000_000)
    throw new Error("--fixture-bytes requires --fixture and an integer from 1 to 8000000.")
  return bytes
}

export const parseLiveReviewArguments = (args: ReadonlyArray<string>) => {
  const { values } = parseArgs({
    args: [...args],
    options: {
      live: { type: "boolean" },
      help: { type: "boolean" },
      fixture: { type: "boolean" },
      "fixture-bytes": { type: "string" },
      all: { type: "boolean" },
      cwd: { type: "string" },
      check: { type: "string", multiple: true },
      path: { type: "string", multiple: true },
      base: { type: "string" },
      uncommitted: { type: "boolean" },
      output: { type: "string" },
      "timeout-seconds": { type: "string" },
    },
    allowPositionals: false,
  })
  if (values.help) return undefined
  if (!values.live)
    throw new Error("Explicit --live consent is required. This sends selected code to models and consumes quota.")
  if (values.all && values.check) throw new Error("Choose --all or --check, not both.")
  const checks = selectReviewChecks(
    values.all ? reviewCheckCatalog.map((check) => check.id) : (values.check ?? ["ponytail"]),
  ).map((check) => check.id)
  const paths = values.path
  if (paths && (new Set(paths).size !== paths.length || paths.some((entry) => !entry.trim())))
    throw new Error("--path values must be distinct and nonempty.")
  return {
    ...liveTarget(values),
    all: values.all === true,
    checks,
    paths,
    timeoutMs: liveTimeout(values["timeout-seconds"]),
    fixtureBytes: fixtureSize(values["fixture-bytes"], values.fixture),
    output: values.output === undefined ? undefined : path.resolve(values.output),
  }
}

// An actual Git patch, not a mocked report or SDK response.
export const createLiveReviewFixture = async (
  root: string,
  runner: CommandRunner,
  signal: AbortSignal,
  bytes = 0,
): Promise<string> => {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 8_000_000) throw new Error("Invalid synthetic fixture size.")
  const cwd = path.join(root, "fixture")
  await mkdir(cwd, { mode: 0o700 })
  const git = (args: string[]) => runner.run("git", args, { cwd, signal, timeoutMs: 30_000 })
  await git(["init", "--quiet", "--initial-branch=main", "--template="])
  await writeFile(
    path.join(cwd, "labels.ts"),
    "export const normalizeLabel = (value: string): string => value.trim().toLowerCase()\n",
  )
  await git(["add", "--", "labels.ts"])
  await git([
    "-c",
    "user.name=Review Fixture",
    "-c",
    "user.email=review@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Fixture baseline\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
  ])
  await writeFile(
    path.join(cwd, "labels.ts"),
    [
      "export const normalizeLabel = (value: string): string => {",
      "  const operations: Array<(text: string) => string> = [",
      "    (text) => text.trim(),",
      "    (text) => text.toLowerCase(),",
      "  ]",
      "  let result = value",
      "  for (const operation of operations) result = operation(result)",
      "  if (result.length === 0) return result",
      "  return result",
      "}",
      "",
    ].join("\n"),
  )
  for (let remaining = bytes, index = 0; remaining > 0; index++) {
    const count = Math.min(240_000, remaining)
    const row = `  "${"record-".repeat(27)}",\n`
    const content = `export const records = [\n${row.repeat(Math.ceil(count / row.length))}]\n`
    await writeFile(path.join(cwd, `data-${index}.ts`), content, { mode: 0o600 })
    remaining -= count
  }
  return realpath(cwd)
}

type ReviewOutcome = Pick<
  ReviewRun,
  "status" | "synthesisStatus" | "results" | "artifacts" | "calls" | "error" | "approvedIds" | "execution"
>

export const reviewBatchCounts = (artifacts: ReviewOutcome["artifacts"]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const artifact of artifacts) {
    if (!artifact.id.startsWith(`${artifact.checkId}:batch-evidence-`)) continue
    counts[artifact.checkId] = (counts[artifact.checkId] ?? 0) + 1
  }
  return counts
}

const checkFailures = (run: ReviewOutcome, id: string): string[] => {
  const failures: string[] = []
  const results = run.results.filter((result) => result.id === id)
  const result = results[0]
  if (results.length !== 1 || result?.status !== "complete" || result.error)
    failures.push(`${id}: ${result?.error ?? result?.status ?? "missing result"}.`)
  if (
    !result ||
    !run.artifacts.some(
      (entry) => entry.id === result.reportId && entry.checkId === id && entry.content.trim().length > 0,
    )
  )
    failures.push(`${id}: missing nonempty saved report.`)
  return failures
}

export const liveReviewFailures = (
  run: ReviewOutcome,
  checks: ReadonlyArray<string>,
  requirements: { readonly minimumArchitectureBatches?: number } = {},
): string[] => {
  const failures: string[] = []
  if (run.status !== "complete") failures.push(`Review status: ${run.status}.`)
  if (run.error) failures.push(run.error)
  if (run.calls < 1) failures.push("No model calls were recorded.")
  if (run.results.length !== checks.length || run.results.some((result) => !checks.includes(result.id)))
    failures.push("Saved check results do not match the selection.")
  failures.push(...checks.flatMap((id) => checkFailures(run, id)))
  if (requirements.minimumArchitectureBatches !== undefined) {
    const count = reviewBatchCounts(run.artifacts)["improve-codebase-architecture"] ?? 0
    if (count < requirements.minimumArchitectureBatches)
      failures.push(`Architecture fixture produced ${count} evidence batch${count === 1 ? "" : "es"}; expected at least ${requirements.minimumArchitectureBatches}.`)
  }
  if (run.synthesisStatus !== "complete") failures.push("Synthesis did not complete.")
  if (run.approvedIds.length || run.execution !== "not-started")
    failures.push("Read-only review was approved or launched.")
  return failures
}

const sourceEnvironment = async (): Promise<NodeJS.ProcessEnv> => {
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  const home = await realpath(os.homedir())
  return {
    ...process.env,
    TRELLAGE_GUIDE_SKILLS_MANAGER: path.join(root, "scripts/floating-skills.ts"),
    TRELLAGE_GUIDE_SKILLS_CATALOG: path.join(root, "config.toml"),
    TRELLAGE_GUIDE_NATIVE_SKILLS_CACHE: path.join(
      process.env.XDG_DATA_HOME ?? path.join(home, ".local/share"),
      "trellage/common/skills",
    ),
    TRELLAGE_GUIDE_OPTIMIZE_SKILLS_CACHE: path.join(
      home,
      ".local/share/trellage/common/guide-optimize-architecture-skills",
    ),
  }
}

const openReviewEvents = (output: string) => {
  const eventController = new AbortController()
  const eventsFile = openSync(path.join(output, "events.ndjson"), "wx", 0o600)
  let eventBytes = 0
  let eventError: string | undefined
  const onEvent = (event: ReviewEvent): void => {
    if (eventError) return
    try {
      const data =
        event.kind === "artifact"
          ? { kind: event.kind, artifact: { id: event.artifact.id, digest: event.artifact.digest } }
          : event
      const line = `${JSON.stringify({ at: new Date().toISOString(), ...data })}\n`
      eventBytes += Buffer.byteLength(line)
      if (eventBytes > 16 * 1024 * 1024) throw new Error("Live event evidence exceeds 16 MiB.")
      appendFileSync(eventsFile, line)
      if (event.kind === "status") process.stderr.write(`${event.checkId}: ${event.status}\n`)
      if (event.kind === "synthesis") process.stderr.write(`synthesis: ${event.status}\n`)
    } catch (cause) {
      eventError = `Event persistence failed: ${message(cause)}`
      eventController.abort(new Error(eventError))
    }
  }
  return {
    onEvent,
    signal: eventController.signal,
    get error() {
      return eventError
    },
    close: () => closeSync(eventsFile),
  }
}

const liveServices = async (cwd: string, runner: CommandRunner) => {
  const env = await sourceEnvironment()
  const routing = resolveGuideModelRouting({}, env)
  return createGuideOptimizeServices({
    cwd,
    runner,
    env,
    routing,
    context: null,
    entry: "review",
    catalog: { schemaVersion: 1, sandboxCommandPath: "/unused", native: [], sandbox: [] },
    modelOverrides: {
      ...(env.TRELLAGE_GUIDE_MODEL ? { model: routing.optimize.model } : {}),
      ...(env.TRELLAGE_GUIDE_EFFORT ? { effort: routing.optimize.effort } : {}),
    },
  })
}

const selectedLivePaths = (target: GuideOptimizeTarget, selection: ReadonlyArray<string> | undefined) => {
  const paths =
    selection ??
    target.changes.filter((entry) => entry.kind === "file" || entry.kind === "deleted").map((entry) => entry.path)
  if (!paths.length) throw new Error("No eligible changed files. An empty review cannot pass.")
  return paths
}

const reviewDetails = (saved: ReviewRun | undefined) => ({
  reviewId: saved?.id,
  status: saved?.status ?? "not-completed",
  synthesisStatus: saved ? reviewSynthesisStatus(saved) : "not-completed",
  checks:
    saved?.results.map((result) => ({
      id: result.id,
      status: result.status,
      error: result.error,
      findings: result.findings.length,
      groundedFindings: result.findings.filter((finding) => finding.grounded).length,
    })) ?? [],
  calls: saved?.calls ?? 0,
  batchCounts: saved ? reviewBatchCounts(saved.artifacts) : {},
  sourceFingerprint: saved?.evidence.fingerprint,
  failure: saved?.failure,
})

export const runLiveReviewTest = async (
  input: NonNullable<ReturnType<typeof parseLiveReviewArguments>>,
  output: string,
  signal: AbortSignal,
) => {
  const startedAt = new Date().toISOString()
  const runner = createNodeCommandRunner()
  const failures: string[] = []
  let saved: ReviewRun | undefined
  let recordPath: string | undefined
  let cwd = input.cwd
  let worktreeUnchanged = false
  const deadline = AbortSignal.timeout(input.timeoutMs)
  const events = openReviewEvents(output)
  const bounded = AbortSignal.any([signal, deadline, events.signal])
  try {
    cwd ??= await createLiveReviewFixture(output, runner, bounded, input.fixtureBytes)
    cwd = await realpath(cwd)
    if (output === cwd || output.startsWith(`${cwd}${path.sep}`))
      throw new Error("Live evidence output must be outside the reviewed worktree.")
    const services = await liveServices(cwd, runner)
    const target = await services.inspect(input.scope, bounded)
    const paths = selectedLivePaths(target, input.paths)
    await writeFile(
      path.join(output, "request.json"),
      JSON.stringify(
        {
          target,
          paths,
          checks: services.assignments?.filter((entry) => input.checks.includes(entry.id)),
          coordinator: services.coordinator,
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    )
    try {
      // This is the same service method invoked by the Guide TUI after consent.
      const displayed = await services.review(
        { target, paths, reviewerIds: input.checks },
        bounded,
        () => {},
        events.onEvent,
      )
      recordPath = path.join(target.gitDirectory, "trellage-reviews", `${displayed.id}.json`)
      saved = await new SharedReviewStore(target.gitDirectory).read(displayed.id)
      if (!isDeepStrictEqual(displayed, saved)) failures.push("TUI result differs from the persisted review.")
      await writeFile(path.join(output, "review.json"), JSON.stringify(saved, null, 2), { flag: "wx", mode: 0o600 })
      failures.push(...liveReviewFailures(saved, input.checks, {
        ...(input.fixtureBytes !== undefined && input.checks.includes("improve-codebase-architecture")
          ? { minimumArchitectureBatches: 2 }
          : {}),
      }))
    } finally {
      try {
        await assertGuideOptimizeTargetCurrent(runner, target, AbortSignal.timeout(30_000))
        worktreeUnchanged = true
      } catch (cause) {
        failures.push(`Worktree changed or could not be checked: ${message(cause)}`)
      }
    }
  } catch (cause) {
    failures.push(message(cause))
  } finally {
    events.close()
  }
  if (events.error) failures.push(events.error)
  if (deadline.aborted) failures.push("Live review deadline exceeded.")
  if (signal.aborted) failures.push("Live review cancelled.")
  return {
    schemaVersion: 1,
    passed: failures.length === 0 && worktreeUnchanged && saved !== undefined,
    startedAt,
    finishedAt: new Date().toISOString(),
    output,
    cwd,
    ...reviewDetails(saved),
    recordPath,
    worktreeUnchanged,
    failures,
  }
}

const writeLiveSummary = async (output: string, result: unknown): Promise<void> => {
  await writeFile(path.join(output, "summary.json"), `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  })
}

export const runLiveReviewMatrix = async (
  input: NonNullable<ReturnType<typeof parseLiveReviewArguments>>,
  output: string,
  signal: AbortSignal,
  runCase: typeof runLiveReviewTest = runLiveReviewTest,
) => {
  const startedAt = new Date().toISOString()
  const cases: Array<{ check: string; result: Awaited<ReturnType<typeof runLiveReviewTest>> }> = []
  for (const check of input.checks) {
    if (signal.aborted) break
    const directory = path.join(output, check)
    await mkdir(directory, { mode: 0o700 })
    process.stderr.write(`Live review case: ${check}\n`)
    const result = await runCase({ ...input, all: false, checks: [check] }, directory, signal)
    await writeLiveSummary(directory, result)
    cases.push({ check, result })
  }
  const notRun = input.checks.filter((check) => !cases.some((entry) => entry.check === check))
  return {
    schemaVersion: 1,
    mode: "matrix",
    startedAt,
    finishedAt: new Date().toISOString(),
    output,
    passed: !signal.aborted && notRun.length === 0 && cases.length > 0 && cases.every(({ result }) => result.passed),
    selectedChecks: input.checks,
    cases,
    notRun,
    calls: cases.reduce((total, { result }) => total + result.calls, 0),
    failures: [
      ...cases
        .filter(({ result }) => !result.passed)
        .map(({ check }) => `${check}: acceptance failed; see case summary.`),
      ...notRun.map((check) => `${check}: not run because the matrix was cancelled.`),
      ...(signal.aborted ? ["Live review matrix cancelled."] : []),
    ],
  }
}

const main = async (): Promise<void> => {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  let output: string | undefined
  try {
    const input = parseLiveReviewArguments(process.argv.slice(2))
    if (!input) {
      process.stdout.write(
        `${usage}\nDefault check: ponytail. --all runs each catalog check separately. Real models, skills, extraction, synthesis and storage; no approval or implementation.\n`,
      )
      return
    }
    const parent =
      input.output ??
      path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"), "trellage", "review-live-tests")
    await mkdir(parent, { recursive: true, mode: 0o700 })
    output = await realpath(await mkdtemp(path.join(parent, "run-")))
    process.stderr.write(`Live review evidence: ${output}\n`)
    const result = input.all
      ? await runLiveReviewMatrix(input, output, controller.signal)
      : await runLiveReviewTest(input, output, controller.signal)
    await writeLiveSummary(output, result)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = controller.signal.aborted ? 130 : result.passed ? 0 : 1
  } catch (cause) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, passed: false, output, failures: [message(cause)] })}\n`)
    process.exitCode = controller.signal.aborted ? 130 : 1
  } finally {
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
  }
}

if (import.meta.main) await main()
