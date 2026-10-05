import React, { useEffect, useRef, useState } from "react"
import { Box, Text, useApp, useInput, useWindowSize, type Key } from "ink"
import { MarkdownTextViewport, wrapGuideText } from "./guide-markdown.tsx"
import { spinnerFrameAt } from "./guide-spinner.ts"
import type { ReviewOutput } from "./review-run.ts"
import { useTheme } from "./termcn/use-theme.ts"

export interface ReviewChoice {
  readonly id: string
  readonly label: string
  readonly purpose: string
  readonly models: string
  readonly workers: number
}

export interface ReviewSnapshot {
  readonly branch: string
  readonly baseRef: string
  readonly baseRefSha: string
  readonly baseSha: string
  readonly headSha: string
  readonly changedFiles: ReadonlyArray<string>
  readonly workingTreeFiles: ReadonlyArray<string>
  readonly diffBytes: number
}

export interface ReviewReportTab {
  readonly id: string
  readonly markdown: string
  readonly markdownPath?: string
  readonly status: "complete" | "partial" | "failed"
}

export interface ReviewOutcome {
  readonly markdown: string
  readonly markdownPath: string
  readonly jsonPath: string
  readonly complete: boolean
  readonly reviews?: ReadonlyArray<ReviewReportTab>
}

export type ReviewContinuationDestination = "current-terminal" | "new-herdr-tab" | "new-herdr-worktree"

export interface ReviewContinuation {
  readonly action: "continue"
  readonly destination: ReviewContinuationDestination
  readonly snapshot: ReviewSnapshot
  readonly outcome: ReviewOutcome
}

export type ReviewProgress = (id: string, status: "queued" | "running" | "complete" | "partial" | "failed") => void
export type ReviewOutputCallback = (id: string, output: ReviewOutput) => void

export interface ReviewUiProps {
  readonly choices: ReadonlyArray<ReviewChoice>
  readonly herdrAvailable?: boolean
  readonly prepare: (signal: AbortSignal) => Promise<ReviewSnapshot>
  readonly run: (
    selected: ReadonlyArray<string>,
    snapshot: ReviewSnapshot,
    signal: AbortSignal,
    onProgress: ReviewProgress,
    onOutput: ReviewOutputCallback,
  ) => Promise<ReviewOutcome>
}

type ReviewStage = "preparing" | "select" | "running" | "cancelling" | "report" | "continue-confirm" | "cancelled" | "error"

export const selectReviewIds = (choices: ReadonlyArray<ReviewChoice>, selected: ReadonlySet<string>): ReadonlyArray<string> =>
  choices.filter((choice) => selected.has(choice.id)).map((choice) => choice.id)

