import assert from "node:assert/strict"
import test from "node:test"

import { runSourcePickerAction } from "../source-picker-action.ts"

test("routes the original pane context through private storage before focusing the titled popup", async () => {
  let staged
  let command
  const requestPath = await runSourcePickerAction({
    env: {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        workspace_id: "workspace-1",
        tab_id: "tab-1",
        focused_pane_id: "pane-1",
        focused_pane_cwd: "/work/project",
        focused_pane_agent: "codex",
      }),
      HERDR_PLUGIN_STATE_DIR: "/private/state",
    },
    invocationWriter: async (_stateDir, value) => {
      staged = value
      return "/private/state/invocations/request.json"
    },
    run: async (args) => { command = args },
    request: async () => undefined,
  })
  assert.equal(requestPath, "/private/state/invocations/request.json")
  assert.deepEqual(staged, {
    schemaVersion: 1,
    kind: "source-picker",
    context: {
      workspaceId: "workspace-1",
      tabId: "tab-1",
      paneId: "pane-1",
      cwd: "/work/project",
      agent: "codex",
    },
  })
  assert.deepEqual(command, [
    "plugin", "pane", "open", "--plugin", "trellage.guide-handoff", "--entrypoint", "source-picker",
    "--env", "TRELLAGE_GUIDE_SOURCE_PICKER_INVOCATION_PATH=/private/state/invocations/request.json", "--focus",
  ])
})


test("opening after focus changes consumes the original private context", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const { main } = await import("../source-picker.ts")
  const stateDir = await mkdtemp(path.join(tmpdir(), "trx-source-route-"))
  try {
    const env = { HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w1", tab_id: "w1:t1", focused_pane_id: "original", focused_pane_cwd: "/original" }) }
    const requestPath = await runSourcePickerAction({ env, run: async () => undefined })
    const changed = { ...env, HERDR_PANE_ID: "later", HERDR_CWD: "/later", TRELLAGE_GUIDE_SOURCE_PICKER_INVOCATION_PATH: requestPath }
    let captured
    await main(changed, async ({ context }) => { captured = context; return 0 })
    assert.equal(captured.paneId, "original")
    assert.equal(captured.cwd, "/original")
    await assert.rejects(main(changed, async () => 0))
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})
