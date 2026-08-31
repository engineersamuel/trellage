#!/usr/bin/env node
import readline from "node:readline"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { readClipboard } from "./lib/clipboard.mjs"
import { inspectCaptureOptions, selectedTextChoice } from "./lib/capture-options.mjs"
import {
  panelInvocationSource,
  parseCustomPopupContext,
  validateAnswer,
} from "./lib/context.mjs"
import { requestHerdr } from "./lib/herdr.mjs"
import {
  captureQueueIntent,
  clearCaptureQueue,
  readCaptureQueue,
  removeCaptureQueueEntry,
  removeChoice,
  resolvePluginStateDirectory,
  writeChoice,
} from "./lib/state.mjs"
import { stringWidth, truncateToWidth, wrapText } from "./lib/terminal-text.mjs"

export { panelInvocationSource }
const actionId = "trellage.guide-handoff.open"

const out = (stream, value) => stream.write(value)

const clipped = (value, width) => {
  if (stringWidth(value) <= width) return value
  if (width <= 3) return ".".repeat(width)
  return `${truncateToWidth(value, width - 3)}...`
}

const selectionFromClipboard = (clipboard) => {
  if (!clipboard.ok) return { error: clipboard.message }
  try {
    return { value: validateAnswer(clipboard.value, "Clipboard selection") }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export const orderedSourceChoices = (inspectedChoices, selectedText, captureQueue) => [
  ...(selectedText === undefined ? [] : [selectedTextChoice(selectedText)]),
  ...inspectedChoices,
  ...(captureQueue?.entries.length > 0
    ? [{
        kind: "queue",
        label: `Open capture queue in trx guide (${captureQueue.entries.length})`,
        detail: "Opens all queued items in trx guide, then clears this capture queue.",
        preview: captureQueueIntent(captureQueue),
      }]
    : []),
]

export const sourcePickerStatus = (initialStatus, notes, selectionError) =>
  initialStatus || notes.join(" ") || selectionError || ""

export const captureQueueEntryLabel = (entry, index) => {
  const source =
    entry.origin?.paneTitle ??
    entry.origin?.agent ??
    entry.origin?.paneId ??
    entry.capture?.source ??
    "capture"
  return `${index + 1}. ${source} · ${entry.answer.replaceAll(/\s+/gu, " ").slice(0, 48)}`
}

export const waitForCaptureQueueGrowth = async (
  stateDir,
  previousLength,
  reader = readCaptureQueue,
) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const queue = await reader(stateDir)
    if (queue.entries.length > previousLength) return queue
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("The capture queue did not update")
}

const movedChoiceIndex = (current, count, text, key) => {
  if (count === 0) return current
  if (key.name === "up" || text === "k") return Math.max(0, current - 1)
  if (key.name === "down" || text === "j" || key.name === "tab") {
    return Math.min(count - 1, current + 1)
  }
  return current
}

const popupFooter = ({ busy, status, screen, queueOnly, choices }) => {
  if (busy) return status
  if (screen === "queue") {
    return queueOnly
      ? "Enter open queue  x remove selected  c clear  q/Esc close"
      : "Enter open queue  x remove selected  c clear  a add another  b back  q/Esc close"
  }
  if (choices.length === 0) return status || "Esc cancel"
  return "Enter open  a add selected  e edit queue  x clear queue  q/Esc close"
}

export const invokeGuideChoice = async ({
  choice,
  operation = "open",
  context,
  stateDir,
  request = requestHerdr,
  choiceWriter = writeChoice,
  choiceRemover = removeChoice,
}) => {
  const choiceToken = await choiceWriter(
    stateDir,
    choice.kind === "queue"
      ? { schemaVersion: 1, kind: choice.kind }
      : choice.kind === "selection"
      ? {
          schemaVersion: 1,
          kind: choice.kind,
          ...(operation === "enqueue" ? { operation } : {}),
          selectedText: choice.preview,
        }
      : {
          schemaVersion: 1,
          kind: choice.kind,
          ...(operation === "enqueue" ? { operation } : {}),
          paneId: choice.paneId,
          stateChangeSeq: choice.stateChangeSeq,
          ...(choice.sessionId === undefined ? {} : { sessionId: choice.sessionId }),
        },
  )
  const invocationContext = {
    workspace_id: context.workspaceId,
    ...(context.tabId === undefined ? {} : { tab_id: context.tabId }),
    focused_pane_id: context.paneId,
    focused_pane_cwd: context.cwd,
    invocation_source: panelInvocationSource,
    selected_text: choiceToken,
  }
  try {
    await request("plugin.action.invoke", {
      action_id: actionId,
      context: invocationContext,
    })
  } catch (error) {
    await choiceRemover(stateDir, choiceToken)
    throw error
  }
}

export const main = async ({
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  context: providedContext,
  initialScreen = "sources",
  queueOnly = false,
  clipboardReader = readClipboard,
  request = requestHerdr,
  captureInspector = inspectCaptureOptions,
  initialStatus = "",
} = {}) => {
  if (!input.isTTY || !output.isTTY) throw new Error("The guide source picker requires a terminal")
  const context = providedContext ?? parseCustomPopupContext(env)
  const stateDir = resolvePluginStateDirectory(env)
  const selection = queueOnly ? {} : selectionFromClipboard(clipboardReader())
  let captureQueue = await readCaptureQueue(stateDir)
  let inspected = { choices: [], notes: [] }
  if (!queueOnly) {
    try {
      inspected = await captureInspector(context)
    } catch (error) {
      inspected = { choices: [], notes: [error instanceof Error ? error.message : String(error)] }
    }
  }
  let choices = orderedSourceChoices(inspected.choices, selection.value, captureQueue)
  let selectedIndex = 0
  let queueIndex = 0
  let screen = initialScreen
  let status = sourcePickerStatus(initialStatus, inspected.notes, selection.error)
  let busy = false
  let finished = false
  let resolveRun
  const result = new Promise((resolve) => {
    resolveRun = resolve
  })

  const writeAt = (row, column, text) => {
    out(output, `\x1b[${row};${column}H${text}`)
  }

  const render = () => {
    const columns = Math.max(40, output.columns || 86)
    const rows = Math.max(14, output.rows || 18)
    const left = 3
    const width = Math.max(20, columns - 5)
    const queueChoices = captureQueue.entries.map((entry, index) => ({
      label: captureQueueEntryLabel(entry, index),
      detail: `Queued capture ${index + 1} of ${captureQueue.entries.length}`,
      preview: entry.answer,
    }))
    const visibleSet = screen === "queue" ? queueChoices : choices
    const activeIndex = screen === "queue" ? queueIndex : selectedIndex
    const optionRows = Math.max(2, Math.min(6, visibleSet.length || 2))
    const optionStart = rows - optionRows - 2
    const previewRows = Math.max(2, optionStart - 7)
    const selected = visibleSet[activeIndex]
    const wrappedPreview = wrapText(
      selected?.preview ?? "No usable source is available. Highlight text or wait for an agent to finish.",
      width,
    )
    const preview = wrappedPreview.slice(0, previewRows)
    const firstOption = Math.max(
      0,
      Math.min(activeIndex - Math.floor(optionRows / 2), Math.max(0, visibleSet.length - optionRows)),
    )
    const visibleChoices = visibleSet.slice(firstOption, firstOption + optionRows)

    out(output, "\x1b[2J\x1b[H\x1b[?25l")
    writeAt(2, left, `\x1b[1m${screen === "queue" ? "Edit capture queue" : "Send to Trellage guide"}\x1b[0m`)
    writeAt(3, left, `\x1b[2m${clipped(selected?.detail ?? status, width)}\x1b[0m`)
    if (status) writeAt(4, left, `\x1b[33m${clipped(status, width)}\x1b[0m`)
    writeAt(5, left, "\x1b[1mPreview\x1b[0m")
    preview.forEach((line, index) => {
      writeAt(6 + index, left, `\x1b[2m${clipped(line, width)}\x1b[0m`)
    })
    if (wrappedPreview.length > previewRows) {
      writeAt(5 + previewRows, left + Math.max(0, width - 3), "\x1b[2m...\x1b[0m")
    }

    visibleChoices.forEach((choice, visibleIndex) => {
      const index = firstOption + visibleIndex
      const active = index === activeIndex
      const marker = active ? ">" : " "
      const label = `${marker} ${choice.label}`
      writeAt(optionStart + visibleIndex, left, `${active ? "\x1b[7m" : ""}${clipped(label, width)}\x1b[0m`)
    })

    const footer = popupFooter({ busy, status, screen, queueOnly, choices })
    writeAt(rows, left, `\x1b[2m${clipped(footer, width)}\x1b[0m`)
  }

  const cleanup = () => {
    if (finished) return
    finished = true
    input.off("keypress", onKeypress)
    output.off("resize", render)
    process.off("SIGTERM", onTerminate)
    try {
      process.off("SIGHUP", onTerminate)
    } catch {
      // SIGHUP is not available on every supported platform.
    }
    if (input.isTTY) input.setRawMode(wasRaw)
    input.pause()
    out(output, "\x1b[?25h\x1b[2J\x1b[H\x1b[?1049l")
  }

  const exit = (code) => {
    cleanup()
    resolveRun(code)
  }

  const openSelectedChoice = async () => {
    if (busy) return
    busy = true
    status = "Opening Trellage guide..."
    render()
    const choice = choices[selectedIndex]
    if (choice === undefined) {
      busy = false
      status = "No usable source is available"
      render()
      return
    }
    try {
      await invokeGuideChoice({
        choice,
        context,
        stateDir,
        request,
      })
      exit(0)
    } catch (error) {
      busy = false
      status = error instanceof Error ? error.message : String(error)
      render()
    }
  }

  const enqueueSelectedChoice = async () => {
    if (busy) return
    const choice = choices[selectedIndex]
    if (choice === undefined || choice.kind === "queue") {
      status = "Choose highlighted text, an exact result, or a terminal snapshot to add"
      render()
      return
    }
    busy = true
    status = "Adding capture to queue..."
    render()
    try {
      const previousLength = captureQueue.entries.length
      await invokeGuideChoice({ choice, operation: "enqueue", context, stateDir, request })
      captureQueue = await waitForCaptureQueueGrowth(stateDir, previousLength)
      choices = orderedSourceChoices(inspected.choices, selection.value, captureQueue)
      selectedIndex = choices.findIndex((candidate) => candidate.kind === "queue")
      busy = false
      status = `Added. ${captureQueue.entries.length} item${captureQueue.entries.length === 1 ? "" : "s"} queued. Enter opens the queue.`
      render()
    } catch (error) {
      busy = false
      status = error instanceof Error ? error.message : String(error)
      render()
    }
  }

  const openCaptureQueue = async () => {
    if (busy) return
    if (captureQueue.entries.length === 0) {
      status = "Capture queue is empty"
      render()
      return
    }
    busy = true
    status = "Opening capture queue in Trellage guide..."
    render()
    try {
      await invokeGuideChoice({
        choice: { kind: "queue" },
        context,
        stateDir,
        request,
      })
      exit(0)
    } catch (error) {
      busy = false
      status = error instanceof Error ? error.message : String(error)
      render()
    }
  }

  const removeSelectedQueuedChoice = async () => {
    if (busy) return
    const entry = captureQueue.entries[queueIndex]
    if (entry === undefined) {
      status = "Capture queue is empty"
      render()
      return
    }
    busy = true
    status = "Removing queued capture..."
    render()
    try {
      captureQueue = await removeCaptureQueueEntry(stateDir, entry.id)
      choices = orderedSourceChoices(inspected.choices, selection.value, captureQueue)
      queueIndex = Math.min(queueIndex, Math.max(0, captureQueue.entries.length - 1))
      busy = false
      status = `${captureQueue.entries.length} item${captureQueue.entries.length === 1 ? "" : "s"} queued`
      render()
    } catch (error) {
      busy = false
      status = error instanceof Error ? error.message : String(error)
      render()
    }
  }

  const clearQueuedChoices = async () => {
    if (busy) return
    if (captureQueue.entries.length === 0) {
      status = "Capture queue is already empty"
      render()
      return
    }
    busy = true
    status = "Clearing capture queue..."
    render()
    try {
      await clearCaptureQueue(stateDir)
      captureQueue = await readCaptureQueue(stateDir)
      choices = orderedSourceChoices(inspected.choices, selection.value, captureQueue)
      selectedIndex = 0
      queueIndex = 0
      busy = false
      status = "Capture queue cleared"
      render()
    } catch (error) {
      busy = false
      status = error instanceof Error ? error.message : String(error)
      render()
    }
  }

  const onTerminate = () => exit(0)
  const wasRaw = input.isRaw
  process.on("SIGTERM", onTerminate)
  try {
    process.on("SIGHUP", onTerminate)
  } catch {
    // SIGHUP is not available on every supported platform.
  }
  output.on("resize", render)

  readline.emitKeypressEvents(input, { escapeCodeTimeout: 20 })
  input.setRawMode(true)
  input.resume()
  const onQueueKeypress = (text, key) => {
    if (key.name === "x") {
      void removeSelectedQueuedChoice()
      return
    }
    if (key.name === "c") {
      void clearQueuedChoices()
      return
    }
    if (key.name === "return") {
      void openCaptureQueue()
      return
    }
    if (!queueOnly && (key.name === "a" || key.name === "b")) {
      screen = "sources"
      status = key.name === "a" ? "Choose a source, then press a to add it" : ""
      render()
      return
    }
    queueIndex = movedChoiceIndex(queueIndex, captureQueue.entries.length, text, key)
    status = ""
    render()
  }

  const onSourceKeypress = (text, key) => {
    if (key.name === "a") {
      void enqueueSelectedChoice()
      return
    }
    if (key.name === "e") {
      screen = "queue"
      queueIndex = Math.min(queueIndex, Math.max(0, captureQueue.entries.length - 1))
      status = ""
      render()
      return
    }
    if (key.name === "x") {
      void clearQueuedChoices()
      return
    }
    if (key.name === "return") {
      void openSelectedChoice()
      return
    }
    selectedIndex = movedChoiceIndex(selectedIndex, choices.length, text, key)
    status = ""
    render()
  }

  const onKeypress = (text, key) => {
    if (busy) return
    if (key.ctrl && key.name === "c") return exit(0)
    if (key.name === "escape" || key.name === "q") return exit(0)
    if (screen === "queue") onQueueKeypress(text, key)
    else onSourceKeypress(text, key)
  }
  input.on("keypress", onKeypress)

  out(output, "\x1b[?1049h")
  render()
  return result
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Trellage guide source picker failed: ${message}`)
    process.exitCode = 1
  }
}
