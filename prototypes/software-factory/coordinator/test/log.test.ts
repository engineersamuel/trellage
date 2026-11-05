import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore, ftsQuery } from "../src/events.ts"

const ev = (seq: number, workerId = "coordinator", type = "user.message") => ({ seq, workerId, type, agentId: null, timestamp: "1", data: { content: `m${seq}` } })
const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "sf-db-")), "events.db")

test("events append one row each and survive a restart; deltas and status pings are not stored", () => {
  const file = tmpFile()
  const a = new EventStore(file)
  a.append(ev(1))
  a.append(ev(2, "coordinator", "assistant.message_delta"))
  a.append(ev(3, "coordinator", "factory.worker_updated"))
  a.append(ev(4, "w-1"))
  a.append(ev(4, "w-1")) // a duplicate seq is ignored
  a.close()
  const b = new EventStore(file)
  expect(b.load("coordinator", 100)).toEqual([ev(1)])
  expect(b.load("w-1", 100)).toEqual([ev(4, "w-1")])
  expect(b.maxSeq()).toBe(4)
})

test("load returns the newest N oldest first; prune keeps the newest N per agent", () => {
  const s = new EventStore(tmpFile())
  for (let i = 1; i <= 5; i++) s.append(ev(i)), s.append(ev(100 + i, "w-1"))
  expect(s.load("coordinator", 2).map((e) => e.seq)).toEqual([4, 5])
  s.prune(3)
  expect(s.load("coordinator", 100).map((e) => e.seq)).toEqual([3, 4, 5])
  expect(s.load("w-1", 100).map((e) => e.seq)).toEqual([103, 104, 105])
})

test("timeline merges agents in seq order, filtered by agent, type, per-agent count and since", () => {
  const s = new EventStore(tmpFile())
  s.append(ev(1, "a"))
  s.append(ev(2, "b", "assistant.message"))
  s.append(ev(3, "a", "assistant.message"))
  s.append(ev(4, "c"))
  const seqs = (q: Parameters<EventStore["timeline"]>[0]) => JSON.parse(s.timeline(q)).map((e: any) => e.seq)
  expect(JSON.parse(s.timeline({ workers: ["a", "b"], perWorker: 10 }))).toEqual([ev(1, "a"), ev(2, "b", "assistant.message"), ev(3, "a", "assistant.message")])
  expect(seqs({ types: ["assistant.message"], perWorker: 10 })).toEqual([2, 3])
  expect(seqs({ perWorker: 1 })).toEqual([2, 3, 4])
  expect(seqs({ since: 2, perWorker: 10 })).toEqual([3, 4])
  expect(s.timeline({ workers: ["none"], perWorker: 10 })).toBe("[]")
})

test("latest returns the data of the newest events of one type across agents", () => {
  const s = new EventStore(tmpFile())
  for (let i = 1; i <= 4; i++) s.append({ ...ev(i, `w${i}`, "factory.step_decided"), data: { step: `s${i}` } })
  expect(s.latest("factory.step_decided", 2)).toEqual([{ step: "s3" }, { step: "s4" }])
})

test("a version 1 store (one JSON blob per row) is migrated in place", () => {
  const file = tmpFile()
  const v1 = new Database(file)
  v1.run("CREATE TABLE events (worker TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (worker, seq))")
  v1.run("INSERT INTO events VALUES (?, ?, ?)", ["w-1", 7, JSON.stringify(ev(7, "w-1"))])
  v1.close()
  expect(new EventStore(file).load("w-1", 10)).toEqual([ev(7, "w-1")])
})

test("an old events.json is imported once, then removed; a broken one is ignored", () => {
  const home = mkdtempSync(path.join(tmpdir(), "sf-home-"))
  const s = new EventStore(path.join(home, "events.db"))
  writeFileSync(path.join(home, "events.json"), JSON.stringify([ev(7)]))
  expect(s.load("coordinator", 10, home)).toEqual([ev(7)])
  expect(existsSync(path.join(home, "events.json"))).toBe(false)
  writeFileSync(path.join(home, "events.json"), "{broken")
  expect(s.load("other", 10, home)).toEqual([])
})

