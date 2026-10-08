import React, { useEffect, useRef, useState } from "react"
import { Box, Text, useApp, useInput, usePaste, useWindowSize, type Key } from "ink"
import { MarkdownTextViewport, wrapGuideText } from "./guide-markdown.tsx"
import { OptimizeHistory, OptimizeReviewPanel } from "./guide-optimize-review-ui.tsx"
import type { OptimizeReviewInput } from "./guide-optimize-review.ts"
import type { ReviewRun } from "./review-contracts.ts"
import type { SharedReviewApproval } from "./review-store.ts"
import {
  type GuideOptimizeScope,
  type GuideOptimizeTarget,
} from "./guide-optimize-target.ts"
import {
  buildGuideOptimizePrompt,
  type GuideOptimizeRequest,
  type GuideOptimizeServices,
  type GuideOptimizeTerminalResult,
} from "./guide-optimize.ts"
import { text } from "./guide-text.ts"
import type { ReviewPlanTerminalResult } from "./review-planning.ts"

type Stage =
  | "scope"
  | "base"
  | "target"
  | "review"
  | "history"
  | "profile"
  | "action"
  | "plan"
  | "plan-confirm"
  | "destination"
  | "confirm"
  | "preview"
  | "sending"
  | "result"
type Loaded =
  | { readonly kind: "unselected" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly target: GuideOptimizeTarget }

interface OptimizeProps {
  readonly services: GuideOptimizeServices
  readonly rows: number
  readonly columns: number
  readonly originalIntent?: string | undefined
  readonly intent?: string | undefined
  readonly initialBase?: string | undefined
  readonly blockedReason?: string | undefined
  readonly terminalBlockedReason?: string | undefined
  readonly onBack: (submitted: boolean) => void
  readonly onTerminal: (result: GuideOptimizeTerminalResult | ReviewPlanTerminalResult) => void
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
const cycle = (index: number, delta: number, count: number): number =>
  count === 0 ? 0 : (index + delta + count) % count
const reviewContextOf = (review: ReviewRun): Pick<OptimizeReviewInput, "originalIntent" | "intent"> => ({
  ...(review.request.originalIntent === undefined ? {} : { originalIntent: review.request.originalIntent }),
  ...(review.request.intent === undefined ? {} : { intent: review.request.intent }),
})
const movement = (input: string, key: Key): -1 | 1 | undefined => {
  if (key.upArrow || input === "k" || (key.tab && key.shift)) return -1
  if (key.downArrow || input === "j" || key.tab) return 1
  return undefined
}

const useOptimizeFlow = (props: OptimizeProps) => {
  const [scope, setScope] = useState<GuideOptimizeScope | undefined>(
    props.initialBase === undefined ? undefined : { kind: "branch", baseRef: props.initialBase },
  )
  const [scopeIndex, setScopeIndex] = useState(0)
  const [revision, setRevision] = useState(0)
  const [loaded, setLoaded] = useState<Loaded>({ kind: props.initialBase === undefined ? "unselected" : "loading" })
  const [stage, setStage] = useState<Stage>(props.initialBase === undefined ? "scope" : "target")
  const [paths, setPaths] = useState<ReadonlySet<string>>(new Set())
  const [fileIndex, setFileIndex] = useState(0)
  const [profileIndex, setProfileIndex] = useState(0)
  const [destinationIndex, setDestinationIndex] = useState(0)
  const [review, setReview] = useState<ReviewRun | undefined>()
  const [reviewContext, setReviewContext] = useState<
    Pick<OptimizeReviewInput, "originalIntent" | "intent"> | undefined
  >()
  const [approval, setApproval] = useState<SharedReviewApproval | undefined>()
  const [baseDraft, setBaseDraft] = useState(props.initialBase ?? "")
  const [otherEditorsStopped, setOtherEditorsStopped] = useState(false)
  const [automatic, setAutomatic] = useState(false)
  const [actionIndex, setActionIndex] = useState(0)
  const [planDestination, setPlanDestination] = useState<"terminal" | "worktree">("terminal")
  const [error, setError] = useState<string | undefined>()
  const [preview, setPreview] = useState({ value: "", returnStage: "target" as Stage })
  const [result, setResult] = useState({ message: "", submitted: false })
  const submission = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => submission.current?.abort(), [])
  useEffect(() => {
    if (props.blockedReason !== undefined) {
      setLoaded({ kind: "failed", message: props.blockedReason })
      return
    }
    if (scope === undefined) {
      setLoaded({ kind: "unselected" })
      return
    }
    const controller = new AbortController()
    setLoaded({ kind: "loading" })
    setStage("target")
    setError(undefined)
    setOtherEditorsStopped(false)
    void props.services.inspect(scope, controller.signal).then(
      (target) => {
        if (controller.signal.aborted) return
        setLoaded({ kind: "ready", target })
        setBaseDraft(target.base?.ref ?? "")
        setPaths(
          new Set(
            target.changes
              .filter((entry) => entry.kind === "file" || entry.kind === "deleted")
              .map((entry) => entry.path),
          ),
        )
        setFileIndex(0)
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return
        controller.abort()
        setLoaded({ kind: "failed", message: messageOf(cause) })
      },
    )
    return () => controller.abort()
  }, [props.services, props.blockedReason, scope, revision])

