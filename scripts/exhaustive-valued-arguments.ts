import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { parseRunArguments, NativeRunError } from "@trellage/runtime/native-run"
import { parseGuideHeadlessArgv } from "../packages/trellage-launcher/src/guide-api.ts"

const states = [
  "omitted",
  "single",
  "repeat-same",
  "repeat-conflict",
  "missing",
  "empty-split",
  "empty-inline",
  "inline",
  "next-flag",
] as const
type State = (typeof states)[number]
const examples: Record<string, readonly [string, string]> = {
  "--model": ["fixture-model", "other-model"],
  "--effort": ["low", "high"],
  "--skill": ["fixture/repository:first-skill", "fixture/repository:second-skill"],
  "--resume": ["first-session", "second-session"],
  "--intent": ["first task", "second task"],
  "--profile": ["codex/pstack", "claude/default"],
  "--ui-variant": ["pager", "split"],
  "--base": ["main", "topic"],
}
const { values } = parseArgs({ options: { command: { type: "string" } } })
const command = values.command
assert(command === "run" || command === "guide", "--command must be run or guide")
assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "use scripts/test-offline.sh")
const sourceHashes: Record<string, string> = {}
const read = async (name: string) => {
  const content = await readFile(new URL(`../${name}`, import.meta.url), "utf8")
  sourceHashes[name] = createHash("sha256").update(content).digest("hex")
  return content
}
await read("scripts/exhaustive-valued-arguments.ts")
await read("packages/trellage-runtime/src/native-run/paths.ts")
const runSource = await read("packages/trellage-runtime/src/native-run/run.ts")
const guideSource = await read("packages/trellage-launcher/src/guide-api.ts")
const runBody = runSource.split("const parseValuedRunArgument =")[1]?.split("const parseFlagRunArgument")[0]
assert(runBody)
const runFlags = [
  ...new Set([...runBody.matchAll(/argument(?: === |\.startsWith\()"(--[a-z-]+)=?"/g)].map((match) => match[1]!)),
]
const names = new Map(
  [...guideSource.matchAll(/const (\w+Flag) = "(--[a-z-]+)"/g)].map((match) => [match[1]!, match[2]!]),
)
const guideBody = guideSource.match(/const valueFlags = new Set\(\[([^\]]+)\]\)/)?.[1]
assert(guideBody)
const guideFlags = guideBody.split(",").map((name) => names.get(name.trim())!)
const flags = (command === "run" ? runFlags : guideFlags).sort()
assert(
  flags.length > 0 && flags.every((flag) => examples[flag]),
  "every valued flag needs representative conflicting values",
)
const contexts = command === "run" ? [[]] : [[], ["--json"], ["--review"], ["--json", "--review"]]
const orders = ["forward", "reverse"]
const total = states.length ** flags.length * contexts.length * orders.length
const outcomes: Record<string, number> = {}
const digest = createHash("sha256")
let executed = 0

const render = (flag: string, state: State): string[] => {
  const [first, second] = examples[flag]!
  const pair = (value: string) => (command === "run" && flag === "--resume" ? [`${flag}=${value}`] : [flag, value])
  switch (state) {
    case "omitted":
      return []
    case "single":
      return pair(first)
    case "repeat-same":
      return [...pair(first), ...pair(first)]
    case "repeat-conflict":
      return [...pair(first), ...pair(second)]
    case "missing":
      return [flag]
    case "empty-split":
      return [flag, ""]
    case "empty-inline":
      return [`${flag}=`]
    case "inline":
      return [`${flag}=${first}`]
    case "next-flag":
      return [flag, "--help"]
  }
}

