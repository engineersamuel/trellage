#!/usr/bin/env node

import { constants, openSync, writeSync } from "node:fs"
import tty from "node:tty"

const MAX_INPUT_BYTES = 1024 * 1024
const MAX_DESCRIPTION_LENGTH = 4000
const MAX_DETAILS_LENGTH = 8000
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/
const escapeSequenceDelayMs = 30

const fail = (message) => {
  throw new Error(message)
}

const validateText = (value, name, maximumLength) => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    fail(`${name} must be a non-empty string of at most ${maximumLength} characters`)
  }
  if (controlCharacters.test(value)) fail(`${name} must not contain control characters`)
  return value
}

const parseChoices = (text) => {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    fail("stdin must contain valid JSON")
  }

  const choices = Array.isArray(payload) ? payload : payload?.choices
  const prompt = Array.isArray(payload)
    ? "Select an option"
    : validateText(payload?.prompt ?? "Select an option", "prompt", 200)

  if (!Array.isArray(choices) || choices.length === 0) {
    fail("JSON must be a non-empty choices array or an object containing one")
  }

  const ids = new Set()
  const validated = choices.map((choice, index) => {
    if (choice === null || typeof choice !== "object" || Array.isArray(choice)) {
      fail(`choice ${index} must be an object`)
    }
    const id = validateText(choice.id, `choice ${index} id`, 256)
    const label = validateText(choice.label, `choice ${index} label`, 1000)
    const description =
      choice.description === undefined
        ? undefined
        : validateText(
            choice.description,
            `choice ${index} description`,
            MAX_DESCRIPTION_LENGTH,
          )
    const details =
      choice.details === undefined
        ? undefined
        : validateText(choice.details, `choice ${index} details`, MAX_DETAILS_LENGTH)
    if (ids.has(id)) fail(`choice IDs must be unique: ${id}`)
    ids.add(id)
    return { id, label, description, details }
  })

  return { choices: validated, prompt }
}

