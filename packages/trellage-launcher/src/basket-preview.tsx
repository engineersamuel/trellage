/**
 * Fixture-only preview of the staged prompt basket composer overlay.
 *
 * The basket holds text highlighted in several Herdr panes and sends it to one
 * working session as a single prompt. `trx guide --preview` renders the held
 * state as a full-width composer so the layout can be judged in a real terminal
 * at a real width.
 *
 * Staged blocks can be long, so the list truncates each one to a few wrapped
 * lines and the viewer opens the selected block, or the assembled final prompt,
 * in full with paging. The destination that will execute the prompt is always
 * on screen.
 *
 * Nothing here captures from a live pane, calls a model, reads the profile
 * catalog, or launches anything. The chunks are fixtures and "send" only
 * returns the assembled prompt text to the caller.
 *
 * Every state transition and every text-shaping helper is pure and exported so
 * the tests never have to render Ink, matching `guide-ui.tsx`.
 */
import React, { useMemo, useReducer } from "react"
import { Box, Text, useApp, useInput, useWindowSize, type Key } from "ink"
import {
  basketBlockPreview,
  basketVisibleRange,
  countLabel,
  countTextLines,
  previewBlockLines,
  type BasketBlockPreview,
} from "./basket.js"
import { wrapGuideText } from "./guide-ui.js"

// ---------------------------------------------------------------------------
// Argument parsing.
// ---------------------------------------------------------------------------

export class BasketPreviewArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BasketPreviewArgsError"
  }
}

export interface BasketPreviewArgs {
  readonly help: boolean
}

const previewFlag = "--preview"
const helpFlags = new Set(["--help", "-h"])

export const basketPreviewHelpText = [
  "Usage:",
  "  trx guide --preview",
  "",
  "Renders the staged prompt basket composer overlay from fixture data.",
  "It never calls a model, reads the profile catalog, or launches anything.",
  "",
  "List keys:",
  "  down/up        next or previous staged block (j and k also work)",
  "  J K            move the selected block later or earlier",
  "  o              open the selected block in full",
  "  f              open the assembled final prompt in full",
  "  e              edit the selected block",
  "  u              revert the selected block to its captured text",
  "  x X            drop the selected block, clear the basket",
  "  r              restore the fixture blocks",
  "  Enter          send: print the assembled prompt and exit",
  "  q or Esc       quit",
  "",
  "Viewer keys:",
  "  down/up        scroll one line (j and k also work)",
  "  PgDn PgUp      scroll one page",
  "  e              edit the block being viewed",
  "  q or Esc       back to the list",
  "",
  "Editor keys:",
  "  Backspace      delete the last character",
  "  Enter          save the block",
  "  Esc            discard the edit",
].join("\n")

interface BasketPreviewArgsDraft {
  readonly help: boolean
  readonly sawPreview: boolean
}

const applyPreviewToken = (draft: BasketPreviewArgsDraft, token: string): BasketPreviewArgsDraft => {
  if (helpFlags.has(token)) return { ...draft, help: true }
  if (token !== previewFlag) throw new BasketPreviewArgsError(`Preview mode accepts no argument: ${token}`)
  if (draft.sawPreview) throw new BasketPreviewArgsError(`Duplicate flag: ${previewFlag}`)
  return { ...draft, sawPreview: true }
}

/** Parses the `--preview` argument vector `trx guide` forwards to preview mode. */
export const parseBasketPreviewArgv = (argv: ReadonlyArray<string>): BasketPreviewArgs => {
  const draft = argv.reduce<BasketPreviewArgsDraft>(applyPreviewToken, { help: false, sawPreview: false })
  if (!draft.help && !draft.sawPreview) throw new BasketPreviewArgsError(`Preview mode requires ${previewFlag}`)
  return { help: draft.help }
}

// ---------------------------------------------------------------------------
// Fixture basket and destination.
// ---------------------------------------------------------------------------

export interface BasketChunk {
  readonly id: string
  readonly pane: string
  readonly harness: string
  readonly color: string
  readonly capturedAt: string
  readonly text: string
}

