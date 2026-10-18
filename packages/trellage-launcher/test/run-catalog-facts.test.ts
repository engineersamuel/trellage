import { expect, test } from "vitest"
import path from "node:path"
import { loadRunExecutionFacts } from "../src/run-catalog-facts.ts"
const shippedRoot = path.resolve(import.meta.dirname, "../../..")
test("retains the router's verified non-lifecycle headless contracts", async () => {
  const facts = await loadRunExecutionFacts({ shippedRoot, environment: { HOME: "/nonexistent-catalog-home" } })
  expect(facts.headless.get("native:fx/default")?.prompt).toBe(true)
  expect(facts.headless.get("native:fx/default")?.outputFormats).toEqual(["text", "json"])
  expect(facts.headless.get("native:headlong/default")?.prompt).toBe(false)
  expect(facts.headless.get("native:pi/firstmate")?.prompt).toBe(false)
  expect(facts.headless.get("native:claude/firstmate")?.modelOverride).toBe(false)
})
test("canonicalizes backend profile aliases without losing capability evidence", async () => {
  const facts = await loadRunExecutionFacts({ shippedRoot, environment: { HOME: "/nonexistent-catalog-home" } })
  expect(facts.headless.has("native:agency/azure")).toBe(true)
  expect(facts.headless.has("native:agency/trellage-azure")).toBe(false)
})
