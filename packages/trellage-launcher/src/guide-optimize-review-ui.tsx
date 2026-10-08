import React, { useEffect, useRef, useState } from "react"
import { Box, Text, useInput, type Key } from "ink"
import stringWidth from "string-width"
import { MarkdownTextViewport, wrapGuideText } from "./guide-markdown.tsx"
import {
  sharedReviewDocument,
  type OptimizeReviewInput,
} from "./guide-optimize-review.ts"
import type { OptimizeReviewSummary } from "./guide-optimize-store.ts"
import type { SharedReviewApproval } from "./review-store.ts"
import type { GuideOptimizeServices } from "./guide-optimize.ts"
import {
  reviewFailureKindLabel,
  reviewFailurePhaseLabel,
  reviewIncompatibilities,
  maximumReviewCalls,
  reviewSynthesisStatus,
  type ReviewEvent,
  type ReviewRun,
} from "./review-contracts.ts"
import { reviewCheckCatalog } from "./review-catalog.ts"
import { appendReviewOutput, safeOutput } from "./review-ui.tsx"
import { useTheme } from "./termcn/use-theme.ts"

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
  readonly review: ReviewRun | undefined
  readonly height: number
  readonly width: number
  readonly onReview: (review: ReviewRun) => void
  readonly onApproved: (approval: SharedReviewApproval) => void
  readonly onBack: () => void
  readonly onQuit: () => void
  readonly onRestart: (review: ReviewRun | undefined) => void
  readonly onPlan?: () => void
}

