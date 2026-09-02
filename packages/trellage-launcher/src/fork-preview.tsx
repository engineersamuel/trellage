/**
 * Fixture-only preview of forking the guide into parallel subflows.
 *
 * From the profile screen you pick a lens or a recommendation and the flow
 * splits: the fork keeps its own prompt candidate and its own destination while
 * the intent and the recommendation list stay shared. Every fork ends as one
 * queued job, so a fork is really a queue entry that is not finished yet.
 *
 * Two variants render that same model with two different ways to move between
 * the main screen and the open forks, and `]` and `[` switch between them live.
 * Both wear the real recommendations screen: the wizard breadcrumbs, the pinned
 * lens row, the bordered rail, and the WHY / COST detail pane.
 *
 * Nothing here calls a model, reads the profile catalog, or launches anything.
 * The recommendations, the candidates, and the destinations are all fixtures.
 *
 * Every state transition is pure and exported so the tests never render Ink,
 * matching `guide-ui.tsx` and `basket-preview.tsx`.
 */
import React, { useReducer } from "react"
import { Box, Text, useApp, useInput, useWindowSize, type Key } from "ink"

import { basketBlockPreview, countLabel } from "./basket.js"

// ---------------------------------------------------------------------------
// Argument parsing.
// ---------------------------------------------------------------------------

export class ForkPreviewArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ForkPreviewArgsError"
  }
}

export const forkPreviewVariants = ["tabs", "inline"] as const

export type ForkPreviewVariant = (typeof forkPreviewVariants)[number]

export interface ForkPreviewArgs {
  readonly help: boolean
  readonly variant: ForkPreviewVariant
}

const forksFlag = "--forks"
const helpFlags = new Set(["--help", "-h"])

const isForkPreviewVariant = (value: string): value is ForkPreviewVariant =>
  forkPreviewVariants.some((variant) => variant === value)

export const forkPreviewHelpText = [
  "Usage:",
  `  trx guide ${forksFlag} [${forkPreviewVariants.join("|")}]`,
  "",
  "Renders two ways to fork the guide into parallel subflows, on the real",
  "recommendations screen, from fixture data. It never calls a model, reads the",
  "profile catalog, or launches anything.",
  "",
  "Everywhere:",
  "  ] [            next or previous variant",
  "  c r h          fork a pinned lens (council, research, HVE RPI)",
  "  L              launch: print every fork and exit",
  "  q              quit",
  "",
  "tabs      a tab bar holds the forks and each fork gets the whole screen;",
  "          Tab and Shift-Tab cycle, ` returns to main, 1-9 jump to one fork.",
  "          Inside a fork: j/k choice, Enter take it, b back, x drop",
  "inline    one rail; a fork and its open choices are rows under the",
  "          recommendations and the detail pane follows the cursor.",
  "          j/k row, Enter acts on the row, x drops the fork under the cursor",
  "",
  "Under 70 columns both variants drop the detail pane and show the rail alone.",
].join("\n")

export const parseForkPreviewArgv = (argv: ReadonlyArray<string>): ForkPreviewArgs => {
  let seenFlag = false
  let variant: ForkPreviewVariant | undefined
  for (const argument of argv) {
    if (helpFlags.has(argument)) return { help: true, variant: variant ?? "tabs" }
    if (argument === forksFlag) {
      if (seenFlag) throw new ForkPreviewArgsError(`Duplicate flag: ${forksFlag}`)
      seenFlag = true
    } else if (!isForkPreviewVariant(argument)) {
      throw new ForkPreviewArgsError(`Unknown variant: ${argument}. Expected one of ${forkPreviewVariants.join(", ")}.`)
    } else if (variant !== undefined) {
      throw new ForkPreviewArgsError(`Only one variant is allowed: ${variant} and ${argument}.`)
    } else {
      variant = argument
    }
  }
  if (!seenFlag) throw new ForkPreviewArgsError(`Fork preview requires ${forksFlag}.`)
  return { help: false, variant: variant ?? "tabs" }
}

// ---------------------------------------------------------------------------
// Fixtures. None of this is read from the catalog.
// ---------------------------------------------------------------------------

export const previewIntent =
  "Hold text highlighted in several Herdr panes and send it to one working session as a single prompt."

export const previewIntentCharacters = 301
export const previewIntentWords = 59
export const previewModel = "gpt-5.6-sol"
export const previewEffort = "medium"

/** One source a fork can start from: a pinned lens or a scored recommendation. */
export interface ForkOrigin {
  readonly key: string
  readonly label: string
  readonly profileRef: string
  readonly harness: string
  readonly workflowId: string
  /** `0` marks a pinned lens, which is not scored against the intent. */
  readonly score: number
  readonly reason: string
  readonly why: string
  readonly tradeoff: string
  readonly skill: string
  readonly sandbox: boolean
  readonly headlessPrompt: boolean
  readonly herdr: string
  readonly prerequisites: string
}

export interface PreviewLens {
  readonly key: string
  readonly emoji: string
  readonly label: string
  readonly description: string
  readonly origin: ForkOrigin
}

