import { constants, openSync } from "node:fs"
import { execFile, spawn } from "node:child_process"
import tty from "node:tty"
import { promisify } from "node:util"
import React, { useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, render, useApp, useInput, useWindowSize, type Key } from "ink"
import {
  contextMenuErrorResponse,
  runContextMenuRewriteInWorker,
  type ContextMenuRewriteRequest,
  type ContextMenuRewriteResponse,
  type ContextMenuRewriteStyle,
} from "./context-menu-command.ts"
import { MarkdownTextViewport, spinnerFrameAt } from "./guide-ui.tsx"
import { markdownDiffRows, diffDisplayLines, diffColumnWidth, type ContextMenuView } from "./context-menu-diff.ts"
import { readPreferredStyle, writePreferredStyle } from "./rewrite-state.ts"

export type { ContextMenuUiRequest } from "./context-menu-command.ts"
import type { ContextMenuUiRequest } from "./context-menu-command.ts"

export type ContextMenuUiState =
  | { readonly kind: "selecting"; readonly index: number; readonly status?: string }
  | { readonly kind: "loading"; readonly style: ContextMenuRewriteStyle; readonly index: number; readonly cancelRequested?: boolean; readonly previousMarkdown?: string; readonly previousStyle?: ContextMenuRewriteStyle; readonly previousIndex?: number }
  | { readonly kind: "result"; readonly style: ContextMenuRewriteStyle; readonly index: number; readonly markdown: string; readonly copied?: boolean; readonly selectedView?: ContextMenuView; readonly cache?: "hit" | "miss"; readonly cacheStatus?: string }
  | { readonly kind: "error"; readonly style?: ContextMenuRewriteStyle; readonly index: number; readonly message: string; readonly previousMarkdown?: string; readonly previousStyle?: ContextMenuRewriteStyle; readonly previousIndex?: number; readonly selectedView?: ContextMenuView }
  | { readonly kind: "cancelled"; readonly index: number; readonly message: string; readonly previousMarkdown?: string; readonly previousStyle?: ContextMenuRewriteStyle; readonly previousIndex?: number; readonly selectedView?: ContextMenuView }

export type ContextMenuUiAction =
  | { readonly kind: "move"; readonly delta: number; readonly count: number }
  | { readonly kind: "loading"; readonly style: ContextMenuRewriteStyle; readonly index: number; readonly previousMarkdown?: string; readonly previousStyle?: ContextMenuRewriteStyle; readonly previousIndex?: number }
  | { readonly kind: "result"; readonly style: ContextMenuRewriteStyle; readonly index: number; readonly markdown: string; readonly cache?: "hit" | "miss"; readonly cacheStatus?: string }
  | { readonly kind: "error"; readonly style?: ContextMenuRewriteStyle; readonly index: number; readonly message: string; readonly previousMarkdown?: string; readonly previousStyle?: ContextMenuRewriteStyle; readonly previousIndex?: number }
  | { readonly kind: "cancelled"; readonly index: number; readonly message: string; readonly previousMarkdown?: string; readonly previousStyle?: ContextMenuRewriteStyle; readonly previousIndex?: number }
  | { readonly kind: "copied"; readonly value: boolean }
  | { readonly kind: "selecting"; readonly index?: number }
  | { readonly kind: "view"; readonly view: ContextMenuView }

export const initialContextMenuUiState = (request: ContextMenuUiRequest): ContextMenuUiState =>
  request.kind === "context-menu-error"
    ? { kind: "error", index: 0, message: request.error?.message ?? "The contextual action menu is unavailable." }
    : { kind: "selecting", index: 0 }

