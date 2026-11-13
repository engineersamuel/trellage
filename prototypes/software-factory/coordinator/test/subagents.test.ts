import { expect, test } from "bun:test"
import { toEvents } from "../src/claude.ts"
import type { SubagentInfo } from "../src/factory.ts"
import { trackSubagent } from "../src/subagents.ts"

const run = (harness: string, events: [string, string | null, Record<string, unknown>][]) =>
  events.reduce<SubagentInfo[]>((l, [type, agentId, d]) => trackSubagent(l, type, agentId, d, harness) ?? l, [])

test("Copilot subagent events add a running subagent, then mark it done or failed", () => {
  const l = run("copilot", [
    [
      "subagent.started",
      "a1",
      { toolCallId: "c1", agentName: "explore", agentDisplayName: "arch-explore", agentDescription: "Walk the code" },
    ],
    ["subagent.started", "a2", { toolCallId: "c2", agentName: "research" }],
    ["subagent.completed", "a1", { toolCallId: "c1" }],
    ["subagent.failed", "a2", { toolCallId: "c2", error: "no response" }],
  ])
  expect(l).toEqual([
    { id: "c1", name: "arch-explore", description: "Walk the code", status: "done" },
    { id: "c2", name: "research", description: "", status: "failed" },
  ])
})

test("a Pi worker's subagent tool call is a subagent; its tool result ends it", () => {
  const l = run("pi", [
    [
      "tool.execution_start",
      null,
      { toolCallId: "p1", toolName: "subagent", arguments: { agent: "scout", task: "Map the repo" } },
    ],
    ["tool.execution_start", null, { toolCallId: "p2", toolName: "bash", arguments: {} }],
  ])
  expect(l).toEqual([{ id: "p1", name: "scout", description: "Map the repo", status: "running" }])
  expect(trackSubagent(l, "tool.execution_complete", null, { toolCallId: "p1", success: true }, "pi")).toEqual([
    { ...l[0]!, status: "done" },
  ])
})

test("a Claude background Agent call's tool result does not end its subagent; the task notification does", () => {
  const started = run("claude", [["subagent.started", null, { toolCallId: "t1", agentName: "Explore" }]])
  expect(
    trackSubagent(started, "tool.execution_complete", null, { toolCallId: "t1", success: true }, "claude"),
  ).toBeNull()
  expect(trackSubagent(started, "subagent.completed", null, { toolCallId: "t1" }, "claude")![0]!.status).toBe("done")
})

test("Claude subagent tasks map to subagent events; shell tasks do not", () => {
  const sys = (m: Record<string, unknown>) =>
    toEvents({ type: "system", ...m } as never, "t").map((e) => [e.type, e.data])
  expect(
    sys({
      subtype: "task_started",
      task_id: "k",
      tool_use_id: "t1",
      task_type: "local_agent",
      subagent_type: "Explore",
      description: "Find X",
    }),
  ).toEqual([
    [
      "subagent.started",
      { toolCallId: "t1", agentName: "Explore", agentDisplayName: "Explore", agentDescription: "Find X" },
    ],
  ])
  expect(
    sys({ subtype: "task_started", task_id: "k", tool_use_id: "b1", task_type: "local_bash", description: "npm test" }),
  ).toEqual([])
  expect(
    sys({ subtype: "task_notification", task_id: "k", tool_use_id: "t1", status: "completed", summary: "" }),
  ).toEqual([["subagent.completed", { toolCallId: "t1" }]])
  expect(
    sys({ subtype: "task_notification", task_id: "k", tool_use_id: "t1", status: "stopped", summary: "" }),
  ).toEqual([["subagent.failed", { toolCallId: "t1", error: "subagent stopped" }]])
})

test("a stopped agent's subagents come back from its stored events; one left running ended with it", () => {
  const { withSubagents } = require("../src/run.ts") as typeof import("../src/run.ts")
  const past = [
    { id: "w1", harness: "copilot" },
    { id: "w2", harness: "pi" },
  ]
  const out = withSubagents(past, [
    { worker: "w1", type: "subagent.started", agent: "a", data: { toolCallId: "c1", agentName: "explore" } },
    { worker: "w1", type: "subagent.completed", agent: "a", data: { toolCallId: "c1" } },
    {
      worker: "w2",
      type: "tool.execution_start",
      agent: null,
      data: { toolCallId: "p1", toolName: "subagent", arguments: { agent: "scout" } },
    },
    { worker: "live", type: "subagent.started", agent: "a", data: { toolCallId: "x" } },
  ])
  expect(out.map((w) => w.subagents.map((s) => `${s.name}:${s.status}`))).toEqual([["explore:done"], ["scout:failed"]])
})