/** The pinned lenses, reachable by their own key from every screen. */
export const previewLenses: ReadonlyArray<PreviewLens> = [
  {
    key: "c",
    emoji: "🧠",
    label: "Council",
    description: "Pressure-test the idea and its implementation.",
    origin: {
      key: "council",
      label: "Council",
      profileRef: "native:cpx/council",
      harness: "Copilot",
      workflowId: "three-positions-one-verdict",
      score: 0,
      reason: "Three independent positions argue the change, then one verdict decides it.",
      why: "Runs the same question through three opposed reviewers before any code is written.",
      tradeoff: "Three passes cost three times the tokens of a direct implementation loop.",
      skill: "none",
      sandbox: false,
      headlessPrompt: true,
      herdr: "known-issue",
      prerequisites: "none",
    },
  },
  {
    key: "r",
    emoji: "🔍",
    label: "Research",
    description: "Gather evidence before implementation.",
    origin: {
      key: "research",
      label: "Research",
      profileRef: "native:cdx/research",
      harness: "Codex",
      workflowId: "read-before-write",
      score: 0,
      reason: "Reads the prior work and the surrounding code before it proposes an edit.",
      why: "Front-loads a survey pass, so the first edit lands with the constraints already known.",
      tradeoff: "The survey pass delays the first visible change.",
      skill: "none",
      sandbox: true,
      headlessPrompt: true,
      herdr: "untested",
      prerequisites: "none",
    },
  },
  {
    key: "h",
    emoji: "🧭",
    label: "HVE RPI",
    description: "Run the dedicated HVE Core RPI agent.",
    origin: {
      key: "hve-rpi",
      label: "HVE RPI",
      profileRef: "native:cldx/hve-rpi",
      harness: "Claude",
      workflowId: "risk-plan-implement",
      score: 0,
      reason: "Names the risk, writes the plan, and only then implements, in that order.",
      why: "Blocks implementation behind an explicit risk register and an approved plan.",
      tradeoff: "Two gates before any code makes small changes feel heavy.",
      skill: "hve-core",
      sandbox: false,
      headlessPrompt: true,
      herdr: "verified",
      prerequisites: "hve-core-all plugin",
    },
  },
]

export const previewRecommendations: ReadonlyArray<ForkOrigin> = [
  {
    key: "graph-of-loops",
    label: "Claude Graph Of Loops",
    profileRef: "sandbox:claude-graph-of-loops",
    harness: "Claude",
    workflowId: "start-isolated-feature-branch",
    score: 96,
    reason:
      "Its isolated worktrees, retryable orchestration nodes, and research fan-out closely match implementing a queued current-workspace-or-new-worktree launch flow.",
    why: "Start a new coding task in an isolated git worktree, staffed with a curated specialist agent role.",
    tradeoff: "Its persistent graph and review gates add more machinery than a direct host-native implementation loop.",
    skill: "none",
    sandbox: true,
    headlessPrompt: true,
    herdr: "untested",
    prerequisites: "none",
  },
  {
    key: "poteto-mode",
    label: "Poteto Mode",
    profileRef: "native:cdx/pstack",
    harness: "Codex",
    workflowId: "poteto-mode-entry-point",
    score: 92,
    reason: "Small steps, each one verified against a test before the next one starts.",
    why: "Forces a failing test in front of every change, so nothing lands unverified.",
    tradeoff: "The per-step gate is slow on wide mechanical edits that need no proof.",
    skill: "none",
    sandbox: true,
    headlessPrompt: true,
    herdr: "untested",
    prerequisites: "none",
  },
  {
    key: "copilot",
    label: "Copilot",
    profileRef: "native:omp/copilot",
    harness: "OpenCode",
    workflowId: "pstack-orchestrate-omp",
    score: 88,
    reason: "Fast on well-shaped edits where the target files are already known.",
    why: "Skips the survey pass and edits directly, which suits a scoped, well-described change.",
    tradeoff: "It assumes the scope is right, so a wrong premise is discovered late.",
    skill: "none",
    sandbox: false,
    headlessPrompt: true,
    herdr: "verified",
    prerequisites: "none",
  },
  {
    key: "default",
    label: "Default",
    profileRef: "native:picx/default",
    harness: "Pi",
    workflowId: "subagent-and-workflow-fan-out",
    score: 84,
    reason: "No profile bias, so the harness behaves the way its vendor shipped it.",
    why: "Adds no workflow of its own, which keeps the comparison against the other profiles honest.",
    tradeoff: "Nothing guides it, so quality tracks the prompt alone.",
    skill: "none",
    sandbox: false,
    headlessPrompt: true,
    herdr: "untested",
    prerequisites: "none",
  },
  {
    key: "headlong",
    label: "Headlong",
    profileRef: "native:cdx/headlong",
    harness: "Headlong",
    workflowId: "start-persistent-exploration",
    score: 76,
    reason: "Writes first and asks later, which suits a throwaway spike.",
    why: "Removes the planning gates entirely to reach running code as fast as possible.",
    tradeoff: "It produces code you must review closely, because nothing reviewed it first.",
    skill: "none",
    sandbox: true,
    headlessPrompt: true,
    herdr: "untested",
    prerequisites: "none",
  },
]

