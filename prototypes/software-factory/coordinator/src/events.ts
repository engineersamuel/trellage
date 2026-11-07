// Factory event store: an append-only SQLite log of every agent's events and the factory's own.
// The UI reads an agent's history after a restart, and cross-agent timelines in one query.
import { Database, type Statement } from "bun:sqlite"
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import type { FeedEvent } from "./factory.ts"

/** Rows kept per agent; older ones are pruned when the store opens. */
export const KEEP_PER_WORKER = 20_000

/** Not stored: streaming fragments (the final message replaces them), model-layer copies, and status pings. */
export const ephemeral = (type: string): boolean =>
  type.endsWith("_delta") ||
  type === "tool.execution_partial_result" ||
  type.startsWith("model.") ||
  type === "factory.worker_updated" ||
  type === "factory.ping"

const SCHEMA = 3

/** Searchable text of an event: messages, errors and tool calls. Used by the FTS5 index triggers. */
const SEARCH_TEXT = `CASE new.type
  WHEN 'tool.execution_start' THEN coalesce(json_extract(new.data, '$.toolName'), '') || ' ' || coalesce(json_extract(new.data, '$.arguments'), '')
  ELSE coalesce(json_extract(new.data, '$.content'), json_extract(new.data, '$.message'), '') END`
const SEARCH_TYPES = "('user.message', 'assistant.message', 'session.error', 'tool.execution_start')"

export type SearchHit = { seq: number; workerId: string; type: string; timestamp: string; snippet: string }

/** User text as an FTS5 query: every word must match, the last one as a prefix. */
export const ftsQuery = (q: string): string | null => {
  const words = q.match(/[\p{L}\p{N}_]+/gu) ?? []
  return words.length ? words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ") : null
}

/** One event row as a JSON object, built in SQLite so reads skip a parse and re-serialize. */
const ROW_JSON = "json_object('seq', seq, 'workerId', worker, 'type', type, 'agentId', agent, 'timestamp', ts, 'data', json(data))"

export class EventStore {
  private readonly db: Database
  private readonly insert: Statement