export const toggleReviewId = (selected: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

interface ReviewLog {
  readonly text: string
  readonly source: string
}

const safeOutput = (value: string): string => value
  .replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
  .replaceAll(/\r\n?/gu, "\n")
  .replaceAll("\t", "    ")
  .replaceAll(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "")

export const appendReviewOutput = (previous: ReviewLog | undefined, output: ReviewOutput): ReviewLog => {
  const text = safeOutput(output.text)
  if (!text) return previous ?? { text: "", source: "" }
  const current = previous?.text ?? ""
  const prefix = output.kind === "activity" ? "\n" :
    output.source !== previous?.source ? `\n[${safeOutput(output.source ?? "Reviewer")}] ` : ""
  return {
    text: `${current}${prefix}${text}`.slice(-8192),
    source: output.kind === "activity" ? "" : output.source ?? "Reviewer",
  }
}

interface ReviewViewProps {
  readonly stage: ReviewStage
  readonly snapshot: ReviewSnapshot | undefined
  readonly choices: ReadonlyArray<ReviewChoice>
  readonly selected: ReadonlySet<string>
  readonly cursor: number
  readonly statuses: Readonly<Record<string, string>>
  readonly logs: Readonly<Record<string, ReviewLog>>
  readonly outcome: ReviewOutcome | undefined
  readonly failure: string
  readonly destination: ReviewContinuationDestination | undefined
  readonly herdrAvailable: boolean
  readonly activeTab: string
  readonly scrollOffsets: Readonly<Record<string, number>>
  readonly onReportScroll: (id: string, line: number) => void
}

const ReviewChoices = ({ choices, selected, cursor }: Pick<ReviewViewProps, "choices" | "selected" | "cursor">) => {
  const theme = useTheme()
  return (
    <Box flexDirection="column" marginTop={1}>
      {choices.map((choice, index) => (
        <Box key={choice.id} flexDirection="column">
          <Text {...(index === cursor ? { color: theme.colors.focusRing } : {})}>
            {index === cursor ? "› " : "  "}{selected.has(choice.id) ? "[x]" : "[ ]"} {choice.label} · {choice.workers} {choice.workers === 1 ? "worker" : "workers"}
          </Text>
          <Text dimColor>    {choice.purpose} · {choice.models}</Text>
        </Box>
      ))}
      <Text dimColor>↑/↓ choose · Space select · Enter start reviews · Esc exit</Text>
    </Box>
  )
}

const ReviewTarget = ({ snapshot }: { readonly snapshot: ReviewSnapshot }) => {
  const theme = useTheme()
  return (
    <Box flexDirection="column">
      <Text>Branch: {snapshot.branch}</Text>
      <Text>{snapshot.baseRef} {snapshot.baseRefSha.slice(0, 12)} · review base {snapshot.baseSha.slice(0, 12)} → HEAD {snapshot.headSha.slice(0, 12)}</Text>
      <Text>{snapshot.changedFiles.length} {snapshot.changedFiles.length === 1 ? "file" : "files"} · captured patch: {snapshot.diffBytes.toLocaleString("en-US")} bytes ({(snapshot.diffBytes / 1024).toFixed(1)} KiB)</Text>
      {snapshot.baseRefSha !== snapshot.baseSha && (
        <Text color={theme.colors.warning}>Review uses the common ancestor; changes only on {snapshot.baseRef} are excluded.</Text>
      )}
      {snapshot.workingTreeFiles.length > 0 && (
        <Text color={theme.colors.warning}>Included staged, unstaged, and untracked files: {snapshot.workingTreeFiles.length}</Text>
      )}
    </Box>
  )
}

const statusAt = (status: string, tick: number): string =>
  status === "running" ? spinnerFrameAt(tick) : status

const ReviewLiveBox = ({ label, status, log, height, width, offset, tick }: {
  readonly label: string
  readonly status: string
  readonly log: ReviewLog | undefined
  readonly height: number
  readonly width: number
  readonly offset: number
  readonly tick: number
}) => {
  const theme = useTheme()
  const lines = wrapGuideText(log?.text.trim() || (status === "queued" ? "Waiting to start…" : "Waiting for reviewer output…"), width)
  const pageHeight = Math.max(1, height - 3)
  const start = Math.max(0, lines.length - pageHeight - offset)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={
      status === "failed" ? theme.colors.error : status === "complete" ? theme.colors.success : theme.colors.focusRing
    } paddingX={1} height={height} overflowY="hidden">
      <Text bold wrap="truncate-end">{label}: {statusAt(status, tick)} · live output{offset > 0 ? " · scrolled" : ""}</Text>
      {lines.slice(start, start + pageHeight).map((line, index) => <Text key={index} wrap="truncate-end">{line}</Text>)}
    </Box>
  )
}

const reviewTabLabel = (choice: ReviewChoice): string =>
  choice.id === "ponytail" ? "Ponytail" :
    choice.id === "fleet" ? "Fleet" :
      choice.id === "matt-code-review" ? "Matt" : choice.label

const ReviewTabs = ({ choices, selected, statuses, outcome, activeTab, tick }: Pick<
  ReviewViewProps, "choices" | "selected" | "statuses" | "outcome" | "activeTab"
> & { readonly tick: number }) => {
  const theme = useTheme()
  return (
    <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
      {[
        { id: "overview", label: "Overview", status: "" },
        ...choices.filter((choice) => selected.has(choice.id)).map((choice) => ({
          id: choice.id, label: reviewTabLabel(choice),
          status: outcome?.reviews?.find((review) => review.id === choice.id)?.status ?? statuses[choice.id] ?? "queued",
        })),
        ...(statuses.synthesis || outcome ? [{
          id: "synthesis", label: "Synthesis",
          status: outcome ? outcome.complete ? "complete" : "incomplete" : statuses.synthesis ?? "queued",
        }] : []),
      ].map(({ id, label, status }) => (
        <Text key={id} {...(id === activeTab ? { color: theme.colors.focusRing } : {})}
          bold={id === activeTab} wrap="truncate-end">
          {id === activeTab ? "[" : " "}{label}{status ? `: ${statusAt(status, tick)}` : ""}{id === activeTab ? "]" : " "}{" "}
        </Text>
      ))}
    </Box>
  )
}

