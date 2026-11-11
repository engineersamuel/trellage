// sf: talk to the software factory from the command line.
// Prompts go through the same AG-UI endpoint as the UIs, into a saved thread,
// so they show up in the Foldkit thread list and in the coordinator log of both UIs.
//   sf "prompt"                 new thread, stream the coordinator's answer
//   sf -t THREAD_ID "prompt"    continue a thread
//   sf -f FOLDER "prompt"       new thread in a folder (id from `sf folders`): own worktree and sub-coordinator
//   sf -f FOLDER -b BASE "prompt"  same, worktree branched from BASE instead of origin's default branch
//   sf folders                  folders; `sf folders /path/to/repo` adds a repo folder
//   sf status | workers | threads
//   sf settings ['{"theme":"nord"}']   read, or apply a JSON merge patch
//   sf approvals                        pending approvals
//   sf approve ID "Option" [note]       answer one (the coordinator continues in its thread)
//   sf draft FOLDER "prompt"            new draft (nothing starts until run); prints its id
//   sf draft ID                         show the draft: versions, pending rewrites, reports
//   sf draft ID enhance|council|debate|research|hyperresearch|dismiss|run
//   sf draft ID pick N | use VERSION_ID | edit "prompt" | rm
//   sf run THREAD                       delivery record: workers and steps, approvals, security reviews, PR
//   sf goal ...                         goal specs: create, run, score, history (see goal-cli.ts)
import { Console, Effect, Stream } from "effect"
import { goalCommand } from "./goal-cli.ts"
import type { Draft, Thread } from "./src/threads.ts"

const base = process.env.SF_URL ?? "http://127.0.0.1:7700"

/** Keep the real error (e.g. the server's `400 {"error":…}`), not Effect's generic wrapper. */
const keep = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))
const request = (path: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async () => {
      const r = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json" } })
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
      return r
    },
    catch: keep,
  })
/** The parsed response body; `A` is the shape the endpoint returns. */
const json = <A = unknown>(path: string, init?: RequestInit) =>
  request(path, init).pipe(Effect.flatMap((r) => Effect.tryPromise({ try: () => r.json() as Promise<A>, catch: keep })))
const print = (v: unknown) => Console.log(JSON.stringify(v, null, 2))

/** The AG-UI event fields the CLI reads. */
type AguiEvent = { type: string; delta: string; toolCallName: string; message: string }
type PendingApproval = {
  id: string
  title: string
  status: string
  options: string[]
  threadId?: string | null
  summary: string
}

/** Server-sent events from a response body, one parsed JSON value per `data:` line. */
const events = (body: ReadableStream<Uint8Array>) =>
  Stream.fromReadableStream({ evaluate: () => body, onError: (e) => e as Error }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((l) => l.startsWith("data: ")),
    Stream.map((l) => JSON.parse(l.slice(6)) as AguiEvent),
  )

