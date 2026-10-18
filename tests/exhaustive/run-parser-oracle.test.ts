import { expect, test } from "bun:test"
import { parseRunArguments } from "../../packages/trellage-runtime/src/native-run/run.ts"
import { NativeRunError } from "../../packages/trellage-runtime/src/native-run/paths.ts"
import { exhaustiveDomains } from "./domains.ts"
import { cartesianCases } from "./matrix.ts"
import { runParserExpectation } from "./run-parser-oracle.ts"

test("run parser preserves all boolean states for every registered harness", async () => {
  const { matrices, inventory } = await exhaustiveDomains(new URL("../../", import.meta.url).pathname)
  const booleans = matrices.run
    .filter((domain) => domain.values.some((value) => value.id === "present"))
    .map((domain) => ({ ...domain, values: domain.values.filter((value) => value.id !== "repeat") }))
  let cases = 0
  for (const harness of inventory.harnesses) {
    for (const entry of cartesianCases("run-modes", booleans)) {
      const choices = { ...entry.values, harness }
      const oracle = runParserExpectation(matrices.run, choices)
      if (!("expected" in oracle)) throw new Error(`Unexpected oracle rejection: ${oracle.rejection}`)
      expect(parseRunArguments([harness, ...entry.argv])).toEqual(oracle.expected)
      cases++
    }
  }
  expect(cases).toBe(inventory.harnesses.length * 128)
})

test("run parser matches declared value classes without swallowing unexpected errors", async () => {
  const { matrices } = await exhaustiveDomains(new URL("../../", import.meta.url).pathname)
  for (const domain of matrices.run) {
    for (const value of domain.values) {
      const choices = { harness: "codex", [domain.name]: value.id }
      const argv = domain.name === "harness" ? [...value.argv] : ["codex", ...value.argv]
      const oracle = runParserExpectation(matrices.run, choices)
      try {
        const actual = parseRunArguments(argv)
        if (!("expected" in oracle)) throw new Error(`${domain.name}/${value.id}: accepted despite ${oracle.rejection}`)
        expect(actual).toEqual(oracle.expected)
      } catch (error) {
        if (!(error instanceof NativeRunError) || !("rejection" in oracle)) throw error
        expect(error.code).toBe("usage")
      }
    }
  }
})

test("later conflicting flags override earlier modes, including an explicit resume ID", async () => {
  const { matrices } = await exhaustiveDomains(new URL("../../", import.meta.url).pathname)
  const choices: Record<string, string> = {
    harness: "codex",
    "--require-proven-isolation": "repeat",
    "--continue": "repeat",
    "--resume": "repeat",
    "resume-id": "representative",
    "isolation-order": "require-allow",
    "resume-order": "id-pick-continue",
  }
  const argv = matrices.run.flatMap((domain) => {
    const value = domain.values.find((candidate) => candidate.id === (choices[domain.name] ?? "omitted"))
    if (!value) throw Error(`Missing fixture ${domain.name}/${choices[domain.name]}`)
    return value.argv
  })
  const oracle = runParserExpectation(matrices.run, choices)
  if (!("expected" in oracle)) throw Error(oracle.rejection)
  const actual = parseRunArguments(argv)
  expect(actual).toEqual(oracle.expected)
  expect(actual.allowUnprovenIsolation).toBe(true)
  expect(actual.resume).toEqual({ kind: "continue" })
})

test("all conflict orders compose with omitted, present, and repeated earlier flags", async () => {
  const { matrices } = await exhaustiveDomains(new URL("../../", import.meta.url).pathname)
  const names = new Set([
    "--allow-unproven-isolation",
    "--require-proven-isolation",
    "--continue",
    "--resume",
    "resume-id",
    "isolation-order",
    "resume-order",
  ])
  const domains = matrices.run.filter((domain) => names.has(domain.name))
  let cases = 0
  for (const entry of cartesianCases("run-conflicts", domains)) {
    const oracle = runParserExpectation(matrices.run, { ...entry.values, harness: "codex" })
    if (!("expected" in oracle)) throw Error(oracle.rejection)
    expect(parseRunArguments(["codex", ...entry.argv])).toEqual(oracle.expected)
    cases++
  }
  expect(cases).toBe(5103)
})

test("inline and repeated options preserve scalar precedence and accumulate skill selections", async () => {
  const { matrices } = await exhaustiveDomains(new URL("../../", import.meta.url).pathname)
  const choices: Record<string, string> = {
    harness: "codex",
    "--model": "representative:inline",
    "--effort": "low:repeat",
    "--skill": "hyphenated-owner:repeat",
  }
  const argv = matrices.run.flatMap(
    (domain) => domain.values.find((value) => value.id === (choices[domain.name] ?? "omitted"))?.argv ?? [],
  )
  const oracle = runParserExpectation(matrices.run, choices)
  if (!("expected" in oracle)) throw Error(oracle.rejection)
  const actual = parseRunArguments(argv)
  expect(actual).toEqual(oracle.expected)
  expect(actual.model).toBe("gpt-5.6-sol")
  expect(actual.effort).toBe("low")
  expect(actual.skills).toEqual(["example/skills:initial", "example-team/skills:review"])
})
