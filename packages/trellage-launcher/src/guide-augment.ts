/**
 * The two out-of-band prompt augmenters offered from inside the `trx guide`
 * TUI. Both take the intent the user is editing and return a richer one:
 *
 * - `research` runs HVE Core's RPI research skill through the already
 *   installed `cpx hve` launcher and returns the durable research note it
 *   writes. It runs out-of-process on purpose: the note needs the `hve-core`
 *   plugin, file-write tools, and the repository as its working directory,
 *   which `CopilotGuideProvider`'s locked-down sessions deliberately deny.
 * - `codebase` packs the repository with `repomix` and asks the provider's
 *   `enrich` phase to restate the intent with that pack as reference. The
 *   pack travels as prompt content, so the provider stays locked down.
 *
 * No React here: `guide-ui.tsx` calls these from an effect and owns the
 * spinner, cancellation, and error presentation.
 */
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { guideIntentMaximumLength } from "./guide-api.js"
import type { CombinedGuideCatalog } from "./guide-catalog.js"
import { CommandRunnerError, type CommandRunner } from "./guide-launch.js"
import { guideEnrichPackMaximumLength, type GuideProvider } from "./guide-provider.js"

export enum GuideAugmentKind {
  Research = "research",
  Codebase = "codebase",
}

export enum GuideAugmentPhase {
  RunningResearch = "running-research",
  ReadingNote = "reading-note",
  PackingRepository = "packing-repository",
  RewritingIntent = "rewriting-intent",
}

export class GuideAugmentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "GuideAugmentError"
  }
}

export interface GuideAugmentContext {
  readonly runner: CommandRunner
  /** The repository the user launched `trx guide` in. Both augmenters read it; only research writes to it. */
  readonly cwd: string
  readonly signal: AbortSignal
  readonly onPhase: (phase: GuideAugmentPhase) => void
  /** One line of live progress, already cleaned. The caller shows the most recent few. */
  readonly onActivity: (line: string) => void
}

const activityLineMaximum = 160
const ansiEscape = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu
const controlCharacters = /[\u0000-\u0008\u000b-\u001f\u007f]/gu

/**
 * Turns raw child output into whole, printable lines. Terminal progress
 * writers repaint with `\r` and colour codes, so both are stripped and each
 * repaint becomes its own line.
 */
export const createOutputLineReader = (emit: (line: string) => void): ((text: string) => void) => {
  let pending = ""
  return (text) => {
    pending += text
    const parts = pending.split(/\r\n|\r|\n/u)
    pending = parts.pop() ?? ""
    for (const part of parts) {
      const line = part.replace(ansiEscape, "").replace(controlCharacters, "").trim()
      if (line.length > 0) emit(line.slice(0, activityLineMaximum))
    }
  }
}

const researchDirectory = path.join(".copilot-tracking", "research")
const researchSuffix = "-research.md"
/**
 * HVE Core's delegated workers write their lane notes under
 * `research/subagents/`. Those share the `-research.md` suffix but hold raw
 * evidence, so only the parent's primary artifact can become the prompt.
 */
const researchSubagentDirectory = "subagents"
/** How many closing lines of the run's own response a failure quotes. */
const researchResponseTailLines = 12
const truncationMarker = "\n\n[truncated: augmented prompt exceeded the intent limit]"

const defaultResearchTimeoutMs = 900_000
const repomixTimeoutMs = 600_000