export const contextMenuUiReducer = (state: ContextMenuUiState, action: ContextMenuUiAction): ContextMenuUiState => {
  if (action.kind === "move") {
    if (state.kind !== "selecting") return state
    return { kind: "selecting", index: Math.max(0, Math.min(Math.max(0, action.count - 1), state.index + action.delta)) }
  }
  if (action.kind === "selecting") {
    return { kind: "selecting", index: action.index ?? (state.kind === "selecting" ? state.index : 0) }
  }
  if (action.kind === "loading") return { kind: "loading", style: action.style, index: action.index, ...(action.previousMarkdown === undefined ? {} : { previousMarkdown: action.previousMarkdown }), ...(action.previousStyle === undefined ? {} : { previousStyle: action.previousStyle }), ...(action.previousIndex === undefined ? {} : { previousIndex: action.previousIndex }) }
  if (action.kind === "result") return { kind: "result", style: action.style, index: action.index, markdown: action.markdown, ...(action.cache === undefined ? {} : { cache: action.cache }), ...(action.cacheStatus === undefined ? {} : { cacheStatus: action.cacheStatus }) }
  if (action.kind === "error") return { kind: "error", ...(action.style === undefined ? {} : { style: action.style }), index: action.index, message: action.message, ...(action.previousMarkdown === undefined ? {} : { previousMarkdown: action.previousMarkdown }), ...(action.previousStyle === undefined ? {} : { previousStyle: action.previousStyle }), ...(action.previousIndex === undefined ? {} : { previousIndex: action.previousIndex }) }
  if (action.kind === "cancelled") return { kind: "cancelled", index: action.index, message: action.message, ...(action.previousMarkdown === undefined ? {} : { previousMarkdown: action.previousMarkdown }), ...(action.previousStyle === undefined ? {} : { previousStyle: action.previousStyle }), ...(action.previousIndex === undefined ? {} : { previousIndex: action.previousIndex }) }
  if (action.kind === "view") return (state.kind === "result" || state.kind === "error" || state.kind === "cancelled") ? { ...state, selectedView: action.view } : state
  if (state.kind !== "result") return state
  return { ...state, copied: action.value }
}

export const contextMenuStyleRequest = (
  request: ContextMenuUiRequest,
  style: ContextMenuRewriteStyle,
  bypassCache = false,
): ContextMenuRewriteRequest => ({
  schemaVersion: 1,
  kind: "rewrite",
  paneId: request.source.paneId,
  styleId: style.id,
  style,
  message: request.message!.text,
  ...(request.model === undefined ? {} : { model: request.model }),
  ...(request.effort === undefined ? {} : { effort: request.effort }),
  ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  ...(bypassCache ? { bypassCache } : {}),
} as ContextMenuRewriteRequest)

export const ensureContextMenuMarkdown = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > 60_000) {
    throw new Error("Copilot returned an empty or oversized rewrite")
  }
  return value
}

export interface ContextMenuRewriteTask {
  readonly controller: AbortController
  readonly promise: Promise<Exclude<ContextMenuUiState, { readonly kind: "selecting" | "loading" }>>
}

export interface ContextMenuClipboard {
  readonly copy: (value: string) => Promise<void>
}

export interface ContextMenuUiProps {
  readonly request: ContextMenuUiRequest
  readonly rewrite?: (request: ContextMenuRewriteRequest, signal: AbortSignal) => Promise<ContextMenuRewriteResponse>
  readonly clipboard?: ContextMenuClipboard
  readonly onExit?: (code: number) => void
  readonly shutdownSignal?: AbortSignal
}

export const startContextMenuRewriteTask = ({
  request,
  style,
  index,
  bypassCache = false,
  rewrite,
}: {
  readonly request: ContextMenuUiRequest
  readonly style: ContextMenuRewriteStyle
  readonly index: number
  readonly bypassCache?: boolean
  readonly rewrite: (request: ContextMenuRewriteRequest, signal: AbortSignal) => Promise<ContextMenuRewriteResponse>
}): ContextMenuRewriteTask => {
  const controller = new AbortController()
  const promise = (async (): Promise<Exclude<ContextMenuUiState, { readonly kind: "selecting" | "loading" }>> => {
    try {
      const response = await rewrite(contextMenuStyleRequest(request, style, bypassCache), controller.signal)
      if (controller.signal.aborted) return { kind: "cancelled", index, message: "Rewrite cancelled after SDK cleanup." }
      const markdown = ensureContextMenuMarkdown(response.markdown)
      return { kind: "result", style, index, markdown, ...(response.cache === undefined ? {} : { cache: response.cache }), ...(response.cacheStatus === undefined ? {} : { cacheStatus: response.cacheStatus }) }
    } catch (error: unknown) {
      const message = contextMenuErrorResponse(error).message
      return controller.signal.aborted
        ? { kind: "cancelled", index, message }
        : { kind: "error", style, index, message }
    }
  })()
  return { controller, promise }
}