  const selectedProfile = () => {
    const profile = props.services.profiles[profileIndex]
    if (profile === undefined) throw new Error("No eligible Native profile is installed.")
    return profile
  }
  const openHandoff = async (next: "action" | "plan"): Promise<void> => {
    if (submission.current) return
    const controller = new AbortController()
    submission.current = controller
    setStage("sending")
    setError(undefined)
    try {
      await props.services.refreshProfiles?.(controller.signal)
      if (!controller.signal.aborted) setStage(next)
    } catch (cause) {
      setError(messageOf(cause))
      setStage("review")
    } finally {
      submission.current = undefined
    }
  }
  const request = (): GuideOptimizeRequest => {
    if (review === undefined || approval === undefined)
      throw new Error("Approve saved review findings before continuing.")
    const destination = props.services.destinations[destinationIndex]
    if (destination === undefined) throw new Error("Choose an available destination.")
    if (destination === "terminal" && props.terminalBlockedReason !== undefined)
      throw new Error(props.terminalBlockedReason)
    return {
      target: review.request.target,
      paths: review.request.paths,
      approval,
      destination,
      otherEditorsStopped,
      ...(automatic ? { automatic: true } : {}),
      ...(review.request.originalIntent === undefined ? {} : { originalIntent: review.request.originalIntent }),
      ...(review.request.intent === undefined ? {} : { intent: review.request.intent }),
    }
  }
  const attempt = (action: () => void): void => {
    setError(undefined)
    try {
      action()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }
  const appendBase = (input: string): void =>
    attempt(() => {
      const value = baseDraft + input
      text(value, "Comparison base", 256, { preserve: true })
      setBaseDraft(value)
    })
  const showPreview = (value: string): void => {
    setPreview({ value, returnStage: stage })
    setStage("preview")
  }
  const chooseBase = (): void => {
    setError(undefined)
    if (loaded.kind === "failed") setLoaded({ kind: "unselected" })
    setStage("base")
  }
  const execute = async (): Promise<void> => {
    if (submission.current) return
    const controller = new AbortController()
    submission.current = controller
    setStage("sending")
    setError(undefined)
    try {
      const current = request()
      if (!current.otherEditorsStopped)
        throw new Error("Confirm that other agents and editors have stopped changing this worktree.")
      const profile = selectedProfile()
      buildGuideOptimizePrompt(current)
      if (current.destination === "terminal") {
        props.onTerminal({ action: "optimize-terminal", request: current, selectedProfile: profile.profile })
        return
      }
      const receipt = await props.services.execute(current, profile.ref, controller.signal)
      setResult({
        message: `${receipt.message}\n\nPane: ${receipt.paneId}\nDo not start another editor on these files while it runs.`,
        submitted: true,
      })
    } catch (cause) {
      setResult({
        message: `${messageOf(cause)}\n\nNo automatic retry. Inspect the destination pane before launching again.`,
        submitted: false,
      })
    }
    setStage("result")
  }
  const plan = async (): Promise<void> => {
    if (submission.current || !review || !props.services.plan) return
    const controller = new AbortController()
    submission.current = controller
    setStage("sending")
    try {
      if (planDestination === "terminal" && props.terminalBlockedReason) throw new Error(props.terminalBlockedReason)
      const result = await props.services.plan(review, planDestination, controller.signal)
      if ("action" in result) { props.onTerminal(result); return }
      setResult({ message: `${result.message}\nPane: ${result.paneId}`, submitted: true })
    } catch (error) {
      setResult({ message: `${messageOf(error)}\nNo automatic retry. Inspect the destination before another handoff.`, submitted: false })
    }
    setStage("result")
  }
  const back = (): void => {
    setError(undefined)
    if (stage === "sending") {
      setError("Waiting for the handoff result. Delivery may already have started.")
      return
    }
    const previous: Partial<Record<Stage, Stage>> = {
      base: loaded.kind === "ready" ? "target" : "scope",
      review: "target",
      history: loaded.kind === "ready" ? "target" : "scope",
      profile: "review",
      action: "review",
      plan: "review",
      "plan-confirm": "plan",
      destination: "profile",
      confirm: automatic ? "action" : props.services.destinations.length > 1 ? "destination" : "profile",
      preview: preview.returnStage,
    }
    const parent = previous[stage]
    if (parent === undefined || props.blockedReason !== undefined) props.onBack(result.submitted)
    else {
      setOtherEditorsStopped(false)
      setStage(parent)
    }
  }
  return {
    props,
    automatic,
    setAutomatic,
    actionIndex,
    setActionIndex,
    planDestination,
    setPlanDestination,
    plan,
    scopeIndex,
    setScopeIndex,
    loaded,
    stage,
    setStage,
    paths,
    setPaths,
    fileIndex,
    setFileIndex,
    review,
    setReview,
    reviewContext,
    setReviewContext,
    approval,
    setApproval,
    destinationIndex,
    setDestinationIndex,
    profileIndex,
    setProfileIndex,
    baseDraft,
    setBaseDraft,
    otherEditorsStopped,
    setOtherEditorsStopped,
    error,
    setError,
    preview,
    result,
    selectedProfile,
    openHandoff,
    request,
    attempt,
    appendBase,
    showPreview,
    chooseBase,
    execute,
    back,
    setScope,
    setLoaded,
    refresh: () => {
      if (loaded.kind === "ready") setScope(loaded.target.scope)
      setRevision((value) => value + 1)
    },
    resetDelivery: () => {
      submission.current = undefined
      setAutomatic(false)
      setActionIndex(0)
    },
  }
}

type Flow = ReturnType<typeof useOptimizeFlow>

const FileChoices = ({
  flow,
  height,
  width,
}: {
  readonly flow: Flow
  readonly height: number
  readonly width: number
}) => {
  const changes = flow.loaded.kind === "ready" ? flow.loaded.target.changes : []
  useInput((input, key) => {
    const delta = movement(input, key)
    if (delta !== undefined) flow.setFileIndex((index) => cycle(index, delta, changes.length))
    else if (input === " ")
      flow.attempt(() => {
        const entry = changes[flow.fileIndex]
        if (entry === undefined) throw new Error("There are no changed files. Enter a branch comparison base.")
        const selected = new Set(flow.paths)
        if (selected.has(entry.path)) selected.delete(entry.path)
        else {
          if (entry.kind === "unsupported")
            throw new Error("Links, submodules, and special files cannot be selected.")
          selected.add(entry.path)
        }
        flow.setPaths(selected)
      })
    else targetCommand(flow, input, key)
  })
  const scope =
    flow.loaded.kind === "ready" && flow.loaded.target.base !== undefined
      ? `Branch base: ${flow.loaded.target.base.ref.replace(/^refs\/(?:heads|remotes)\//u, "")} (${flow.loaded.target.base.mergeBase.slice(0, 12)}) + current edits`
      : flow.loaded.kind === "ready" && flow.loaded.target.head === null
        ? "Scope: current files (no commits yet)"
        : "Scope: uncommitted changes"
  const instructions = "All eligible files start selected. Use Space to exclude unrelated files."
  const summary = `${flow.paths.size} of ${changes.length} files selected. Press p for target details.`
  const reserved = [scope, instructions, summary].reduce(
    (total, value) => total + wrapGuideText(value, width).length,
    0,
  )
  const capacity = Math.max(1, height - reserved)
  const start = Math.max(0, Math.min(flow.fileIndex - Math.floor(capacity / 2), changes.length - capacity))
  return (
    <Box flexDirection="column">
      <Text>{scope}</Text>
      <Text dimColor>{instructions}</Text>
      {changes.length === 0 ? (
        <Text color="yellow">No changes in this scope. Press b to compare against a branch or commit.</Text>
      ) : null}
      {changes.slice(start, start + capacity).map((entry, index) => (
        <Text
          key={entry.path}
          bold={start + index === flow.fileIndex}
          {...(start + index === flow.fileIndex ? { color: "green" as const } : {})}
          wrap="truncate-end"
        >
          {start + index === flow.fileIndex ? "> " : "  "}[{flow.paths.has(entry.path) ? "x" : " "}]{" "}
          {JSON.stringify(entry.path)} (
          {[
            entry.staged ? "staged" : "",
            entry.unstaged ? "unstaged" : "",
            entry.untracked ? "untracked" : "",
            entry.committed ? "branch" : "",
          ]
            .filter(Boolean)
            .join(", ")}
          )
        </Text>
      ))}
      <Text dimColor>{summary}</Text>
    </Box>
  )
}

const targetCommand = (flow: Flow, input: string, key: Key): void => {
  if (input === "b") flow.chooseBase()
  else if (input === "u") flow.setScope({ kind: "uncommitted" })
  else if (input === "r") flow.refresh()
  else if (input === "p")
    flow.showPreview(
      JSON.stringify(
        {
          target: flow.loaded.kind === "ready" ? flow.loaded.target : undefined,
          originalTask: flow.props.originalIntent,
          currentTask: flow.props.intent,
        },
        null,
        2,
      ),
    )
  else if (key.return)
    flow.attempt(() => {
      if (flow.loaded.kind !== "ready") throw new Error("Inspect the worktree first.")
      if (flow.paths.size === 0) throw new Error("Select one or more changed files.")
      flow.setReview(undefined)
      flow.setApproval(undefined)
      flow.resetDelivery()
      flow.setStage("review")
    })
}

const BaseEditor = ({ flow }: { readonly flow: Flow }) => {
  useInput((input, key) => {
    if (key.ctrl && input === "u") flow.setBaseDraft("")
    else if (key.return)
      flow.attempt(() => {
        const baseRef = text(flow.baseDraft, "Comparison base", 256)
        flow.setScope({ kind: "branch", baseRef })
      })
    else if (key.backspace || key.delete) flow.setBaseDraft((value) => [...value].slice(0, -1).join(""))
    else if (!key.ctrl && !key.meta && !key.escape && input !== "") flow.appendBase(input)
  })
  return (
    <Box flexDirection="column">
      <Text>Enter the branch or commit this work started from.</Text>
      <Text dimColor>The scope includes changes since its merge-base with HEAD, plus current edits.</Text>
      <Text color="green">{flow.baseDraft}_</Text>
    </Box>
  )
}

const ScopeChoices = ({ flow }: { readonly flow: Flow }) => {
  useInput((input, key) => {
    const delta = movement(input, key)
    if (delta !== undefined) flow.setScopeIndex((index) => cycle(index, delta, 2))
    else if (key.return) {
      if (flow.scopeIndex === 0) flow.setScope({ kind: "current-branch" })
      else flow.setScope({ kind: "uncommitted" })
    }
  })
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold={flow.scopeIndex === 0} {...(flow.scopeIndex === 0 ? { color: "green" as const } : {})}>
        {flow.scopeIndex === 0 ? "> " : "  "}Committed and uncommitted changes
      </Text>
      <Text bold={flow.scopeIndex === 1} {...(flow.scopeIndex === 1 ? { color: "green" as const } : {})}>
        {flow.scopeIndex === 1 ? "> " : "  "}Uncommitted changes only
      </Text>
      <Text dimColor>
        Use the current worktree and branch. Review the detected comparison base and files before running.
      </Text>
      <Text dimColor>
        Press b on the target screen to change the base. No repository-wide cleanup or conversation capture.
      </Text>
    </Box>
  )
}