const slug = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

export interface ForkChoice {
  readonly name: string
  readonly text: string
}

/** Three prompts of three lengths, so truncation can be judged. */
export const previewCandidates = (label: string): ReadonlyArray<ForkChoice> => [
  {
    name: "direct",
    text: `Work as ${label}. Name the single change that makes the staged basket send one combined prompt, then make it.`,
  },
  {
    name: "structured",
    text: [
      `Work as ${label}.`,
      "",
      "1. Read the composer state model and say what it already holds.",
      "2. Name the one field that must move from the batch onto the entry.",
      "3. Write the failing test first, then the change that makes it pass.",
      "",
      "Report each step with the command you ran and its result.",
    ].join("\n"),
  },
  {
    name: "exploratory",
    text: [
      `Work as ${label}.`,
      "",
      "Before you write code, lay out the options for holding several unfinished",
      "flows in one terminal application. For each option give the state it must",
      "keep, the keys it costs, and the case where it reads badly.",
      "",
      "Assume the intent and the profile recommendations are computed once and",
      "shared by every flow. Assume each flow ends by putting exactly one job in",
      "a queue, and that no flow may take over this terminal.",
      "",
      "Rank the options, say which one you would build, and say why the runner",
      "up loses. Only then write the smallest change that proves the winner.",
    ].join("\n"),
  },
]

export const previewPlacements = (label: string): ReadonlyArray<ForkChoice> => [
  { name: "pane here", text: "pane in this Herdr workspace (split right)" },
  { name: "new worktree", text: `new worktree worktree/${slug(label)} from main` },
  { name: "existing worktree", text: "existing worktree /repo/.worktrees/review" },
]

// ---------------------------------------------------------------------------
// The shared model. Both variants render exactly this.
// ---------------------------------------------------------------------------

export enum ForkStep {
  Candidate = "candidate",
  Placement = "placement",
  Ready = "ready",
}

export interface ForkDraft {
  readonly id: number
  readonly origin: ForkOrigin
  readonly step: ForkStep
  readonly candidateIndex: number
  readonly placementIndex: number
}

export interface ForkPreviewState {
  readonly variant: ForkPreviewVariant
  readonly forks: ReadonlyArray<ForkDraft>
  /** `undefined` means the main screen is showing. */
  readonly activeId: number | undefined
  readonly mainCursor: number
  readonly nextId: number
}

export const initialForkPreviewState = (variant: ForkPreviewVariant): ForkPreviewState => ({
  variant,
  forks: [],
  activeId: undefined,
  mainCursor: 0,
  nextId: 1,
})

export const activeFork = (state: ForkPreviewState): ForkDraft | undefined =>
  state.forks.find((fork) => fork.id === state.activeId)

export const forkChoices = (fork: ForkDraft): ReadonlyArray<ForkChoice> =>
  fork.step === ForkStep.Placement ? previewPlacements(fork.origin.label) : previewCandidates(fork.origin.label)

export const forkChoiceIndex = (fork: ForkDraft): number =>
  fork.step === ForkStep.Placement ? fork.placementIndex : fork.candidateIndex

export const forkPrompt = (fork: ForkDraft): string =>
  previewCandidates(fork.origin.label)[fork.candidateIndex]?.text ?? ""

export const forkPlacement = (fork: ForkDraft): string =>
  previewPlacements(fork.origin.label)[fork.placementIndex]?.text ?? ""

export const readyForks = (state: ForkPreviewState): ReadonlyArray<ForkDraft> =>
  state.forks.filter((fork) => fork.step === ForkStep.Ready)

export const launchSummaryLines = (state: ForkPreviewState): ReadonlyArray<string> => {
  const ready = readyForks(state)
  if (ready.length === 0) return ["No fork is ready. Nothing was launched."]
  const skipped = state.forks.length - ready.length
  return [
    `Launching ${countLabel(ready.length, "fork")}.`,
    ...ready.map((fork) => `${fork.id}. ${fork.origin.profileRef} → ${forkPlacement(fork)}`),
    ...(skipped === 0 ? [] : [`Skipped ${countLabel(skipped, "unfinished fork")}.`]),
  ]
}

// ---------------------------------------------------------------------------
// Rows. `tabs` shows the recommendations alone; `inline` appends every fork
// and its open choices to the same rail.
// ---------------------------------------------------------------------------

export type PreviewRow =
  | { readonly kind: "recommendation"; readonly origin: ForkOrigin }
  | { readonly kind: "fork"; readonly fork: ForkDraft }
  | { readonly kind: "choice"; readonly fork: ForkDraft; readonly index: number; readonly choice: ForkChoice }

const recommendationRows: ReadonlyArray<PreviewRow> = previewRecommendations.map((origin) => ({
  kind: "recommendation" as const,
  origin,
}))

export const inlineRows = (state: ForkPreviewState): ReadonlyArray<PreviewRow> => [
  ...recommendationRows,
  ...state.forks.flatMap((fork) => [
    { kind: "fork" as const, fork },
    ...(fork.step === ForkStep.Ready
      ? []
      : forkChoices(fork).map((choice, index) => ({ kind: "choice" as const, fork, index, choice }))),
  ]),
]