const useReview = (props: ReviewProps) => {
  const [mode, setMode] = useState<Mode>(
    props.review === undefined ? "reviewers" : props.review.status === "complete" ? "findings" : "outcome",
  )
  const [reviewerIds, setReviewerIds] = useState<ReadonlySet<string>>(
    new Set(props.services.defaultReviewerIds ?? ["first-principles", "behavior-preservation"]),
  )
  const [index, setIndex] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [progress, setProgress] = useState("")
  const [outputs, setOutputs] = useState<ReadonlyMap<string, ReturnType<typeof appendReviewOutput>>>(new Map())
  const [statuses, setStatuses] = useState<ReadonlyMap<string, string>>(new Map())
  const [tab, setTab] = useState("overview")
  const [scrollPositions, setScrollPositions] = useState<ReadonlyMap<string, number>>(new Map())
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
    setStatuses(new Map([...reviewerIds].map((id) => [id, "queued"])))
    setTab([...reviewerIds][0] ?? "overview")
    setOutputs(new Map())
    setScrollPositions(new Map())
    setMode("running")
    try {
      const review = await props.services.review(
        { ...props.input, reviewerIds: [...reviewerIds] },
        controller.signal,
        (message) => {
          if (mounted.current) setProgress(message)
        },
        (event: ReviewEvent) => {
          if (!mounted.current) return
          if (event.kind === "status") setStatuses((current) => new Map(current).set(event.checkId, event.status))
          else if (event.kind === "synthesis") setStatuses((current) => new Map(current).set("synthesis", event.status))
          else if (event.kind === "text" || event.kind === "activity")
            setOutputs((current) => new Map(current).set(event.checkId,
              appendReviewOutput(current.get(event.checkId), event)))
        },
      )
      if (!mounted.current) return
      setStatuses((current) => new Map([...current, ...[...reviewerIds].map((id): [string, string] =>
        [id, review.results.find((entry) => entry.id === id)?.status ??
          (review.status === "complete" ? "complete" : "failed")]),
        ["synthesis", reviewSynthesisStatus(review)]]))
      props.onReview(review)
      setIndex(0)
      setMode(review.artifacts.some((entry) => entry.id === "synthesis:legacy-document")
        ? review.status === "complete" ? "findings" : "outcome" : "report")
    } catch (cause) {
      if (!mounted.current) return
      setError(messageOf(cause))
      setStatuses((current) => new Map([...current].map(([id, status]) =>
        [id, status === "queued" || status === "running" ? "failed" : status])))
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
  const showReport = (): void => {
    if (props.review?.artifacts.some((entry) => entry.id === "synthesis:legacy-document")) setTab("overview")
    setMode("report")
  }
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
    outputs,
    statuses,
    tab,
    setTab,
    scrollPositions,
    setScrollPositions,
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

const confirmChecks = (flow: ReviewFlow): void => {
  if (flow.reviewerIds.size === 0) { flow.setError("Choose at least one reviewer."); return }
  const assignments = flow.props.services.assignments?.filter((entry) => flow.reviewerIds.has(entry.id))
  const incompatible = assignments ? reviewIncompatibilities({
    ...flow.props.input, checks: assignments, coordinator: flow.props.services.coordinator,
  }) : []
  if (incompatible.length) { flow.setError(incompatible.join("\n")); return }
  flow.setError(undefined)
  flow.setMode("consent")
}

const ReviewerChoices = ({ flow, height }: { readonly flow: ReviewFlow; readonly height: number }) => {
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
    } else if (key.return) confirmChecks(flow)
  })
  const capacity = Math.max(1, height - 8)
  const start = Math.max(0, Math.min(flow.index - Math.floor(capacity / 2), reviewers.length - capacity))
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Choose reviewers</Text>
      <Box flexDirection="column">
        {reviewers.slice(start, start + capacity).map((reviewer, offset) => {
          const index = start + offset
          return (
          <Text
            key={reviewer.id}
            bold={index === flow.index}
            {...(index === flow.index ? { color: "green" as const } : {})}
          >
            {index === flow.index ? "> " : "  "}[{flow.reviewerIds.has(reviewer.id) ? "x" : " "}] {reviewer.title}
          </Text>
          )
        })}
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
    reviewers.some((entry) => reviewCheckCatalog.find((check) => check.id === entry.id)?.evidence === "related-source")
      ? "Selected built-in or architecture checks can read selected diffs, selected untracked text, and related tracked source across this repository. Check for private information."
      : "Selected skill checks receive only selected patches, untracked content or link metadata, commit identities and standards pinned to the comparison base. Related repository source is not shared.",
    ...reviewers.map((entry) => `- ${entry.title}: ${entry.model.model} / ${entry.model.effort}`),
    `Coordinator: ${coordinator.model} / ${coordinator.effort}.`,
    `One batch permits up to ${maximumReviewCalls([...flow.reviewerIds], 1)} SDK requests and worker starts, including recovery. Large snapshots use fresh batches and cross-file checks: up to 128 batches and ${maximumReviewCalls([...flow.reviewerIds], 128)} requests. Tool turns also use model quota.`,
    "One combined synthesis. Built-in checks retain one complete proposal challenge round and at most one correction for each invalid structured response.",
    "Each Ponytail and Matt batch needs structured extraction. The master can ask at most four peer questions in each of two rounds; round two requires new evidence. Failed checks do not retry without bounds.",
    ...(flow.reviewerIds.has("fleet") ? ["Fleet uses exactly six guarded code-review workers per batch. Each completed result must be read; report recovery stays in the same coordinator. Model assignments are shown below.",
      ...(flow.props.services.assignments?.find((entry) => entry.id === "fleet")?.workers.map((worker) =>
        `- ${worker.name}: ${worker.model.model} / ${worker.model.effort}`) ?? [])] : []),
    ...(flow.reviewerIds.has("matt-code-review") ? ["Matt launches only Standards. Spec is unavailable; task context is not a verified Spec."] : []),
    "Request deadlines: built-in 8 minutes. Skill 4 minutes; Fleet 15 minutes per batch. Combined synthesis has a 15-minute budget. Large reviews take longer and use more quota.",
    "Only frozen text tools are available. A failed or incomplete review cannot authorize edits. No-change and unresolved outcomes are valid.",
    ...(flow.reviewerIds.has("improve-codebase-architecture")
      ? [
          "The architecture option loads Matt Pocock's managed skill and codebase-design after consent. First use can fetch their current content. Guide replaces HTML, subagents, questions, and writes with its read-only report and approval steps.",
        ]
      : []),
    "Evidence and partial results are saved privately in this worktree's Git metadata. Reopening them does not call a model.",
  ].join("\n\n")
}

const waitingReport = (flow: ReviewFlow): string =>
  flow.mode === "running"
    ? `${flow.tab}: ${flow.statuses.get(flow.tab) ?? "queued"}.\nWaiting for streamed output. Tab switches reviews; Esc cancels and saves partial evidence.`
    : flow.tab === "synthesis" && flow.props.review ? sharedReviewDocument(flow.props.review) : "No output was saved for this review."

const savedReportContent = (review: ReviewRun | undefined, tab: string): string | undefined => {
  const saved = review?.artifacts.filter((entry) =>
    entry.checkId === tab && !entry.id.includes("skill-"))
    .map((entry) => entry.content).join("\n\n")
  const failed = review?.results.find((entry) => entry.id === tab)?.status === "failed"
  return saved && failed ? `Unvalidated source report. Read-only; not approved findings.\n\n${saved}` : saved
}