const ProfileChoices = ({ flow, height }: { readonly flow: Flow; readonly height: number }) => {
  const profiles = flow.props.services.profiles
  useInput((input, key) => {
    const delta = movement(input, key)
    if (delta !== undefined) flow.setProfileIndex((index) => cycle(index, delta, profiles.length))
    else if (key.return)
      flow.attempt(() => {
        flow.selectedProfile()
        if (flow.props.services.destinations.length === 1) flow.request()
        flow.setStage(flow.props.services.destinations.length > 1 ? "destination" : "confirm")
      })
  })
  const start = Math.max(0, Math.min(flow.profileIndex - Math.floor(height / 2), profiles.length - height))
  return (
    <Box flexDirection="column">
      {profiles.length === 0 ? (
        <Text color="yellow">No Native Copilot, Codex, or Claude profiles are installed.</Text>
      ) : null}
      {profiles.slice(start, start + height).map((entry, index) => (
        <Text
          key={entry.ref}
          bold={start + index === flow.profileIndex}
          {...(start + index === flow.profileIndex ? { color: "green" as const } : {})}
        >
          {start + index === flow.profileIndex ? "> " : "  "}
          {entry.label}
        </Text>
      ))}
    </Box>
  )
}

const destinationLabels: Record<GuideOptimizeRequest["destination"], string> = {
  terminal: "Current terminal",
  pane: "New Herdr pane",
  tab: "New Herdr tab",
}
const ActionChoices = ({ flow }: { readonly flow: Flow }) => {
  useInput((input, key) => {
    if (movement(input, key) !== undefined) flow.setActionIndex((index) => 1 - index)
    else if (key.return) flow.attempt(() => {
      flow.setAutomatic(flow.actionIndex === 1)
      if (flow.actionIndex === 0) { flow.setStage("profile"); return }
      const profile = flow.props.services.profiles.findIndex((entry) => entry.profile.launcher === "copilot" && entry.profile.profile === "hve")
      const tab = flow.props.services.destinations.indexOf("tab")
      if (profile < 0 || tab < 0) throw new Error("Automatic action unavailable: Copilot hve and a Herdr tab are required.")
      flow.setProfileIndex(profile)
      flow.setDestinationIndex(tab)
      flow.setStage("confirm")
    })
  })
  return <Box flexDirection="column" gap={1}>
    <Text bold>Choose implementation action</Text>
    <Text>{flow.actionIndex === 0 ? "> " : "  "}Implement approved findings with a Native agent</Text>
    <Text>{flow.actionIndex === 1 ? "> " : "  "}Plan then implement approved findings with Copilot hve</Text>
    <Text color="yellow">The automatic action uses full access in a same-worktree Herdr tab. It does not ask again before editing.</Text>
  </Box>
}
const PlanChoices = ({ flow }: { readonly flow: Flow }) => {
  useInput((input, key) => {
    if (flow.stage === "plan-confirm") {
      if (key.return) void flow.plan()
    } else if (movement(input, key) !== undefined) flow.setPlanDestination((value) => value === "terminal" ? "worktree" : "terminal")
    else if (key.return) flow.attempt(() => {
      if (flow.planDestination === "worktree" && !flow.props.services.herdr) throw new Error("Herdr is unavailable.")
      if (flow.planDestination === "terminal" && flow.props.terminalBlockedReason) throw new Error(flow.props.terminalBlockedReason)
      flow.setStage("plan-confirm")
    })
  })
  return <Box flexDirection="column" gap={1}>
    <Text bold>{flow.stage === "plan-confirm" ? "Confirm planning-only Copilot hve" : "Choose planning destination"}</Text>
    <Text>{flow.planDestination === "terminal" ? "> " : "  "}Current terminal</Text>
    <Text>{flow.planDestination === "worktree" ? "> " : "  "}Clean new Herdr worktree</Text>
    <Text>No implementation is approved. Copilot must stop after the plan. Missing coverage remains visible.</Text>
    <Text>New worktrees require a clean, unchanged source at the reviewed HEAD. Dirty files are not transferred.</Text>
  </Box>
}
const DestinationChoices = ({ flow }: { readonly flow: Flow }) => {
  const choices = flow.props.services.destinations
  useInput((input, key) => {
    const delta = movement(input, key)
    if (delta !== undefined) flow.setDestinationIndex((index) => cycle(index, delta, choices.length))
    else if (key.return)
      flow.attempt(() => {
        flow.request()
        flow.setStage("confirm")
      })
  })
  return (
    <Box flexDirection="column" gap={1}>
      <Text>Keep the reviewed staged, unstaged, and untracked files in this worktree.</Text>
      {choices.map((choice, index) => (
        <Text
          key={choice}
          bold={index === flow.destinationIndex}
          {...(index === flow.destinationIndex ? { color: "green" as const } : {})}
        >
          {index === flow.destinationIndex ? "> " : "  "}
          {destinationLabels[choice]}
        </Text>
      ))}
      <Text dimColor>A new worktree would omit local edits. It is not an available destination.</Text>
    </Box>
  )
}

