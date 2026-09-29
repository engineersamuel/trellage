import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { bunExecutable } from "@trellage/runtime"
import { engagementGuideCommand, engagementSourceChoice, openEngagementGuide } from "../engagement-action.ts"
import { requestHerdr, runHerdr } from "../lib/herdr.ts"
import { initialSourceChoiceIndex, orderedSourceChoices } from "../custom-popup.ts"

const execute = promisify(execFile)
const context = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", cwd: "/customer/engagement" }
const pane = (id = context.paneId, overrides: Record<string, unknown> = {}) => ({
  type: "pane_info",
  pane: {
    pane_id: id, terminal_id: `terminal-${id}`, workspace_id: context.workspaceId,
    tab_id: context.tabId, cwd: context.cwd, foreground_cwd: context.cwd,
    agent: null, ...overrides,
  },
})

const sourceFixture = async (t: test.TestContext) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trx-engagement-action-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, "Trellage's checkout")
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

test("opens the worktree Guide for the source repository, then verifies and focuses the new pane", async (t) => {
  const { root } = await sourceFixture(t)
  const recorded = recorder()
  const created = await openEngagementGuide({
    context, root, ...recorded,
    inspectRepository: async (cwd) => {
      assert.equal(cwd, context.cwd)
      return cwd
    },
  })
  assert.equal(created, "w1:p2")
  assert.deepEqual(recorded.calls.map(({ method }) => method), [
    "pane.get", "pane.get", "pane.split", "pane.get", "pane.rename", "pane.focus",
  ])
  assert.deepEqual(recorded.calls[2]?.params, {
    target_pane_id: "w1:p1", workspace_id: "w1", direction: "right", cwd: context.cwd, focus: false,
  })
  assert.deepEqual(recorded.commands, [
    ["pane", "run", "w1:p2", engagementGuideCommand(root, bunExecutable())],
    ["pane", "wait-output", "w1:p2", "--match", "Engagement sources", "--source", "visible", "--timeout", "30000"],
  ])
  assert.deepEqual(recorded.calls.at(-1)?.params, { pane_id: "w1:p2" })
})

test("refuses a changed source terminal before allocating a pane", async (t) => {
  const { root } = await sourceFixture(t)
  const recorded = recorder()
  let reads = 0
  await assert.rejects(openEngagementGuide({
    context, root, run: recorded.run, inspectRepository: async (cwd) => cwd,
    request: async (method, params) => {
      assert.equal(method, "pane.get")
      assert.equal(params.pane_id, context.paneId)
      return pane(context.paneId, { terminal_id: ++reads === 1 ? "first-terminal" : "replacement-terminal" })
    },
  }), /source terminal changed/u)
  assert.equal(reads, 2)
  assert.equal(recorded.commands.length, 0)
})

test("never sends the Guide command to a changed directory or an agent that occupied the new pane", async (t) => {
  const { root } = await sourceFixture(t)
  for (const changed of [{ foreground_cwd: "/another/repository" }, { agent: "copilot" }]) {
    const recorded = recorder()
    await assert.rejects(openEngagementGuide({
      context, root, run: recorded.run, inspectRepository: async (cwd) => cwd,
      request: async (method, params) => method === "pane.get" && params.pane_id === "w1:p2"
        ? pane("w1:p2", changed)
        : recorded.request(method, params),
    }), /Inspect engagement pane w1:p2.*not an idle terminal/u)
    assert.equal(recorded.commands.length, 0)
    assert.equal(recorded.calls.some(({ method }) => method === "pane.focus" || method === "pane.close"), false)
  }
})

test("reports startup uncertainty with the allocated pane ID and never retries or closes it", async (t) => {
  const { root } = await sourceFixture(t)
  const recorded = recorder()
  await assert.rejects(openEngagementGuide({
    context, root, request: recorded.request, inspectRepository: async (cwd) => cwd,
    run: async (args) => {
      recorded.commands.push(args)
      if (args[1] === "wait-output") throw new Error("Guide startup timed out")
    },
  }), /Inspect engagement pane w1:p2 before retrying: Guide startup timed out/u)
  assert.equal(recorded.commands.filter((args) => args[1] === "run").length, 1)
  assert.equal(recorded.calls.filter(({ method }) => method === "pane.split").length, 1)
  assert.equal(recorded.calls.some(({ method }) => method === "pane.close" || method === "pane.focus"), false)
})

test("rejects an unsafe worktree router without allocating a pane", async (t) => {
  const { root, router } = await sourceFixture(t)
  await rm(router)
  await symlink("/bin/echo", router)
  const recorded = recorder()
  await assert.rejects(openEngagementGuide({
    context, root, ...recorded, inspectRepository: async (cwd) => cwd,
  }), /worktree trx launcher is unsafe/u)
  assert.equal(recorded.calls.length, 0)
})

test("quotes the source checkout, preserves the target cwd, and removes stale popup intent", async (t) => {
  const { root, directory, router } = await sourceFixture(t)
  const customer = path.join(directory, "customer's repository")
  await mkdir(customer)
  await writeFile(router, [
    "#!/bin/sh",
    'printf "%s\\n" "$TRELLAGE_TRX_SOURCE_ROOT" "$TRELLAGE_TRX_NATIVE_SOURCE" "$PWD" "$@"',
    'printf "%s\\n" "${TRELLAGE_GUIDE_HERDR_CONTEXT_JSON-unset}" "${TRELLAGE_GUIDE_HERDR_INTENT_FILE-unset}" "${TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE-unset}"',
  ].join("\n"), { mode: 0o755 })
  const result = await execute("/bin/sh", ["-c", engagementGuideCommand(root, bunExecutable())], {
    cwd: customer,
    env: {
      ...process.env,
      TRELLAGE_GUIDE_HERDR_CONTEXT_JSON: "old-popup",
      TRELLAGE_GUIDE_HERDR_INTENT_FILE: "/old-intent",
      TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE: "/old-conversation",
    },
  })
  assert.deepEqual(result.stdout.trim().split("\n"), [
    path.join(root, "prototypes/trellage-router"), "1", await realpath(customer),
    "guide", "--engagement", "unset", "unset", "unset",
  ])
})

test("keeps engagement visible without changing the preferred highlighted-text source", () => {
  const engagement = engagementSourceChoice(context)
  const choices = orderedSourceChoices([], "Selected text", { entries: [] }, { kind: "rewrite" }, engagement)
  assert.deepEqual(choices.map((choice) => choice.kind), ["rewrite", "engagement", "selection"])
  assert.equal(initialSourceChoiceIndex(choices), 2)
  assert.match(engagement.label, /HVE next steps/u)
  assert.match(engagement.preview, /No capture, model call, or HVE agent launch/u)
  assert.equal(initialSourceChoiceIndex([engagement]), 0)
})