/**
 * Where the assembled prompt runs. One destination for the whole basket: the
 * blocks are assembled into a single prompt and handed to one session.
 */
export interface BasketDestination {
  readonly session: string
  readonly launcher: string
  readonly harness: string
  readonly profile: string
  readonly model: string
  readonly effort: string
  readonly sandbox: boolean
  readonly cwd: string
  readonly herdrPane: string
}

export const previewDestination: BasketDestination = {
  session: "profile-match",
  launcher: "cldx",
  harness: "claude",
  profile: "default",
  model: "claude-opus-5",
  effort: "medium",
  sandbox: false,
  cwd: "~/src/trellage",
  herdrPane: "%4 right split",
}

export const previewChunks: ReadonlyArray<BasketChunk> = [
  {
    id: "council",
    pane: "council",
    harness: "claude-council",
    color: "blue",
    capturedAt: "09:38",
    text: [
      "Verdict 3/4: prefer streaming resolve over lockfile pinning for the dev loop; pin only at release.",
      "",
      "Member 1 (for): the dev loop already tolerates a cold first resolve, and streaming removes the",
      "whole class of merge conflicts we keep hitting on the lockfile. Measured 47-55ms warm against",
      "68ms cold, so the cost is inside the noise floor for an interactive command.",
      "",
      "Member 2 (against): cold start on a fresh machine goes from 0.4s to 6.2s because nothing is",
      "cached yet. That is the first impression for a new contributor and it reads as broken.",
      "",
      "Member 4 (for, with a condition): accept streaming, but keep the release job pinned and add a",
      "`--frozen` escape hatch so CI can still fail loudly when a transitive dependency moves.",
      "",
      "Unresolved: whether the offline reuse guarantee survives. Nobody in the room could name the",
      "exact cache directory the resolver reads when the network is gone.",
    ].join("\n"),
  },
  {
    id: "research",
    pane: "research",
    harness: "codex",
    color: "green",
    capturedAt: "09:39",
    text: [
      "mcptoon token savings: 41% p50, 28% p95 across 12 tool schemas (n=340).",
      "",
      "  schema group        p50     p95     calls   accuracy delta",
      "  file operations     46%     33%     104     +0.2%",
      "  shell / process     39%     26%      88     -0.1%",
      "  search / grep       44%     31%      71     +0.0%",
      "  editor / patch      37%     22%      52     -0.4%",
      "  misc                31%     19%      25     +0.1%",
      "",
      "No regression in tool-call accuracy at the 95% interval. The p95 tail is dominated by the",
      "editor/patch group, where the schema carries a long enum of edit modes that does not compress.",
      "Recommend landing this behind a flag and measuring again once the patch schema is trimmed.",
    ].join("\n"),
  },
  {
    id: "doctor",
    pane: "doctor",
    harness: "trx",
    color: "yellow",
    capturedAt: "09:40",
    text: "prx default → agent_not_ready: not an active named agent.",
  },
  {
    id: "trace",
    pane: "trace",
    harness: "shell",
    color: "red",
    capturedAt: "09:42",
    text: [
      "$ trx inventory prx default --json",
      "trx: prx inventory failed for default",
      "",
      "prx: readiness probe timed out after 300000ms",
      "    at probeAgent (/opt/prx/lib/agent.mjs:412:15)",
      "    at async inventory (/opt/prx/lib/inventory.mjs:88:22)",
      "    at async main (/opt/prx/bin/prx:203:5)",
      "",
      "Last 3 probe attempts:",
      "  09:41:58  pane not found",
      "  09:42:03  pane found, agent handshake pending",
      "  09:42:08  pane found, agent handshake pending",
    ].join("\n"),
  },
  {
    id: "spec",
    pane: "spec",
    harness: "editor",
    color: "cyan",
    capturedAt: "09:44",
    text: [
      "Acceptance criteria for the staged prompt basket:",
      "",
      "1. Staging is persistent. A captured block survives pane focus changes and stays held until it",
      "   is sent or explicitly dropped. Closing the source pane must not drop the block.",
      "2. The queue is ordered and reorderable. The assembled prompt follows the on-screen order.",
      "3. Every block records its origin: source pane, harness, and capture time. The assembled",
      "   prompt carries that origin as a `## from <pane> · <time>` header so the receiving agent can",
      "   tell the blocks apart.",
      "4. Long blocks are readable. The list truncates; opening a block shows the whole thing with",
      "   paging, and never reflows into unreadable fragments at 60 columns.",
      "5. A block can be edited in place before sending, and reverted to the captured text.",
      "6. The destination is visible without leaving the composer: launcher, harness, profile, model,",
      "   effort, sandbox flag, working directory, target pane, and session name.",
      "7. Sending is one keystroke and prints the assembled prompt on stdout.",
      "",
      "Out of scope for now: persisting a basket across processes, and capturing from a pane that is",
      "not on the current Herdr workspace.",
    ].join("\n"),
  },
  {
    id: "notes",
    pane: "notes",
    harness: "editor",
    color: "magenta",
    capturedAt: "09:45",
    text: "Constraint: keep offline reuse. No lockfile writes outside release. Doctor must stay under 20s.",
  },
]