const reportContent = (flow: ReviewFlow, savedOnly = false): string => {
  const review = flow.props.review
  const ids = review?.request.checks.map((check) => check.id) ?? [...flow.reviewerIds]
  const live = flow.mode === "running"
  const overview = live
    ? ids.map((id) => `${id}: ${flow.statuses.get(id) ?? "queued"}`).join("\n\n") + `\n\n${flow.progress}`
    : review ? sharedReviewDocument(review) : "No saved review is available."
  const output = flow.outputs.get(flow.tab)?.text
  return flow.tab === "overview" ? overview :
    (!savedOnly && output) || savedReportContent(review, flow.tab) || waitingReport(flow)
}

const reportTabStatus = (flow: ReviewFlow, id: string): string => {
  const current = flow.statuses.get(id)
  if (current) return current
  const review = flow.props.review
  if (id === "synthesis" && review) return reviewSynthesisStatus(review)
  const result = review?.results.find((entry) => entry.id === id)
  if (result) return result.status
  if (flow.mode === "running") return id === "overview" ? "running" : "queued"
  return review?.status ?? "failed"
}

const ReviewReports = ({ flow, height }: { readonly flow: ReviewFlow; readonly height: number }) => {
  const ids = flow.props.review?.request.checks.map((check) => check.id) ?? [...flow.reviewerIds]
  const tabs = [...ids, "overview", "synthesis"]
  const theme = useTheme()
  const [savedOnly, setSavedOnly] = useState(false)
  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow || key.tab)
      flow.setTab(tabs[nextIndex(tabs.indexOf(flow.tab), key.leftArrow || (key.tab && key.shift) ? -1 : 1, tabs.length)]!)
    else if (input === "f" && flow.mode !== "running")
      flow.setMode(flow.props.review?.status === "complete" ? "findings" : "outcome")
    else if (input === "p" && flow.mode !== "running") setSavedOnly((value) => !value)
  })
  const live = flow.mode === "running"
  const labels = tabs.map((id) => {
    const status = reportTabStatus(flow, id)
    const title = ({
      ponytail: "Ponytail", fleet: "Fleet", "matt-code-review": "Matt",
      "first-principles": "First principles", "behavior-preservation": "Behavior",
      "improve-codebase-architecture": "Architecture", overview: "Overview", synthesis: "Synthesis",
    } as Record<string, string>)[id] ?? id
    const text = `${id === flow.tab ? "›" : " "} ${title} [${status}]`
    return { id, title, status, text, width: Math.min(flow.props.width, stringWidth(text) + 4) }
  })
  const tabRows = labels.reduce<Array<typeof labels>>((rows, label) => {
    const last = rows.at(-1)
    if (last && last.reduce((sum, entry) => sum + entry.width, 0) + label.width <= flow.props.width)
      last.push(label)
    else rows.push([label])
    return rows
  }, [])
  // Each bordered row costs three cells vertically. Page the strip on short
  // terminals so eight tabs cannot displace the report or its controls.
  const rowLimit = height >= 30 ? 2 : 1
  const activeRow = tabRows.findIndex((row) => row.some((entry) => entry.id === flow.tab))
  const rowStart = Math.floor(Math.max(0, activeRow) / rowLimit) * rowLimit
  const visibleRows = tabRows.slice(rowStart, rowStart + rowLimit)
  const panelHeight = height - visibleRows.length * 3
  const selected = labels.find((entry) => entry.id === flow.tab)!
  const notice = live ? "Live text is unverified · bounded buffer · full reports saved" :
    !savedOnly && flow.outputs.has(flow.tab) ? "Unverified live buffer · p full saved reports · f findings" :
      "Full saved report · p live buffer · f findings"
  return <Box flexDirection="column" width={flow.props.width} height={height} flexShrink={0}>
    {visibleRows.map((row, index) => <Box key={index} height={3} flexShrink={0}>
      {row.map((entry) => <Box key={entry.id} width={entry.width} height={3} paddingX={1} flexShrink={0}
        borderStyle={entry.id === flow.tab ? "double" : "round"}
        borderColor={entry.id === flow.tab ? theme.colors.focusRing : theme.colors.border}>
        <Text bold={entry.id === flow.tab} color={entry.id === flow.tab ? theme.colors.accent : theme.colors.mutedForeground}
          wrap="truncate-end">{entry.text}</Text>
      </Box>)}
    </Box>)}
    <Box flexDirection="column" width={flow.props.width} height={panelHeight} flexShrink={0}
      borderStyle="round" borderColor={theme.colors.border} paddingX={1}>
      <Text bold wrap="truncate-end">{selected.title} · {selected.status} · {live ? "Live output" : savedOnly ? "Saved report" : "Report"} · Tab {tabs.indexOf(flow.tab) + 1}/{tabs.length}</Text>
      <Text color={theme.colors.mutedForeground} wrap="truncate-end">{notice}</Text>
      <MarkdownTextViewport value={safeOutput(reportContent(flow, savedOnly))} width={flow.props.width - 4} height={Math.max(1, panelHeight - 4)}
      startLine={flow.scrollPositions.get(`${flow.tab}:${savedOnly}`) ?? 0}
      onStartLineChange={(line) => flow.setScrollPositions((current) => new Map(current).set(`${flow.tab}:${savedOnly}`, line))}
        renderDiffs />
    </Box>
  </Box>
}