interface ActiveRewrite {
  readonly id: number
  readonly style: ContextMenuRewriteStyle
  readonly index: number
  readonly controller: AbortController
}

const styleTitle = (style: ContextMenuRewriteStyle): string => style.title ?? style.id
const styleDescription = (style: ContextMenuRewriteStyle): string => style.description ?? "Configured output style"

const ContextMenuDiffViewport = ({ original, rewritten, width, height, sideBySide, startLine, onStartLineChange }: {
  readonly original: string; readonly rewritten: string; readonly width: number; readonly height: number; readonly sideBySide: boolean
  readonly startLine: number; readonly onStartLineChange: (line: number) => void
}): React.ReactElement => {
  const compared = useMemo(() => markdownDiffRows(original, rewritten), [original, rewritten])
  const lines = useMemo(() => diffDisplayLines(compared, width, sideBySide), [compared, width, sideBySide])
  const capacity = Math.max(1, height - 1)
  const maximum = Math.max(0, lines.length - capacity)
  const start = Math.min(startLine, maximum)
  useInput((_input, key) => {
    if (key.pageUp) onStartLineChange(Math.max(0, start - capacity))
    if (key.pageDown) onStartLineChange(Math.min(maximum, start + capacity))
  })
  return <Box flexDirection="column" height={height}>
    <Text bold>{sideBySide ? `${"Original (before)".padEnd(diffColumnWidth(width))} │ Rewritten (after)` : "Unified diff: − original / + rewritten"}</Text>
    {lines.slice(start, start + capacity).map((line, i) => <Text key={start + i}>
      <Text {...(line.removed ? { color: "red" } : line.added && !sideBySide ? { color: "green" } : {})}>{line.left}</Text>
      {sideBySide ? <><Text> │ </Text><Text {...(line.added ? { color: "green" } : {})}>{line.right}</Text></> : null}
    </Text>)}
  </Box>
}

