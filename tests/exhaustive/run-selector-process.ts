import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import type { guideWorld } from "./guide-world.ts"
import type { RunOptions } from "../../packages/trellage-runtime/src/native-run/run.ts"
import {
  spawnSourcePty,
  waitForRawInput,
  type SourcePtyExit,
} from "../../packages/trellage-launcher/test/helpers/source-pty.ts"

const root = path.resolve(import.meta.dir, "../..")
const require = createRequire(path.join(root, "packages/trellage-launcher/package.json"))
const { Terminal } = require("@xterm/headless")

export interface SelectorExpectation {
  readonly options?: RunOptions
  readonly rejection?: string
}

export async function verifyRunSelectorProcess(
  world: Awaited<ReturnType<typeof guideWorld>>,
  argv: readonly string[],
  ordinal: bigint,
  columns?: number,
  action: "cancel" | "launch" = "cancel",
  expectation?: SelectorExpectation,
  routedArgv: readonly string[] = argv,
) {
  await world.withCase(ordinal, async (cwd) => {
    const receipt = path.join(cwd, "selector-audit.json")
    if (action === "launch") assert.notEqual(columns, undefined, "Launching requires a terminal")
    const separator = routedArgv.indexOf("--")
    const ownArgs = separator < 0 ? routedArgv : routedArgv.slice(0, separator)
    const dryRun = expectation?.options?.dryRun ?? ownArgs.includes("--dry-run")
    const expectedStatus =
      action !== "launch" ? 0 : expectation?.rejection ? (expectation.rejection === "usage" ? 2 : 1) : dryRun ? 0 : 17
    const expectedSpawned = action === "launch" && !expectation?.rejection && !dryRun ? 1 : 0
    const command = ["/bin/bash", path.join(root, "prototypes/trellage-router/bin/trx"), "run", ...argv]
    const environment = {
      ...world.environment,
      CI: "false",
      FORCE_COLOR: "1",
      TRELLAGE_TRX_SOURCE_ROOT: path.join(root, "prototypes/trellage-router"),
      TRELLAGE_BUN_EXECUTABLE: path.join(import.meta.dir, "run-selector-bun.sh"),
      TRELLAGE_SELECTOR_REAL_BUN: process.execPath,
      TRELLAGE_SELECTOR_PRELOAD: path.join(import.meta.dir, "run-selector-preload.ts"),
      TRELLAGE_SELECTOR_RECEIPT: receipt,
      TRELLAGE_SELECTOR_ACTION: action,
      TRELLAGE_SELECTOR_EXPECTED_ARGS: JSON.stringify(routedArgv),
      ...(expectation ? { TRELLAGE_SELECTOR_EXPECTATION: JSON.stringify(expectation) } : {}),
      XDG_CACHE_HOME: path.join(cwd, "cache"),
      XDG_DATA_HOME: path.join(cwd, "data"),
      XDG_STATE_HOME: path.join(cwd, "state"),
    }
    if (columns === undefined) {
      const child = Bun.spawn(
        ["python3", "-c", "import os,sys; os.setsid(); os.execv(sys.argv[1],sys.argv[1:])", ...command],
        { cwd: root, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      )
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15000)
      try {
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        assert.equal(status, 1, stdout + stderr)
        assert.match(stderr, /ENXIO/)
      } finally {
        clearTimeout(timeout)
      }
    } else {
      const terminal = new Terminal({
        cols: columns,
        rows: 40,
        scrollback: 0,
        allowProposedApi: true,
      })
      const child = spawnSourcePty(command[0]!, command.slice(1), {
        name: "xterm-256color",
        cols: columns,
        rows: 40,
        cwd: root,
        env: environment,
      })
      let raw = "",
        screen = "",
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
            (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? "",
          ).join("\n")
        })
      })
      const wait = async (predicate: () => boolean, timeout = 15000) => {
        const deadline = Date.now() + timeout
        while (!predicate()) {
          if (Date.now() > deadline) throw Error(`Selector timeout: ${raw}`)
          await Bun.sleep(20)
        }
      }
      try {
        await wait(() => exit !== undefined || screen.includes("cancel"))
        assert.equal(exit, undefined, raw)
        const commandLine = () => screen.split("\n").find((line) => line.includes("trx run "))
        const initial = commandLine()
        assert.ok(initial, raw)
        await waitForRawInput(child)
        if (action === "launch") {
          assert.ok(initial.includes("trx run pi clean"), raw)
          child.write("\r")
        } else {
          child.write("\u001b[C")
          await wait(() => exit !== undefined || commandLine() !== initial)
          assert.equal(exit, undefined, raw)
          child.write("q")
        }
        await wait(() => exit !== undefined)
        assert.equal(exit!.exitCode, expectedStatus, raw)
        assert.equal(exit!.signal, 0, raw)
        assert.equal(exit!.error, undefined)
      } finally {
        if (!exit) {
          child.kill("SIGKILL")
          await wait(() => exit !== undefined, 5000)
        }
        terminal.dispose()
      }
    }
    const audit = JSON.parse(await readFile(receipt, "utf8"))
    assert.equal(audit.failure, undefined)
    assert.deepEqual(
      audit.launch,
      action === "launch"
        ? {
            argv: ["pi", "clean", "--model", "gpt-6.1-sol", "--effort", "high", ...routedArgv],
            spawned: expectedSpawned,
            status: expectedStatus,
          }
        : undefined,
    )
    assert.deepEqual(audit.calls, { "models.list": 1 })
    assert.equal(audit.entry, path.join(root, "packages/trellage-launcher/src/run-select-cli.tsx"))
  })
}
