import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it } from "vitest"
import { readPreferredStyle, readRewriteCache, rewriteCacheKey, writePreferredStyle, writeRewriteCache, type RewriteCacheKey } from "../src/rewrite-state.js"
const dirs: string[] = []
const directory = async () => { const dir = await mkdtemp(path.join(os.tmpdir(), "rewrite-state-")); dirs.push(dir); return dir }
const key = (value: string): RewriteCacheKey => ({ sourcePrompt: value, systemPrompt: "style", model: "model", effort: "high", version: "1" })
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
it("keeps the latest 100 results including maximum-size documents and private permissions", async () => {
  const dir = await directory()
  const markdown = "🦊".repeat(60_000)
  const entries = Array.from({ length: 100 }, (_, i) => ({ key: rewriteCacheKey(key(String(99 - i))), markdown }))
  await writeFile(path.join(dir, "rewrite-cache.json"), JSON.stringify({ schemaVersion: 1, entries }), { mode: 0o600 })
  await writeRewriteCache(key("100"), markdown, dir)
  expect(await readRewriteCache(key("0"), dir)).toBeUndefined()
  expect(await readRewriteCache(key("1"), dir)).toBe(markdown)
  expect(await readRewriteCache(key("100"), dir)).toBe(markdown)
  expect((await stat(dir)).mode & 0o777).toBe(0o700)
  expect((await stat(path.join(dir, "rewrite-cache.json"))).mode & 0o777).toBe(0o600)
}, 30_000)
it("serializes concurrent results without losing entries", async () => {
  const dir = await directory()
  await Promise.all(Array.from({ length: 8 }, (_, i) => writeRewriteCache(key(String(i)), String(i), dir)))
  for (let i = 0; i < 8; i++) expect(await readRewriteCache(key(String(i)), dir)).toBe(String(i))
})
it("rejects symlink state, unsafe files, corrupt data and oversized preferences", async () => {
  const dir = await directory()
  const outside = await directory()
  const link = path.join(dir, "linked")
  await symlink(outside, link)
  await expect(writePreferredStyle(link, "style")).rejects.toThrow()
  const target = path.join(outside, "target")
  await writeFile(target, '{"schemaVersion":1,"styleId":"secret"}', { mode: 0o600 })
  await symlink(target, path.join(dir, "rewrite-preferences.json"))
  await expect(readPreferredStyle(dir)).rejects.toThrow()
  expect(await readFile(target, "utf8")).toContain("secret")
  await rm(path.join(dir, "rewrite-preferences.json"))
  await writeFile(path.join(dir, "rewrite-preferences.json"), "x".repeat(4097), { mode: 0o600 })
  await expect(readPreferredStyle(dir)).rejects.toThrow()
  await writeFile(path.join(dir, "rewrite-cache.json"), "{broken", { mode: 0o600 })
  await expect(readRewriteCache(key("x"), dir)).rejects.toThrow()
})
it("preserves saved data on cancellation and validates preferences", async () => {
  const dir = await directory()
  await writeRewriteCache(key("x"), "old", dir)
  const controller = new AbortController(); controller.abort()
  await expect(writeRewriteCache(key("x"), "new", dir, controller.signal)).rejects.toThrow()
  expect(await readRewriteCache(key("x"), dir)).toBe("old")
  await writePreferredStyle(dir, "ste-english")
  expect(await readPreferredStyle(dir)).toBe("ste-english")
  await expect(writePreferredStyle(dir, "bad\nstyle")).rejects.toThrow()
})