const Confirmation = ({ flow }: { readonly flow: Flow }) => {
  useInput((input, key) => {
    if (input === " ") flow.setOtherEditorsStopped((value) => !value)
    else if (input === "p") flow.attempt(() => flow.showPreview(buildGuideOptimizePrompt(flow.request())))
    else if (key.return)
      flow.attempt(() => {
        if (!flow.otherEditorsStopped)
          throw new Error("Press Space to confirm that other agents and editors have stopped.")
        void flow.execute()
      })
  })
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold> Approved findings to implement: {flow.approval?.findings.length ?? 0}</Text>
      <Text>Destination: {flow.props.services.profiles[flow.profileIndex]?.label} (fresh agent)</Text>
      <Text>Placement: {destinationLabels[flow.props.services.destinations[flow.destinationIndex] ?? "terminal"]}</Text>
      <Text>Worktree: {JSON.stringify(flow.review?.request.target.cwd)}</Text>
      <Text>Context: repository files and any supplied task. No conversation is captured.</Text>
      <Text color="yellow">This action can change files. It will not stage or commit them.</Text>
      <Text>Selected paths are instructions, not a filesystem sandbox. Native profile permissions still apply.</Text>
      {flow.automatic ? <Text color="yellow">Automatic Copilot hve: plan then implement approved findings with full access and no further prompts.</Text> : null}
      <Text bold>
        [{flow.otherEditorsStopped ? "x" : " "}] Confirm other agents and editors have stopped changing this worktree.
      </Text>
    </Box>
  )
}

