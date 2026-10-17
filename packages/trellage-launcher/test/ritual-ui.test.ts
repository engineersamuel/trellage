import { Socket } from "node:net"
import { clearLine, clearScreenDown, cursorTo, moveCursor } from "node:readline"
import { stripVTControlCharacters } from "node:util"
import type { Direction } from "node:tty"
import React from "react"
import { render } from "ink"
import { afterEach, describe, expect, it, vi } from "vitest"

import { shippedRituals } from "../src/ritual-catalog.ts"
import { nextRitualScreen, RitualApp, type RitualScreen } from "../src/ritual-ui.tsx"

class TestInput extends Socket {
  isTTY = true
  isRaw = false
  override _read(): void {}
  setRawMode(mode: boolean): this {
    this.isRaw = mode
    return this
  }
}

class TestOutput extends Socket {
  isTTY = true
  columns = 100
  rows = 30
  readonly frames: string[] = []
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const text = stripVTControlCharacters(chunk.toString("utf8"))
    if (text.trim().length > 0) this.frames.push(text)
    callback()
  }
  clearLine(direction: Direction, callback?: () => void): boolean { return clearLine(this, direction, callback) }
  clearScreenDown(callback?: () => void): boolean { return clearScreenDown(this, callback) }
  cursorTo(x: number, y?: number | (() => void), callback?: () => void): boolean {
    return typeof y === "function" ? cursorTo(this, x, undefined, y) : cursorTo(this, x, y, callback)
  }
  moveCursor(x: number, y: number, callback?: () => void): boolean { return moveCursor(this, x, y, callback) }
  getColorDepth(): number { return 1 }
  hasColors(): boolean { return false }
  getWindowSize(): [number, number] { return [this.columns, this.rows] }
}

const idle: RitualScreen = { query: "", filtering: false, index: 0, reading: false, status: "" }
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("ritual list keys", () => {
  it("copies on Enter and filters without copying", () => {
    expect(nextRitualScreen(idle, "v", {}, 1)).toMatchObject({ copy: false, screen: { reading: true } })
    expect(nextRitualScreen(idle, "\r", { return: true }, 1).copy).toBe(true)
    expect(nextRitualScreen(idle, "\r", { return: true }, 0).copy).toBe(false)
    const filtering = nextRitualScreen(idle, "/", {}, 1).screen
    expect(filtering.filtering).toBe(true)
    expect(nextRitualScreen(filtering, "q", {}, 1).screen.query).toBe("q")
    expect(nextRitualScreen(filtering, "\r", { return: true }, 1)).toMatchObject({ copy: false, screen: { filtering: false } })
    expect(nextRitualScreen(idle, "q", {}, 1).quit).toBe(true)
  })
})

describe("ritual list screen", () => {
  it("does not copy on open, copies on Enter, and filters the list", async () => {
    const copy = vi.fn()
    const stdin = new TestInput()
    const stdout = new TestOutput()
    const app = render(
      React.createElement(RitualApp, { catalog: { rituals: [...shippedRituals], problems: [] }, copy }),
      { stdin, stdout, stderr: new TestOutput(), debug: true, interactive: true, patchConsole: false },
    )
    const exited = app.waitUntilExit()
    cleanups.push(async () => {
      app.unmount()
      await exited
      app.cleanup()
      stdin.destroy()
      stdout.destroy()
    })
    const screen = () => stripVTControlCharacters(stdout.frames.join(""))
    const press = async (key: string) => {
      stdin.push(key)
      await new Promise<void>((resolve) => setImmediate(resolve))
      await app.waitUntilRenderFlush()
    }
    await vi.waitFor(() => expect(screen()).toContain("Rituals"))
    expect(copy).not.toHaveBeenCalled()
    expect(screen()).toContain("Progress page")
    await press("\r")
    expect(copy).toHaveBeenCalledTimes(1)
    expect(copy.mock.calls[0]?.[0]).toContain(".dashboard/index.html")
    expect(screen()).toContain("Copied. Paste it into the current agent.")
    await press("/")
    await press("z")
    await vi.waitFor(() => expect(screen()).toContain("No ritual matches."))
    await press("\u001b")
    await exited
  })
})
