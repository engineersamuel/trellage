// Subagents an agent starts inside its own harness (Copilot `task`, Claude `Agent`, Pi `subagent`).
// The factory does not start or own them; the tree shows them as leaves under the agent.
import type { SubagentInfo } from "./factory.ts"

/** Pi's pi-subagents tool. Copilot and Claude report subagents with subagent.* events instead. */
const PI_TOOL = "subagent"

/**
 * Apply one event to an agent's subagent list. Returns the new list, or null when the event changes nothing.
 * Copilot (and Claude, mapped in claude.ts) send subagent.started/completed/failed with the spawning toolCallId;
 * Pi sends only the `subagent` tool call and its result. Only Pi's tool result ends a subagent: a Claude background
 * Agent call returns at once, long before its subagent finishes.
 */
export const trackSubagent = (
  list: readonly SubagentInfo[],
  type: string,
  agentId: string | null,
  d: Record<string, unknown>,
  harness: string,
): SubagentInfo[] | null => {
  const id = typeof d.toolCallId === "string" ? d.toolCallId : ""
  if (!id) return null
  const pi = harness === "pi" && agentId === null
  const set = (status: SubagentInfo["status"]) =>
    list.some((s) => s.id === id && s.status !== status) ? list.map((s) => (s.id === id ? { ...s, status } : s)) : null
  if (type === "subagent.started" || (pi && type === "tool.execution_start" && d.toolName === PI_TOOL)) {
    if (list.some((s) => s.id === id)) return null
    const args = (d.arguments ?? {}) as Record<string, unknown>
    const name = String(d.agentDisplayName || d.agentName || args.agent || args.description || "subagent")
    const description = String(d.agentDescription ?? args.task ?? args.description ?? "").slice(0, 200)
    return [...list, { id, name, description, status: "running" }]
  }
  if (type === "subagent.completed") return set(d.cancelled === true ? "failed" : "done")
  if (type === "subagent.failed") return set("failed")
  if (pi && type === "tool.execution_complete") return set(d.success === false ? "failed" : "done")
  return null
}