const titles: Record<Stage, string> = {
  scope: "Choose review scope",
  target: "Confirm target",
  base: "Choose comparison base",
  review: "Review",
  history: "Saved reviews",
  profile: "Choose a fresh agent",
  action: "Choose implementation action",
  plan: "Plan fixes",
  "plan-confirm": "Confirm planning",
  destination: "Choose destination",
  confirm: "Confirm execution",
  preview: "Review context",
  sending: "Submitting",
  result: "Handoff result",
}
const footer = (flow: Flow): string => {
  if (flow.props.blockedReason !== undefined) return "Esc back"
  if (flow.stage === "scope") return "↑/↓ j/k select · Enter choose scope · h saved reviews · Esc back"
  if (flow.stage === "base") return "Enter inspect base · Ctrl+U clear · Esc back"
  if (flow.loaded.kind === "failed") return "b change base · r retry · Esc back"
  if (flow.loaded.kind === "loading") return "Esc back"
  const keys: Record<Stage, string> = {
    scope: "↑/↓ j/k select · Enter choose scope · Esc back",
    target:
      "↑/↓ j/k select · Space toggle · b base · u uncommitted · p context · h history · r refresh · Enter continue · Esc back",
    base: "Enter inspect base · Ctrl+U clear · Esc back",
    review: "Read-only reviews do not authorize edits. Approval and execution are separate.",
    history: "↑/↓ j/k select · Enter reopen without model calls · Esc back",
    profile: "↑/↓ j/k select · Enter continue · Esc back",
    action: "↑/↓ j/k select · Enter choose action · Esc back",
    plan: "↑/↓ j/k select · Enter continue · Esc back",
    "plan-confirm": "Enter start planning only · Esc back",
    destination: "↑/↓ j/k select · Enter choose destination · Esc back",
    confirm: "Space confirm editors stopped · p request · Enter run · Esc back",
    preview: "PgUp/PgDn read · Esc back",
    sending: "Waiting for acknowledgment; do not resend.",
    result: "PgUp/PgDn read · Esc back",
  }
  return keys[flow.stage]
}