/** The rail the cursor walks: every row in `inline`, recommendations only in `tabs`. */
export const previewRows = (state: ForkPreviewState): ReadonlyArray<PreviewRow> =>
  state.variant === "inline" ? inlineRows(state) : recommendationRows

export const rowAt = (state: ForkPreviewState): PreviewRow | undefined => previewRows(state)[state.mainCursor]

/** The fork a row belongs to, so `inline` knows what the cursor is standing on. */
export const rowFork = (row: PreviewRow | undefined): ForkDraft | undefined =>
  row === undefined || row.kind === "recommendation" ? undefined : row.fork

// ---------------------------------------------------------------------------
// Wizard breadcrumbs, matching the live guide.
// ---------------------------------------------------------------------------

export const wizardStepLabels: ReadonlyArray<string> = ["Profile", "Prompt candidates", "Destination"]

const stepIndexes: Record<ForkStep, number> = {
  [ForkStep.Candidate]: 1,
  [ForkStep.Placement]: 2,
  [ForkStep.Ready]: 2,
}

/** Which breadcrumb is lit: the active fork in `tabs`, the cursor's fork in `inline`. */
export const wizardStepIndex = (state: ForkPreviewState): number => {
  const fork = state.variant === "inline" ? rowFork(rowAt(state)) : activeFork(state)
  return fork === undefined ? 0 : stepIndexes[fork.step]
}

// ---------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------

export enum ForkPreviewActionType {
  NextVariant = "variant/next",
  PreviousVariant = "variant/previous",
  MainNext = "main/next",
  MainPrevious = "main/previous",
  MainActivate = "main/activate",
  ForkLens = "fork/lens",
  GoMain = "fork/go-main",
  NextFork = "fork/next",
  PreviousFork = "fork/previous",
  SelectFork = "fork/select",
  ChoiceNext = "choice/next",
  ChoicePrevious = "choice/previous",
  Advance = "fork/advance",
  Retreat = "fork/retreat",
  DropFork = "fork/drop",
}

export type ForkPreviewAction =
  | { readonly type: Exclude<ForkPreviewActionType, ForkPreviewActionType.ForkLens | ForkPreviewActionType.SelectFork> }
  | { readonly type: ForkPreviewActionType.ForkLens; readonly index: number }
  | { readonly type: ForkPreviewActionType.SelectFork; readonly index: number }

const wrapIndex = (index: number, length: number): number => (length === 0 ? 0 : ((index % length) + length) % length)

const withFork = (state: ForkPreviewState, change: (fork: ForkDraft) => ForkDraft): ForkPreviewState => ({
  ...state,
  forks: state.forks.map((fork) => (fork.id === state.activeId ? change(fork) : fork)),
})

/** In `inline` the cursor lands on the fork's first choice, so Enter advances it. */
const cursorOnFork = (state: ForkPreviewState, id: number): number => {
  if (state.variant !== "inline") return state.mainCursor
  const rows = inlineRows(state)
  const choice = rows.findIndex((row) => row.kind === "choice" && row.fork.id === id)
  return choice >= 0 ? choice : Math.max(0, rows.findIndex((row) => row.kind === "fork" && row.fork.id === id))
}

const openFork = (state: ForkPreviewState, origin: ForkOrigin): ForkPreviewState => {
  const fork: ForkDraft = {
    id: state.nextId,
    origin,
    step: ForkStep.Candidate,
    candidateIndex: 0,
    placementIndex: 0,
  }
  const opened = { ...state, forks: [...state.forks, fork], activeId: fork.id, nextId: state.nextId + 1 }
  return { ...opened, mainCursor: cursorOnFork(opened, fork.id) }
}

const nextStep = (step: ForkStep): ForkStep => (step === ForkStep.Candidate ? ForkStep.Placement : ForkStep.Ready)

const previousStep = (step: ForkStep): ForkStep => (step === ForkStep.Ready ? ForkStep.Placement : ForkStep.Candidate)

const cycleVariant = (state: ForkPreviewState, delta: 1 | -1): ForkPreviewState => ({
  ...state,
  variant:
    forkPreviewVariants[wrapIndex(forkPreviewVariants.indexOf(state.variant) + delta, forkPreviewVariants.length)] ??
    state.variant,
})

const selectForkAt = (state: ForkPreviewState, index: number): ForkPreviewState => {
  const fork = state.forks[index]
  return fork === undefined ? state : { ...state, activeId: fork.id, mainCursor: cursorOnFork(state, fork.id) }
}

/** Enter: fork a recommendation, or take the choice the cursor stands on. */
const activateRow = (state: ForkPreviewState): ForkPreviewState => {
  const row = rowAt(state)
  if (row === undefined) return state
  if (row.kind === "recommendation") return openFork(state, row.origin)
  return stepFork({ ...state, activeId: row.fork.id }, 1)
}

const forkFromLens = (state: ForkPreviewState, index: number): ForkPreviewState => {
  const lens = previewLenses[index]
  return lens === undefined ? state : openFork(state, lens.origin)
}

