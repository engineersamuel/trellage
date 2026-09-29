import React, { useEffect, useRef, useState } from "react"
import { Box, Text, useApp, useInput, usePaste, useWindowSize, type Key } from "ink"
import type { CombinedGuideCatalog } from "./guide-catalog.ts"
import type { CommandRunner } from "./guide-launch.ts"
import { MarkdownTextViewport } from "./guide-markdown.tsx"
import { text } from "./guide-text.ts"
import { spinnerFrameAt } from "./guide-ui.tsx"
import {
  assertEngagementSnapshotCurrent,
  captureEngagementSnapshot,
  engagementLimits,
  engagementPath,
  engagementContextSource,
  engagementErrorMessage,
  inspectEngagementRepository,
  readEngagementFile,
  type EngagementRepository,
  type EngagementSnapshot,
} from "./engagement-context.ts"
import {
  EngagementAssessmentResponseError,
  engagementAssessmentDocument,
  type EngagementAssessment,
  type EngagementAssessor,
} from "./engagement-assessment.ts"
import {
  EngagementWorkStore,
  engagementLaunchPlan,
  engagementResultDocument,
  engagementWorkAction,
  type EngagementWork,
} from "./engagement-work.ts"

export type EngagementUiResult =
  | { readonly action: "exit"; readonly exitCode: number }
  | { readonly action: "launch"; readonly work: EngagementWork }

export interface EngagementUiProps {
  readonly repository: EngagementRepository
  readonly intent: string
  readonly catalog: CombinedGuideCatalog
  readonly guideRoot: string
  readonly runner: CommandRunner
  readonly assessor: EngagementAssessor
  readonly modelLabel: string
  readonly store: EngagementWorkStore
  readonly records: ReadonlyArray<EngagementWork>
  readonly initialWork?: EngagementWork
  readonly notice?: string
  readonly onResult: (result: EngagementUiResult) => void
}

type Screen =
  | "overview"
  | "sources"
  | "consent"
  | "assessment"
  | "assignment"
  | "confirm-launch"
  | "records"
  | "review"
  | "review-confirm"
  | "evidence"
  | "editor"
type Editor = "context" | "answer" | "source" | "output" | "review" | "intent"
// oxlint-disable-next-line no-control-regex -- Untrusted text must not control the terminal.
const displayControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu
const displayText = (value: string): string => value.replace(displayControls, "")
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" })
const removeLastCharacter = (value: string): string => {
  const last = [...segmenter.segment(value)].at(-1)
  return last === undefined ? "" : value.slice(0, last.index)
}

