import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { bunExecutable } from "@trellage/runtime"
import { requestHerdr, runHerdr } from "../lib/herdr.ts"
import {
  copyProgressPagePrompt,
  openRitualGuide,
  progressPageClipboardText,
  ritualGuideCommand,
} from "../ritual-action.ts"

const execute = promisify(execFile)
const context = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", cwd: "/customer/rituals" }
const pane = (id = context.paneId, overrides: Record<string, unknown> = {}) => ({
  type: "pane_info",
  pane: {
    pane_id: id, terminal_id: `terminal-${id}`, workspace_id: context.workspaceId,
    tab_id: context.tabId, cwd: context.cwd, foreground_cwd: context.cwd,
    agent: null, ...overrides,
  },
})

const sourceFixture = async (t: test.TestContext) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trx-ritual-action-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, "checkout")
  const router = path.join(root, "prototypes/trellage-router/bin/trx")
  await mkdir(path.dirname(router), { recursive: true })
  await writeFile(router, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  return { directory, root, router }
}

const recorder = () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const commands: Array<ReadonlyArray<string>> = []
  const request: typeof requestHerdr = async (method, params) => {
    calls.push({ method, params })
    if (method === "pane.get") return pane(String(params.pane_id))
    if (method === "pane.split") return pane("w1:p2")
    if (method === "pane.rename" || method === "pane.focus") return { type: "ok" }
    throw new Error(`Unexpected Herdr method: ${method}`)
  }
  const run: typeof runHerdr = async (args) => { commands.push(args) }
  return { calls, commands, request, run }
}

test("opens the ritual list in a new pane and waits for the Rituals heading", async (t) => {
  const { root } = await sourceFixture(t)
  const recorded = recorder()
  const created = await openRitualGuide({
    context, root, ...recorded,
    inspectRepository: async (cwd) => cwd,
  })
  assert.equal(created, "w1:p2")
  assert.deepEqual(recorded.commands, [
    ["pane", "run", "w1:p2", ritualGuideCommand(root, bunExecutable())],
    ["pane", "wait-output", "w1:p2", "--match", "Rituals", "--source", "visible", "--timeout", "30000"],
  ])
})

test("rejects an unsafe router before it copies or opens a pane", async (t) => {
  const { root, router } = await sourceFixture(t)
  await rm(router)
  await symlink("/bin/echo", router)
  const recorded = recorder()
  await assert.rejects(copyProgressPagePrompt({
    context, root, request: recorded.request, printPrompt: async () => "prompt", copy: () => {},
  }), /worktree trx launcher is unsafe/u)
  assert.equal(recorded.calls.length, 0)
})

test("copies the printed prompt with the repository path and does not open a pane", async (t) => {
  const { root } = await sourceFixture(t)
  const recorded = recorder()
  const copied: string[] = []
  const message = await copyProgressPagePrompt({
    context, root, request: recorded.request,
    printPrompt: async (cwd) => {
      assert.equal(cwd, context.cwd)
      return "Write the page.\n"
    },
    copy: (value) => { copied.push(value) },
  })
  assert.equal(message, "Copied the progress-page prompt. Paste it into the current agent.")
  assert.deepEqual(copied, [progressPageClipboardText("Write the page.\n", context.cwd)])
  assert.equal(recorded.calls.some(({ method }) => method === "pane.split"), false)
})

test("keeps the prompt on a clipboard failure", async (t) => {
  const { root } = await sourceFixture(t)
  await assert.rejects(copyProgressPagePrompt({
    context, root, request: recorder().request,
    printPrompt: async () => "Write the page.",
    copy: () => { throw new Error("Clipboard verification failed") },
  }), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /Clipboard verification failed/u)
    assert.equal((error as { prompt?: string }).prompt, progressPageClipboardText("Write the page.", context.cwd))
    return true
  })
})

test("quotes the ritual command and removes stale popup intent", async (t) => {
  const { root, directory, router } = await sourceFixture(t)
  const customer = path.join(directory, "customer's repository")
  await mkdir(customer)
  await writeFile(router, [
    "#!/bin/sh",
    'printf "%s\\n" "$PWD" "$@"',
    'printf "%s\\n" "${TRELLAGE_GUIDE_HERDR_CONTEXT_JSON-unset}" "${TRELLAGE_GUIDE_HERDR_INTENT_FILE-unset}" "${TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE-unset}"',
  ].join("\n"), { mode: 0o755 })
  const result = await execute("/bin/sh", ["-c", ritualGuideCommand(root, bunExecutable())], {
    cwd: customer,
    env: {
      ...process.env,
      TRELLAGE_GUIDE_HERDR_CONTEXT_JSON: "old-popup",
      TRELLAGE_GUIDE_HERDR_INTENT_FILE: "/old-intent",
      TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE: "/old-conversation",
    },
  })
  assert.deepEqual(result.stdout.trim().split("\n"), [
    await realpath(customer), "guide", "--ritual", "unset", "unset", "unset",
  ])
})