const capturedText = (id: string): string | undefined => previewChunks.find((chunk) => chunk.id === id)?.text

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------

export enum BasketPreviewView {
  List = "list",
  Block = "block",
  Final = "final",
  Edit = "edit",
}

export interface BasketPreviewState {
  readonly chunks: ReadonlyArray<BasketChunk>
  readonly cursor: number
  readonly view: BasketPreviewView
  readonly scroll: number
  readonly draft: string
}

export enum BasketPreviewActionType {
  NextChunk = "next-chunk",
  PreviousChunk = "previous-chunk",
  MoveChunkLater = "move-chunk-later",
  MoveChunkEarlier = "move-chunk-earlier",
  DropChunk = "drop-chunk",
  ClearChunks = "clear-chunks",
  RestoreChunks = "restore-chunks",
  RevertChunk = "revert-chunk",
  OpenBlock = "open-block",
  OpenFinal = "open-final",
  CloseView = "close-view",
  Scroll = "scroll",
  EditStart = "edit-start",
  EditAppend = "edit-append",
  EditBackspace = "edit-backspace",
  EditSave = "edit-save",
  EditCancel = "edit-cancel",
}

type PlainBasketPreviewActionType = Exclude<
  BasketPreviewActionType,
  BasketPreviewActionType.Scroll | BasketPreviewActionType.EditAppend
>

export type BasketPreviewAction =
  | { readonly type: PlainBasketPreviewActionType }
  | { readonly type: BasketPreviewActionType.Scroll; readonly delta: number; readonly maximum: number }
  | { readonly type: BasketPreviewActionType.EditAppend; readonly text: string }

/** The basket never holds more than one novel's worth of text; the editor stops there. */
export const previewPromptMaximumLength = 60_000

export const initialBasketPreviewState = (): BasketPreviewState => ({
  chunks: previewChunks,
  cursor: 0,
  view: BasketPreviewView.List,
  scroll: 0,
  draft: "",
})

const selectedChunk = (state: BasketPreviewState): BasketChunk | undefined => state.chunks[state.cursor]

const swapped = (chunks: ReadonlyArray<BasketChunk>, first: number, second: number): ReadonlyArray<BasketChunk> => {
  const left = chunks[first]
  const right = chunks[second]
  if (left === undefined || right === undefined) return chunks
  const next = [...chunks]
  next[first] = right
  next[second] = left
  return next
}

const withSelectedText = (state: BasketPreviewState, text: string): BasketPreviewState => ({
  ...state,
  chunks: state.chunks.map((chunk, index) => (index === state.cursor ? { ...chunk, text } : chunk)),
})