const canApprove = (review: ReviewRun): boolean =>
  review.status === "complete" && review.execution === "not-started"

const toggleFinding = (flow: ReviewFlow): void => {
  const review = flow.props.review
  const finding = review?.results.flatMap((entry) => entry.findings)[flow.index]
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
  const findings = review?.results.flatMap((entry) => entry.findings) ?? []
  useInput((input, key) => {
    if (flow.saving) return
    const delta = movement(input, key)
    if (delta !== 0) flow.setIndex((value) => nextIndex(value, delta, findings.length))
    else if (input === "p") flow.showReport()
    else if (input === "l" && flow.props.services.plan) flow.props.onPlan?.()
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
            {finding.severity ? `${finding.severity}: ` : ""}{finding.title}
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

const outcomeTitle = (review: ReviewRun | undefined): string => {
  if (review === undefined || review.status === "incomplete") return "Review failed"
  if (review.status === "cancelled") return "Review cancelled"
  if (review.status === "running") return "Review interrupted"
  return "Review outcome unavailable"
}

const outcomeDescription = (review: ReviewRun | undefined): string => {
  if (review === undefined) return "The review could not finish. No saved report is available."
  if (review.status === "incomplete") return "The review stopped before a final verdict. No findings can be approved."
  if (review.status === "cancelled")
    return "The review was cancelled before a final verdict. No findings can be approved."
  if (review.status === "running")
    return "This saved review was still running when reopened. Its partial results are saved and it will not resume automatically."
  return "This review is not available for approval."
}

const outcomeFailureLines = (review: ReviewRun | undefined): ReadonlyArray<string> => {
  const failure = review?.failure
  if (failure === undefined) return []
  return [
    `Failed phase: ${reviewFailurePhaseLabel(failure.phase)}`,
    `Failure reason: ${reviewFailureKindLabel(failure.kind)}. ${failure.message}`,
  ]
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
  const findings = review?.results.flatMap((entry) => entry.findings) ?? []
  const title = outcomeTitle(review)
  const description = outcomeDescription(review)
  const failureLines = outcomeFailureLines(review)
  const details = review?.error ?? flow.error ?? "No failure details were saved."
  useInput((input) => {
    if (input === "p" && review !== undefined) flow.showReport()
    else if (input === "l" && review !== undefined && flow.props.services.plan) flow.props.onPlan?.()
    else if (input === "r") flow.restart()
  })
  const partialFindings = `Partial findings saved: ${findings.length}.`
  const detailsHeading = "Failure details · PgUp/PgDn to read"
  const reservedRows =
    wrapGuideText(title, width).length +
    wrapGuideText(description, width).length +
    failureLines.reduce((rows, line) => rows + wrapGuideText(line, width).length, 0) +
    (review === undefined ? 0 : wrapGuideText(partialFindings, width).length) +
    wrapGuideText(detailsHeading, width).length
  return (
    <Box flexDirection="column" height={height}>
      <Text bold color="yellow">
        {title}
      </Text>
      <Text>{description}</Text>
      {failureLines.map((line) => <Text key={line}>{line}</Text>)}
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
  running: "Tab/Shift+Tab or ←/→ tabs · PgUp/PgDn read · Esc cancel and save",
  findings: "↑/↓ select · Space toggle · p reports · l plan only · Enter approve selected · Esc back",
  outcome: "p reports · l plan only · r inspect target and start a new review · Esc back",
  report: "Tab/Shift+Tab or ←/→ tabs · PgUp/PgDn read · f findings · Esc back",
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
        {flow.mode === "reviewers" ? <ReviewerChoices flow={flow} height={height} /> : null}
        {flow.mode === "consent" ? (
          <MarkdownTextViewport value={consentDocument(flow)} width={props.width} height={height} />
        ) : null}
        {flow.mode === "running" ? <ReviewReports flow={flow} height={height} /> : null}
        {flow.mode === "findings" ? <Findings flow={flow} height={height} /> : null}
        {flow.mode === "outcome" ? <ReviewOutcome flow={flow} height={height} width={props.width} /> : null}
        {flow.mode === "report" && props.review !== undefined ? (
          <ReviewReports flow={flow} height={height} />
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
  readonly onOpen: (review: ReviewRun) => void
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
