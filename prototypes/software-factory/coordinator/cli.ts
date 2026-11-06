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
//   sf verify THREAD EXPECT.json [SECS] check the record against EXPECT; poll up to SECS.
//                                       Exit 0 met, 1 unmet, 2 decision pending, 3 reported blocked
import { Console, Duration, Effect, Stream } from "effect"
import { readFileSync } from "node:fs"
import { stopReason, unmet, type Expectation, type Run } from "./src/run.ts"

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
const json = (path: string, init?: RequestInit) => request(path, init).pipe(Effect.flatMap((r) => Effect.tryPromise({ try: () => r.json(), catch: keep })))
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

/** A draft in short form: versions (current marked), waiting rewrites, reports. */
const showDraft = (id: string, d: any) => {
  const n = (vid: string) => d.versions.findIndex((v: any) => v.id === vid) + 1
  const lines = [`draft ${id}${d.startedAt ? "  (started)" : ""}`]
  d.versions.forEach((v: any, i: number) => lines.push(`${v.id === d.current ? "*" : " "} v${i + 1} ${v.source}${v.title ? ` · ${v.title}` : ""}  ${v.id}\n    ${v.prompt.split("\n")[0].slice(0, 120)}`))
  d.pending?.candidates.forEach((c: any, i: number) => lines.push(`  rewrite ${i}: ${c.title}\n    ${c.notes}`))
  for (const r of d.reports) lines.push(`  report ${r.action} (v${n(r.versionId)}): ${r.path}  worker ${r.workerId}`)
  return Console.log(lines.join("\n"))
}

const draft = (args: string[]) => {
  const [a, b, ...more] = args
  const id = a ?? ""
  const post = (path: string, body?: unknown) =>
    json(`/api/drafts/${encodeURIComponent(id)}/${path}`, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).pipe(Effect.flatMap((d) => showDraft(id, d)))
  switch (b) {
    case undefined:
      return json("/api/threads/get").pipe(
        Effect.flatMap((v: any) => {
          const t = v.threads.find((t: any) => t.id === id || t.id.startsWith(id))
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
      return request(`/api/drafts/${encodeURIComponent(id)}`, { method: "DELETE" }).pipe(Effect.flatMap(() => Console.log(`deleted ${id}`)))
    default:
      // A folder id and a prompt create a draft; anything else is an action on a draft id.
      return ["enhance", "council", "debate", "research", "hyperresearch", "dismiss", "run"].includes(b)
        ? post(b)
        : json("/api/drafts", { method: "POST", body: JSON.stringify({ folderId: a, prompt: [b, ...more].join(" ") }) }).pipe(
            Effect.flatMap((t: any) => Effect.andThen(Console.log(t.id), showDraft(t.id, t.draft))),
          )
  }
}

/**
 * Poll the run record every 15 s until it meets the expectation or `secs` pass. Exit 0 met, 1 unmet at the end,
 * 2 a decision for this run is pending (answer it, then verify again), 3 the run reported blocked.
 */
const verify = (thread: string, file: string, secs: number) => {
  const expect = JSON.parse(readFileSync(file, "utf8")) as Expectation
  const deadline = Date.now() + secs * 1000
  const done = (run: Run, code: number, text: string) => Effect.andThen(print(run), Effect.sync(() => (console.log(text), process.exit(code))))
  const tick: Effect.Effect<void, Error> = json(`/api/runs/${encodeURIComponent(thread)}`).pipe(
    Effect.flatMap((run: Run) => {
      const missing = unmet(run, expect)
      if (!missing.length) return done(run, 0, "PASS")
      const stop = stopReason(run)
      if (stop) return done(run, stop.code, `STOP ${stop.reason}\nunmet:\n${missing.join("\n")}`)
      if (Date.now() >= deadline) return done(run, 1, `FAIL\n${missing.join("\n")}`)
      return Effect.andThen(Effect.sleep(Duration.seconds(15)), Effect.suspend(() => tick))
    }),
  )
  return tick
}

const [cmd, ...rest] = process.argv.slice(2)
const program = (() => {
  switch (cmd) {
    case undefined:
    case "-h":
    case "--help":
      return Console.log('usage: sf "prompt" | sf -t THREAD "prompt" | sf -f FOLDER [-b BASE] "prompt" | sf folders [PATH] | sf status | sf workers | sf threads | sf settings [PATCH_JSON] | sf run THREAD | sf verify THREAD EXPECT.json [SECS] | sf approvals | sf approve ID "Option" [note] | sf draft FOLDER "prompt" | sf draft ID [enhance|council|debate|research|hyperresearch|dismiss|run|pick N|use VERSION|edit "prompt"|rm]')
    case "run":
      return json(`/api/runs/${encodeURIComponent(rest[0] ?? "")}`).pipe(Effect.flatMap(print))
    case "verify":
      return verify(rest[0] ?? "", rest[1] ?? "", Number(rest[2] ?? 0))
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
    case "draft":
      return draft(rest)
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