const ReviewReportActions = ({ outcome, snapshot, stage, destination, herdrAvailable }: {
  readonly outcome: ReviewOutcome
  readonly snapshot: ReviewSnapshot | undefined
  readonly stage: ReviewStage
  readonly destination: ReviewContinuationDestination | undefined
  readonly herdrAvailable: boolean
}) => {
  const theme = useTheme()
  const newWorktree = destination === "new-herdr-worktree"
  const label = newWorktree ? "Create a worktree and plan fixes with Copilot there" :
    destination === "new-herdr-tab" ? "Plan then implement in a new Herdr tab (auto-approved, full access)" : "Plan fixes with Copilot here"
  return (
    <Box flexDirection="column">
      {stage === "continue-confirm" ? (
        <Text color={theme.colors.warning}>{label}? Enter confirms · Esc returns</Text>
      ) : (
        <>
          <Text dimColor>Tab/Shift+Tab switch · PgUp/PgDn read · c plan fixes here{herdrAvailable ? " · t plan then fix in Herdr tab" : ""} · q exits</Text>
          {herdrAvailable && <Text dimColor>{snapshot?.workingTreeFiles.length
            ? "New worktree unavailable: uncommitted changes are not transferred."
            : "w plan in a new worktree from reviewed HEAD"}</Text>}
        </>
      )}
    </Box>
  )
}

const ReviewOverview = ({ choices, selected, statuses, outcome, height, tick }: Pick<
  ReviewViewProps, "choices" | "selected" | "statuses" | "outcome"
> & { readonly height: number; readonly tick: number }) => (
  <Box flexDirection="column" height={height} overflowY="hidden">
    <Text bold>Review status</Text>
    {choices.filter((choice) => selected.has(choice.id)).map((choice) => <Text key={choice.id} wrap="truncate-end">
      {choice.label}: {statusAt(outcome?.reviews?.find((item) => item.id === choice.id)?.status ??
        statuses[choice.id] ?? "queued", tick)}
    </Text>)}
    <Text>Synthesis: {statusAt(outcome ? outcome.complete ? "complete" : "incomplete" :
      statuses.synthesis ?? "queued", tick)}</Text>
    <Text dimColor>Live model text is unverified; saved reports establish coverage.</Text>
  </Box>
)

const SavedReviewPane = ({ choice, outcome, activeTab, scrollOffsets, onReportScroll, height, width }: {
  readonly choice: ReviewChoice | undefined
  readonly outcome: ReviewOutcome
  readonly activeTab: string
  readonly scrollOffsets: ReviewViewProps["scrollOffsets"]
  readonly onReportScroll: ReviewViewProps["onReportScroll"]
  readonly height: number
  readonly width: number
}) => {
  const report = outcome.reviews?.find((item) => item.id === activeTab)
  if (!report && activeTab !== "synthesis") {
    return <Text>No saved reviewer report. Read the combined review for details.</Text>
  }
  const label = report ? choice?.label : "Combined review"
  const status = report?.status ?? (outcome.complete ? "complete" : "incomplete")
  const file = report?.markdownPath ?? (report ? "Report retained in combined JSON." :
    `${outcome.markdownPath} · ${outcome.jsonPath}`)
  return (
    <>
      <Text bold wrap="truncate-end">{label}: {status}</Text>
      <MarkdownTextViewport value={report?.markdown ?? outcome.markdown} width={width}
        height={Math.max(3, height - 2)} startLine={scrollOffsets[activeTab] ?? 0}
        onStartLineChange={(line) => onReportScroll(activeTab, line)} renderDiffs />
      <Text dimColor wrap="truncate-end">{file}</Text>
    </>
  )
}

const ReviewDetail = ({ choices, selected, statuses, logs, outcome, stage, activeTab, scrollOffsets,
  onReportScroll, height, columns, width, tick }: Pick<ReviewViewProps,
  "choices" | "selected" | "statuses" | "logs" | "outcome" | "stage" | "activeTab" |
  "scrollOffsets" | "onReportScroll"
> & { readonly height: number; readonly columns: number; readonly width: number; readonly tick: number }) => {
  const choice = choices.find((item) => selected.has(item.id) && item.id === activeTab)
  if (outcome && (stage === "report" || stage === "continue-confirm")) {
    return <SavedReviewPane choice={choice} outcome={outcome} activeTab={activeTab}
      scrollOffsets={scrollOffsets} onReportScroll={onReportScroll} height={height} width={width} />
  }
  if (!choice && activeTab !== "synthesis") return null
  return <ReviewLiveBox label={choice?.label ?? "Master synthesis"} status={statuses[activeTab] ?? "queued"}
    log={logs[activeTab]} height={height} width={Math.max(1, columns - 6)}
    offset={scrollOffsets[activeTab] ?? 0} tick={tick} />
}

