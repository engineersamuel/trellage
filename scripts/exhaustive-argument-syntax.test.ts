import { expect, test } from "bun:test"
import { parseRunArguments } from "@trellage/runtime/native-run"
import { parseGuideHeadlessArgv } from "../packages/trellage-launcher/src/guide-api.ts"
import { renderArgumentForm, type ArgumentForm } from "./exhaustive-argument-syntax.ts"
import type { DomainValue } from "./exhaustive-cli-domains.ts"

const selection = (form: ArgumentForm, entries: [string, string[]][]): Map<string, DomainValue> =>
  new Map([...entries.map(([name, argv]): [string, DomainValue] => [name, { id: name, argv }]),
    ["syntax", { id: form, argv: [], form }]])

test("reversing option groups changes resume and isolation precedence without moving forwarded arguments", () => {
  const entries: [string, string[]][] = [
    ["harness", ["codex"]], ["profiles", ["base"]],
    ["--continue", ["--continue"]], ["--resume", ["--resume"]],
    ["--require-proven-isolation", ["--require-proven-isolation"]],
    ["--allow-unproven-isolation", ["--allow-unproven-isolation"]],
    ["inline-resume", ["--resume=session"]], ["forwarded", ["--", "--model", "untouched"]],
  ]
  const canonical = parseRunArguments(renderArgumentForm("run", selection("canonical", entries)))
  const reversed = parseRunArguments(renderArgumentForm("run", selection("reverse-options", entries)))
  expect(canonical.resume).toEqual({ kind: "pick", id: "session" })
  expect(canonical.allowUnprovenIsolation).toBe(true)
  expect(reversed.resume).toEqual({ kind: "continue" })
  expect(reversed.allowUnprovenIsolation).toBe(false)
  expect(reversed.forwardedArgs).toEqual(canonical.forwardedArgs)
  expect(reversed.profiles).toEqual(["base"])
})

test("inline and repeated skill groups preserve values and sequence", () => {
  const entries: [string, string[]][] = [["harness", ["codex"]],
    ["--skill", ["--skill", "a/b:c", "--skill", "a/b:d"]], ["--model", ["--model", "space value"]]]
  expect(parseRunArguments(renderArgumentForm("run", selection("inline-values", entries))).skills)
    .toEqual(["a/b:c", "a/b:d"])
  const repeated = parseRunArguments(renderArgumentForm("run", selection("repeat-values", entries)))
  expect(repeated.skills).toEqual(["a/b:c", "a/b:d", "a/b:c", "a/b:d"])
  expect(repeated.model).toBe("space value")
})

test("missing Guide value remains missing when a positional intent exists", () => {
  const argv = renderArgumentForm("guide", selection("missing-value", [["positionals", ["review-code"]]]))
  expect(argv).toEqual(["review-code", "--model"])
  expect(() => parseGuideHeadlessArgv(argv)).toThrow("--model")
})

test("Guide accepts inline intent and rejects repeated flags and inline model", () => {
  expect(parseGuideHeadlessArgv(renderArgumentForm("guide", selection("inline-values", [
    ["--intent", ["--intent", "Review this change"]],
  ]))).intent).toBe("Review this change")
  for (const [form, entries] of [
    ["inline-values", [["--model", ["--model", "gpt-6-astra"]]]],
    ["repeat-values", [["--intent", ["--intent", "review"]]]],
    ["repeat-booleans", [["--help", ["--help"]]]],
  ] as [ArgumentForm, [string, string[]][]][])
    expect(() => parseGuideHeadlessArgv(renderArgumentForm("guide", selection(form, entries)))).toThrow()
})
