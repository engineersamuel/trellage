import { expect, test } from "bun:test"
import { specView } from "../src/spec.ts"

const worker = { id: "w-1", name: "arch", role: "worker", auth: "native", model: "opus", owner: "sub-84574dec", home: "/h" }
const spec = {
  step: "optimize-improve-codebase-architecture",
  workdir: "/wt",
  skills: [
    { name: "improve-codebase-architecture", dir: "/s/ica", healed: false },
    { name: "codebase-design", dir: "/s/cd", healed: false },
  ],
  skillDirectories: ["/h/skills"],
  extraPath: [],
  tools: [],
  systemPrompt: null,
  sessionId: null,
}
const ev = (type: string, data: unknown, agentId: string | null = null) => ({ seq: 0, workerId: "w-1", type, agentId, timestamp: "", data })

test("the spec shows the worktree and which requested skills the runtime really loaded", () => {
  const log = [
    ev("session.start", { context: { cwd: "/wt", repository: "o/copilot-proxy-rs", branch: "factory/x", headCommit: "8e511c8" } }),
    ev("session.skills_loaded", { skills: [{ name: "codebase-design", source: "custom", enabled: true, path: "/s/cd/SKILL.md" }, { name: "pr-stack", source: "builtin", enabled: true }] }),
    ev("session.skills_loaded", { skills: [] }, "sub-agent"),
    ev("session.mcp_servers_loaded", { servers: [{ name: "github", status: "connected" }] }),
  ]
  const thread = { id: "84574dec-1", title: "Look for optimizations", createdAt: 0, folderId: "copilot-proxy-rs", worktree: "/wt", branch: "factory/x", base: "8e511c8" }
  const v = specView(worker, spec, log, thread, ["p1"])
  expect(v.worktree).toEqual({
    path: "/wt",
    repository: "o/copilot-proxy-rs",
    branch: "factory/x",
    base: "8e511c8",
    head: "8e511c8",
    folder: "copilot-proxy-rs",
    conversation: { id: "84574dec-1", title: "Look for optimizations" },
  })
  expect(v.skills.map((s) => [s.name, s.loaded])).toEqual([
    ["improve-codebase-architecture", false],
    ["codebase-design", true],
  ])
  expect(v.loadedSkills.map((s) => [s.name, s.requested])).toEqual([
    ["codebase-design", true],
    ["pr-stack", false],
  ])
  expect(v.mcpServers).toEqual([{ name: "github", status: "connected", source: null }])
  expect(v.plugins).toEqual(["p1"])
})

test("a worker without a spec or events still gets a view", () => {
  const v = specView(worker, null, [], undefined, [])
  expect(v.step).toBeNull()
  expect(v.skills).toEqual([])
  expect(v.worktree.path).toBeNull()
})
