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
import { Console, Effect, Stream } from "effect"

const base = process.env.SF_URL ?? "http://127.0.0.1:7700"

const request = (path: string, init?: RequestInit) =>
  Effect.tryPromise(async () => {
    const r = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json" } })
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
    return r
  })
const json = (path: string, init?: RequestInit) => request(path, init).pipe(Effect.flatMap((r) => Effect.tryPromise(() => r.json())))
const print = (v: unknown) => Console.log(JSON.stringify(v, null, 2))

/** Server-sent events from a response body, one parsed JSON value per `data:` line. */
const events = (body: ReadableStream<Uint8Array>) =>
  Stream.fromReadableStream({ evaluate: () => body, onError: (e) => e as Error }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((l) => l.startsWith("data: ")),
    Stream.map((l) => JSON.parse(l.slice(6)) as { type: string; [k: string]: any }),
  )

const ask = (prompt: string, thread?: string, folderId = "general", base?: string) =>
  Effect.gen(function* () {
    const threadId: string =
      thread ?? (yield* json("/api/threads/create", { method: "POST", body: JSON.stringify({ folderId, ...(base ? { base } : {}), messages: [{ role: "user", content: prompt }] }) })).id
    yield* Console.error(`thread ${threadId}`)
    const r = yield* request("/api/agui", {
      method: "POST",
      body: JSON.stringify({ threadId, runId: crypto.randomUUID(), messages: [{ id: crypto.randomUUID(), role: "user", content: prompt }] }),
    })
    yield* events(r.body!).pipe(
      Stream.runForEach((e) =>
        Effect.sync(() => {
          if (e.type === "TEXT_MESSAGE_CONTENT") process.stdout.write(e.delta)
          else if (e.type === "TEXT_MESSAGE_END") process.stdout.write("\n")
          else if (e.type === "TOOL_CALL_START") process.stderr.write(`· ${e.toolCallName}\n`)
          else if (e.type === "RUN_ERROR") process.stderr.write(`error: ${e.message}\n`)
        }),
      ),
    )
  })

const [cmd, ...rest] = process.argv.slice(2)
const program = (() => {
  switch (cmd) {
    case undefined:
    case "-h":
    case "--help":
      return Console.log('usage: sf "prompt" | sf -t THREAD "prompt" | sf -f FOLDER [-b BASE] "prompt" | sf folders [PATH] | sf status | sf workers | sf threads | sf settings [PATCH_JSON] | sf approvals | sf approve ID "Option" [note]')
    case "status":
      return json("/api/steps").pipe(Effect.flatMap(print))
    case "workers":
      return json("/api/workers").pipe(Effect.flatMap(print))
    case "threads":
      return json("/api/threads/get").pipe(Effect.flatMap(print))
    case "settings":
      return rest[0]
        ? json("/api/settings", { method: "PATCH", body: rest[0] }).pipe(Effect.flatMap(print))
        : json("/api/settings").pipe(Effect.flatMap((v: any) => print(v.settings)))
    case "approvals":
      return json("/api/approvals").pipe(
        Effect.flatMap((all: any[]) => {
          const p = all.filter((a) => a.status === "pending")
          return Console.log(
            p.length === 0
              ? "no pending approvals"
              : p.map((a) => `${a.id}  ${a.title}\n  options: ${a.options.map((o: string) => JSON.stringify(o)).join(" | ")}\n  thread: ${a.threadId ?? "-"}\n\n${a.summary}`).join("\n\n"),
          )
        }),
      )
    case "approve":
      return json(`/api/approvals/${encodeURIComponent(rest[0] ?? "")}`, {
        method: "POST",
        body: JSON.stringify({ answer: rest[1] ?? "", note: rest.slice(2).join(" ") }),
      }).pipe(Effect.flatMap((a: any) => Console.log(`answered ${a.id}: ${a.answer}`)))
    case "-t":
      return ask(rest.slice(1).join(" "), rest[0])
    case "-f":
      return rest[1] === "-b" ? ask(rest.slice(3).join(" "), undefined, rest[0], rest[2]) : ask(rest.slice(1).join(" "), undefined, rest[0])
    case "folders":
      return (rest[0] ? json("/api/folders", { method: "POST", body: JSON.stringify({ path: rest[0] }) }) : json("/api/folders")).pipe(Effect.flatMap(print))
    default:
      return ask([cmd, ...rest].join(" "))
  }
})()

Effect.runPromise(program).catch((e) => {
  console.error(String(e?.message ?? e))
  process.exit(1)
})