function stepFork(state: ForkPreviewState, direction: 1 | -1): ForkPreviewState {
  const fork = activeFork(state)
  if (fork === undefined) return state
  if (direction === -1 && fork.step === ForkStep.Candidate) return { ...state, activeId: undefined }
  const stepped = withFork(state, (current) => ({
    ...current,
    step: direction === 1 ? nextStep(current.step) : previousStep(current.step),
  }))
  return { ...stepped, mainCursor: cursorOnFork(stepped, fork.id) }
}

/** The cursor's fork in `inline`, the active fork in `tabs`. */
const targetFork = (state: ForkPreviewState): ForkDraft | undefined =>
  state.variant === "inline" ? rowFork(rowAt(state)) : activeFork(state)

const moveChoice = (state: ForkPreviewState, delta: 1 | -1): ForkPreviewState => {
  const fork = targetFork(state)
  if (fork === undefined || fork.step === ForkStep.Ready) return state
  const length = forkChoices(fork).length
  return {
    ...state,
    forks: state.forks.map((current) =>
      current.id !== fork.id
        ? current
        : current.step === ForkStep.Placement
          ? { ...current, placementIndex: wrapIndex(current.placementIndex + delta, length) }
          : { ...current, candidateIndex: wrapIndex(current.candidateIndex + delta, length) },
    ),
  }
}

const dropFork = (state: ForkPreviewState): ForkPreviewState => {
  const fork = targetFork(state)
  if (fork === undefined) return state
  return { ...state, forks: state.forks.filter((current) => current.id !== fork.id), activeId: undefined }
}

const cycleFork = (state: ForkPreviewState, delta: 1 | -1): ForkPreviewState => {
  if (state.forks.length === 0) return state
  const current = state.forks.findIndex((fork) => fork.id === state.activeId)
  return selectForkAt(state, wrapIndex((current < 0 ? -1 : current) + delta, state.forks.length))
}

const moveCursor = (state: ForkPreviewState, delta: 1 | -1): ForkPreviewState => ({
  ...state,
  mainCursor: wrapIndex(state.mainCursor + delta, Math.max(1, previewRows(state).length)),
})

/**
 * In `inline` the cursor addresses a row, and advancing or dropping a fork
 * removes rows underneath it, so the cursor is pulled back into range.
 */
const clampCursor = (state: ForkPreviewState): ForkPreviewState => {
  const last = Math.max(0, previewRows(state).length - 1)
  return state.mainCursor <= last ? state : { ...state, mainCursor: last }
}

const handlers: Record<ForkPreviewActionType, (state: ForkPreviewState, action: ForkPreviewAction) => ForkPreviewState> =
  {
    [ForkPreviewActionType.NextVariant]: (state) => cycleVariant(state, 1),
    [ForkPreviewActionType.PreviousVariant]: (state) => cycleVariant(state, -1),
    [ForkPreviewActionType.MainNext]: (state) => moveCursor(state, 1),
    [ForkPreviewActionType.MainPrevious]: (state) => moveCursor(state, -1),
    [ForkPreviewActionType.MainActivate]: (state) => activateRow(state),
    [ForkPreviewActionType.ForkLens]: (state, action) =>
      forkFromLens(state, action.type === ForkPreviewActionType.ForkLens ? action.index : 0),
    [ForkPreviewActionType.GoMain]: (state) => ({ ...state, activeId: undefined }),
    [ForkPreviewActionType.NextFork]: (state) => cycleFork(state, 1),
    [ForkPreviewActionType.PreviousFork]: (state) => cycleFork(state, -1),
    [ForkPreviewActionType.SelectFork]: (state, action) =>
      action.type === ForkPreviewActionType.SelectFork ? selectForkAt(state, action.index) : state,
    [ForkPreviewActionType.ChoiceNext]: (state) => moveChoice(state, 1),
    [ForkPreviewActionType.ChoicePrevious]: (state) => moveChoice(state, -1),
    [ForkPreviewActionType.Advance]: (state) => stepFork(state, 1),
    [ForkPreviewActionType.Retreat]: (state) => stepFork(state, -1),
    [ForkPreviewActionType.DropFork]: (state) => dropFork(state),
  }

export const forkPreviewReducer = (state: ForkPreviewState, action: ForkPreviewAction): ForkPreviewState =>
  clampCursor(handlers[action.type](state, action))

// ---------------------------------------------------------------------------
// Key maps. This is where the two variants actually differ.
// ---------------------------------------------------------------------------

export type ForkPreviewCommand = ForkPreviewAction | { readonly type: "quit" } | { readonly type: "launch" }

const lensKeys = previewLenses.map((lens) => lens.key)

const sharedCommand = (input: string): ForkPreviewCommand | undefined => {
  if (input === "]") return { type: ForkPreviewActionType.NextVariant }
  if (input === "[") return { type: ForkPreviewActionType.PreviousVariant }
  if (input === "q") return { type: "quit" }
  if (input === "L") return { type: "launch" }
  const lens = lensKeys.indexOf(input)
  return lens < 0 ? undefined : { type: ForkPreviewActionType.ForkLens, index: lens }
}

const downKey = (input: string, key: Key): boolean => key.downArrow || input === "j"
const upKey = (input: string, key: Key): boolean => key.upArrow || input === "k"

