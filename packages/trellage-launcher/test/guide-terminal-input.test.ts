import { bunArguments, bunExecutable } from "@trellage/runtime"
import { expect, test, vi } from "vitest"
import { spawnSourcePty, type SourcePtyExit } from "./helpers/source-pty.ts"

for (const mode of ["inherited", "redirected"]) {
  test(`interactive handoff reads real keyboard input with ${mode} parent streams`, async ({ onTestFailed }) => {
    const terminal = spawnSourcePty(
      bunExecutable(),
      bunArguments(new URL("./fixtures/guide-terminal-input.ts", import.meta.url), [mode]),
      { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env },
    )
    let output = ""
    let exit: SourcePtyExit | undefined
    onTestFailed(() => console.error({ output, exit }))
    terminal.onData((data) => {
      output += data
    })
    terminal.onExit((status) => {
      exit = status
    })
    try {
      await vi.waitFor(
        () => {
          expect(exit).toBeUndefined()
          expect(output).toContain("TERMINAL INPUT READY")
        },
        { timeout: 5000, interval: 20 },
      )
      terminal.write("terminal-proof\r")
      await vi.waitFor(
        () => {
          expect(output).toContain("TERMINAL INPUT ACCEPTED")
          expect(exit).toEqual({ exitCode: 0, signal: 0 })
        },
        { timeout: 5000, interval: 20 },
      )
    } finally {
      if (exit === undefined) terminal.kill("SIGKILL")
      await vi.waitFor(() => expect(exit).toBeDefined())
    }
  }, 15_000)
}