const readStdin = async () => {
  const chunks = []
  let length = 0
  for await (const chunk of process.stdin) {
    length += chunk.length
    if (length > MAX_INPUT_BYTES) fail(`stdin exceeds ${MAX_INPUT_BYTES} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

const truncate = (text, width) => {
  if (text.length <= width) return text
  if (width <= 1) return "…".slice(0, width)
  return `${text.slice(0, width - 1)}…`
}

const wrap = (text, width) => {
  if (width <= 1) return [...text].map((character) => truncate(character, width))
  const lines = []
  let remaining = text.trim()
  while (remaining.length > width) {
    let split = remaining.lastIndexOf(" ", width)
    if (split <= 0) split = width
    lines.push(remaining.slice(0, split))
    remaining = remaining.slice(split).trimStart()
  }
  if (remaining.length > 0) lines.push(remaining)
  return lines
}

const choose = ({ choices, prompt }) => new Promise((resolve, reject) => {
  let terminalFd
  try {
    terminalFd = openSync("/dev/tty", constants.O_RDWR)
  } catch {
    reject(new Error("an interactive controlling terminal is required"))
    return
  }

  const input = new tty.ReadStream(terminalFd)
  const terminalOutput = process.stderr.isTTY ? process.stderr : new tty.WriteStream(terminalFd)
  let selected = 0
  let viewportStart = 0
  let renderedLines = 0
  let escapeTimer
  let settled = false
  let rawModeEnabled = false
  let cursorHidden = false
  let resizeListening = false

  const clearMenu = () => {
    if (renderedLines > 0) terminalOutput.write(`\x1b[${renderedLines}F\x1b[J`)
    renderedLines = 0
  }

  const restore = () => {
    if (escapeTimer) clearTimeout(escapeTimer)
    input.pause()
    if (rawModeEnabled) {
      try {
        input.setRawMode(false)
      } catch {
        // The terminal may already be detached during shutdown.
      }
      rawModeEnabled = false
    }
    clearMenu()
    if (cursorHidden) terminalOutput.write("\x1b[?25h")
    cursorHidden = false
    if (resizeListening) {
      terminalOutput.removeListener("resize", render)
      process.removeListener("SIGWINCH", render)
      resizeListening = false
    }
    input.destroy()
    input.unref()
    if (terminalOutput !== process.stderr) terminalOutput.destroy()
  }

  const finish = (result) => {
    if (settled) return
    settled = true
    restore()
    process.removeListener("exit", restore)
    resolve(result)
  }

  const render = () => {
    const rows =
      Number.isInteger(terminalOutput.rows) && terminalOutput.rows > 0
        ? terminalOutput.rows
        : 24
    const columns = Math.max(
      1,
      Number.isInteger(terminalOutput.columns) && terminalOutput.columns > 0
        ? terminalOutput.columns
        : 80,
    )
    const choice = choices[selected]
    const detailLines = [
      ...(choice.description === undefined
        ? []
        : wrap(`Description: ${choice.description}`, columns)),
      ...(choice.details === undefined ? [] : wrap(`Details: ${choice.details}`, columns)),
    ]
    const detailCapacity = Math.max(0, rows - 3)
    const visibleDetailCount =
      detailLines.length > detailCapacity ? Math.max(0, detailCapacity - 1) : detailLines.length
    const visibleDetails = detailLines.slice(0, visibleDetailCount)
    const detailsHiddenWithoutRoom = detailLines.length > 0 && detailCapacity === 0
    if (visibleDetailCount < detailLines.length && detailCapacity > 0) {
      visibleDetails.push(
        truncate(
          `… ${detailLines.length - visibleDetailCount} detail line(s) hidden; resize to view`,
          columns,
        ),
      )
    }
    const viewportSize = Math.max(1, rows - 2 - visibleDetails.length)
    if (selected < viewportStart) viewportStart = selected
    if (selected >= viewportStart + viewportSize) viewportStart = selected - viewportSize + 1
    const viewportEnd = Math.min(choices.length, viewportStart + viewportSize)
    const lines = [truncate(prompt, columns)]

    for (let index = viewportStart; index < viewportEnd; index += 1) {
      const above = index === viewportStart && viewportStart > 0
      const below = index === viewportEnd - 1 && viewportEnd < choices.length
      const marker = index === selected ? "❯" : " "
      const overflow = above ? "↑" : below ? "↓" : " "
      lines.push(truncate(`${marker}${overflow} ${choices[index].label}`, columns))
    }
    lines.push(...visibleDetails)
    lines.push(
      truncate(
        detailsHiddenWithoutRoom
          ? "Details hidden; resize • ↑/↓ move • Enter select • Esc cancel"
          : "↑/↓ move • Enter select • Esc cancel",
        columns,
      ),
    )

    clearMenu()
    terminalOutput.write(`${lines.join("\n")}\n`)
    renderedLines = lines.length
  }

  const handleKey = (key) => {
    if (key === "\u0003") {
      finish({ cancelled: true, exitCode: 130 })
      return
    }
    if (key === "\r" || key === "\n") {
      finish({ id: choices[selected].id, exitCode: 0 })
      return
    }
    if (key === "\u001b[A") {
      selected = (selected - 1 + choices.length) % choices.length
      render()
      return
    }
    if (key === "\u001b[B") {
      selected = (selected + 1) % choices.length
      render()
      return
    }
    if (key === "\u001b") finish({ cancelled: true, exitCode: 130 })
  }

  let pending = ""
  const consumeKeys = () => {
    while (pending.length > 0) {
      if (pending.startsWith("\u001b[A") || pending.startsWith("\u001b[B")) {
        const key = pending.slice(0, 3)
        pending = pending.slice(3)
        handleKey(key)
        continue
      }
      if (pending === "\u001b" || pending === "\u001b[" || pending === "\u001b[O") {
        escapeTimer = setTimeout(() => {
          escapeTimer = undefined
          const key = pending
          pending = ""
          if (key === "\u001b") handleKey(key)
        }, escapeSequenceDelayMs)
        return
      }
      const key = pending[0]
      pending = pending.slice(1)
      handleKey(key)
    }
  }

  input.on("data", (chunk) => {
    if (escapeTimer) {
      clearTimeout(escapeTimer)
      escapeTimer = undefined
    }
    pending += chunk.toString("utf8")
    consumeKeys()
  })
  input.on("error", (error) => {
    restore()
    process.removeListener("exit", restore)
    reject(error)
  })
  process.once("exit", restore)

  try {
    input.setRawMode(true)
    rawModeEnabled = true
    terminalOutput.write("\x1b[?25l")
    cursorHidden = true
    terminalOutput.on("resize", render)
    process.on("SIGWINCH", render)
    resizeListening = true
    render()
    input.resume()
  } catch (error) {
    restore()
    reject(error)
  }
})

const signalExitCodes = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGQUIT", 131],
  ["SIGTERM", 143],
])

let activeSignal
for (const [signal, exitCode] of signalExitCodes) {
  process.once(signal, () => {
    activeSignal = exitCode
    process.exit(exitCode)
  })
}

try {
  const payload = parseChoices(await readStdin())
  const result = await choose(payload)
  if (result.id !== undefined) writeSync(process.stdout.fd, `${result.id}\n`)
  process.exit(activeSignal ?? result.exitCode)
} catch (error) {
  process.stderr.write(`terminal-picker: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
