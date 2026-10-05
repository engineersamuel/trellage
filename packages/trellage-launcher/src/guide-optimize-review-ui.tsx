import React, { useEffect, useRef, useState } from "react"
import { Box, Text, useInput, type Key } from "ink"
import { MarkdownTextViewport, wrapGuideText } from "./guide-markdown.tsx"
import {
  optimizeReviewDocument,
  optimizeReviewCallLimit,
  type OptimizeApproval,
  type OptimizeReview,
  type OptimizeReviewInput,
} from "./guide-optimize-review.ts"
import type { OptimizeReviewSummary } from "./guide-optimize-store.ts"
import type { GuideOptimizeServices } from "./guide-optimize.ts"

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
const movement = (input: string, key: Key): number => {
  if (key.upArrow || input === "k" || (key.tab && key.shift)) return -1
  if (key.downArrow || input === "j" || key.tab) return 1
  return 0
}
const nextIndex = (index: number, delta: number, count: number): number =>
  count === 0 ? 0 : (index + delta + count) % count

type Mode = "reviewers" | "consent" | "running" | "findings" | "outcome" | "report"
interface ReviewProps {
  readonly services: GuideOptimizeServices
  readonly input: Omit<OptimizeReviewInput, "reviewerIds">
  readonly review: OptimizeReview | undefined
  readonly height: number
  readonly width: number
  readonly onReview: (review: OptimizeReview) => void
  readonly onApproved: (approval: OptimizeApproval) => void
  readonly onBack: () => void
  readonly onQuit: () => void
  readonly onRestart: (review: OptimizeReview | undefined) => void
}

const useReview = (props: ReviewProps) => {
  const [mode, setMode] = useState<Mode>(
    props.review === undefined ? "reviewers" : props.review.status === "complete" ? "findings" : "outcome",
  )
  const [reviewerIds, setReviewerIds] = useState<ReadonlySet<string>>(
    new Set(["first-principles", "behavior-preservation"]),
  )
  const [index, setIndex] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [progress, setProgress] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const active = useRef<AbortController | undefined>(undefined)
  const quitAfterSave = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      active.current?.abort()
    }
  }, [])

  const run = async (): Promise<void> => {
    if (active.current !== undefined) return
    const controller = new AbortController()
    active.current = controller
    setError(undefined)
    setMode("running")
    try {
      const review = await props.services.review(
        { ...props.input, reviewerIds: [...reviewerIds] },
        controller.signal,
        (message) => {
          if (mounted.current) setProgress(message)
        },
      )
      if (!mounted.current) return
      props.onReview(review)
      setIndex(0)
      setMode(review.status === "complete" ? "findings" : "outcome")
    } catch (cause) {
      if (!mounted.current) return
      setError(messageOf(cause))
      setMode("outcome")
    } finally {
      active.current = undefined
      if (mounted.current && quitAfterSave.current) props.onQuit()
    }
  }
  const approve = async (): Promise<void> => {
    const review = props.review
    if (active.current !== undefined || review === undefined) return
    if (selected.size === 0) {
      setError("Select a recommended finding with Space before approving.")
      return
    }
    const controller = new AbortController()
    active.current = controller
    setSaving(true)
    setError(undefined)
    try {
      const approval = await props.services.approve(review.id, [...selected], controller.signal)
      if (mounted.current && !controller.signal.aborted) props.onApproved(approval)
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause))
    } finally {
      active.current = undefined
      if (mounted.current) {
        setSaving(false)
        if (quitAfterSave.current) props.onQuit()
      }
    }
  }
  const back = (): void => {
    setError(undefined)
    if (active.current !== undefined) {
      active.current.abort(new Error("Review cancelled by the user."))
      setProgress("Cancelling model calls and saving partial evidence...")
    } else if (mode === "report") setMode(props.review?.status === "complete" ? "findings" : "outcome")
    else if (mode === "consent") setMode("reviewers")
    else props.onBack()
  }
  const showReport = (): void => setMode("report")
  const restart = (): void => {
    if (active.current !== undefined) return
    setError(undefined)
    props.onRestart(props.review)
  }
  const quit = (): void => {
    if (active.current === undefined) props.onQuit()
    else {
      quitAfterSave.current = true
      back()
    }
  }
  return {
    props,
    mode,
    setMode,
    reviewerIds,
    setReviewerIds,
    index,
    setIndex,
    selected,
    setSelected,
    progress,
    error,
    setError,
    saving,
    run,
    approve,
    back,
    quit,
    showReport,
    restart,
  }
}
type ReviewFlow = ReturnType<typeof useReview>