type SuccessfulRewrite = Extract<ContextMenuUiState, { kind: "result" }>
export const ContextMenuApp = ({ request, rewrite = (value, signal) => runContextMenuRewriteInWorker(value, { signal }), clipboard = { copy: copyMarkdownToClipboard }, onExit, shutdownSignal }: ContextMenuUiProps): React.ReactElement => {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const [state, setState] = useState<ContextMenuUiState>(() => initialContextMenuUiState(request))
  const [selectedView, setSelectedView] = useState<ContextMenuView>("rewritten")
  const [successful, setSuccessful] = useState<SuccessfulRewrite>()
  const [copyFeedback, setCopyFeedback] = useState("")
  const [storageStatus, setStorageStatus] = useState("")
  const [positions, setPositions] = useState<Record<ContextMenuView, number>>({ original: 0, rewritten: 0, diff: 0 })
  const [tick, setTick] = useState(0)
  const active = useRef<ActiveRewrite | undefined>(undefined)
  const sequence = useRef(0)
  const copySequence = useRef(0)
  const closing = useRef(false)
  const mounted = useRef(true)
  const styleTouched = useRef(false)
  const preferenceWrite = useRef(Promise.resolve())
  const styles = request.styles
  const sourceText = request.message?.text ?? ""
  const view = successful === undefined ? "original" : selectedView
  const copyValue = view === "original" ? sourceText : successful?.markdown ?? ""
  const copyTarget = view === "original" ? "original" : "rewritten"
  const copyContext = useRef({ view, value: copyValue })
  copyContext.current = { view, value: copyValue }
  const finish = (): void => { closing.current = true; onExit?.(0); exit() }
  const cancel = (): void => {
    active.current?.controller.abort()
    setState(current => current.kind === "loading" ? { ...current, cancelRequested: true } : current)
  }
  const remember = (style: ContextMenuRewriteStyle): void => {
    styleTouched.current = true
    preferenceWrite.current = preferenceWrite.current.then(() => writePreferredStyle(undefined, style.id)).catch(() => {
      if (mounted.current && !closing.current) setStorageStatus("Could not save the selected style.")
    })
  }
  useEffect(() => {
    let disposed = false
    void readPreferredStyle().then(id => {
      if (disposed || styleTouched.current) return
      const index = Math.max(0, styles.findIndex(style => style.id === id))
      setState(current => current.kind === "selecting" ? { ...current, index } : current)
    }).catch(() => { if (!disposed) setStorageStatus("Could not read the saved style.") })
    return () => { disposed = true }
  }, [styles])
  const startRewrite = (style: ContextMenuRewriteStyle, index: number, bypassCache = false): void => {
    if (active.current || request.kind !== "rewrite-output" || !request.message) return
    remember(style)
    copySequence.current += 1
    setCopyFeedback("")
    const id = ++sequence.current
    const task = startContextMenuRewriteTask({ request, style, index, bypassCache, rewrite })
    active.current = { id, style, index, controller: task.controller }
    setState({ kind: "loading", style, index })
    void task.promise.then(next => {
      if (!mounted.current || active.current?.id !== id) return
      if (next.kind === "result") {
        setSuccessful(next)
        setSelectedView("rewritten")
        setPositions(current => ({ ...current, rewritten: 0, diff: 0 }))
        copySequence.current += 1
        setCopyFeedback("")
      }
      setState(next)
    }).finally(() => {
      if (active.current?.id === id) active.current = undefined
      if (closing.current && mounted.current) finish()
    })
  }
  useEffect(() => {
    const shutdown = () => { closing.current = true; if (active.current) cancel(); else finish() }
    if (shutdownSignal?.aborted) shutdown()
    shutdownSignal?.addEventListener("abort", shutdown, { once: true })
    return () => shutdownSignal?.removeEventListener("abort", shutdown)
  }, [shutdownSignal])
  useEffect(() => {
    if (state.kind !== "loading") return
    const timer = setInterval(() => setTick(value => value + 1), 80)
    return () => clearInterval(timer)
  }, [state.kind])
  useEffect(() => () => { mounted.current = false; active.current?.controller.abort() }, [])

  useInput((input, key) => {
    if (closing.current) return
    if (key.escape || input === "q" || (key.ctrl && input === "c")) {
      if (active.current) cancel(); else finish()
      return
    }
    if (input === "o" || ((input === "w" || input === "d") && successful !== undefined)) {
      setSelectedView(input === "o" ? "original" : input === "w" ? "rewritten" : "diff")
      copySequence.current += 1; setCopyFeedback("")
      return
    }
    if (input === "c" && copyValue.length > 0) {
      const id = ++copySequence.current
      const captured = { view, value: copyValue }
      setCopyFeedback(`Copying ${copyTarget}…`)
      const feedback = (ok: boolean) => {
        if (!mounted.current || closing.current || id !== copySequence.current || captured.view !== copyContext.current.view || captured.value !== copyContext.current.value) return
        setCopyFeedback(ok ? `Copied ${copyTarget} to clipboard.` : `Clipboard verification failed for ${copyTarget}. Try again.`)
      }
      void Promise.resolve().then(() => clipboard.copy(captured.value)).then(() => feedback(true), () => feedback(false))
      return
    }
    if (active.current || request.kind !== "rewrite-output") return
    if (input === "g") {
      const style = styles[state.index]
      if (style) startRewrite(style, state.index, true)
      return
    }
    if (state.kind === "selecting") {
      if (key.return) { const style = styles[state.index]; if (style) startRewrite(style, state.index); return }
      const delta = key.upArrow || input === "k" ? -1 : key.downArrow || input === "j" || key.tab ? 1 : 0
      if (delta !== 0) {
        const index = Math.max(0, Math.min(styles.length - 1, state.index + delta))
        setState({ kind: "selecting", index })
        if (styles[index]) remember(styles[index])
      }
      return
    }
    if (input === "r" && state.kind === "error" && state.style) { startRewrite(state.style, state.index); return }
    if (input === "r" || input === "s") setState({ kind: "selecting", index: state.index })
  })

  const width = Math.max(12, columns - 6)
  const capacity = state.kind === "selecting" ? Math.min(styles.length, Math.max(1, Math.min(5, rows - 15))) : 0
  const styleStart = Math.max(0, Math.min(state.index - Math.floor(capacity / 2), styles.length - capacity))
  const height = Math.max(2, rows - 12 - capacity)
  const status = state.kind === "loading"
    ? `${spinnerFrameAt(tick)} Rewriting as ${styleTitle(state.style)}${state.cancelRequested ? " (cancelling…)" : "…"}`
    : state.kind === "error" ? "Rewrite unavailable." : state.kind === "cancelled" ? "Rewrite cancelled."
    : state.kind === "selecting" ? `Choose a style (${state.index + 1}/${styles.length}), then press Enter to rewrite.` : `Rewritten as ${styleTitle(state.style)}`
  const cacheStatus = successful?.cacheStatus ? "Rewrite cache unavailable; generation can continue." : successful?.cache === "hit" ? "Saved result" : ""
  return <Box flexDirection="column" paddingX={1}>
    <Text bold color="cyan">TRX contextual actions</Text>
    <Text dimColor wrap="truncate-end">{request.source.agent ?? "agent"} · {request.source.paneId} · {request.source.cwd}</Text>
    <Text color={state.kind === "error" ? "red" : state.kind === "loading" ? "yellow" : "cyan"}>{status}</Text>
    <Text wrap="truncate-end">{state.kind === "error" || state.kind === "cancelled" ? state.message : cacheStatus || "o original · w rewritten · d diff"}</Text>
    <Text dimColor wrap="truncate-end">{storageStatus || (state.kind === "loading" ? "Esc cancels and waits for SDK cleanup." : "")}</Text>
    <Text bold>{view === "original" ? "Original" : view === "diff" ? "Diff" : "Rewritten"}{successful && state.kind !== "result" ? " · previous rewrite available" : ""}</Text>
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      {view === "diff" && successful ? <ContextMenuDiffViewport original={sourceText} rewritten={successful.markdown} width={width} height={height} sideBySide={columns >= 80} startLine={positions.diff} onStartLineChange={line => setPositions(current => ({ ...current, diff: line }))} />
        : <MarkdownTextViewport value={view === "original" ? sourceText : successful?.markdown ?? ""} width={width} height={height} startLine={positions[view]} onStartLineChange={line => setPositions(current => ({ ...current, [view]: line }))} />}
    </Box>
    {state.kind === "selecting" ? styles.slice(styleStart, styleStart + capacity).map((style, i) => <Text key={style.id} inverse={state.index === styleStart + i} wrap="truncate-end">{state.index === styleStart + i ? "› " : "  "}{styleTitle(style)} · {styleDescription(style)}</Text>) : null}
    <Text wrap="truncate-end">{copyFeedback || `c copy ${copyTarget}`}</Text>
    <Text dimColor wrap="truncate-end">{state.kind === "selecting" ? "Enter rewrite · ↑/↓ choose · " : "g regenerate · r retry/styles · s styles · "}PgUp/PgDn scroll</Text>
    <Text dimColor>o original · w rewritten · d diff · q/Esc {state.kind === "loading" ? "cancel" : "close"}</Text>
  </Box>
}