const StageView = ({
  flow,
  height,
  width,
}: {
  readonly flow: Flow
  readonly height: number
  readonly width: number
}) => {
  if (flow.props.blockedReason !== undefined)
    return <MarkdownTextViewport value={flow.props.blockedReason} width={width} height={height} />
  if (flow.stage === "scope") return <ScopeChoices flow={flow} />
  if (flow.stage === "base") return <BaseEditor flow={flow} />
  if (flow.stage === "history")
    return (
      <OptimizeHistory
        services={flow.props.services}
        height={height}
        onOpen={(review) => {
          flow.setReview(review)
          flow.setReviewContext(reviewContextOf(review))
          flow.setApproval(undefined)
          flow.setLoaded({ kind: "ready", target: review.request.target })
          flow.setPaths(new Set(review.request.paths))
          flow.setStage("review")
        }}
      />
    )
  if (flow.loaded.kind === "loading") return <Text>Inspecting committed and current worktree changes...</Text>
  if (flow.loaded.kind === "failed")
    return <MarkdownTextViewport value={flow.loaded.message} width={width} height={height} />
  return <ReadyStageView flow={flow} height={height} width={width} />
}

const ReadyStageView = ({ flow, height, width }: {
  readonly flow: Flow
  readonly height: number
  readonly width: number
}) => {
  switch (flow.stage) {
    case "target":
      return <FileChoices flow={flow} height={height} width={width} />
    case "review":
      return <ReviewStage flow={flow} height={height} width={width} />
    case "profile":
      return <ProfileChoices flow={flow} height={height} />
    case "action":
      return <ActionChoices flow={flow} />
    case "plan":
    case "plan-confirm":
      return <PlanChoices flow={flow} />
    case "destination":
      return <DestinationChoices flow={flow} />
    case "confirm":
      return <Confirmation flow={flow} />
    case "preview":
      return (
        <MarkdownTextViewport value={flow.preview.value} width={width} height={height} resetKey={flow.preview.value} />
      )
    case "sending":
      return <Text>Rechecking the target and agent before submission...</Text>
    case "result":
      return <MarkdownTextViewport value={flow.result.message} width={width} height={height} />
  }
}