/** The four actions that move the cursor, or the block under it, within the basket. */
const reduceSelection = (state: BasketPreviewState, action: BasketPreviewAction): BasketPreviewState | undefined => {
  const total = state.chunks.length
  switch (action.type) {
    case BasketPreviewActionType.NextChunk:
      return total === 0 ? state : { ...state, cursor: (state.cursor + 1) % total }
    case BasketPreviewActionType.PreviousChunk:
      return total === 0 ? state : { ...state, cursor: (state.cursor - 1 + total) % total }
    case BasketPreviewActionType.MoveChunkLater:
      return state.cursor + 1 >= total
        ? state
        : { ...state, chunks: swapped(state.chunks, state.cursor, state.cursor + 1), cursor: state.cursor + 1 }
    case BasketPreviewActionType.MoveChunkEarlier:
      return state.cursor === 0
        ? state
        : { ...state, chunks: swapped(state.chunks, state.cursor, state.cursor - 1), cursor: state.cursor - 1 }
    default:
      return undefined
  }
}

/** The contents of the basket: dropping, clearing, and undoing an edit. */
const reduceContents = (state: BasketPreviewState, action: BasketPreviewAction): BasketPreviewState | undefined => {
  switch (action.type) {
    case BasketPreviewActionType.DropChunk: {
      if (state.chunks.length === 0) return state
      const chunks = state.chunks.filter((_chunk, index) => index !== state.cursor)
      return { ...state, chunks, cursor: Math.max(0, Math.min(state.cursor, chunks.length - 1)) }
    }
    case BasketPreviewActionType.ClearChunks:
      return { ...state, chunks: [], cursor: 0 }
    case BasketPreviewActionType.RestoreChunks:
      return initialBasketPreviewState()
    case BasketPreviewActionType.RevertChunk: {
      const selected = selectedChunk(state)
      const original = selected === undefined ? undefined : capturedText(selected.id)
      return original === undefined || original === selected?.text ? state : withSelectedText(state, original)
    }
    default:
      return undefined
  }
}

/** Opening, closing, and paging the full-text viewers. */
const reduceView = (state: BasketPreviewState, action: BasketPreviewAction): BasketPreviewState | undefined => {
  switch (action.type) {
    case BasketPreviewActionType.OpenBlock:
      return state.chunks.length === 0 ? state : { ...state, view: BasketPreviewView.Block, scroll: 0 }
    case BasketPreviewActionType.OpenFinal:
      return state.chunks.length === 0 ? state : { ...state, view: BasketPreviewView.Final, scroll: 0 }
    case BasketPreviewActionType.CloseView:
      return { ...state, view: BasketPreviewView.List, scroll: 0 }
    case BasketPreviewActionType.Scroll:
      return { ...state, scroll: Math.max(0, Math.min(state.scroll + action.delta, action.maximum)) }
    default:
      return undefined
  }
}

/** Editing one held block in place. */
const reduceEditor = (state: BasketPreviewState, action: BasketPreviewAction): BasketPreviewState => {
  switch (action.type) {
    case BasketPreviewActionType.EditStart: {
      const selected = selectedChunk(state)
      return selected === undefined ? state : { ...state, view: BasketPreviewView.Edit, draft: selected.text }
    }
    case BasketPreviewActionType.EditAppend:
      return state.draft.length + action.text.length > previewPromptMaximumLength
        ? state
        : { ...state, draft: state.draft + action.text }
    case BasketPreviewActionType.EditBackspace:
      return { ...state, draft: state.draft.slice(0, -1) }
    case BasketPreviewActionType.EditSave:
      return state.draft.trim().length === 0
        ? state
        : { ...withSelectedText(state, state.draft), view: BasketPreviewView.List, scroll: 0, draft: "" }
    case BasketPreviewActionType.EditCancel:
      return { ...state, view: BasketPreviewView.List, scroll: 0, draft: "" }
    default:
      return state
  }
}

export const basketPreviewReducer = (state: BasketPreviewState, action: BasketPreviewAction): BasketPreviewState =>
  reduceSelection(state, action) ??
  reduceContents(state, action) ??
  reduceView(state, action) ??
  reduceEditor(state, action)

// ---------------------------------------------------------------------------
// Text shaping.
// ---------------------------------------------------------------------------

/** Assembles the staged blocks into the single sourced prompt the basket would send. */
export const assembleStagedPrompt = (chunks: ReadonlyArray<BasketChunk>): string =>
  chunks.map((chunk) => `## from ${chunk.pane} · ${chunk.capturedAt}\n${chunk.text}`).join("\n\n")

