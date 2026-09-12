import { bunArguments, bunExecutable } from "@trellage/runtime"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test, vi } from "vitest"
import { spawnSourcePty, type SourcePtyExit } from "./helpers/source-pty.ts"

test("source PTYs preserve Bun, process identity, raw Unicode input, dimensions, resizing and exit codes", async ({
  onTestFailed,
}) => {
  const terminal = spawnSourcePty(
    bunExecutable(),
    bunArguments(new URL("./fixtures/source-pty-probe.ts", import.meta.url)),
    {
      name: "xterm-256color",
      cols: 117,
      rows: 39,
      cwd: process.cwd(),
      env: process.env,
    },
  )
  let output = ""
  let exit: SourcePtyExit | undefined
  onTestFailed(() => {
    console.error({ output, exit })
  })
  terminal.onData((data) => {
    output += data
  })
  terminal.onExit((status) => {
    exit = status
  })
  const waitFor = (expected: string) =>
    vi.waitFor(
      () => {
        expect(exit, output).toBeUndefined()
        expect(output).toContain(expected)
      },
      { timeout: 2_000, interval: 20 },
    )
  try {
    await waitFor('{"bun":"1.3.3","columns":117,"rows":39}')
    const pidReport = output.match(/^\{"pid":(\d+)\}\r?$/mu)
    expect(pidReport).not.toBeNull()
    const pid = Number(pidReport?.[1])
    expect(Number.isSafeInteger(pid)).toBe(true)
    expect(pid).toBeGreaterThan(0)
    expect(pid).not.toBe(process.pid)
    await vi.waitFor(() => expect(terminal.pid).toBe(pid))
    const input = "literal input \u03bb \u001b[A"
    terminal.write(`${input}\n`)
    await waitFor(JSON.stringify({ input }))
    terminal.resize(83, 24)
    terminal.write("size\n")
    await waitFor('{"bun":"1.3.3","columns":83,"rows":24}')
    terminal.write("exit\n")
    await vi.waitFor(() => expect(exit).toEqual({ exitCode: 7, signal: 0 }))
  } finally {
    if (exit === undefined) {
      terminal.kill("SIGKILL")
      await vi.waitFor(() => expect(exit).toBeDefined())
    }
  }
})

test("source PTYs preserve the child signal instead of the transport exit code", async () => {
  const terminal = spawnSourcePty(
    bunExecutable(),
    bunArguments(new URL("./fixtures/source-pty-probe.ts", import.meta.url)),
    {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    },
  )
  let output = ""
  let exit: SourcePtyExit | undefined
  terminal.onData((data) => {
    output += data
  })
  terminal.onExit((status) => {
    exit = status
  })
  try {
    await vi.waitFor(() => {
      expect(exit, output).toBeUndefined()
      expect(output).toContain('"bun":"1.3.3"')
    })
    terminal.kill("SIGKILL")
    await vi.waitFor(() => expect(exit).toEqual({ exitCode: 0, signal: 9 }))
  } finally {
    if (exit === undefined) {
      terminal.kill("SIGKILL")
      await vi.waitFor(() => expect(exit).toBeDefined())
    }
  }
})

test.each([false, true])(
  "source PTYs preserve cache-free source execution in isolated environments (override: %s)",
  async (override) => {
    const home = await mkdtemp(path.join(tmpdir(), "trellage-source-pty-cache-"))
    const terminal = spawnSourcePty(
      bunExecutable(),
      bunArguments(new URL("./fixtures/source-pty-probe.ts", import.meta.url), ["source-cache"]),
      {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: {
          HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: home,
          PATH: path.dirname(bunExecutable()),
          NODE_ENV: "test",
          ...(override ? { BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(home, "configured-cache") } : {}),
        },
      },
    )
    let output = ""
    let exit: SourcePtyExit | undefined
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
          expect(output).toMatch(/"transpilerCache":[^\r\n]+\r\n/u)
        },
        { timeout: 5_000, interval: 20 },
      )
      expect(output).toContain('{"transpilerCache":"0"}')
      await vi.waitFor(
        () => {
          expect(exit).toBeUndefined()
          expect(output).toContain('{"bun":"1.3.3","columns":80,"rows":24}')
        },
        { timeout: 5_000, interval: 20 },
      )
      terminal.write("exit\n")
      await vi.waitFor(() => expect(exit).toEqual({ exitCode: 7, signal: 0 }))
      expect(await readdir(home, { recursive: true })).toEqual([])
    } finally {
      try {
        if (exit === undefined) {
          terminal.kill("SIGKILL")
        }
        await vi.waitFor(() => expect(exit).toBeDefined())
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  },
  10_000,
)