const ReviewStage = ({
  flow,
  height,
  width,
}: {
  readonly flow: Flow
  readonly height: number
  readonly width: number
}) => {
  if (flow.loaded.kind !== "ready") return null
  const context = flow.reviewContext ?? {
    originalIntent: flow.props.originalIntent,
    intent: flow.props.intent,
  }
  const input: Omit<OptimizeReviewInput, "reviewerIds"> = flow.review?.request ?? {
    target: flow.loaded.target,
    paths: [...flow.paths],
    ...(context.originalIntent === undefined ? {} : { originalIntent: context.originalIntent }),
    ...(context.intent === undefined ? {} : { intent: context.intent }),
  }
  return (
    <OptimizeReviewPanel
      services={flow.props.services}
      input={input}
      review={flow.review}
      height={height}
      width={width}
      onReview={flow.setReview}
      onPlan={() => { void flow.openHandoff("plan") }}
      onBack={flow.back}
      onQuit={() => flow.props.onBack(flow.result.submitted)}
      onApproved={(approval) => {
        flow.setApproval(approval)
        flow.setOtherEditorsStopped(false)
        void flow.openHandoff("action")
      }}
      onRestart={(savedReview) => {
        if (savedReview !== undefined) {
          flow.setReviewContext(reviewContextOf(savedReview))
        }
        flow.setReview(undefined)
        flow.setApproval(undefined)
        flow.resetDelivery()
        flow.setOtherEditorsStopped(false)
        flow.setStage("target")
        flow.refresh()
      }}
    />
  )
}