const ReviewPanels = (props: ReviewViewProps & { readonly rows: number; readonly columns: number; readonly width: number }) => {
  const { rows, columns, width, snapshot, choices, selected, statuses, logs, outcome, stage, activeTab, scrollOffsets,
    onReportScroll } = props
  const reviewing = stage === "running" || stage === "cancelling"
  const [tick, setTick] = useState(0)
  const spinning = !outcome && Object.values(statuses).some((status) => status === "running")
  useEffect(() => {
    if (!spinning) return
    const timer = setInterval(() => setTick((current) => current + 1), 80)
    return () => clearInterval(timer)
  }, [spinning])
  const height = Math.max(4, rows - 11 - Number(!!snapshot?.workingTreeFiles.length) -
    Number(!!snapshot && snapshot.baseRefSha !== snapshot.baseSha))
  return (
    <>
      <ReviewTabs choices={choices} selected={selected} statuses={statuses} outcome={outcome} activeTab={activeTab} tick={tick} />
      <Box flexDirection="column" marginTop={1}>
        {activeTab === "overview"
          ? <ReviewOverview choices={choices} selected={selected} statuses={statuses} outcome={outcome} height={height} tick={tick} />
          : <ReviewDetail choices={choices} selected={selected} statuses={statuses} logs={logs}
            outcome={outcome} stage={stage} activeTab={activeTab} scrollOffsets={scrollOffsets}
            onReportScroll={onReportScroll} height={height} columns={columns} width={width} tick={tick} />}
        {reviewing && <Text dimColor>Tab/Shift+Tab switch · PgUp/PgDn scroll · {stage === "cancelling"
          ? "Stopping reviewers and saving partial results…" : "Esc cancels and saves completed results."}</Text>}
      </Box>
    </>
  )
}

const ReviewContent = (props: ReviewViewProps) => {
  const { stage, snapshot, choices, selected, cursor, outcome, failure, destination, herdrAvailable } = props
  const { rows, columns } = useWindowSize()
  const theme = useTheme()
  const width = Math.max(20, columns - 4)
  const message = stage === "error" ? `Error: ${failure}` : stage === "cancelled" ? `Cancelled: ${failure}` : ""
  const reporting = !!outcome && (stage === "report" || stage === "continue-confirm")
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.colors.primary}>Review committed and working-tree changes</Text>
      {stage === "preparing" && <Text>Checking branch and current base… Esc cancels.</Text>}
      {snapshot && <ReviewTarget snapshot={snapshot} />}
      {stage === "select" && (
        <ReviewChoices choices={choices} selected={selected} cursor={cursor} />
      )}
      {(stage === "running" || stage === "cancelling" || reporting) &&
        <ReviewPanels {...props} rows={rows} columns={columns} width={width} />}
      {outcome && reporting && (
        <ReviewReportActions outcome={outcome} snapshot={snapshot} stage={stage}
          destination={destination} herdrAvailable={herdrAvailable} />
      )}
      {message && wrapGuideText(message, width).map((line, index) => (
        <Text key={index} color={theme.colors.error}>{line}</Text>
      ))}
    </Box>
  )
}

const reviewTabDirection = (input: string, key: Key): number => {
  if (key.leftArrow || input === "[" || (key.tab && key.shift)) return -1
  if (key.rightArrow || input === "]" || key.tab) return 1
  return 0
}