interface InteractiveTerminal {
  readonly input: NodeJS.ReadStream
  readonly output: NodeJS.WriteStream
  readonly close: () => void
}

const openInteractiveTerminal = (): InteractiveTerminal => {
  let input: NodeJS.ReadStream | undefined
  let output: NodeJS.WriteStream | undefined
  try {
    const configuredInputFd = Number.parseInt(process.env.TRELLAGE_CONTEXT_MENU_INPUT_FD ?? "", 10)
    const configuredOutputFd = Number.parseInt(process.env.TRELLAGE_CONTEXT_MENU_OUTPUT_FD ?? "", 10)
    const inputFd = Number.isSafeInteger(configuredInputFd) && configuredInputFd >= 0 ? configuredInputFd : undefined
    const outputFd = Number.isSafeInteger(configuredOutputFd) && configuredOutputFd >= 0 ? configuredOutputFd : undefined
    input = inputFd === undefined
      ? process.stdin.isTTY
        ? process.stdin
        : new tty.ReadStream(openSync("/dev/tty", constants.O_RDONLY))
      : new tty.ReadStream(inputFd)
    output = outputFd === undefined
      ? process.stderr.isTTY
        ? process.stderr
        : new tty.WriteStream(openSync("/dev/tty", constants.O_WRONLY))
      : new tty.WriteStream(outputFd)
    return {
      input,
      output,
      close: () => {
        if (input !== process.stdin) input?.destroy()
        if (output !== process.stderr) output?.destroy()
      },
    }
  } catch (error) {
    if (input !== undefined && input !== process.stdin) input.destroy()
    if (output !== undefined && output !== process.stderr) output.destroy()
    throw error
  }
}

