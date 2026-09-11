import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Terminal } from "@xterm/headless"
import { spawn, type IPty } from "node-pty"
import { expect, vi, type TestContext } from "vitest"
import type { FixtureEvent, FixtureMode, FixtureReport } from "../fixtures/guide-integration-data.js"

const waitOptions = { timeout: 5_000, interval: 20 }

export const createGuideTerminal = async (entry: string, onTestFailed: TestContext["onTestFailed"]) => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage guide integration-"))
  const terminal = new Terminal({ cols: 120, rows: 40, scrollback: 0, allowProposedApi: true })
  let child: IPty | undefined
  let exit: { readonly exitCode: number; readonly signal?: number } | undefined
  let output = ""
  let screen = ""
  let selectedQueueJobs: ReadonlyArray<number> = []
  const inputs: string[] = []
  onTestFailed(() => {
    console.error(
      `Guide input: ${JSON.stringify(inputs)}\nGuide screen:\n${screen}\nGuide PTY tail: ${JSON.stringify(output)}`,
    )
  })
  const press = (keys: string): void => {
    if (child === undefined || exit !== undefined) throw new Error("Guide input requires a running fixture")
    inputs.push(keys)
    child.write(keys)
  }
  const readScreen = async <Value>(read: (text: string) => Value): Promise<Value> =>
    vi.waitFor(() => {
      expect(exit, "Guide exited before the expected screen state").toBeUndefined()
      return read(screen)
    }, waitOptions)
  const waitForText = async (...texts: ReadonlyArray<string>): Promise<void> =>
    readScreen((text) => {
      for (const expected of texts) expect(text).toContain(expected)
    })
  const events = async (): Promise<ReadonlyArray<FixtureEvent>> => {
    const lines = (await readFile(path.join(root, "events.jsonl"), "utf8")).trimEnd()
    return lines.length === 0 ? [] : lines.split("\n").map((line) => JSON.parse(line) as FixtureEvent)
  }
  return {
    root,
    text: (): string => screen,
    press,
    readScreen,
    waitForText,
    async start(mode: FixtureMode, columns = terminal.cols): Promise<void> {
      if (child !== undefined) throw new Error("Each integration scenario must use a fresh guide process")
      terminal.resize(columns, terminal.rows)
      const home = path.join(root, "home")
      const temporary = path.join(root, "tmp")
      await mkdir(home)
      await mkdir(temporary)
      const processUnderTest = spawn(process.execPath, [entry, root, mode], {
        name: "xterm-256color",
        cols: terminal.cols,
        rows: terminal.rows,
        cwd: root,
        env: {
          HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: home,
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
          PATH: path.dirname(process.execPath),
          TERM: "xterm-256color",
          CI: "true",
          // Queue focus changes use styling; keep those redraws enabled under CI.
          FORCE_COLOR: "1",
        },
      })
      child = processUnderTest
      terminal.onData((data) => processUnderTest.write(data))
      processUnderTest.onData((data) => {
        output = (output + data).slice(-24_000)
        terminal.write(data, () => {
          const buffer = terminal.buffer.active
          const lines = Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row))
          screen = lines.map((line) => line?.translateToString(true) ?? "").join("\n")
          // Queue selection is an inverse numeric badge, not a text change.
          selectedQueueJobs = lines.flatMap((line) => {
            const text = line?.translateToString(true) ?? ""
            const id = text.match(/^\s+(\d+)\s/u)?.[1]
            return id !== undefined && line?.getCell(text.indexOf(id))?.isInverse() ? [Number(id)] : []
          })
        })
      })
      processUnderTest.onExit((status) => {
        exit = status
      })
      await waitForText("What do you want to do?")
      // The first render precedes Ink's input effects. Echo is not input acknowledgment.
      await vi.waitFor(() => {
        expect(exit, "Guide exited before enabling terminal input").toBeUndefined()
        expect(output).toContain("\u001b[?2004h")
      }, waitOptions)
    },
    async pressAndWait(keys: string, ...texts: ReadonlyArray<string>): Promise<void> {
      press(keys)
      await waitForText(...texts)
    },
    async waitForQueueSelection(id: number): Promise<void> {
      await readScreen((text) => {
        expect(text).toContain("Batch queue.")
        expect(selectedQueueJobs).toEqual([id])
      })
    },
    async waitForInput(input: string): Promise<void> {
      await vi.waitFor(async () => {
        expect((await events()).some((event) => event.kind === "input" && event.input === input)).toBe(true)
      }, waitOptions)
    },
    events,
    async finish(keys: string, exitCode = 0): Promise<FixtureReport> {
      press(keys)
      await vi.waitFor(() => expect(exit).toMatchObject({ exitCode }), waitOptions)
      expect(exit?.signal ?? 0).toBe(0)
      return JSON.parse(await readFile(path.join(root, "result.json"), "utf8")) as FixtureReport
    },
    async close(): Promise<void> {
      try {
        if (child !== undefined && exit === undefined) {
          child.kill("SIGKILL")
          await vi.waitFor(() => expect(exit).toBeDefined(), waitOptions)
        }
      } finally {
        await new Promise<void>((resolve) => terminal.write("", resolve))
        terminal.dispose()
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}

export type GuideTerminal = Awaited<ReturnType<typeof createGuideTerminal>>