/** Choosing inside a fork, on the screen `tabs` gives that fork. */
const stepCommand = (input: string, key: Key): ForkPreviewCommand | undefined => {
  if (downKey(input, key)) return { type: ForkPreviewActionType.ChoiceNext }
  if (upKey(input, key)) return { type: ForkPreviewActionType.ChoicePrevious }
  if (key.return) return { type: ForkPreviewActionType.Advance }
  if (input === "b") return { type: ForkPreviewActionType.Retreat }
  if (input === "x") return { type: ForkPreviewActionType.DropFork }
  return undefined
}

const railCommand = (input: string, key: Key): ForkPreviewCommand | undefined => {
  if (downKey(input, key)) return { type: ForkPreviewActionType.MainNext }
  if (upKey(input, key)) return { type: ForkPreviewActionType.MainPrevious }
  if (key.return) return { type: ForkPreviewActionType.MainActivate }
  return undefined
}

const digitCommand = (input: string): ForkPreviewCommand | undefined => {
  const digit = Number.parseInt(input, 10)
  return Number.isInteger(digit) && digit >= 1 && digit <= 9
    ? { type: ForkPreviewActionType.SelectFork, index: digit - 1 }
    : undefined
}

const tabsCommand = (state: ForkPreviewState, input: string, key: Key): ForkPreviewCommand | undefined => {
  if (key.tab) return { type: key.shift ? ForkPreviewActionType.PreviousFork : ForkPreviewActionType.NextFork }
  if (input === "`" || key.escape) return { type: ForkPreviewActionType.GoMain }
  return digitCommand(input) ?? (state.activeId === undefined ? railCommand(input, key) : stepCommand(input, key))
}

/**
 * One rail, so the cursor decides: on a recommendation Enter forks it, on a
 * choice Enter takes it. `<` and `>` still move the choice under the cursor
 * without leaving the row.
 */
const inlineCommand = (state: ForkPreviewState, input: string, key: Key): ForkPreviewCommand | undefined => {
  if (downKey(input, key)) return { type: ForkPreviewActionType.MainNext }
  if (upKey(input, key)) return { type: ForkPreviewActionType.MainPrevious }
  if (key.return) return { type: ForkPreviewActionType.MainActivate }
  if (input === "b") return rowFork(rowAt(state)) === undefined ? undefined : { type: ForkPreviewActionType.Retreat }
  if (input === "x") return { type: ForkPreviewActionType.DropFork }
  return undefined
}

const variantCommands: Record<
  ForkPreviewVariant,
  (state: ForkPreviewState, input: string, key: Key) => ForkPreviewCommand | undefined
> = { tabs: tabsCommand, inline: inlineCommand }

/** The rail plus the detail pane needs width; under 70 columns the rail is alone. */
export const showsDetailPane = (columns: number): boolean => columns >= 70

export const forkPreviewCommandForKey = (
  state: ForkPreviewState,
  input: string,
  key: Key,
): ForkPreviewCommand | undefined => sharedCommand(input) ?? variantCommands[state.variant](state, input, key)

// ---------------------------------------------------------------------------
// Result.
// ---------------------------------------------------------------------------

export type ForkPreviewResult =
  | { readonly kind: "quit" }
  | { readonly kind: "launched"; readonly lines: ReadonlyArray<string> }

// ---------------------------------------------------------------------------
// Footers.
// ---------------------------------------------------------------------------

const variantFooters: Record<ForkPreviewVariant, (state: ForkPreviewState) => string> = {
  tabs: (state) =>
    state.activeId === undefined
      ? "↑/↓ or j/k select · ↵ fork it · Tab next fork · 1-9 jump to a fork"
      : "↑/↓ or j/k choice · ↵ take it · b back · x drop · Tab next fork · ` main",
  inline: (state) =>
    rowFork(rowAt(state)) === undefined
      ? "↑/↓ or j/k row · ↵ fork it · everything stays on one rail"
      : "↑/↓ or j/k row · ↵ take this choice · b back · x drop this fork",
}

export const forkPreviewFooterLines = (state: ForkPreviewState): ReadonlyArray<string> => [
  variantFooters[state.variant](state),
  `] [ variant (${state.variant}) · c council · r research · h HVE RPI · L launch · q cancel`,
]

// ---------------------------------------------------------------------------
// Shared pieces. These mirror the live recommendations screen.
// ---------------------------------------------------------------------------

const stepLabels: Record<ForkStep, string> = {
  [ForkStep.Candidate]: "Prompt",
  [ForkStep.Placement]: "Destination",
  [ForkStep.Ready]: "Ready",
}

const WizardBreadcrumbs = ({ activeIndex }: { readonly activeIndex: number }) => (
  <Box marginBottom={1}>
    {wizardStepLabels.map((label, index) => (
      <React.Fragment key={label}>
        {index === 0 ? null : <Text dimColor> › </Text>}
        <Text bold={index === activeIndex} color={index === activeIndex ? "cyan" : index < activeIndex ? "green" : "gray"}>
          {index < activeIndex ? "✓ " : ""}Step {index + 1}: {label}
        </Text>
      </React.Fragment>
    ))}
  </Box>
)