export const stagedCharacterCount = (chunks: ReadonlyArray<BasketChunk>): number =>
  chunks.reduce((total, chunk) => total + chunk.text.length, 0)

/** True when the held text no longer matches what was captured from the pane. */
export const isChunkEdited = (chunk: BasketChunk, captured: string | undefined): boolean => captured !== chunk.text

/** The two dense lines that say what will run the assembled prompt, and where. */
export const destinationSummaryLines = (destination: BasketDestination): ReadonlyArray<string> => [
  `${destination.launcher} · ${destination.harness}/${destination.profile} · ${destination.model} · effort ${destination.effort} · sandbox ${destination.sandbox ? "on" : "off"}`,
  `${destination.cwd} · herdr pane ${destination.herdrPane} · session ${destination.session}`,
]

// ---------------------------------------------------------------------------
// Key mapping.
// ---------------------------------------------------------------------------

export type BasketPreviewCommand =
  | BasketPreviewAction
  | { readonly type: "submit" }
  | { readonly type: "quit" }
  | { readonly type: "scroll"; readonly delta: number }

const controlCharacters = /[\p{Cc}\p{Cf}]/u

const isPrintableInput = (input: string, key: Key): boolean =>
  !key.ctrl && !key.meta && input.length > 0 && !controlCharacters.test(input)

const listNavigationCommand = (input: string, key: Key): BasketPreviewCommand | undefined => {
  if (key.rightArrow || key.downArrow || input === "j") return { type: BasketPreviewActionType.NextChunk }
  if (key.leftArrow || key.upArrow || input === "k") return { type: BasketPreviewActionType.PreviousChunk }
  if (input === "J") return { type: BasketPreviewActionType.MoveChunkLater }
  if (input === "K") return { type: BasketPreviewActionType.MoveChunkEarlier }
  return undefined
}

const listOpenCommand = (input: string): BasketPreviewCommand | undefined => {
  if (input === "o") return { type: BasketPreviewActionType.OpenBlock }
  if (input === "f") return { type: BasketPreviewActionType.OpenFinal }
  if (input === "e") return { type: BasketPreviewActionType.EditStart }
  if (input === "u") return { type: BasketPreviewActionType.RevertChunk }
  return undefined
}

const listContentsCommand = (input: string): BasketPreviewCommand | undefined => {
  if (input === "x") return { type: BasketPreviewActionType.DropChunk }
  if (input === "X") return { type: BasketPreviewActionType.ClearChunks }
  if (input === "r") return { type: BasketPreviewActionType.RestoreChunks }
  return undefined
}

const listCommand = (input: string, key: Key): BasketPreviewCommand | undefined => {
  if (key.escape || input === "q") return { type: "quit" }
  if (key.return) return { type: "submit" }
  return listNavigationCommand(input, key) ?? listOpenCommand(input) ?? listContentsCommand(input)
}

const viewerCommand = (input: string, key: Key, editable: boolean): BasketPreviewCommand | undefined => {
  if (key.escape || input === "q" || input === "o") return { type: BasketPreviewActionType.CloseView }
  if (key.downArrow || input === "j") return { type: "scroll", delta: 1 }
  if (key.upArrow || input === "k") return { type: "scroll", delta: -1 }
  if (key.pageDown || input === " ") return { type: "scroll", delta: 10 }
  if (key.pageUp) return { type: "scroll", delta: -10 }
  if (editable && input === "e") return { type: BasketPreviewActionType.EditStart }
  return undefined
}

const editorCommand = (input: string, key: Key): BasketPreviewCommand | undefined => {
  if (key.escape) return { type: BasketPreviewActionType.EditCancel }
  if (key.return) return { type: BasketPreviewActionType.EditSave }
  if (key.backspace || key.delete) return { type: BasketPreviewActionType.EditBackspace }
  if (isPrintableInput(input, key)) return { type: BasketPreviewActionType.EditAppend, text: input }
  return undefined
}