export const EngagementApp = (props: EngagementUiProps) => {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const [repository, setRepository] = useState(props.repository)
  const [selected, setSelected] = useState<ReadonlyArray<string>>(props.repository.selected)
  const [intent, setIntent] = useState(props.intent)
  const [context, setContext] = useState(props.initialWork?.request.snapshot.context ?? "")
  const [screen, setScreen] = useState<Screen>(props.initialWork === undefined ? "overview" : "review")
  const [returnScreen, setReturnScreen] = useState<Screen>("sources")
  const [cursor, setCursor] = useState(0)
  const [actionIndex, setActionIndex] = useState(0)
  const [snapshot, setSnapshot] = useState<EngagementSnapshot>()
  const [assessment, setAssessment] = useState<EngagementAssessment>()
  const [work, setWork] = useState(props.initialWork)
  const [records, setRecords] = useState(props.records)
  const [editor, setEditor] = useState<Editor>("context")
  const [draft, setDraft] = useState("")
  const [reviewDraft, setReviewDraft] = useState("")
  const [document, setDocument] = useState("")
  const [evidence, setEvidence] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [progress, setProgress] = useState<ReadonlyArray<string>>([])
  const [tick, setTick] = useState(0)
  const operation = useRef<AbortController | null>(null)
  const leaveAfterOperation = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      operation.current?.abort()
    }
  }, [])
  useEffect(() => {
    if (!busy || progress.length === 0) return
    const timer = setInterval(() => setTick((value) => value + 1), 80)
    return () => clearInterval(timer)
  }, [busy, progress.length])

  const finish = (result: EngagementUiResult) => {
    props.onResult(result)
    exit()
  }
  const run = (label: string, action: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current !== null) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(label)
    setError("")
    void action(controller.signal)
      .catch((cause: unknown) => {
        if (mounted.current) setError(displayText(engagementErrorMessage(cause)))
      })
      .finally(() => {
        operation.current = null
        if (mounted.current) {
          setBusy("")
          if (leaveAfterOperation.current) finish({ action: "exit", exitCode: 130 })
        }
      })
  }
  const reportProgress = (message: string) => {
    setProgress((previous) => (previous.at(-1) === message ? previous : [...previous, displayText(message)].slice(-7)))
  }
  const edit = (kind: Editor, initial: string) => {
    setReturnScreen(screen)
    setEditor(kind)
    setDraft(initial)
    setError("")
    setScreen("editor")
  }
  const append = (value: string) => {
    try {
      const next = draft + value.replace(/\r\n?/gu, "\n")
      text(next, "your text", engagementLimits.contextCharacters, {
        multiline: true,
        preserve: true,
      })
      setDraft(next)
      setError("")
    } catch (cause) {
      setError(displayText(engagementErrorMessage(cause)))
    }
  }
  const viewDocument = (value: string) => {
    setEvidence(value)
    setReturnScreen(screen)
    setScreen("evidence")
  }
  const openWork = (item: EngagementWork) => {
    setWork(item)
    setReviewDraft(item.review?.note ?? "")
    setScreen("assignment")
  }
  const openReview = (item: EngagementWork) =>
    run("Reading result evidence", async () => {
      setDocument(await engagementResultDocument(item, props.store, props.runner))
      setScreen("review")
    })
  const refreshSources = async () => {
    const next = await inspectEngagementRepository(props.runner, repository.root)
    setRepository(next)
    setSelected(next.selected)
    setRecords(await props.store.list())
    setSnapshot(undefined)
    setAssessment(undefined)
    setCursor(0)
    setScreen("overview")
  }
  const reload = () => run("Reading local source inventory", refreshSources)
  const saveContext = () => {
    const next =
      editor === "answer"
        ? `${context}${context ? "\n\n" : ""}Guide question: ${assessment?.question ?? ""}\nYour answer: ${text(draft, "answer", 8000, { multiline: true, preserve: true })}`
        : draft
    if (next) text(next, "your context", 8000, { multiline: true, preserve: true })
    setContext(next)
    setSnapshot(undefined)
    setAssessment(undefined)
    setScreen(editor === "answer" ? "sources" : returnScreen)
  }
  const editorSavers: Record<Editor, () => void> = {
    review: () => {
      text(draft, "result review", 8000, { multiline: true, preserve: true })
      setReviewDraft(draft)
      setScreen("review-confirm")
    },
    source: () => {
      const filename = engagementPath(draft.trim())
      run("Reading the selected source", async () => {
        await readEngagementFile(repository.root, filename)
        if (!repository.files.includes(filename))
          setRepository({ ...repository, files: [...repository.files, filename] })
        if (!selected.includes(filename)) setSelected([...selected, filename])
        setSnapshot(undefined)
        setAssessment(undefined)
        setScreen("sources")
      })
    },
    output: () => {
      const filename = engagementPath(draft.trim())
      run("Reading the result file", async () => {
        setEvidence(`# ${filename}\n\n${await readEngagementFile(repository.root, filename)}`)
        setReturnScreen("review")
        setScreen("evidence")
      })
    },
    intent: () => {
      setIntent(text(draft, "engagement question", 8000, { multiline: true, preserve: true }))
      setSnapshot(undefined)
      setAssessment(undefined)
      setScreen(returnScreen)
    },
    context: saveContext,
    answer: saveContext,
  }
  usePaste((value) => {
    if (screen === "editor" && operation.current === null) append(value)
  })
  const reviewSelectedEvidence = () =>
    run("Capturing selected local evidence", async () => {
      setSnapshot(await captureEngagementSnapshot(props.runner, repository.root, selected, context))
      setScreen("consent")
    })
  const openRecords = () =>
    run("Reading saved work", async () => {
      setRecords(await props.store.list())
      setCursor(0)
      setScreen("records")
    })
  const sourceCommands: Record<string, () => void> = {
    " ": () => {
      const filename = repository.files[cursor]
      if (filename === undefined) return
      setSelected(selected.includes(filename) ? selected.filter((item) => item !== filename) : [...selected, filename])
      setSnapshot(undefined)
      setAssessment(undefined)
    },
    a: reviewSelectedEvidence,
    e: () =>
      run("Reading local evidence", async () => {
        const filename = repository.files[cursor]
        if (filename !== undefined)
          viewDocument(`# ${filename}\n\n${await readEngagementFile(repository.root, filename)}`)
      }),
    c: () => edit("context", context),
    i: () => edit("intent", intent),
    "+": () => edit("source", ""),
    r: reload,
    w: openRecords,
  }
  const evidenceDocument = (current: EngagementSnapshot) =>
    [...current.sources, ...(current.context ? [{ path: engagementContextSource, content: current.context }] : [])]
      .map(
        (source) =>
          `# ${source.path}\n\n${source.content
            .split("\n")
            .map((line, index) => `${index + 1}: ${line}`)
            .join("\n")}`,
      )
      .join("\n\n")
  const handlers: Record<Screen, (input: string, key: Key) => void> = {
    overview: (input, key) => {
      if (key.return) reviewSelectedEvidence()
      else if (input === "s") {
        setCursor(0)
        setScreen("sources")
      } else if (input === "c") edit("context", context)
      else if (input === "i") edit("intent", intent)
      else if (input === "w") openRecords()
    },
    sources: (input, key) => {
      if (key.upArrow) setCursor(Math.max(0, cursor - 1))
      else if (key.downArrow) setCursor(Math.min(repository.files.length - 1, cursor + 1))
      else if (key.return) reviewSelectedEvidence()
      else sourceCommands[input]?.()
    },
    consent: (input) => {
      if (snapshot === undefined) return
      if (input === "s")
        run("Assessing the engagement; no agent tools are enabled", async (signal) => {
          setProgress([])
          await assertEngagementSnapshotCurrent(props.runner, repository.root, snapshot)
          let result: EngagementAssessment
          try {
            result = await props.assessor(snapshot, intent, signal, reportProgress)
          } catch (cause) {
            if (cause instanceof EngagementAssessmentResponseError) setScreen("overview")
            throw cause
          }
          if (signal.aborted) throw new Error("Engagement assessment cancelled; no assignment was saved.")
          setAssessment(result)
          setActionIndex(0)
          setScreen("assessment")
        })
      else if (input === "e") viewDocument(evidenceDocument(snapshot))
    },
    assessment: (input) => {
      if (assessment === undefined || snapshot === undefined) return
      if (/^[1-3]$/u.test(input) && assessment.actions[Number(input) - 1] !== undefined)
        setActionIndex(Number(input) - 1)
      else if (input === "c")
        edit(assessment.question === null ? "context" : "answer", assessment.question === null ? context : "")
      else if (input === "e") viewDocument(evidenceDocument(snapshot))
      else if (input === "p" && assessment.actions[actionIndex] !== undefined)
        run("Saving one assignment and its evidence snapshot", async () => {
          openWork(await props.store.prepare(props.guideRoot, intent, snapshot, assessment, actionIndex))
          setRecords(await props.store.list())
        })
    },
    assignment: (input) => {
      if (work === undefined) return
      if (input === "l" && work.status === "prepared" && engagementWorkAction(work).workflow !== null)
        run("Checking the assignment and launch command", async () => {
          const plan = await engagementLaunchPlan(work, props.store, props.catalog, props.guideRoot, props.runner)
          setDocument(
            `# Confirm interactive launch\n\nCurrent worktree: ${repository.root}\n\nExecutable: ${plan.command.executable}\n\nArgument vector:\n${JSON.stringify(plan.command.args, null, 2)}\n\nThis launches one interactive agent, not autopilot. It can change host repository files. Guide is not a security boundary. Return here when the agent exits to review the result.`,
          )
          setScreen("confirm-launch")
        })
      else if (input === "r") openReview(work)
      else if (input === "e") viewDocument(evidenceDocument(work.request.snapshot))
    },
    "confirm-launch": (input) => {
      if (work !== undefined && input === "y") finish({ action: "launch", work })
    },
    records: (_input, key) => {
      if (key.upArrow) setCursor(Math.max(0, cursor - 1))
      else if (key.downArrow) setCursor(Math.min(records.length - 1, cursor + 1))
      else if (key.return && records[cursor] !== undefined) openWork(records[cursor])
    },
    review: (input) => {
      if (work === undefined) return
      if (input === "n" && work.status !== "reviewed") edit("review", reviewDraft)
      else if (input === "v") edit("output", "")
      else if (input === "e")
        run("Publishing the reviewed result note", async () => {
          await props.store.exportReview(work)
          await refreshSources()
        })
    },
    "review-confirm": (input) => {
      if (work === undefined || (input !== "s" && input !== "x")) return
      run("Saving the human review", async () => {
        const reviewed = await props.store.review(work, reviewDraft, input === "s" ? "recorded" : "rejected")
        setWork(reviewed)
        setScreen("review")
        await props.store.exportReview(reviewed)
        setDocument(await engagementResultDocument(reviewed, props.store, props.runner))
        setRecords(await props.store.list())
      })
    },
    evidence: () => {},
    editor: (input, key) => {
      if (key.return) {
        try {
          editorSavers[editor]()
        } catch (cause) {
          setError(displayText(engagementErrorMessage(cause)))
        }
      } else if (key.backspace || key.delete) setDraft(removeLastCharacter(draft))
      else if (!key.ctrl && !key.meta && !key.super && !key.hyper && input) append(input)
    },
  }
  const goBack = () => {
    setError("")
    if (screen === "editor" || screen === "evidence") setScreen(returnScreen)
    else if (screen === "confirm-launch" || screen === "review") setScreen("assignment")
    else if (screen === "review-confirm") edit("review", reviewDraft)
    else if (screen === "overview") finish({ action: "exit", exitCode: 0 })
    else setScreen("overview")
  }
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (operation.current === null) finish({ action: "exit", exitCode: 130 })
      else {
        leaveAfterOperation.current = true
        operation.current.abort()
      }
    } else if (operation.current !== null) {
      if (key.escape) operation.current.abort()
    } else if (key.escape) goBack()
    else if (input === "?" && error && screen !== "editor") viewDocument(`# Error\n\n${error}`)
    else handlers[screen](input, key)
  })
  useEffect(() => {
    if (props.initialWork !== undefined) openReview(props.initialWork)
  }, [])
  const view = engagementView({
    screen,
    repository,
    intent,
    context,
    selected,
    records,
    cursor,
    rows,
    snapshot,
    assessment,
    actionIndex,
    work,
    document,
    evidence,
    editor,
    draft,
    reviewDraft,
    modelLabel: props.modelLabel,
    busy,
    progress,
    tick,
  })
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>{view.title}</Text>
      <Text>
        {busy ? `${spinnerFrameAt(tick)} ${busy}` : "Local context; model use and launch need separate confirmation."}
      </Text>
      {props.notice ? <Text wrap="truncate-end">{displayText(props.notice)}</Text> : null}
      {error ? (
        <Text color="red" wrap="truncate-end">
          Error: {error} (? details)
        </Text>
      ) : null}
      <MarkdownTextViewport
        value={displayText(view.content)}
        width={Math.max(1, columns - 2)}
        height={Math.max(1, rows - 10 - (props.notice ? 1 : 0) - (error ? 1 : 0))}
        resetKey={`${screen}-${screen === "sources" || screen === "records" ? cursor : ""}`}
      />
      <Text>{busy ? "Working; Esc requests cancellation | Ctrl+C cancels and exits" : view.hints}</Text>
      {view.secondHints ? <Text>{view.secondHints}</Text> : null}
      <Text dimColor>PgUp/PgDn scroll | Ctrl+C exit{busy ? " after cleanup" : ""}</Text>
    </Box>
  )
}