const diagnostic = (error: unknown): string => {
  if (error instanceof CommandRunnerError) {
    const output = error.stderr.trim() || error.stdout.trim()
    return output.length > 0 ? output.slice(-2000) : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** Keeps the augmented text within the same bound the intent editor enforces. */
export const clampAugmentedIntent = (value: string): string => {
  const characters = [...value.trim()]
  if (characters.length <= guideIntentMaximumLength) return characters.join("")
  const markerLength = [...truncationMarker].length
  return characters.slice(0, guideIntentMaximumLength - markerLength).join("") + truncationMarker
}

const positiveInteger = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Every primary research note under `<cwd>/.copilot-tracking/research`, with
 * the time it last changed, keyed by absolute path.
 */
const researchNotes = async (cwd: string): Promise<ReadonlyMap<string, number>> => {
  const root = path.join(cwd, researchDirectory)
  let entries: ReadonlyArray<string>
  try {
    entries = await readdir(root, { recursive: true })
  } catch {
    // An absent tracking directory is the normal first-run state.
    return new Map()
  }
  const notes = new Map<string, number>()
  for (const entry of entries) {
    if (!entry.endsWith(researchSuffix)) continue
    if (entry.split(path.sep)[0] === researchSubagentDirectory) continue
    const file = path.join(root, entry)
    notes.set(file, (await stat(file)).mtimeMs)
  }
  return notes
}

/**
 * The note this run produced: the most recent one it created *or rewrote*.
 *
 * A rewrite counts because HVE Core resumes the existing artifact whenever the
 * task slug and the date repeat, which is exactly what a second run on the same
 * intent does. Judging the run by new paths alone called that success a
 * failure and threw the note away.
 */
const noteFromRun = (before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): string | undefined => {
  let newest: { readonly file: string; readonly modifiedMs: number } | undefined
  for (const [file, modifiedMs] of after) {
    const previous = before.get(file)
    if (previous !== undefined && modifiedMs === previous) continue
    if (newest === undefined || modifiedMs > newest.modifiedMs) newest = { file, modifiedMs }
  }
  return newest?.file
}

/**
 * The closing lines of the run's own response. A run that exits clean and still
 * writes nothing has a reason, and this is the only place it survives.
 */
const responseTail = (response: string): string => {
  const lines = response
    .replace(ansiEscape, "")
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-researchResponseTailLines)
  return lines.length === 0 ? "" : `\n\ncopilot said:\n${lines.join("\n")}`
}

const researchPrompt = (intent: string): string =>
  [
    "Use the rpi-research skill to research the request below and write its",
    "durable research note under .copilot-tracking/research/. Write the note on",
    "this run even if a note for the same task already exists: update that note",
    "in place, or write a new dated one. Do not finish without writing it.",
    "Research only: do not plan, do not implement, and do not change any other",
    "file.",
    "",
    "<request>",
    intent,
    "</request>",
  ].join("\n")

/**
 * Runs `cpx hve` headlessly and returns the research note it wrote.
 *
 * The note is found by diffing the tracking directory before and after the
 * run: HVE Core names the file `{YYYY-MM-DD}/{task_slug}-research.md` with a
 * model-chosen slug, so the name can never be predicted.
 */
export const runResearchAugment = async (
  intent: string,
  catalog: CombinedGuideCatalog,
  context: GuideAugmentContext,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> => {
  const profile = catalog.native.find((entry) => entry.launcher === "cpx" && entry.name === "hve")
  if (profile === undefined) {
    throw new GuideAugmentError(
      "research needs the native cpx/hve profile, which is not installed. Install it with: cpx setup hve",
    )
  }

  const before = await researchNotes(context.cwd)
  context.onPhase(GuideAugmentPhase.RunningResearch)
  let response = ""
  try {
    const result = await context.runner.run(profile.commandPath, ["hve", "-p", researchPrompt(intent)], {
      cwd: context.cwd,
      timeoutMs: positiveInteger(env.TRELLAGE_GUIDE_RESEARCH_TIMEOUT_MS, defaultResearchTimeoutMs),
      signal: context.signal,
      outputOverflow: "truncate",
      onOutput: createOutputLineReader(context.onActivity),
    })
    response = result.stdout
  } catch (error) {
    throw new GuideAugmentError(`cpx hve research failed: ${diagnostic(error)}`, { cause: error })
  }

  context.onPhase(GuideAugmentPhase.ReadingNote)
  const note = noteFromRun(before, await researchNotes(context.cwd))
  if (note === undefined) {
    throw new GuideAugmentError(
      `research wrote no note under ${researchDirectory}; the prompt is unchanged.${responseTail(response)}`,
    )
  }
  const content = await readFile(note, "utf8")
  if (content.trim().length === 0) throw new GuideAugmentError(`research note is empty: ${note}`)
  return clampAugmentedIntent(content)
}

/**
 * Generated, vendored, and binary content that never helps the model restate an
 * intent. `repomix` already honours `.gitignore` and skips `.git/` and
 * `node_modules/` through its own default patterns; this list removes what a
 * repository still commits on top of that, such as built bundles and lockfiles.
 */
const repomixNoiseIgnores = [
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/target/**",
  "**/coverage/**",
  "**/node_modules/**",
  "**/vendor/**",
  "**/third_party/**",
  "**/.venv/**",
  "**/testdata/**",
  "**/fixtures/**",
  "**/__snapshots__/**",
  "**/*.snap",
  "**/*.min.*",
  "**/*.map",
  "**/*.lock",
  "**/*-lock.json",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.svg",
  "**/*.ico",
  "**/*.pdf",
  "**/*.zip",
  "**/*.gz",
  "**/*.mp4",
  "**/*.wasm",
  "**/*.woff",
  "**/*.woff2",
  "**/*.ttf",
]

/** Where source, entry points, and prose actually live in a conventional repository. */
const repomixSourceIncludes = [
  "**/src/**",
  "**/lib/**",
  "**/app/**",
  "**/internal/**",
  "**/pkg/**",
  "**/cmd/**",
  "**/bin/**",
  "docs/**",
  "*.md",
  "*.json",
  "*.toml",
  "*.yaml",
  "*.yml",
]

/** Tests and prose, dropped only when the balanced scope is still too large. */
const repomixTestIgnores = ["**/test/**", "**/tests/**", "**/spec/**", "**/*.test.*", "**/*.spec.*"]

interface RepomixScope {
  readonly label: string
  readonly args: ReadonlyArray<string>
}

/**
 * Progressively narrower `repomix` invocations. The first that fits the pack
 * budget wins, so a small repository is packed whole and a large monorepo still
 * produces something the enrich phase can read.
 */
const repomixScopes: ReadonlyArray<RepomixScope> = [
  { label: "whole repository", args: ["--ignore", repomixNoiseIgnores.join(",")] },
  {
    label: "source, entry points, and docs",
    args: ["--ignore", repomixNoiseIgnores.join(","), "--include", repomixSourceIncludes.join(",")],
  },
  {
    label: "source signatures only",
    args: [
      "--ignore", [...repomixNoiseIgnores, ...repomixTestIgnores].join(","),
      "--include", ["**/src/**", "**/lib/**", "**/app/**", "**/internal/**", "**/pkg/**"].join(","),
      "--remove-comments",
      "--remove-empty-lines",
    ],
  },
]

/** Packs the repository with `repomix` and returns the provider's rewritten intent. */
export const runCodebaseAugment = async (
  intent: string,
  provider: GuideProvider,
  context: GuideAugmentContext,
): Promise<string> => {
  if (provider.enrich === undefined) {
    throw new GuideAugmentError("this guide provider does not support codebase augmentation")
  }

  // Outside the repository, so the pack is never mistaken for a tracked file.
  const directory = await mkdtemp(path.join(os.tmpdir(), "trellage-guide-pack-"))
  try {
    context.onPhase(GuideAugmentPhase.PackingRepository)
    let pack: string | undefined
    let oversized = 0
    for (const [index, scope] of repomixScopes.entries()) {
      const packPath = path.join(directory, `pack-${index}.md`)
      context.onActivity(`repomix: packing ${scope.label}`)
      try {
        await context.runner.run(
          "npx",
          ["--yes", "repomix@latest", "--style", "markdown", "--compress", ...scope.args, "-o", packPath],
          {
            cwd: context.cwd,
            timeoutMs: repomixTimeoutMs,
            signal: context.signal,
            outputOverflow: "truncate",
            onOutput: createOutputLineReader(context.onActivity),
          },
        )
      } catch (error) {
        throw new GuideAugmentError(`repomix failed: ${diagnostic(error)}`, { cause: error })
      }
      const candidate = await readFile(packPath, "utf8")
      const length = [...candidate].length
      if (candidate.trim().length === 0) throw new GuideAugmentError("repomix produced an empty pack")
      if (length <= guideEnrichPackMaximumLength) {
        context.onActivity(`repomix: ${scope.label} fits in ${length} characters`)
        pack = candidate
        break
      }
      oversized = length
      context.onActivity(
        `repomix: ${scope.label} is ${length} characters, over the ${guideEnrichPackMaximumLength} budget; narrowing`,
      )
    }
    if (pack === undefined) {
      throw new GuideAugmentError(
        `this repository still packs to ${oversized} characters after narrowing to source signatures, over the ${guideEnrichPackMaximumLength}-character budget. Add an "include" list to repomix.config.json, or run trx guide from a single package directory, then try again.`,
      )
    }

    context.onPhase(GuideAugmentPhase.RewritingIntent)
    const result = await provider.enrich({ intent, pack }, context.onActivity)
    return clampAugmentedIntent(result.intent)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