test("importAll imports every agent directory's events.json", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-root-"))
  const s = new EventStore(path.join(root, "events.db"))
  for (const id of ["w-1", "sub-2"]) {
    mkdirSync(path.join(root, id))
    writeFileSync(path.join(root, id, "events.json"), JSON.stringify([ev(id === "w-1" ? 1 : 2, id)]))
  }
  s.importAll(root)
  expect(JSON.parse(s.timeline({ perWorker: 10 })).map((e: any) => e.workerId)).toEqual(["w-1", "sub-2"])
})

test("after replays stored events past a seq, scoped to one agent plus factory events, or null past the limit", () => {
  const s = new EventStore(tmpFile())
  s.append(ev(1, "a"))
  s.append(ev(2, "b"))
  s.append(ev(3, "coordinator", "factory.thread_updated"))
  s.append(ev(4, "a"))
  expect(s.after(1, 10)!.map((e) => e.seq)).toEqual([2, 3, 4])
  expect(s.after(1, 10, "a")!.map((e) => e.seq)).toEqual([3, 4])
  expect(s.after(1, 2)).toBeNull()
  expect(s.after(4, 10)).toEqual([])
})

test("full-text search finds messages, errors and tool calls across agents, and follows prune", () => {
  const s = new EventStore(tmpFile())
  s.append({ ...ev(1, "a", "assistant.message"), data: { content: "The SQLite migration finished" } })
  s.append({ ...ev(2, "b", "session.error"), data: { message: "sqlite busy" } })
  s.append({ ...ev(3, "b", "tool.execution_start"), data: { toolName: "bash", arguments: { command: "git status" } } })
  s.append({ ...ev(4, "b", "session.usage_info"), data: { content: "sqlite" } })
  expect(s.search("sqlite", 10).map((h) => h.seq).sort()).toEqual([1, 2])
  expect(s.search("SQLite migr", 10)).toMatchObject([{ seq: 1, workerId: "a", type: "assistant.message" }])
  expect(s.search("sqlite", 10)[0]!.snippet).toContain("«")
  expect(s.search("sqlite", 10, ["b"]).map((h) => h.seq)).toEqual([2])
  expect(s.search("bash status", 10).map((h) => h.seq)).toEqual([3])
  s.prune(1)
  expect(s.search("sqlite", 10).map((h) => h.seq)).toEqual([1])
})

test("search text is quoted for FTS5, so operators and quotes in it are plain words", () => {
  expect(ftsQuery('a "b" OR c*')).toBe('"a" "b" "OR" "c"*')
  expect(ftsQuery("  ")).toBeNull()
  const s = new EventStore(tmpFile())
  expect(s.search('") OR (', 10)).toEqual([])
})

test("a version 2 store gets the search index of its existing rows", () => {
  const file = tmpFile()
  const v2 = new Database(file)
  v2.run("CREATE TABLE events (seq INTEGER PRIMARY KEY, worker TEXT NOT NULL, type TEXT NOT NULL, agent TEXT, ts TEXT NOT NULL, data TEXT NOT NULL)")
  v2.run("INSERT INTO events VALUES (5, 'w', 'user.message', NULL, '1', '{\"content\":\"find the needle\"}')")
  v2.run("PRAGMA user_version = 2")
  v2.close()
  expect(new EventStore(file).search("needle", 10).map((h) => h.seq)).toEqual([5])
})

test("between returns one agent's events in [from, before), oldest first", () => {
  const s = new EventStore(tmpFile())
  for (let i = 1; i <= 6; i++) s.append(ev(i, i % 2 ? "a" : "b"))
  expect(s.between("a", 2, 5, 10).map((e) => e.seq)).toEqual([3])
  expect(s.between("a", 1, 6, 10).map((e) => e.seq)).toEqual([1, 3, 5])
  expect(s.between("a", 1, 6, 2).map((e) => e.seq)).toEqual([1, 3])
})