const PinnedLenses = () => (
  <Box flexDirection="column" marginTop={1}>
    <Text bold>PINNED LENSES</Text>
    <Box gap={3}>
      {previewLenses.map((lens) => (
        <Text key={lens.key} wrap="truncate-end">
          <Text bold color="magenta">
            {lens.emoji} {lens.key} {lens.label}
          </Text>
          <Text dimColor> — {lens.description}</Text>
        </Text>
      ))}
    </Box>
  </Box>
)

const ForkBadge = ({ fork }: { readonly fork: ForkDraft }) => (
  <Text color={fork.step === ForkStep.Ready ? "green" : "yellow"}>
    {fork.step === ForkStep.Ready ? "●" : "○"} fork {fork.id}
  </Text>
)

const RailRow = ({ row, active }: { readonly row: PreviewRow; readonly active: boolean }) => {
  if (row.kind === "recommendation") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold={active} {...(active ? { color: "green" as const } : {})} wrap="truncate-end">
          {active ? "❯ " : "  "}
          {row.origin.label}
        </Text>
        <Text dimColor>
          {row.origin.harness} | {row.origin.score}%
        </Text>
        <Text dimColor wrap="truncate-end">
          {row.origin.workflowId}
        </Text>
      </Box>
    )
  }
  if (row.kind === "fork") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold={active} {...(active ? { color: "green" as const } : {})} wrap="truncate-end">
          {active ? "❯ " : "  "}
          <ForkBadge fork={row.fork} />
          {" "}
          {row.fork.origin.label}
        </Text>
        <Text dimColor wrap="truncate-end">
          {"  "}
          {stepLabels[row.fork.step].toLowerCase()}
        </Text>
      </Box>
    )
  }
  const taken = row.index === forkChoiceIndex(row.fork)
  return (
    <Text bold={active} {...(active ? { color: "green" as const } : {})} wrap="truncate-end">
      {active ? "❯ " : "  "}
      <Text {...(taken ? { color: "green" as const } : { dimColor: true })}>{taken ? "◉" : "○"}</Text>
      {"  "}
      {row.choice.name}
    </Text>
  )
}

const Rail = ({
  title,
  cursor,
  rows,
}: {
  readonly title: string
  readonly cursor: number
  readonly rows: ReadonlyArray<PreviewRow>
}) => (
  <Box flexDirection="column" width={30} flexShrink={0} borderStyle="single" borderColor="gray" paddingX={1}>
    <Text bold>{title}</Text>
    {rows.map((row, index) => (
      <RailRow
        key={row.kind === "recommendation" ? row.origin.key : row.kind === "fork" ? `f${row.fork.id}` : `c${row.fork.id}:${row.index}`}
        row={row}
        active={index === cursor}
      />
    ))}
  </Box>
)

/** The WHY / COST pane from the live guide, unchanged in shape. */
const OriginDetail = ({ origin }: { readonly origin: ForkOrigin }) => (
  <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
    <Text bold color="cyan">
      {origin.label}
    </Text>
    <Text dimColor>
      {origin.profileRef} | {origin.harness}
      {origin.score === 0 ? " | pinned lens" : ` | ${origin.score}%`}
    </Text>
    <Text wrap="wrap">{origin.reason}</Text>
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="green">
        WHY THIS PROFILE OVER PLAIN {origin.harness.toUpperCase()}
      </Text>
      <Text wrap="wrap">• {origin.why}</Text>
      <Text wrap="wrap">• Adds the {origin.workflowId} workflow, profile guidance, constraints, and prerequisites.</Text>
    </Box>
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">COST OF THIS CHOICE</Text>
      <Text wrap="wrap">{origin.tradeoff}</Text>
    </Box>
    <Text dimColor>
      Skill: {origin.skill} | Sandbox: {origin.sandbox ? "Docker" : "host"} | Headless prompt:{" "}
      {origin.headlessPrompt ? "yes" : "no"} | Herdr: {origin.herdr}
    </Text>
    <Text dimColor>Prerequisites: {origin.prerequisites}</Text>
  </Box>
)