/** Maps one keypress onto a command for the view that is on screen. */
export const basketPreviewCommandForKey = (
  input: string,
  key: Key,
  view: BasketPreviewView,
): BasketPreviewCommand | undefined => {
  if (view === BasketPreviewView.Edit) return editorCommand(input, key)
  if (view === BasketPreviewView.Block) return viewerCommand(input, key, true)
  if (view === BasketPreviewView.Final) return viewerCommand(input, key, false)
  return listCommand(input, key)
}

// ---------------------------------------------------------------------------
// Shared chrome.
// ---------------------------------------------------------------------------

/**
 * A narrow terminal cannot hold both halves of a space-between row: the two
 * children overflow into each other instead of truncating, so the caption is
 * dropped rather than allowed to collide with the tabs.
 */
const TabBar = ({ narrow }: { readonly narrow: boolean }) => (
  <Box justifyContent="space-between" flexShrink={0}>
    <Text wrap="truncate-end">
      <Text bold color="magenta">
        trellage
      </Text>
      <Text> </Text>
      <Text inverse> 1 resolve </Text>
      <Text dimColor> 2 build</Text>
    </Text>
    {narrow ? null : (
      <Text dimColor wrap="truncate-end">
        Composer overlay · fixture preview
      </Text>
    )}
  </Box>
)

const DestinationPanel = ({ destination }: { readonly destination: BasketDestination }) => (
  <Box flexDirection="column" flexShrink={0}>
    {destinationSummaryLines(destination).map((line, index) => (
      <Text key={line} wrap="truncate-end">
        <Text bold color="green">
          {index === 0 ? "→ runs on " : "→ in      "}
        </Text>
        <Text dimColor>{line}</Text>
      </Text>
    ))}
  </Box>
)

const StagedHeader = ({ state }: { readonly state: BasketPreviewState }) => (
  <Text bold color="magenta" wrap="truncate-end">
    STAGED PROMPT · {countLabel(state.chunks.length, "block")} · {stagedCharacterCount(state.chunks)} chars ·{" "}
    {countLabel(countTextLines(assembleStagedPrompt(state.chunks)), "line")}
  </Text>
)

const Footer = ({ lines }: { readonly lines: ReadonlyArray<string> }) => (
  <Box flexDirection="column" flexShrink={0}>
    {lines.map((line) => (
      <Text key={line} dimColor wrap="truncate-end">
        {line}
      </Text>
    ))}
  </Box>
)

// ---------------------------------------------------------------------------
// List view.
// ---------------------------------------------------------------------------

const StagedBlock = ({
  chunk,
  index,
  selected,
  preview,
}: {
  readonly chunk: BasketChunk
  readonly index: number
  readonly selected: boolean
  readonly preview: BasketBlockPreview
}) => (
  <Box flexDirection="column" marginBottom={1} flexShrink={0}>
    <Text wrap="truncate-end">
      <Text inverse={selected}> {index + 1} </Text>
      <Text color={chunk.color}> ## from {chunk.pane}</Text>
      <Text dimColor>
        {" "}
        · {chunk.harness} · {chunk.capturedAt} · {chunk.text.length}c · {countLabel(countTextLines(chunk.text), "line")}
      </Text>
      {isChunkEdited(chunk, capturedText(chunk.id)) ? <Text color="yellow"> · edited</Text> : null}
      {preview.truncated ? (
        <Text dimColor color="cyan">
          {" "}
          · o opens
        </Text>
      ) : null}
    </Text>
    {preview.lines.map((line, lineIndex) => (
      <Text key={`${chunk.id}:${lineIndex}`} dimColor={!selected} wrap="truncate-end">
        {line.length === 0 ? " " : line}
      </Text>
    ))}
  </Box>
)

const listFooterLines: ReadonlyArray<string> = [
  "j/k move · J/K reorder · o open block · f final prompt · e edit · u revert",
  "x drop · X clear · r restore · ↵ send · q quit",
]