/** Send a prompt (new thread unless `thread`), stream the coordinator's answer to `out`, and return the thread id. */
const ask = (
  prompt: string,
  thread?: string,
  folderId = "general",
  baseBranch?: string,
  out: NodeJS.WriteStream = process.stdout,
  goalId?: string,
) =>
  Effect.gen(function* () {
    const threadId: string =
      thread ??
      (yield* json<{ id: string }>("/api/threads/create", {
        method: "POST",
        body: JSON.stringify({
          folderId,
          ...(baseBranch ? { base: baseBranch } : {}),
          ...(goalId ? { goalId } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
      })).id
    yield* Console.error(`thread ${threadId}`)
    const r = yield* request("/api/agui", {
      method: "POST",
      body: JSON.stringify({
        threadId,
        runId: crypto.randomUUID(),
        messages: [{ id: crypto.randomUUID(), role: "user", content: prompt }],
      }),
    })
    yield* events(r.body!).pipe(
      Stream.runForEach((e) =>
        Effect.sync(() => {
          if (e.type === "TEXT_MESSAGE_CONTENT") out.write(e.delta)
          else if (e.type === "TEXT_MESSAGE_END") out.write("\n")
          else if (e.type === "TOOL_CALL_START") process.stderr.write(`· ${e.toolCallName}\n`)
          else if (e.type === "RUN_ERROR") process.stderr.write(`error: ${e.message}\n`)
        }),
      ),
    )
    return threadId
  })

/** A draft in short form: versions (current marked), waiting rewrites, reports. */
const showDraft = (id: string, d: Draft) => {
  const n = (vid: string) => d.versions.findIndex((v) => v.id === vid) + 1
  const lines = [`draft ${id}${d.startedAt ? "  (started)" : ""}`]
  d.versions.forEach((v, i) =>
    lines.push(
      `${v.id === d.current ? "*" : " "} v${i + 1} ${v.source}${v.title ? ` · ${v.title}` : ""}  ${v.id}\n    ${(v.prompt.split("\n")[0] ?? "").slice(0, 120)}`,
    ),
  )
  d.pending?.candidates.forEach((c, i) => lines.push(`  rewrite ${i}: ${c.title}\n    ${c.notes}`))
  for (const r of d.reports) lines.push(`  report ${r.action} (v${n(r.versionId)}): ${r.path}  worker ${r.workerId}`)
  return Console.log(lines.join("\n"))
}

const draft = (args: string[]) => {
  const [a, b, ...more] = args
  const id = a ?? ""
  const post = (path: string, body?: unknown) =>
    json<Draft>(`/api/drafts/${encodeURIComponent(id)}/${path}`, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).pipe(Effect.flatMap((d) => showDraft(id, d)))
  switch (b) {
    case undefined:
      return json<{ threads: Thread[] }>("/api/threads/get").pipe(
        Effect.flatMap((v) => {
          const t = v.threads.find((x) => x.id === id || x.id.startsWith(id))
          return t?.draft ? showDraft(t.id, t.draft) : Effect.fail(new Error(`no draft ${id}`))
        }),
      )
    case "pick":
      return post("pick", { index: Number(more[0]) })
    case "use":
      return post("current", { versionId: more[0] })
    case "edit":
      return post("versions", { prompt: more.join(" ") })
    case "rm":
      return request(`/api/drafts/${encodeURIComponent(id)}`, { method: "DELETE" }).pipe(
        Effect.flatMap(() => Console.log(`deleted ${id}`)),
      )
    default:
      // A folder id and a prompt create a draft; anything else is an action on a draft id.
      return ["enhance", "council", "debate", "research", "hyperresearch", "dismiss", "run"].includes(b)
        ? post(b)
        : json<{ id: string; draft: Draft }>("/api/drafts", {
            method: "POST",
            body: JSON.stringify({ folderId: a, prompt: [b, ...more].join(" ") }),
          }).pipe(Effect.flatMap((t) => Effect.andThen(Console.log(t.id), showDraft(t.id, t.draft))))
  }
}

const [cmd, ...rest] = process.argv.slice(2)
const program = (() => {
  switch (cmd) {
    case undefined:
    case "-h":
    case "--help":
      return Console.log(
        'usage: sf "prompt" | sf -t THREAD "prompt" | sf -f FOLDER [-b BASE] "prompt" | sf folders [PATH] | sf status | sf workers | sf threads | sf settings [PATCH_JSON] | sf run THREAD | sf goal [list|show ID|new|save FILE|run ID [--thread T]|check ID THREAD|history ID] | sf approvals | sf approve ID "Option" [note] | sf draft FOLDER "prompt" | sf draft ID [enhance|council|debate|research|hyperresearch|dismiss|run|pick N|use VERSION|edit "prompt"|rm]',
      )
    case "run":
      return json(`/api/runs/${encodeURIComponent(rest[0] ?? "")}`).pipe(Effect.flatMap(print))
    case "goal":
      return goalCommand(
        json,
        (prompt, folderId, baseBranch, goalId) => ask(prompt, undefined, folderId, baseBranch, process.stderr, goalId),
        rest,
      )
    case "status":
      return json("/api/steps").pipe(Effect.flatMap(print))
    case "workers":
      return json("/api/workers").pipe(Effect.flatMap(print))
    case "threads":
      return json("/api/threads/get").pipe(Effect.flatMap(print))
    case "settings":
      return rest[0]
        ? json("/api/settings", { method: "PATCH", body: rest[0] }).pipe(Effect.flatMap(print))
        : json<{ settings: unknown }>("/api/settings").pipe(Effect.flatMap((v) => print(v.settings)))
    case "approvals":
      return json<PendingApproval[]>("/api/approvals").pipe(
        Effect.flatMap((all) => {
          const p = all.filter((a) => a.status === "pending")
          return Console.log(
            p.length === 0
              ? "no pending approvals"
              : p
                  .map(
                    (a) =>
                      `${a.id}  ${a.title}\n  options: ${a.options.map((o) => JSON.stringify(o)).join(" | ")}\n  thread: ${a.threadId ?? "-"}\n\n${a.summary}`,
                  )
                  .join("\n\n"),
          )
        }),
      )
    case "approve":
      return json<{ id: string; answer: string }>(`/api/approvals/${encodeURIComponent(rest[0] ?? "")}`, {
        method: "POST",
        body: JSON.stringify({ answer: rest[1] ?? "", note: rest.slice(2).join(" ") }),
      }).pipe(Effect.flatMap((a) => Console.log(`answered ${a.id}: ${a.answer}`)))
    case "-t":
      return ask(rest.slice(1).join(" "), rest[0])
    case "-f":
      return rest[1] === "-b"
        ? ask(rest.slice(3).join(" "), undefined, rest[0], rest[2])
        : ask(rest.slice(1).join(" "), undefined, rest[0])
    case "draft":
      return draft(rest)
    case "folders":
      return (
        rest[0]
          ? json("/api/folders", { method: "POST", body: JSON.stringify({ path: rest[0] }) })
          : json("/api/folders")
      ).pipe(Effect.flatMap(print))
    default:
      return ask([cmd, ...rest].join(" "))
  }
})()

Effect.runPromise(program as Effect.Effect<unknown, Error>)
  .then((code) => {
    if (typeof code === "number") process.exit(code)
  })
  .catch((e) => {
    console.error(String(e?.message ?? e))
    process.exit(1)
  })