const ReviewerChoices = ({ flow }: { readonly flow: ReviewFlow }) => {
  const reviewers = flow.props.services.reviewers
  useInput((input, key) => {
    const delta = movement(input, key)
    if (delta !== 0) flow.setIndex((value) => nextIndex(value, delta, reviewers.length))
    else if (input === " ") {
      const reviewer = reviewers[flow.index]
      if (reviewer === undefined) return
      const selected = new Set(flow.reviewerIds)
      if (selected.has(reviewer.id)) selected.delete(reviewer.id)
      else selected.add(reviewer.id)
      flow.setReviewerIds(selected)
    } else if (key.return) {
      if (flow.reviewerIds.size === 0) flow.setError("Choose at least one reviewer.")
      else {
        flow.setError(undefined)
        flow.setMode("consent")
      }
    }
  })
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Choose reviewers</Text>
      <Box flexDirection="column">
        {reviewers.map((reviewer, index) => (
          <Text
            key={reviewer.id}
            bold={index === flow.index}
            {...(index === flow.index ? { color: "green" as const } : {})}
          >
            {index === flow.index ? "> " : "  "}[{flow.reviewerIds.has(reviewer.id) ? "x" : " "}] {reviewer.title}
          </Text>
        ))}
      </Box>
      <Text>{reviewers[flow.index]?.description}</Text>
      <Text dimColor>Independent Copilot SDK sessions, not Native profile replicas.</Text>
      <Text dimColor>
        {reviewers[flow.index]?.model.model} / {reviewers[flow.index]?.model.effort}
      </Text>
    </Box>
  )
}

const consentDocument = (flow: ReviewFlow): string => {
  const reviewers = flow.props.services.reviewers.filter((entry) => flow.reviewerIds.has(entry.id))
  const coordinator = flow.props.services.coordinator
  return [
    "## Confirm read-only review",
    `Review ${flow.props.input.paths.length} selected files. Nothing can edit, stage, or commit through the review tools.`,
    "These models can read selected Git diffs, selected untracked files, and related tracked source text across this repository. Other untracked files are not included. Check for private information before continuing.",
    ...reviewers.map((entry) => `- ${entry.title}: ${entry.model.model} / ${entry.model.effort}`),
    `Coordinator: ${coordinator.model} / ${coordinator.effort}.`,
    `At most ${optimizeReviewCallLimit(reviewers.length)} model calls: independent reviews, one challenge round, then synthesis.`,
    "Includes one correction attempt per invalid response.",
    "Review timeout: 8 minutes. Model quota may be used.",
    "Only frozen text tools are available. A failed or incomplete review cannot authorize edits. No-change and unresolved outcomes are valid.",
    ...(flow.reviewerIds.has("improve-codebase-architecture")
      ? [
          "The architecture option loads Matt Pocock's managed skill and codebase-design after consent. First use can fetch their current content. Guide replaces HTML, subagents, questions, and writes with its read-only report and approval steps.",
        ]
      : []),
    "Evidence and partial results are saved privately in this worktree's Git metadata. Reopening them does not call a model.",
  ].join("\n\n")
}

const canApprove = (review: OptimizeReview): boolean =>
  review.status === "complete" && review.execution === "not-started"

const toggleFinding = (flow: ReviewFlow): void => {
  const review = flow.props.review
  const finding = review?.reports.flatMap((entry) => entry.findings)[flow.index]
  if (review === undefined || finding === undefined) return
  if (
    !canApprove(review) ||
    review.decisions.find((entry) => entry.findingId === finding.id)?.disposition !== "recommended"
  ) {
    flow.setError("Only recommended findings from a complete, unlaunched review can be approved.")
    return
  }
  const selected = new Set(flow.selected)
  if (selected.has(finding.id)) selected.delete(finding.id)
  else selected.add(finding.id)
  flow.setSelected(selected)
}