  constructor(file: string) {
    this.db = new Database(file, { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    // WAL + NORMAL: a crash can lose the last commits, never corrupt the file.
    this.db.run("PRAGMA synchronous = NORMAL")
    this.migrate()
    this.insert = this.db.prepare("INSERT OR IGNORE INTO events (seq, worker, type, agent, ts, data) VALUES (?, ?, ?, ?, ?, ?)")
    this.prune(KEEP_PER_WORKER)
  }

  private migrate(): void {
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version
    if (version === SCHEMA) return
    this.db.transaction(() => {
      if (version < 2) this.migrateV2()
      this.migrateV3()
      this.db.run(`PRAGMA user_version = ${SCHEMA}`)
    })()
  }

  /** Version 3: an FTS5 index of message text, kept in step with events by triggers. */
  private migrateV3(): void {
    this.db.run("CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, tokenize = 'unicode61')")
    this.db.run(`CREATE TRIGGER IF NOT EXISTS events_fts_add AFTER INSERT ON events WHEN new.type IN ${SEARCH_TYPES}
      BEGIN INSERT INTO events_fts (rowid, text) VALUES (new.seq, ${SEARCH_TEXT}); END`)
    this.db.run("CREATE TRIGGER IF NOT EXISTS events_fts_del AFTER DELETE ON events BEGIN DELETE FROM events_fts WHERE rowid = old.seq; END")
    this.db.run(`INSERT INTO events_fts (rowid, text) SELECT seq, ${SEARCH_TEXT.replaceAll("new.", "")} FROM events WHERE type IN ${SEARCH_TYPES}`)
  }

  private migrateV2(): void {
    const old = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").get()
    {
      if (old) this.db.run("ALTER TABLE events RENAME TO events_v1")
      this.db.run(
        "CREATE TABLE events (seq INTEGER PRIMARY KEY, worker TEXT NOT NULL, type TEXT NOT NULL, agent TEXT, ts TEXT NOT NULL, data TEXT NOT NULL)",
      )
      this.db.run("CREATE INDEX events_worker ON events (worker, seq)")
      this.db.run("CREATE INDEX events_type ON events (type, seq)")
      // Version 1 kept one JSON blob per row.
      if (old) {
        this.db.run(`INSERT OR IGNORE INTO events SELECT json_extract(event, '$.seq'), worker, json_extract(event, '$.type'),
          json_extract(event, '$.agentId'), json_extract(event, '$.timestamp'), json(json_extract(event, '$.data')) FROM events_v1`)
        this.db.run("DROP TABLE events_v1")
      }
    }
  }

  /** Keep the newest `keep` rows of each agent. */
  prune(keep: number): void {
    this.db.run(
      "DELETE FROM events WHERE seq IN (SELECT seq FROM (SELECT seq, ROW_NUMBER() OVER (PARTITION BY worker ORDER BY seq DESC) AS n FROM events) WHERE n > ?)",
      [keep],
    )
  }

  /** Append one event; ephemeral types are skipped. */
  append(e: FeedEvent): void {
    if (ephemeral(e.type)) return
    this.insert.run(e.seq, e.workerId, e.type, e.agentId, e.timestamp, JSON.stringify(e.data ?? null))
  }

  /** Highest stored seq, so a restarted factory never reuses one. */
  maxSeq(): number {
    return (this.db.query("SELECT coalesce(max(seq), 0) AS m FROM events").get() as { m: number }).m
  }

  /** The newest `limit` events of one agent, oldest first. An old events.json in `home` is imported once. */
  load(worker: string, limit: number, home?: string): FeedEvent[] {
    if (home) this.importLegacy(worker, home)
    const rows = this.db
      .query(`SELECT ${ROW_JSON} AS e FROM (SELECT * FROM events WHERE worker = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`)
      .all(worker, limit) as { e: string }[]
    return rows.map((r) => JSON.parse(r.e))
  }

  /**
   * One timeline across agents, oldest first, as a JSON array string (no parse on the way out).
   * Optional filters: agents, event types, and the newest `perWorker` events of each agent.
   */
  timeline(q: { workers?: string[]; types?: string[]; perWorker: number; since?: number }): string {
    const where: string[] = []
    const args: (string | number)[] = []
    if (q.workers?.length) where.push(`worker IN (${q.workers.map(() => "?").join(",")})`), args.push(...q.workers)
    if (q.types?.length) where.push(`type IN (${q.types.map(() => "?").join(",")})`), args.push(...q.types)
    if (q.since !== undefined) where.push("seq > ?"), args.push(q.since)
    const sql = `SELECT coalesce(json_group_array(json(e)), '[]') AS a FROM (
      SELECT ${ROW_JSON} AS e, seq FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY worker ORDER BY seq DESC) AS n FROM events
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ) WHERE n <= ? ORDER BY seq)`
    return (this.db.query(sql).get(...args, q.perWorker) as { a: string }).a
  }

  /**
   * Stored events after `seq`, oldest first, for a feed client that reconnects.
   * Null when more than `limit` were missed: the client must reload instead.
   */
  after(seq: number, limit: number, worker?: string | null): FeedEvent[] | null {
    const rows = this.db
      .query(`SELECT ${ROW_JSON} AS e FROM events WHERE seq > ? ${worker ? "AND (worker = ? OR type LIKE 'factory.%')" : ""} ORDER BY seq LIMIT ?`)
      .all(...(worker ? [seq, worker, limit + 1] : [seq, limit + 1])) as { e: string }[]
    return rows.length > limit ? null : rows.map((r) => JSON.parse(r.e))
  }

  /** One agent's stored events with from <= seq < before, oldest first: the part older than a loaded window. */
  between(worker: string, from: number, before: number, limit: number): FeedEvent[] {
    const rows = this.db
      .query(`SELECT ${ROW_JSON} AS e FROM events WHERE worker = ? AND seq >= ? AND seq < ? ORDER BY seq LIMIT ?`)
      .all(worker, from, before, limit) as { e: string }[]
    return rows.map((r) => JSON.parse(r.e))
  }

  /** Full-text search over messages, errors and tool calls of every agent, best match first. */
  search(q: string, limit: number, workers?: string[]): SearchHit[] {
    const match = ftsQuery(q)
    if (!match) return []
    const only = workers?.length ? `AND e.worker IN (${workers.map(() => "?").join(",")})` : ""
    return this.db
      .query(
        `SELECT e.seq, e.worker AS workerId, e.type, e.ts AS timestamp, snippet(events_fts, 0, '«', '»', '…', 16) AS snippet
         FROM events_fts JOIN events e ON e.seq = events_fts.rowid
         WHERE events_fts MATCH ? ${only} ORDER BY rank LIMIT ?`,
      )
      .all(match, ...(workers ?? []), limit) as SearchHit[]
  }

  /** Names of the skills each of `workers` invoked (`skill.invoked` events), by worker id. */
  skillsInvoked(workers: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>()
    if (!workers.length) return out
    const rows = this.db
      .query(`SELECT DISTINCT worker, json_extract(data, '$.name') AS name FROM events WHERE type = 'skill.invoked' AND worker IN (${workers.map(() => "?").join(",")})`)
      .all(...workers) as { worker: string; name: string | null }[]
    for (const r of rows) if (r.name) out.set(r.worker, [...(out.get(r.worker) ?? []), r.name])
    return out
  }

  /** Data of the newest `limit` events of one type, across agents, oldest first. */
  latest(type: string, limit: number): unknown[] {
    const rows = this.db
      .query("SELECT data FROM (SELECT data, seq FROM events WHERE type = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq")
      .all(type, limit) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data))
  }

  /** Import every agent's old `<root>/<id>/events.json`, so cross-agent queries see stopped agents too. */
  importAll(root: string): void {
    for (const d of readdirSync(root, { withFileTypes: true })) if (d.isDirectory()) this.importLegacy(d.name, path.join(root, d.name))
  }

  private importLegacy(worker: string, home: string): void {
    const legacy = path.join(home, "events.json")
    if (!existsSync(legacy)) return
    try {
      const log: FeedEvent[] = JSON.parse(readFileSync(legacy, "utf8"))
      this.db.transaction(() => log.forEach((e) => this.append({ ...e, workerId: worker })))()
      rmSync(legacy)
    } catch {}
  }

  close(): void {
    this.db.close()
  }
}
