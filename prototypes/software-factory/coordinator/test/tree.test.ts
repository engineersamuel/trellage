import { expect, test } from "bun:test"
import { workerTree } from "../../shared/tree.ts"

test("agents nest under the coordinator that started them", () => {
  const ws = [
    { id: "w-2", role: "worker", owner: "coordinator" },
    { id: "w-1", role: "worker", owner: "sub-a" },
    { id: "sub-a", role: "coordinator", owner: undefined },
    { id: "coordinator", role: "coordinator" },
    { id: "w-3", role: "worker", owner: "sub-gone" },
  ]
  expect(workerTree(ws).map(({ w, depth }) => `${depth}:${w.id}`)).toEqual([
    "0:coordinator",
    "1:sub-a",
    "2:w-1",
    "1:w-2",
    "1:w-3",
  ])
})

test("rows say which agent is the Chief of Staff, an archived chat, a sub-coordinator, or a worker", () => {
  const { agentLabel } = require("../../shared/tree.ts")
  expect(agentLabel({ id: "coordinator", role: "coordinator", name: "coordinator" }).tag).toBe("🌐 Chief of Staff")
  expect(agentLabel({ id: "gen-1", role: "coordinator", name: "General · Look for optimizations" })).toEqual({
    tag: "💬 Archived chat",
    kind: "sub",
    name: "Look for optimizations",
  })
  expect(agentLabel({ id: "sub-1", role: "coordinator", name: "trellage · Fix the thing" })).toEqual({
    tag: "⎇ Sub-coordinator · trellage",
    kind: "sub",
    name: "Fix the thing",
  })
  expect(agentLabel({ id: "w-1", role: "worker", name: "verify-fix" })).toEqual({
    tag: "Worker",
    kind: "worker",
    name: "verify-fix",
  })
})