const Findings = ({ flow, height }: { readonly flow: ReviewFlow; readonly height: number }) => {
  const review = flow.props.review
  const findings = review?.reports.flatMap((entry) => entry.findings) ?? []
  useInput((input, key) => {
    if (flow.saving) return
    const delta = movement(input, key)
    if (delta !== 0) flow.setIndex((value) => nextIndex(value, delta, findings.length))
    else if (input === "p") flow.showReport()
    else if (input === " ") toggleFinding(flow)
    else if (key.return) {
      if (review === undefined || !canApprove(review)) flow.setError("This review cannot authorize implementation.")
      else void flow.approve()
    }
  })
  if (review === undefined) return <Text>Review data is unavailable.</Text>
  const summary =
    review.status === "running"
      ? "This saved review was interrupted or is still running elsewhere. It will not resume automatically."
      : review.summary
  const notice =
    review.execution !== "not-started"
      ? `Execution: ${review.execution}. Inspect the destination. This review cannot be sent again.`
      : review.status !== "complete"
        ? "Review incomplete. No findings can be approved."
        : "Select findings yourself. Nothing is preapproved."
  const summaryLines = wrapGuideText(summary, flow.props.width)
  const summaryLimit = Math.min(3, Math.max(1, height - 6))
  const visibleSummary =
    summaryLines.length > summaryLimit
      ? [...summaryLines.slice(0, summaryLimit - 1), "Summary continues (p for full report)."]
      : summaryLines
  const reserved = visibleSummary.length + wrapGuideText(notice, flow.props.width).length + 4
  const capacity = Math.max(1, height - reserved)
  const start = Math.max(0, Math.min(flow.index - Math.floor(capacity / 2), findings.length - capacity))
  return (
    <Box flexDirection="column">
      <Text bold>
        Review {review.status} · {review.calls} model calls
      </Text>
      <Text>{visibleSummary.join("\n")}</Text>
      <Text color="yellow">{notice}</Text>
      {findings.length === 0 && review.status === "complete" ? (
        <Text>No change recommended. Keep the implementation as it is.</Text>
      ) : null}
      {findings.slice(start, start + capacity).map((finding, index) => {
        const decision = review.decisions.find((entry) => entry.findingId === finding.id)?.disposition ?? "incomplete"
        return (
          <Text
            key={finding.id}
            bold={start + index === flow.index}
            wrap="truncate-end"
            {...(start + index === flow.index ? { color: "green" as const } : {})}
          >
            {start + index === flow.index ? "> " : "  "}[{flow.selected.has(finding.id) ? "x" : " "}] {decision}:{" "}
            {finding.title}
          </Text>
        )
      })}
      <Text dimColor>Findings selected: {flow.selected.size}. Press p for evidence, risks, and replies.</Text>
      {review.error === null ? null : (
        <Text color="yellow" wrap="truncate-end">
          Failure: {review.error} (p for full report)
        </Text>
      )}
      {flow.saving ? <Text>Saving approval. No implementation has started.</Text> : null}
    </Box>
  )
}

const outcomeTitle = (review: OptimizeReview | undefined): string => {
  if (review === undefined || review.status === "incomplete") return "Review failed"
  if (review.status === "cancelled") return "Review cancelled"
  if (review.status === "running") return "Review interrupted"
  return "Review outcome unavailable"
}

const outcomeDescription = (review: OptimizeReview | undefined): string => {
  if (review === undefined) return "The review could not finish. No saved report is available."
  if (review.status === "incomplete") return "The review stopped before a final verdict. No findings can be approved."
  if (review.status === "cancelled")
    return "The review was cancelled before a final verdict. No findings can be approved."
  if (review.status === "running")
    return "This saved review was still running when reopened. Its partial results are saved and it will not resume automatically."
  return "This review is not available for approval."
}

const ReviewOutcome = ({
  flow,
  height,
  width,
}: {
  readonly flow: ReviewFlow
  readonly height: number
  readonly width: number
}) => {
  const review = flow.props.review
  const findings = review?.reports.flatMap((entry) => entry.findings) ?? []
  const title = outcomeTitle(review)
  const description = outcomeDescription(review)
  const details = review?.error ?? flow.error ?? "No failure details were saved."
  useInput((input) => {
    if (input === "p" && review !== undefined) flow.showReport()
    else if (input === "r") flow.restart()
  })
  const partialFindings = `Partial findings saved: ${findings.length}.`
  const detailsHeading = "Failure details · PgUp/PgDn to read"
  const reservedRows =
    wrapGuideText(title, width).length +
    wrapGuideText(description, width).length +
    (review === undefined ? 0 : wrapGuideText(partialFindings, width).length) +
    wrapGuideText(detailsHeading, width).length
  return (
    <Box flexDirection="column" height={height}>
      <Text bold color="yellow">
        {title}
      </Text>
      <Text>{description}</Text>
      {review === undefined ? null : <Text>{partialFindings}</Text>}
      <Text bold>{detailsHeading}</Text>
      <MarkdownTextViewport
        value={details}
        width={width}
        height={Math.max(1, height - reservedRows)}
        resetKey={details}
      />
    </Box>
  )
}

