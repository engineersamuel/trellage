import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import {
  spawnSourcePty,
  waitForRawInput,
  type SourcePtyExit,
} from "../../packages/trellage-launcher/test/helpers/source-pty.ts"
import type { guideWorld } from "./guide-world.ts"

type World = Awaited<ReturnType<typeof guideWorld>>
const root = path.resolve(import.meta.dir, "../..")
const require = createRequire(path.join(root, "packages/trellage-launcher/package.json"))
const { Terminal } = require("@xterm/headless")

export async function runGuideProcess(options: {
  world: World
  cwd: string
  argv: readonly string[]
  mode?: "guide" | "guide-preview" | "guide-forks"
  fallback?: boolean
  optimize?: boolean
  missingKey?: boolean
  clipboard?: boolean
  stdin?: string
  terminal?: { columns: number; ready: string; close: "cancel" | "quit" | "optimize-back" }
}) {
  const { world, cwd } = options
  const receipt = path.join(cwd, "model-audit.json")
  const mode = options.mode ?? "guide"
  const inputFile = options.terminal && options.stdin !== undefined ? path.join(cwd, "stdin.txt") : undefined
  if (inputFile) await writeFile(inputFile, options.stdin!, { mode: 0o600, flag: "wx" })
  const argv = [
    "-c",
    inputFile
      ? 'exec "$@" <"$TRELLAGE_GUIDE_TEST_STDIN" 3<"$TRELLAGE_GUIDE_TEST_CATALOG"'
      : 'exec "$@" 3<"$TRELLAGE_GUIDE_TEST_CATALOG"',
    "guide-fixture",
    process.execPath,
    path.join(import.meta.dir, "guide-process-entry.ts"),
    mode,
    ...(mode === "guide" ? [world.guideRoot, world.promptMasterSkillDirectory] : []),
    ...options.argv,
  ]
  const env = {
    ...world.environment,
    CI: "false",
    FORCE_COLOR: "1",
    TYPESAFE_API_KEY: options.fallback || options.missingKey ? undefined : "fixture-not-a-secret",
    TRELLAGE_GUIDE_TEST_FALLBACK: options.fallback ? "1" : "0",
    TRELLAGE_GUIDE_TEST_OPTIMIZE: options.optimize ? "1" : "0",
    TRELLAGE_GUIDE_TEST_AUDIT: receipt,
    TRELLAGE_GUIDE_TEST_CATALOG: world.catalogFile,
    TRELLAGE_GUIDE_TEST_STDIN: inputFile,
    TRELLAGE_GUIDE_TEST_ALLOW_CLIPBOARD: options.clipboard ? "1" : "0",
  }
  let output: string, status: number, initialScreen: string | undefined
  if (!options.terminal) {
    const child = Bun.spawn(["/bin/bash", ...argv], {
      cwd,
      env,
      stdin: Buffer.from(options.stdin ?? ""),
      stdout: "pipe",
      stderr: "pipe",
    })
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      output = stdout + stderr
      status = code
    } finally {
      clearTimeout(timeout)
    }
  } else {
    const configuration = options.terminal
    const terminal = new Terminal({ cols: configuration.columns, rows: 30, scrollback: 0, allowProposedApi: true })
    const child = spawnSourcePty("/bin/bash", argv, {
      name: "xterm-256color",
      cols: configuration.columns,
      rows: 30,
      cwd,
      env,
    })
    let screen = "",
      raw = "",
      exit: SourcePtyExit | undefined
    child.onExit((value) => {
      exit = value
    })
    terminal.onData((data: string) => {
      if (!exit) child.write(data)
    })
    child.onData((data) => {
      raw = (raw + data).slice(-65536)
      terminal.write(data, () => {
        screen = Array.from(
          { length: terminal.rows },
          (_, row) =>
            terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? "",
        ).join("\n")
      })
    })
    const wait = async (ready: () => boolean, timeout = 15_000) => {
      const deadline = Date.now() + timeout
      while (!ready()) {
        if (Date.now() >= deadline) throw Error(`Guide terminal timed out: ${JSON.stringify(options.argv)}\n${screen}`)
        await Bun.sleep(20)
      }
    }
    try {
      await wait(() => exit !== undefined || screen.includes(configuration.ready))
      assert.equal(exit, undefined, `Guide exited before ${configuration.ready}: ${raw}`)
      // Rendering precedes input effects; terminal output alone is not an input-ready signal.
      await waitForRawInput(child)
      assert.equal(exit, undefined, "Guide exited before enabling terminal input")
      initialScreen = screen
      child.write(configuration.close === "cancel" ? "\u0003" : "q")
      if (configuration.close === "optimize-back") {
        await wait(() => exit !== undefined || screen.includes("What do you want to do?"))
        assert.equal(exit, undefined, "Optimize must return to intent entry")
        await waitForRawInput(child)
        assert.equal(exit, undefined, "Guide exited before re-enabling terminal input")
        child.write("\u0003")
      }
      await wait(() => exit !== undefined)
      assert.equal(exit!.signal, 0, `Guide was killed rather than closed: ${raw}`)
      assert.equal(exit!.error, undefined)
      status = exit!.exitCode
      output = screen
    } finally {
      if (!exit) {
        child.kill("SIGHUP")
        try {
          await wait(() => exit !== undefined, 2000)
        } catch {
          if (!exit) child.kill("SIGKILL")
          await wait(() => exit !== undefined, 2000)
        }
      }
      terminal.dispose()
    }
  }
  const audit = JSON.parse(await readFile(receipt, "utf8")) as {
    clean: boolean
    clipboard?: string
    failure?: string
    calls: Record<string, number>
    expectedMatches: readonly { profileRef: string; workflowId: string; confidence: number }[]
  }
  return { status, output, initialScreen, audit }
}