interface EngagementViewState {
  readonly screen: Screen
  readonly repository: EngagementRepository
  readonly intent: string
  readonly context: string
  readonly selected: ReadonlyArray<string>
  readonly records: ReadonlyArray<EngagementWork>
  readonly cursor: number
  readonly rows: number
  readonly snapshot: EngagementSnapshot | undefined
  readonly assessment: EngagementAssessment | undefined
  readonly actionIndex: number
  readonly work: EngagementWork | undefined
  readonly document: string
  readonly evidence: string
  readonly editor: Editor
  readonly draft: string
  readonly reviewDraft: string
  readonly modelLabel: string
  readonly busy: string
  readonly progress: ReadonlyArray<string>
  readonly tick: number
}

interface EngagementView {
  readonly title: string
  readonly content: string
  readonly hints: string
  readonly secondHints?: string
}

const visibleItems = <T,>(
  items: ReadonlyArray<T>,
  state: EngagementViewState,
): ReadonlyArray<{ readonly value: T; readonly focused: boolean }> => {
  const size = Math.max(1, Math.floor((state.rows - 14) / 2))
  const start = Math.max(0, state.cursor)
  return items.slice(start, start + size).map((value, index) => ({ value, focused: start + index === state.cursor }))
}

const engagementViews: Record<Screen, (state: EngagementViewState) => EngagementView> = {
  overview: (state) => {
    const selectedPreview = state.selected.slice(0, 5)
    const remaining = state.selected.length - selectedPreview.length
    return {
      title: "Check engagement",
      content: [
        "Find the next useful HVE step from the engagement evidence in this repository.",
        `Question: ${state.intent}`,
        `Evidence ready: ${state.selected.length} selected file${state.selected.length === 1 ? "" : "s"}.`,
        ...(state.records.some((item) => item.status !== "reviewed")
          ? [
              `Saved work needing review: ${state.records.filter((item) => item.status !== "reviewed").length}. Press w to open it.`,
            ]
          : []),
        ...(selectedPreview.length > 0
          ? selectedPreview.map((filename) => `- ${filename}`)
          : ["- No evidence selected"]),
        ...(remaining > 0 ? [`- ${remaining} more selected file${remaining === 1 ? "" : "s"}`] : []),
        "Press Enter to review what will be shared. No file content is sent to a model until you confirm on the next screen.",
        ...(state.context ? ["## Your added context", state.context] : []),
        `Repository: ${state.repository.root}`,
      ].join("\n\n"),
      hints: "Enter review evidence and continue | s choose evidence | c add context",
      secondHints: "i edit question | w saved work | Esc exit",
    }
  },
  sources: (state) => ({
    title: "Choose engagement evidence",
    content: [
      `Question: ${state.intent}`,
      `Select only evidence that is relevant and permitted to share. ${state.selected.length} file${state.selected.length === 1 ? "" : "s"} selected.`,
      ...visibleItems(state.repository.files, state).map(
        ({ value, focused }) => `${focused ? ">" : " "} ${state.selected.includes(value) ? "[x]" : "[ ]"} ${value}`,
      ),
      ...(state.repository.files.length === 0
        ? ["No documents found. Add a repository-relative source path with +."]
        : []),
      `Repository: ${state.repository.root}`,
      ...state.repository.notices,
      ...(state.context ? ["## Your context (not yet sent)", state.context] : []),
    ].join("\n\n"),
    hints: "Arrows move | Space select | Enter review and continue | e read file",
    secondHints: "c context | i question | + path | w saved work | r reload | Esc back",
  }),
  consent: ({ snapshot, modelLabel, intent, repository, busy, progress, tick }) => ({
    title: "Review source-use consent",
    content: [
      ...(busy && progress.length > 0
        ? [
            `## Copilot SDK activity\n${progress
              .map((message, index) => `${index === progress.length - 1 ? spinnerFrameAt(tick) : "✓"} ${message}`)
              .join("\n")}`,
          ]
        : []),
      `Model: ${modelLabel}`,
      `Repository: ${repository.root}`,
      `Question: ${intent}`,
      "Analyze sends selected file text and your context to this model. Only share permitted material.",
      "Preparing an action later copies this evidence into engagement/work/. No automatic stage, commit, or publish. Do not copy restricted material into Git.",
      "Source-use consent is not customer signoff. Files can have uncommitted changes. Hashes identify bytes, not approval.",
      ...(snapshot?.sources.map(
        (source) =>
          `${source.path} | ${Buffer.byteLength(source.content)} bytes | ${source.tracked ? "tracked" : "not tracked"} | ${source.digest}`,
      ) ?? []),
      "## Your additional context",
      snapshot?.context || "None.",
    ].join("\n\n"),
    hints: "s share evidence and assess | e exact evidence | Esc sources",
  }),
  assessment: ({ assessment, actionIndex }) => {
    if (assessment === undefined) throw new Error("Assessment screen requires a completed assessment")
    const action = assessment.actions[actionIndex]
    return {
      title: assessment.question === null ? "Next engagement action" : "Clarify the engagement",
      content: `${action === undefined ? "" : `Selected action ${actionIndex + 1}: ${action.title}\n\n`}${engagementAssessmentDocument(assessment)}`,
      hints:
        action === undefined
          ? "c answer or correct | e evidence | Esc sources"
          : "p save assignment | 1/2/3 choose | c correct | e evidence",
      secondHints: "Preparing saves selected evidence in engagement/work/. No launch.",
    }
  },
  assignment: ({ work }) => {
    if (work === undefined) throw new Error("Assignment screen requires saved work")
    const human = engagementWorkAction(work).workflow === null
    return {
      title: "Review one assignment",
      content: [
        `Saved work: ${work.request.id}`,
        `Record state: ${work.status}. This is not engagement status.`,
        ...(human ? ["Human action: no agent launch. Do the agreed work, then record your review."] : []),
        work.request.prompt,
      ].join("\n\n"),
      hints: `${work.status === "prepared" && !human ? "l choose launch | " : ""}r review result | e saved evidence`,
      secondHints: "Esc sources. Reopen saved work with w.",
    }
  },
  "confirm-launch": ({ document }) => ({
    title: "Confirm current-terminal launch",
    content: document,
    hints: "y launch this assignment | Esc cancel launch",
    secondHints: "No new worktree or background handoff in engagement mode.",
  }),
  records: (state) => ({
    title: "Saved engagement work",
    content:
      state.records.length === 0
        ? "No assignments saved. Return to sources and assess the engagement."
        : visibleItems(state.records, state)
            .map(
              ({ value, focused }) =>
                `${focused ? ">" : " "} ${value.status} | ${engagementWorkAction(value).title}\n${value.request.id}`,
            )
            .join("\n\n"),
    hints: "Arrows select | Enter open | Esc sources",
    secondHints: "A launch does not prove completion. Review its actual result.",
  }),
  review: ({ work, document }) => ({
    title: "Review the result",
    content: document,
    hints:
      work?.status === "reviewed"
        ? "e export review and reload | v view file | Esc assignment"
        : "n write review | v view output file | Esc assignment",
    secondHints: "Include output paths, observed results, and open questions.",
  }),
  "review-confirm": ({ reviewDraft }) => ({
    title: "Confirm result review",
    content: `## Your review\n\n${reviewDraft}\n\nConfirm that you inspected the output and no agent is still running for this work. Record only what you observed. This note does not approve customer decisions or complete an HVE method.`,
    hints: "s record observed result | x reject result | Esc edit review",
    secondHints: "The reviewed note becomes selectable repository evidence.",
  }),
  evidence: ({ evidence }) => ({
    title: "Engagement evidence",
    content: evidence,
    hints: "Esc return",
  }),
  editor: ({ editor, assessment, draft }) => {
    const labels: Record<Editor, string> = {
      context: "Correct engagement understanding",
      answer: "Answer one question",
      source: "Add a repository-relative source path",
      output: "View a result file",
      review: "Write result review",
      intent: "Edit engagement question",
    }
    return {
      title: labels[editor],
      content: `${editor === "answer" ? `${assessment?.question ?? ""}\n\n` : ""}${draft || "Type or paste your text."}`,
      hints: `Enter apply | Backspace edit | Esc cancel | ${[...draft].length}/8000`,
      secondHints: "Text stays local until you confirm its use.",
    }
  },
}

const engagementView = (state: EngagementViewState): EngagementView => engagementViews[state.screen](state)