export const GuideOptimizeFlow = (props: OptimizeProps) => {
  const flow = useOptimizeFlow(props)
  usePaste((value) => {
    if (flow.stage === "base") flow.appendBase(value)
    else flow.setError("Open the comparison-base editor with b before pasting a reference.")
  })
  useInput((input, key) => {
    if (flow.stage === "review") return
    if ((key.ctrl && input === "c") || (input === "q" && flow.stage !== "base")) {
      if (flow.stage === "sending") flow.back()
      else props.onBack(flow.result.submitted)
    } else if (key.escape) flow.back()
    else if (input === "r" && flow.loaded.kind === "failed") flow.refresh()
    else if (input === "b" && flow.loaded.kind === "failed" && props.blockedReason === undefined) flow.chooseBase()
    else if (input === "h" && ["scope", "target"].includes(flow.stage)) flow.setStage("history")
  })
  const width = Math.max(1, props.columns - 2)
  const keys = footer(flow)
  const errorRows = flow.error === undefined ? 0 : wrapGuideText(flow.error, width).length
  const height = Math.max(1, props.rows - 4 - wrapGuideText(keys, width).length - errorRows)
  return (
    <Box flexDirection="column" paddingX={1} height={Math.max(1, props.rows - 1)}>
      <Text bold color="cyan">
        Review changes · {flow.loaded.kind === "failed" ? "Setup blocked" : titles[flow.stage]}
      </Text>
      <Text dimColor wrap="truncate-end">
        {flow.loaded.kind === "ready"
          ? JSON.stringify(flow.loaded.target.cwd)
          : flow.loaded.kind === "failed"
            ? "Press b to change the base, r to retry, or Esc to return."
            : "Review the current worktree, not a conversation."}
      </Text>
      <Text dimColor wrap="truncate-end">
        No conversation capture. Models require separate review consent.
      </Text>
      <Box flexDirection="column" flexGrow={1} height={height}>
        <StageView flow={flow} height={height} width={width} />
      </Box>
      {flow.error === undefined ? null : <Text color="yellow">{flow.error}</Text>}
      <Text dimColor>{keys}</Text>
    </Box>
  )
}

export const GuideOptimizeApp = ({
  services,
  originalIntent,
  initialBase,
}: {
  readonly services: GuideOptimizeServices
  readonly originalIntent?: string | undefined
  readonly initialBase?: string | undefined
}) => {
  const { rows, columns } = useWindowSize()
  const { exit } = useApp()
  return (
    <GuideOptimizeFlow
      services={services}
      originalIntent={originalIntent}
      initialBase={initialBase}
      rows={rows}
      columns={columns}
      onBack={(submitted) => exit(submitted ? { action: "optimize-submitted" } : { action: "cancel", exitCode: 130 })}
      onTerminal={(result) => exit(result)}
    />
  )
}