const reviewKeys: Record<Mode, string> = {
  reviewers: "↑/↓ j/k select · Space toggle · Enter continue · Esc back",
  consent: "PgUp/PgDn read · Enter start read-only review · Esc back",
  running: "Esc cancel and save partial evidence",
  findings: "↑/↓ j/k select · Space toggle · p full report · Enter approve selected · Esc back",
  outcome: "p full report · r inspect target and start a new review · Esc back",
  report: "PgUp/PgDn read · Esc back",
}

export const OptimizeReviewPanel = (props: ReviewProps) => {
  const flow = useReview(props)
  useInput((input, key) => {
    if (key.escape) flow.back()
    else if (input === "q" || (key.ctrl && input === "c")) flow.quit()
    else if (flow.mode === "consent" && key.return) void flow.run()
  })
  const keys =
    flow.mode === "outcome" && flow.props.review === undefined
      ? "r inspect target and start a new review · Esc back"
      : reviewKeys[flow.mode]
  const errorRows =
    flow.error === undefined || flow.mode === "outcome" ? 0 : wrapGuideText(flow.error, props.width).length
  const height = Math.max(1, props.height - wrapGuideText(keys, props.width).length - errorRows)
  return (
    <Box flexDirection="column" height={props.height}>
      <Box flexDirection="column" height={height} flexGrow={1}>
        {flow.mode === "reviewers" ? <ReviewerChoices flow={flow} /> : null}
        {flow.mode === "consent" ? (
          <MarkdownTextViewport value={consentDocument(flow)} width={props.width} height={height} />
        ) : null}
        {flow.mode === "running" ? (
          <Box flexDirection="column" gap={1}>
            <Text bold>Read-only optimization in progress</Text>
            <Text>{flow.progress}</Text>
            <Text dimColor>No implementation agent is running.</Text>
          </Box>
        ) : null}
        {flow.mode === "findings" ? <Findings flow={flow} height={height} /> : null}
        {flow.mode === "outcome" ? <ReviewOutcome flow={flow} height={height} width={props.width} /> : null}
        {flow.mode === "report" && props.review !== undefined ? (
          <MarkdownTextViewport value={optimizeReviewDocument(props.review)} width={props.width} height={height} />
        ) : null}
      </Box>
      {flow.error === undefined || flow.mode === "outcome" ? null : <Text color="yellow">{flow.error}</Text>}
      <Text dimColor>{keys}</Text>
    </Box>
  )
}

export const OptimizeHistory = ({
  services,
  height,
  onOpen,
}: {
  readonly services: GuideOptimizeServices
  readonly height: number
  readonly onOpen: (review: OptimizeReview) => void
}) => {
  const [records, setRecords] = useState<ReadonlyArray<OptimizeReviewSummary>>([])
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const controller = useRef(new AbortController())
  useEffect(() => {
    const current = new AbortController()
    controller.current = current
    const signal = current.signal
    void services.history(signal).then(
      (value) => {
        if (!signal.aborted) {
          setRecords(value)
          setBusy(false)
        }
      },
      (cause: unknown) => {
        if (!signal.aborted) {
          setError(messageOf(cause))
          setBusy(false)
        }
      },
    )
    return () => current.abort()
  }, [services])
  const open = async (): Promise<void> => {
    const saved = records[index]
    if (saved === undefined || busy) return
    setBusy(true)
    try {
      const review = await services.readReview(saved.id, controller.current.signal)
      if (!controller.current.signal.aborted) onOpen(review)
    } catch (cause) {
      if (!controller.current.signal.aborted) {
        setError(messageOf(cause))
        setBusy(false)
      }
    }
  }
  useInput((input, key) => {
    if (busy) return
    const delta = movement(input, key)
    if (delta !== 0) setIndex((value) => nextIndex(value, delta, records.length))
    else if (key.return) void open()
  })
  const capacity = Math.max(1, height - 3)
  const start = Math.max(0, Math.min(index - Math.floor(capacity / 2), records.length - capacity))
  const statusLabel = (status: OptimizeReviewSummary["status"]): string =>
    status === "incomplete" ? "failed" : status === "running" ? "interrupted" : status
  return (
    <Box flexDirection="column">
      <Text>Saved in this worktree's Git metadata. Reopen without model calls.</Text>
      {busy ? <Text>Reading saved reviews...</Text> : null}
      {!busy && records.length === 0 ? <Text>No saved reviews. Press Esc to choose a change scope.</Text> : null}
      {records.slice(start, start + capacity).map((entry, item) => (
        <Text key={entry.id} bold={start + item === index} wrap="truncate-end">
          {start + item === index ? "> " : "  "}
          {entry.createdAt} · {statusLabel(entry.status)} · {entry.id}
        </Text>
      ))}
      {error === undefined ? null : <Text color="yellow">{error}</Text>}
    </Box>
  )
}