const ListView = ({
  state,
  height,
  columns,
  narrow,
}: {
  readonly state: BasketPreviewState
  readonly height: number
  readonly columns: number
  readonly narrow: boolean
}) => {
  const width = Math.max(20, columns - 6)
  const previews = state.chunks.map((chunk) => basketBlockPreview(chunk.text, width))
  const heights = previews.map((preview) => preview.lines.length + 2)
  const capacity = Math.max(3, height - 7)
  const { start, end } = basketVisibleRange(heights, state.cursor, capacity)
  return (
    <Box flexDirection="column" height={height} overflowY="hidden">
      <Text dimColor wrap="truncate-end">
        council · research · doctor · trace · spec · notes {narrow ? "" : "— panes dimmed behind the composer"}
      </Text>
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="round"
        borderColor="magenta"
        paddingX={1}
        overflowY="hidden"
      >
        <StagedHeader state={state} />
        <DestinationPanel destination={previewDestination} />
        <Box flexDirection="column" marginTop={1} flexGrow={1} overflowY="hidden">
          {state.chunks.length === 0 ? (
            <Text dimColor wrap="truncate-end">
              basket empty · r restores the fixture blocks
            </Text>
          ) : null}
          {state.chunks.slice(start, end).map((chunk, offset) => (
            <StagedBlock
              key={chunk.id}
              chunk={chunk}
              index={start + offset}
              selected={start + offset === state.cursor}
              preview={previews[start + offset] ?? { lines: [], truncated: false }}
            />
          ))}
        </Box>
        {end - start < state.chunks.length ? (
          <Text dimColor wrap="truncate-end">
            showing blocks {start + 1}–{end} of {state.chunks.length}
          </Text>
        ) : null}
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Full-text viewer.
// ---------------------------------------------------------------------------

const ViewerBody = ({
  lines,
  from,
  capacity,
}: {
  readonly lines: ReadonlyArray<string>
  readonly from: number
  readonly capacity: number
}) => (
  <Box flexDirection="column" flexGrow={1} overflowY="hidden">
    {lines.slice(from, from + capacity).map((line, index) => (
      <Text key={`${from + index}`} wrap="truncate-end">
        {line.length === 0 ? " " : line}
      </Text>
    ))}
  </Box>
)

const ViewerView = ({
  title,
  subtitle,
  lines,
  from,
  capacity,
  height,
}: {
  readonly title: string
  readonly subtitle: string
  readonly lines: ReadonlyArray<string>
  readonly from: number
  readonly capacity: number
  readonly height: number
}) => (
  <Box flexDirection="column" height={height} overflowY="hidden">
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="cyan" paddingX={1} overflowY="hidden">
      <Text bold color="cyan" wrap="truncate-end">
        {title}
      </Text>
      <Text dimColor wrap="truncate-end">
        {subtitle}
      </Text>
      <DestinationPanel destination={previewDestination} />
      <Box marginTop={1} flexGrow={1} overflowY="hidden">
        <ViewerBody lines={lines} from={from} capacity={capacity} />
      </Box>
      <Text dimColor wrap="truncate-end">
        lines {Math.min(from + 1, lines.length)}–{Math.min(from + capacity, lines.length)} of {lines.length}
      </Text>
    </Box>
  </Box>
)

// ---------------------------------------------------------------------------
// Editor.
// ---------------------------------------------------------------------------

const EditView = ({
  state,
  lines,
  height,
}: {
  readonly state: BasketPreviewState
  readonly lines: ReadonlyArray<string>
  readonly height: number
}) => {
  const capacity = Math.max(3, height - 6)
  const shown = lines.slice(Math.max(0, lines.length - capacity))
  return (
    <Box flexDirection="column" height={height} overflowY="hidden">
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="yellow" paddingX={1} overflowY="hidden">
        <Text bold color="yellow" wrap="truncate-end">
          EDIT block {state.cursor + 1} · {selectedChunk(state)?.pane ?? "?"} · {state.draft.length} chars
        </Text>
        <Box flexDirection="column" marginTop={1} flexGrow={1} overflowY="hidden">
          {shown.map((line, index) => (
            <Text key={`${index}`} wrap="truncate-end">
              {index === shown.length - 1 ? `${line}█` : line.length === 0 ? " " : line}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Screen.
// ---------------------------------------------------------------------------

export type BasketPreviewResult = { readonly kind: "submitted"; readonly prompt: string } | { readonly kind: "quit" }

interface ScreenBody {
  readonly node: React.ReactNode
  readonly footer: ReadonlyArray<string>
  readonly maximum: number
}

const viewerScreenBody = (state: BasketPreviewState, lines: ReadonlyArray<string>, height: number): ScreenBody => {
  const capacity = Math.max(3, height - 8)
  const maximum = Math.max(0, lines.length - capacity)
  const from = Math.min(state.scroll, maximum)
  const block = state.view === BasketPreviewView.Block ? selectedChunk(state) : undefined
  const title =
    block === undefined
      ? `FINAL PROMPT · ${countLabel(state.chunks.length, "block")} · ${stagedCharacterCount(state.chunks)} chars`
      : `BLOCK ${state.cursor + 1} of ${state.chunks.length} · ## from ${block.pane} · ${block.capturedAt}`
  const subtitle =
    block === undefined
      ? "exactly what is sent, block headers included"
      : `captured from ${block.pane} · ${block.harness}${isChunkEdited(block, capturedText(block.id)) ? " · edited" : ""}`
  return {
    node: (
      <ViewerView title={title} subtitle={subtitle} lines={lines} from={from} capacity={capacity} height={height} />
    ),
    footer: [
      block === undefined ? "j/k scroll · PgDn/PgUp page · q back" : "j/k scroll · PgDn/PgUp page · e edit · q back",
    ],
    maximum,
  }
}

const screenBody = (
  state: BasketPreviewState,
  lines: ReadonlyArray<string>,
  height: number,
  columns: number,
  narrow: boolean,
): ScreenBody => {
  if (state.view === BasketPreviewView.Edit)
    return {
      node: <EditView state={state} lines={lines} height={height} />,
      footer: ["type to append · Backspace delete · ↵ save · Esc discard"],
      maximum: 0,
    }
  if (state.view === BasketPreviewView.List)
    return {
      node: <ListView state={state} height={height} columns={columns} narrow={narrow} />,
      footer: listFooterLines,
      maximum: 0,
    }
  return viewerScreenBody(state, lines, height)
}

/** The text the active view is showing in full: a block, the final prompt, or the draft. */
export const activeViewText = (state: BasketPreviewState): string => {
  if (state.view === BasketPreviewView.Edit) return state.draft
  if (state.view === BasketPreviewView.Final) return assembleStagedPrompt(state.chunks)
  if (state.view === BasketPreviewView.Block) return selectedChunk(state)?.text ?? ""
  return ""
}

export const BasketPreviewApp = () => {
  const { exit } = useApp()
  const { rows, columns } = useWindowSize()
  const [state, dispatch] = useReducer(basketPreviewReducer, undefined, initialBasketPreviewState)
  const narrow = columns < 70
  const height = Math.max(10, rows - 3)
  const lines = useMemo(() => wrapGuideText(activeViewText(state), Math.max(20, columns - 6)), [state, columns])
  const body = screenBody(state, lines, height, columns, narrow)
  useInput((input, key) => {
    const command = basketPreviewCommandForKey(input, key, state.view)
    if (command === undefined) return
    if (command.type === "quit") {
      exit({ kind: "quit" } satisfies BasketPreviewResult)
      return
    }
    if (command.type === "submit") {
      if (state.chunks.length === 0) return
      exit({ kind: "submitted", prompt: assembleStagedPrompt(state.chunks) } satisfies BasketPreviewResult)
      return
    }
    if (command.type === "scroll") {
      dispatch({ type: BasketPreviewActionType.Scroll, delta: command.delta, maximum: body.maximum })
      return
    }
    dispatch(command)
  })
  return (
    <Box flexDirection="column" height={Math.max(12, rows - 1)} overflowY="hidden" paddingX={1}>
      <TabBar narrow={narrow} />
      {body.node}
      <Footer lines={body.footer} />
    </Box>
  )
}