const ChoiceDetail = ({
  fork,
  choice,
  index,
  width,
}: {
  readonly fork: ForkDraft
  readonly choice: ForkChoice
  readonly index: number
  readonly width: number
}) => (
  <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
    <Text bold color="cyan">
      {stepLabels[fork.step]}: {choice.name}
    </Text>
    <Text dimColor>
      fork {fork.id} · {fork.origin.profileRef} · {choice.text.length} chars
      {index === forkChoiceIndex(fork) ? " · taken" : ""}
    </Text>
    <Box flexDirection="column" marginTop={1}>
      {basketBlockPreview(choice.text, width, 14).lines.map((line, lineIndex) => (
        <Text key={`${choice.name}:${lineIndex}`} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  </Box>
)

const ForkDetail = ({ fork, width }: { readonly fork: ForkDraft; readonly width: number }) => (
  <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
    <Text bold color={fork.step === ForkStep.Ready ? "green" : "yellow"}>
      Fork {fork.id}: {fork.origin.label} · {stepLabels[fork.step].toLowerCase()}
    </Text>
    <Text dimColor>{fork.origin.profileRef}</Text>
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="green">
        DESTINATION
      </Text>
      <Text wrap="wrap">→ {forkPlacement(fork)}</Text>
    </Box>
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="green">
        PROMPT
      </Text>
      {basketBlockPreview(forkPrompt(fork), width, 10).lines.map((line, index) => (
        <Text key={`prompt:${index}`} dimColor wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  </Box>
)

const DetailPane = ({ row, width }: { readonly row: PreviewRow | undefined; readonly width: number }) => {
  if (row === undefined) return null
  if (row.kind === "recommendation") return <OriginDetail origin={row.origin} />
  if (row.kind === "fork") return <ForkDetail fork={row.fork} width={width} />
  return <ChoiceDetail fork={row.fork} choice={row.choice} index={row.index} width={width} />
}

/** Title, metrics and lens row: identical text in both variants. */
const ScreenHeading = ({ forks }: { readonly forks: number }) => (
  <>
    <Text bold color="cyan">
      Profile recommendations
    </Text>
    <Text dimColor wrap="truncate-end">
      Prompt: {previewIntentCharacters} chars · {previewIntentWords} words · Model: {previewModel} · Effort:{" "}
      {previewEffort} · {countLabel(forks, "fork")} open · fixtures only
    </Text>
    <PinnedLenses />
  </>
)

// ---------------------------------------------------------------------------
// The two variants.
// ---------------------------------------------------------------------------

const TabBar = ({ state }: { readonly state: ForkPreviewState }) => (
  <Text wrap="truncate-end">
    <Text inverse={state.activeId === undefined}> main </Text>
    {state.forks.map((fork) => (
      <Text key={fork.id}>
        <Text dimColor> │ </Text>
        <Text inverse={fork.id === state.activeId} color={fork.step === ForkStep.Ready ? "green" : "yellow"}>
          {" "}
          {fork.id} {fork.origin.label} {fork.step === ForkStep.Ready ? "●" : "○"}{" "}
        </Text>
      </Text>
    ))}
  </Text>
)

/** The screen `tabs` gives one fork: its own rail of choices and the same detail pane. */
const ForkScreen = ({
  fork,
  width,
  detail,
}: {
  readonly fork: ForkDraft
  readonly width: number
  readonly detail: boolean
}) => {
  if (fork.step === ForkStep.Ready) {
    return (
      <Box marginTop={1}>
        <ForkDetail fork={fork} width={width} />
      </Box>
    )
  }
  const chosen = forkChoiceIndex(fork)
  const choices = forkChoices(fork)
  const rows: ReadonlyArray<PreviewRow> = choices.map((choice, index) => ({
    kind: "choice" as const,
    fork,
    index,
    choice,
  }))
  return (
    <Box marginTop={1}>
      <Rail title={stepLabels[fork.step].toUpperCase()} cursor={chosen} rows={rows} />
      {detail ? <DetailPane row={rows[chosen]} width={width - 34} /> : null}
    </Box>
  )
}

const MainScreen = ({
  state,
  width,
  detail,
}: {
  readonly state: ForkPreviewState
  readonly width: number
  readonly detail: boolean
}) => {
  const rows = previewRows(state)
  return (
    <Box marginTop={1}>
      <Rail
        title={state.variant === "inline" ? "RECOMMENDATIONS & FORKS" : "RECOMMENDATIONS"}
        cursor={state.mainCursor}
        rows={rows}
      />
      {detail ? <DetailPane row={rows[state.mainCursor]} width={width - 34} /> : null}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The application.
// ---------------------------------------------------------------------------

export const ForkPreviewApp = ({ variant }: { readonly variant: ForkPreviewVariant }) => {
  const { exit } = useApp()
  const { rows, columns } = useWindowSize()
  const [state, dispatch] = useReducer(forkPreviewReducer, variant, initialForkPreviewState)
  const width = Math.max(20, columns - 4)
  const detail = showsDetailPane(columns)
  useInput((input, key) => {
    const command = forkPreviewCommandForKey(state, input, key)
    if (command === undefined) return
    if (command.type === "quit") {
      exit({ kind: "quit" } satisfies ForkPreviewResult)
      return
    }
    if (command.type === "launch") {
      exit({ kind: "launched", lines: launchSummaryLines(state) } satisfies ForkPreviewResult)
      return
    }
    dispatch(command)
  })
  const fork = state.variant === "tabs" ? activeFork(state) : undefined
  return (
    <Box flexDirection="column" height={Math.max(12, rows - 1)} overflowY="hidden" paddingX={1}>
      {state.variant === "tabs" ? <TabBar state={state} /> : null}
      <WizardBreadcrumbs activeIndex={wizardStepIndex(state)} />
      <ScreenHeading forks={state.forks.length} />
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {fork === undefined ? (
          <MainScreen state={state} width={width} detail={detail} />
        ) : (
          <ForkScreen fork={fork} width={width} detail={detail} />
        )}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        {forkPreviewFooterLines(state).map((line) => (
          <Text key={line} dimColor wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  )
}