export const runContextMenuUi = async (props: ContextMenuUiProps): Promise<number> => {
  const terminal = openInteractiveTerminal()
  let instance: ReturnType<typeof render> | undefined
  const shutdown = new AbortController()
  const terminate = (): void => shutdown.abort()
  const onTerminalError = (error: NodeJS.ErrnoException): void => {
    if (error.code === "EIO" || error.code === "EPIPE") shutdown.abort()
  }
  terminal.input.on("error", onTerminalError)
  terminal.output.on("error", onTerminalError)
  process.once("SIGINT", terminate)
  process.once("SIGTERM", terminate)
  process.once("SIGHUP", terminate)
  try {
    instance = render(<ContextMenuApp {...props} shutdownSignal={shutdown.signal} />, {
      stdin: terminal.input,
      stdout: terminal.output,
      interactive: true,
      exitOnCtrlC: false,
      kittyKeyboard: { mode: "disabled" },
      alternateScreen: true,
      maxFps: 30,
    })
    await instance.waitUntilExit()
    return 0
  } finally {
    terminal.input.removeListener("error", onTerminalError)
    terminal.output.removeListener("error", onTerminalError)
    process.removeListener("SIGINT", terminate)
    process.removeListener("SIGTERM", terminate)
    process.removeListener("SIGHUP", terminate)
    terminal.close()
  }
}

const execFileAsync = promisify(execFile)

export const copyMarkdownToClipboard = async (value: string): Promise<void> => {
  if (process.platform !== "darwin") throw new Error("Clipboard copying is available on macOS only.")
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "pipe"] })
    let stderr = ""
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGTERM")
      reject(new Error("pbcopy timed out"))
    }, 10_000)
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    }
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => { if (stderr.length < 16 * 1024) stderr += chunk })
    child.stdin.on("error", (error) => fail(error))
    child.once("error", (error) => fail(error))
    child.once("close", (status) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (status === 0) resolve()
      else reject(new Error(stderr.trim() || "pbcopy failed"))
    })
    child.stdin.end(value)
  })
  const readBack = await execFileAsync("pbpaste", [], { maxBuffer: 256 * 1024, timeout: 10_000, killSignal: "SIGTERM" })
  if (readBack.stdout !== value) throw new Error("Clipboard verification failed.")
}