export const ReviewApp = ({ choices, prepare, run, herdrAvailable = false }: ReviewUiProps) => {
  const { exit } = useApp()
  const [stage, setStage] = useState<ReviewStage>("preparing")
  const [snapshot, setSnapshot] = useState<ReviewSnapshot>()
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [statuses, setStatuses] = useState<Readonly<Record<string, string>>>({})
  const [logs, setLogs] = useState<Readonly<Record<string, ReviewLog>>>({})
  const [outcome, setOutcome] = useState<ReviewOutcome>()
  const [failure, setFailure] = useState("")
  const [destination, setDestination] = useState<ReviewContinuationDestination>()
  const [activeTab, setActiveTab] = useState("overview")
  const [scrollOffsets, setScrollOffsets] = useState<Readonly<Record<string, number>>>({})
  const runController = useRef<AbortController | undefined>(undefined)
  const pendingOutput = useRef<Array<{ id: string; output: ReviewOutput }>>([])
  const outputTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => {
    runController.current?.abort()
    if (outputTimer.current) clearTimeout(outputTimer.current)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void prepare(controller.signal).then((target) => {
      if (!controller.signal.aborted) {
        setSnapshot(target)
        setStage("select")
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setFailure(errorMessage(error))
        setStage("error")
      }
    })
    return () => controller.abort()
  }, [prepare])

  const start = (): void => {
    if (runController.current || !snapshot || selected.size === 0) return
    const controller = new AbortController()
    runController.current = controller
    const ids = selectReviewIds(choices, selected)
    setStatuses(Object.fromEntries(ids.map((id) => [id, "queued"])))
    setLogs({})
    setActiveTab("overview")
    setScrollOffsets({})
    setStage("running")
    void run(ids, snapshot, controller.signal,
      (id, status) => {
        if (id === "synthesis" || ids.includes(id)) setStatuses((current) => ({ ...current, [id]: status }))
      },
      (id, output) => {
        if (id !== "synthesis" && !ids.includes(id)) return
        pendingOutput.current.push({ id, output: { ...output, text: output.text.slice(-8192) } })
        if (pendingOutput.current.length > 256) pendingOutput.current.splice(0, pendingOutput.current.length - 256)
        if (outputTimer.current) return
        outputTimer.current = setTimeout(() => {
          outputTimer.current = undefined
          const batch = pendingOutput.current.splice(0)
          setLogs((current) => {
            const next = { ...current }
            for (const item of batch) next[item.id] = appendReviewOutput(next[item.id], item.output)
            return next
          })
        }, 80)
      },
    ).then((report) => {
      setOutcome(report)
      setActiveTab((current) => current === "overview" ? "synthesis" : current)
      setStage("report")
    }).catch((error: unknown) => {
      setFailure(errorMessage(error))
      setStage(controller.signal.aborted ? "cancelled" : "error")
    }).finally(() => {
      runController.current = undefined
    })
  }

  const selectInput = (input: string, key: Key): void => {
    const choice = choices[cursor]
    if (key.upArrow || input === "k") setCursor((current) => Math.max(0, current - 1))
    else if (key.downArrow || input === "j") setCursor((current) => Math.min(choices.length - 1, current + 1))
    else if (input === " " && choice) setSelected((current) => toggleReviewId(current, choice.id))
    else if (key.return) start()
    else if (key.escape || input === "q") exit()
  }

  const activeInput = (input: string, key: Key): boolean => {
    if (stage === "preparing") {
      if (key.escape || (key.ctrl && input === "c")) exit()
      return true
    }
    if (stage === "running") {
      if (key.escape || (key.ctrl && input === "c")) {
        setStage("cancelling")
        runController.current?.abort()
      }
      return true
    }
    return stage === "cancelling"
  }

  const reportInput = (input: string, key: Key): void => {
    const next = input === "c" ? "current-terminal" :
      herdrAvailable && input === "t" ? "new-herdr-tab" :
        herdrAvailable && snapshot?.workingTreeFiles.length === 0 && input === "w" ? "new-herdr-worktree" : undefined
    if (next) {
      setDestination(next)
      setStage("continue-confirm")
    } else if (key.escape || input === "q") exit()
  }

  const tabInput = (input: string, key: Key): boolean => {
    const ids = ["overview", ...selectReviewIds(choices, selected),
      ...(statuses.synthesis || outcome ? ["synthesis"] : [])]
    const delta = reviewTabDirection(input, key)
    if (delta) {
      setActiveTab((current) => ids[(ids.indexOf(current) + delta + ids.length) % ids.length]!)
      return true
    }
    if (stage === "running" && (key.pageUp || key.pageDown) && activeTab !== "overview") {
      const pageSize = 6
      setScrollOffsets((current) => ({
        ...current, [activeTab]: Math.max(0, (current[activeTab] ?? 0) + (key.pageUp ? pageSize : -pageSize)),
      }))
      return true
    }
    return false
  }

  const continuationInput = (key: Key): void => {
    if (key.return && destination && snapshot && outcome) {
      exit({ action: "continue", destination, snapshot, outcome } satisfies ReviewContinuation)
    } else if (key.escape) setStage("report")
  }

  useInput((input, key) => {
    if ((stage === "running" || stage === "report") && tabInput(input, key)) return
    if (activeInput(input, key)) return
    if (stage === "select") return selectInput(input, key)
    if (stage === "report") return reportInput(input, key)
    if (stage === "continue-confirm") return continuationInput(key)
    if (key.escape || input === "q") exit()
  })

  return (
    <ReviewContent
      stage={stage}
      snapshot={snapshot}
      choices={choices}
      selected={selected}
      cursor={cursor}
      statuses={statuses}
      logs={logs}
      outcome={outcome}
      failure={failure}
      destination={destination}
      herdrAvailable={herdrAvailable}
      activeTab={activeTab}
      scrollOffsets={scrollOffsets}
      onReportScroll={(id, line) => setScrollOffsets((current) => ({ ...current, [id]: line }))}
    />
  )
}
