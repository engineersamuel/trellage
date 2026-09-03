import assert from "node:assert/strict"
import test from "node:test"

import { HerdrRequestError } from "../lib/herdr.ts"
import { resolveSourceAgent, sourceAgentCandidates } from "../lib/source-agent.ts"

const context = {
  workspaceId: "w1",
  tabId: "w1:t1",
  paneId: "w1:p1",
  cwd: "/repo",
}

test("lists every completed agent in the active tab when the focused pane is a shell", async () => {
  const agents = await sourceAgentCandidates(context, {
    getAgentForPane: async () => {
      throw new HerdrRequestError("agent.get", "agent_not_found", "not an agent")
    },
    listAvailableAgents: async () => [
      {
        workspace_id: "w1",
        tab_id: "w1:t1",
        pane_id: "w1:p2",
        agent_status: "idle",
        state_change_seq: 8,
      },
      {
        workspace_id: "w1",
        tab_id: "w1:t1",
        pane_id: "w1:p3",
        agent_status: "idle",
        state_change_seq: 12,
      },
      {
        workspace_id: "w1",
        tab_id: "w1:t2",
        pane_id: "w1:p4",
        agent_status: "done",
        state_change_seq: 20,
      },
    ],
  })
  assert.deepEqual(
    agents.map((agent) => agent.pane_id),
    ["w1:p3", "w1:p2"],
  )
})

test("refuses to guess between multiple source agents", async () => {
  await assert.rejects(
    resolveSourceAgent(context, {
      getAgentForPane: async () => {
        throw new HerdrRequestError("agent.get", "agent_not_found", "not an agent")
      },
      listAvailableAgents: async () => [
        {
          workspace_id: "w1",
          tab_id: "w1:t1",
          pane_id: "w1:p2",
          agent_status: "idle",
          state_change_seq: 8,
        },
        {
          workspace_id: "w1",
          tab_id: "w1:t1",
          pane_id: "w1:p3",
          agent_status: "done",
          state_change_seq: 12,
        },
      ],
    }),
    /More than one completed agent/,
  )
})

test("keeps a focused agent instead of searching the workspace", async () => {
  let listed = false
  const focused = {
    workspace_id: "w1",
    pane_id: "w1:p1",
    agent_status: "working",
  }
  const agent = await resolveSourceAgent(context, {
    getAgentForPane: async () => focused,
    listAvailableAgents: async () => {
      listed = true
      return []
    },
  })
  assert.equal(agent, focused)
  assert.equal(listed, false)
})

test("reports an active workspace without any agents", async () => {
  await assert.rejects(
    resolveSourceAgent(context, {
      getAgentForPane: async () => {
        throw new HerdrRequestError("agent.get", "agent_not_found", "not an agent")
      },
      listAvailableAgents: async () => [],
    }),
    /No agent was found in the active Herdr workspace/,
  )
})

test("uses an explicitly selected source pane without workspace fallback", async () => {
  const selected = {
    workspace_id: "w1",
    pane_id: "w1:p3",
    agent_status: "done",
  }
  const agent = await resolveSourceAgent(
    { ...context, sourcePaneId: "w1:p3" },
    {
      getAgentForPane: async (paneId) => {
        assert.equal(paneId, "w1:p3")
        return selected
      },
      listAvailableAgents: async () => {
        throw new Error("workspace fallback must not run")
      },
    },
  )
  assert.equal(agent, selected)
})
