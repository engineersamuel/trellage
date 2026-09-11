import { EventEmitter } from "node:events"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { PassThrough } from "node:stream"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"

import {
  main,
  runContextMenuLauncher,
  runContextMenuPopup,
  type ContextMenuLauncherDependencies,
} from "../context-menu-popup.ts"
import { writeInvocation } from "../lib/state.ts"

const request = {
  schemaVersion: 1 as const,
  kind: "rewrite-output" as const,
  source: { workspaceId: "workspace", tabId: "tab", paneId: "pane", cwd: "/repo", agent: "copilot" },
  message: {
    paneId: "pane",
    role: "harness" as const,
    text: "Visible answer",
    capturedAt: "2026-09-10T12:00:00.000Z",
    source: "visible" as const,
  },
  styles: [{ id: "pony", title: "Ponytail voice", description: "A playful rewrite.", instruction: "Use the Ponytail voice." }],
}

class FakeLauncherChild extends EventEmitter {
  readonly pid = 42
  readonly stdin = new PassThrough()
  readonly killSignals: string[] = []

  kill(signal?: string | number): boolean {
    this.killSignals.push(String(signal ?? "SIGTERM"))
    return true
  }
}

const executableLauncherRoot = async (): Promise<{ readonly root: string; readonly launcher: string }> => {
  const root = await mkdtemp(path.join(tmpdir(), "trx-context-popup-root-"))
  const launcher = path.join(root, "packages", "trellage-launcher", "dist", "launcher.mjs")
  await mkdir(path.dirname(launcher), { recursive: true })
  await writeFile(path.join(root, "mise.toml"), "[env]\n", "utf8")
  await writeFile(launcher, "#!/usr/bin/env node\n", { mode: 0o700 })
  await chmod(launcher, 0o700)
  return { root, launcher }
}

test("resolves the launcher below the Trellage checkout and sends a private stdin request", async (t) => {
  const { root, launcher } = await executableLauncherRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string>; readonly options: Record<string, unknown> }> = []
  let child: FakeLauncherChild | undefined
  const spawnProcess: NonNullable<ContextMenuLauncherDependencies["spawnProcess"]> = ((command, args, options) => {
    child = new FakeLauncherChild()
    calls.push({ command, args: [...args], options: options as Record<string, unknown> })
    queueMicrotask(() => child?.emit("close", 0, null))
    return child as never
  }) as NonNullable<ContextMenuLauncherDependencies["spawnProcess"]>

  await runContextMenuLauncher(request, {
    env: {},
    root,
    spawnProcess,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.command, process.execPath)
  assert.deepEqual(calls[0]?.args, [launcher, "rewrite-context", "--interactive"])
  assert.equal(calls[0]?.options.detached, undefined)
  assert.deepEqual((calls[0]?.options.stdio as ReadonlyArray<unknown>).slice(0, 3), ["pipe", "inherit", "inherit"])
  assert.equal((calls[0]?.options.stdio as ReadonlyArray<unknown>)[0], "pipe")
  assert.equal((calls[0]?.options.env as NodeJS.ProcessEnv).TRELLAGE_CONTEXT_MENU_INPUT_FD, undefined)
  assert.equal(child?.stdin.writableEnded, true)
})

test("makes popup startup failures dismissible without throwing into Herdr", async () => {
  const messages: string[] = []
  const status = await runContextMenuPopup({}, {}, async (message) => { messages.push(message) })
  assert.equal(status, 1)
  assert.deepEqual(messages, ["Trellage contextual action menu failed: The contextual action menu is missing plugin runtime context"])
})

test("resolves HERDR_PLUGIN_ROOT through the private invocation path", async (t) => {
  const { root } = await executableLauncherRoot()
  const pluginRoot = path.join(root, "plugin")
  await mkdir(pluginRoot)
  const stateDir = await mkdtemp(path.join(tmpdir(), "trx-context-popup-state-"))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(stateDir, { recursive: true, force: true })
  })
  const requestPath = await writeInvocation(stateDir, request)
  let observedRoot: string | undefined
  const status = await main({
    HERDR_PLUGIN_ROOT: pluginRoot,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    TRELLAGE_GUIDE_CONTEXT_MENU_INVOCATION_PATH: requestPath,
  }, {
    runLauncher: async (_request, options) => {
      observedRoot = options.root
      return 0
    },
  })
  assert.equal(status, 0)
  assert.equal(observedRoot, root)
})
