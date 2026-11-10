import { GenUiToolError, defineAgentInterface } from "@plana-solutions/agent-interface"
import { Effect, Schema } from "effect"
import { getJson, send } from "./api"

/** Card tool arguments arrive as OpenUI values; this reads one as a string. */
const str = (args: Record<string, unknown>, key: string): string => {
  const value = args[key]
  return typeof value === "string" ? value : ""
}
const fail = (message: string) => new GenUiToolError({ message })

/**
 * Tools the live chat cards call (OpenUI `Query` / `Mutation`, see coordinator/src/cards.ts):
 * - factory_card: the card's current view (refreshed every few seconds), from GET /api/cards;
 * - focus_agent: select an agent in the Inbox (worker board "Show");
 * - answer_decision: answer a decision from the decision queue ("<id>|<option>");
 * - start_finding: start a report finding as a new conversation.
 */
const tools = {
  factory_card: (args: Record<string, unknown>) =>
    getJson(
      `/api/cards?${new URLSearchParams({ name: str(args, "name"), scope: str(args, "scope") || "coordinator", ...(str(args, "path") ? { path: str(args, "path") } : {}) })}`,
      Schema.Unknown,
    ).pipe(Effect.mapError(fail)),
  focus_agent: (args: Record<string, unknown>) =>
    str(args, "id")
      ? send("PATCH", "/api/settings", { focus: str(args, "id") }).pipe(Effect.as({ ok: true }), Effect.mapError(fail))
      : Effect.succeed({ ok: false }),
  answer_decision: (args: Record<string, unknown>) => {
    const [id, ...rest] = str(args, "pick").split("|")
    return id
      ? send("POST", `/api/approvals/${encodeURIComponent(id)}`, { answer: rest.join("|"), note: null }).pipe(
          Effect.as({ ok: true }),
          Effect.mapError(fail),
        )
      : Effect.succeed({ ok: false })
  },
  start_finding: (args: Record<string, unknown>) =>
    typeof args.rank === "number"
      ? send("POST", "/api/cards/start-finding", {
          path: str(args, "path"),
          rank: args.rank,
          scope: str(args, "scope"),
        }).pipe(Effect.as({ ok: true }), Effect.mapError(fail))
      : Effect.succeed({ ok: false }),
}

/** The agent-interface chat, embedded as a Submodel. */
export const chat = defineAgentInterface({ genui: { tools } }).submodel
