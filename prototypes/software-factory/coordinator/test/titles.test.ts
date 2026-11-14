import { afterEach, expect, test } from "bun:test"
import { cleanTitle, llmTitle } from "../src/titles.ts"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

test("cleanTitle keeps the first line, drops quotes and a final period, and caps 48 characters", () => {
  expect(cleanTitle('"Page history in the Open prompt."\nmore')).toBe("Page history in the Open prompt")
  expect(cleanTitle("  ")).toBeNull()
  expect([...cleanTitle("x".repeat(80))!].length).toBe(48)
})

test("llmTitle sends the first message in the title prompt and returns the cleaned reply", async () => {
  let sent = ""
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = String(init.body)
    return Response.json({ choices: [{ message: { content: "Tab picker on T" } }] })
  }) as typeof fetch
  expect(await llmTitle("Implement this optimization from the report: ## 1. Tab picker (T)", "http://proxy/v1")).toBe(
    "Tab picker on T",
  )
  expect(sent).toContain("Tab picker (T)")
})

test("llmTitle returns null when the proxy fails, so the cut text stays", async () => {
  globalThis.fetch = (async () => new Response("down", { status: 502 })) as unknown as typeof fetch
  expect(await llmTitle("anything", "http://proxy/v1")).toBeNull()
  globalThis.fetch = (async () => {
    throw new Error("refused")
  }) as unknown as typeof fetch
  expect(await llmTitle("anything", "http://proxy/v1")).toBeNull()
})