for (let ordinal = 0; ordinal < states.length ** flags.length; ordinal++) {
  let remainder = ordinal
  const selected = flags.map((flag) => {
    const state = states[remainder % states.length]!
    remainder = Math.floor(remainder / states.length)
    return { flag, state }
  })
  for (const context of contexts)
    for (const order of orders) {
      const groups = order === "forward" ? selected : [...selected].reverse()
      const argv = [...context, ...groups.flatMap(({ flag, state }) => render(flag, state))]
      let expectedError: string | undefined
      const expected: Record<string, unknown> =
        command === "run"
          ? {
              harness: "codex",
              profiles: [],
              forwardedArgs: ["--model", "forwarded"],
              dryRun: false,
              allowUnprovenIsolation: true,
              noAlways: false,
              plan: false,
            }
          : {
              help: false,
              json: context.includes("--json"),
              intent: undefined,
              intentStdin: false,
              profile: undefined,
              model: undefined,
              effort: undefined,
              ...(context.includes("--review") ? { review: true } : {}),
            }
      for (const { flag, state } of groups) {
        if (state === "omitted") continue
        const [first, second] = examples[flag]!
        const empty = state === "empty-split" || state === "empty-inline"
        if (command === "guide") {
          if (
            state === "repeat-same" ||
            state === "repeat-conflict" ||
            state === "missing" ||
            state === "next-flag" ||
            ((state === "inline" || state === "empty-inline") && flag !== "--intent")
          )
            expectedError ??= "GuideArgsError"
          else if (empty) expectedError ??= "GuideValidationError"
          else
            expected[flag === "--ui-variant" ? "uiVariant" : flag === "--base" ? "reviewBase" : flag.slice(2)] = first
        } else {
          if ((state === "missing" || state === "next-flag") && flag !== "--resume") expectedError = "usage"
          if (flag === "--resume") {
            expected.resume =
              state === "missing" || state === "empty-split" || state === "next-flag"
                ? { kind: "pick" }
                : { kind: "pick", id: empty ? "" : state === "repeat-conflict" ? second : first }
            if (state === "empty-split") (expected.profiles as string[]).push("")
            if (state === "next-flag") expectedError = "usage" // --help is not a run-parser flag.
          } else if (flag === "--skill") {
            if (empty) expectedError = "usage"
            expected.skills =
              state === "repeat-same" ? [first, first] : state === "repeat-conflict" ? [first, second] : [first]
          } else {
            expected[flag.slice(2)] = empty ? "" : state === "repeat-conflict" ? second : first
            if (flag === "--model" && empty) expectedError = "usage"
          }
        }
      }
      if (command === "guide" && !expectedError) {
        const json = context.includes("--json"),
          review = context.includes("--review")
        if (
          (expected.profile !== undefined && !json) ||
          (expected.uiVariant !== undefined && json) ||
          (expected.reviewBase !== undefined && !review) ||
          (review && (json || expected.profile !== undefined || expected.uiVariant !== undefined))
        )
          expectedError = "GuideArgsError"
      }
      const id = `${ordinal}:${contexts.indexOf(context)}:${order}`
      let actual: unknown, error: unknown
      try {
        actual =
          command === "run"
            ? parseRunArguments(["codex", ...argv, "--", "--model", "forwarded"])
            : parseGuideHeadlessArgv(argv)
      } catch (caught) {
        error = caught
      }
      if (expectedError) {
        assert(error instanceof Error, `${id}: expected ${expectedError}, accepted ${JSON.stringify(argv)}`)
        assert.equal(
          command === "run" && error instanceof NativeRunError ? error.code : error.name,
          expectedError,
          `${id}: ${JSON.stringify(argv)}`,
        )
      } else {
        assert.equal(error, undefined, `${id}: ${JSON.stringify(argv)}`)
        assert.deepEqual(actual, expected, id)
      }
      const outcome = expectedError ?? "accepted"
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
      digest.update(`${id}\n`)
      executed++
      if (executed % 100_000 === 0) console.error(JSON.stringify({ command, executed, total }))
    }
}
assert.equal(executed, total)
for (const [name, hash] of Object.entries(sourceHashes)) {
  const current = await readFile(new URL(`../${name}`, import.meta.url))
  assert.equal(createHash("sha256").update(current).digest("hex"), hash, `source changed: ${name}`)
}
console.log(
  JSON.stringify(
    {
      schema: 1,
      scope: `${command}-valued-argument-syntax`,
      completeWithinScope: true,
      domains: {
        flags,
        states,
        examples: Object.fromEntries(flags.map((flag) => [flag, examples[flag]])),
        contexts,
        orders,
      },
      expectedCases: total,
      executedCases: executed,
      distinctTupleIds: executed,
      idSequenceSha256: digest.digest("hex"),
      outcomes,
      sourceHashes,
      limitations: [
        "Representative conflicting values only; full ordinary value domains remain separate",
        "Guide contexts cross json/review only; other booleans and positional inputs are not part of this scope",
        "Run uses Codex with no selected profile and a fixed forwarded suffix; no adapter execution",
      ],
    },
    null,
    2,
  ),
)
