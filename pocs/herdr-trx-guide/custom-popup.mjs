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
import { removeChoice, resolvePluginStateDirectory, writeChoice } from "./lib/state.mjs"
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

export const orderedSourceChoices = (inspectedChoices, selectedText) => [
  ...inspectedChoices,
  ...(selectedText === undefined ? [] : [selectedTextChoice(selectedText)]),
]

export const sourcePickerStatus = (initialStatus, notes, selectionError) =>
  initialStatus || notes.join(" ") || selectionError || ""

const movedChoiceIndex = (current, count, text, key) => {
  if (count === 0) return current
  if (key.name === "up" || text === "k") return Math.max(0, current - 1)
  if (key.name === "down" || text === "j" || key.name === "tab") {
    return Math.min(count - 1, current + 1)
  }
  return current
}

const shortcutChoiceKind = (keyName) => {
  if (keyName === "s") return "selection"
  if (keyName === "e") return "exact"
  if (keyName === "t") return "terminal"
  return undefined
}

export const invokeGuideChoice = async ({
  choice,
  context,
  stateDir,
  request = requestHerdr,
  choiceWriter = writeChoice,
  choiceRemover = removeChoice,
}) => {
  const choiceToken = await choiceWriter(
    stateDir,
    choice.kind === "selection"
      ? {
          schemaVersion: 1,
          kind: choice.kind,
          selectedText: choice.preview,
        }
      : {
          schemaVersion: 1,
          kind: choice.kind,
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
  clipboardReader = readClipboard,
  request = requestHerdr,
  captureInspector = inspectCaptureOptions,
  initialStatus = "",
} = {}) => {
  if (!input.isTTY || !output.isTTY) throw new Error("The guide source picker requires a terminal")
  const context = parseCustomPopupContext(env)
  const stateDir = resolvePluginStateDirectory(env)
  const selection = selectionFromClipboard(clipboardReader())
  let inspected
  try {
    inspected = await captureInspector(context)
  } catch (error) {
    inspected = { choices: [], notes: [error instanceof Error ? error.message : String(error)] }
  }
  const choices = orderedSourceChoices(inspected.choices, selection.value)
  let selectedIndex = 0
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
    const optionRows = Math.max(2, Math.min(6, choices.length || 2))
    const optionStart = rows - optionRows - 2
    const previewRows = Math.max(2, optionStart - 7)
    const selected = choices[selectedIndex]
    const wrappedPreview = wrapText(
      selected?.preview ?? "No usable source is available. Highlight text or wait for an agent to finish.",
      width,
    )
    const preview = wrappedPreview.slice(0, previewRows)
    const firstOption = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(optionRows / 2), Math.max(0, choices.length - optionRows)),
    )
    const visibleChoices = choices.slice(firstOption, firstOption + optionRows)

    out(output, "\x1b[2J\x1b[H\x1b[?25l")
    writeAt(2, left, "\x1b[1mSend to Trellage guide\x1b[0m")
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
      const active = index === selectedIndex
      const marker = active ? ">" : " "
      const label = `${marker} ${choice.label}`
      writeAt(optionStart + visibleIndex, left, `${active ? "\x1b[7m" : ""}${clipped(label, width)}\x1b[0m`)
    })

    const footer = busy
      ? status
      : choices.length === 0
        ? status || "Esc cancel"
        : "Up/Down choose  Enter open  s selection  e exact  t terminal  Esc cancel"
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
  const selectFirst = (kind) => {
    const index = choices.findIndex((choice) => choice.kind === kind)
    if (index < 0) return false
    selectedIndex = index
    return true
  }
  const onKeypress = (text, key) => {
    if (busy) return
    if (key.ctrl && key.name === "c") return exit(0)
    if (key.name === "escape" || key.name === "q") return exit(0)
    const shortcutKind = shortcutChoiceKind(key.name)
    if (shortcutKind !== undefined) {
      if (selectFirst(shortcutKind)) void openSelectedChoice()
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
