import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigStore, setConfigStore } from "../src/config.ts"
import { makeGoalPage, startGoalRun } from "../src/goalPage.ts"
import { makeGoals } from "../src/goals.ts"

let root = ""
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sf-gp-"))
  process.env.SF_CONFIG = path.join(root, "config.toml")
  setConfigStore(new ConfigStore(process.env.SF_CONFIG))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const page = (started: string[] = []) => {
  const goals = makeGoals(path.join(root, "goals"), ["implement", "verify", "security", "finish"])
  const gp = makeGoalPage({
    proxyUrl: () => "http://127.0.0.1:1/v1",
    folders: () => [{ id: "f", name: "repo", path: root }],
    knownSteps: () => ["implement", "verify", "security", "finish"],
    goals,
    startResearch: async () => {
      throw new Error("not in this test")
    },
    workerState: () => undefined,
    removeDraft: async () => {},
    startRun: async (id) => (started.push(id), "thread-1"),
  })
  const call = (name: string, body?: unknown) =>
    gp.handle(
      new Request(
        `http://x/api/goal-page/${name}`,
        body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
      ),
      name,
    )
  return { call, goals }
}

const doc = {
  title: "Retry",
  id: "cpr-retry",
  task: "Retry upstream calls.",
  inputs: [],
  constraints: [],
  criteria: ["A 502 is retried once"],
  checks: ["cargo test"],
}
const expectations = {
  steps: { implement: { min: 1 } },
  skills: [],
  sdlc: { criteriaProven: true, gatesRun: [], gatesSkipped: [] },
}

test("info reports the configured model and live launch", async () => {
  const r = await (await page().call("info")).json()
  expect(r).toMatchObject({ model: "gpt-6.1-sol", effort: "medium", liveLaunch: true })
})

test("unknown route is 404; a bad body is 400 with the reason", async () => {
  const { call } = page()
  expect((await call("nope", {})).status).toBe(404)
  const bad = await call("launch", { repo: root })
  expect(bad.status).toBe(400)
  expect((await bad.json()).error).toStartWith("bad launch request")
})

test("launch saves the spec with locked criteria and the override, then starts a scored run", async () => {
  const started: string[] = []
  const { call, goals } = page(started)
  const r = await call("launch", { repo: root, base: "main", doc, expect: expectations, override: "tests come later" })
  const body = await r.json()
  expect(r.status).toBe(200)
  expect(body).toMatchObject({ live: true, threadId: "thread-1", command: "sf goal run cpr-retry" })
  expect(started).toEqual(["cpr-retry"])
  const spec = goals.get("cpr-retry")!
  expect(spec.prompt).toContain("AC-1: A 502 is retried once")
  expect(spec.prompt).toContain("use them as AC-1..AC-1 word for word")
  expect(spec.readinessOverride).toBe("tests come later")
})

test("launch refuses an unknown step", async () => {
  const { call } = page()
  const step = await call("launch", {
    repo: root,
    base: "main",
    doc,
    expect: { ...expectations, steps: { nope: { min: 1 } } },
  })
  expect(step.status).toBe(400)
  expect((await step.json()).error).toContain("unknown step nope")
})

test("startGoalRun resolves with the thread the CLI prints, and logs its output", async () => {
  // A stand-in for cli.ts: prints what `sf goal run` prints first (no server, no port).
  const cli = path.join(root, "cli.ts")
  writeFileSync(
    cli,
    'console.error(`goal ${process.argv[4]}: run 1 to ${process.env.SF_URL}`)\nconsole.error("thread 11111111-2222-3333-4444-555555555555")\n',
  )
  const logs = path.join(root, "logs")
  expect(await startGoalRun("http://coord", logs, cli)("g1")).toBe("11111111-2222-3333-4444-555555555555")
  const [log] = readdirSync(logs)
  expect(log).toStartWith("goal-g1-")
  expect(readFileSync(path.join(logs, log!), "utf8")).toContain("goal g1: run 1 to http://coord")
})

test("startGoalRun rejects when the CLI exits without a thread", async () => {
  const cli = path.join(root, "cli.ts")
  writeFileSync(cli, 'console.error("400 not found"); process.exit(1)\n')
  await expect(startGoalRun("http://coord", path.join(root, "logs"), cli)("g1")).rejects.toThrow(
    "exited 1 before it started a thread",
  )
})

test("each Goal page model call records its usage for cost reports", async () => {
  const usage: Record<string, unknown>[] = []
  const rewrites = [1, 2, 3].map((i) => ({ title: `t${i}`, prompt: "p", notes: "n" }))
  // The quality gate runs offline with no sockets: stub fetch instead of serving a fake proxy.
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    Response.json({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "c", type: "function", function: { name: "rewrites", arguments: JSON.stringify({ rewrites }) } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
    })) as unknown as typeof fetch
  try {
    const gp = makeGoalPage({
      proxyUrl: () => "http://127.0.0.1:1/v1",
      folders: () => [],
      knownSteps: () => [],
      goals: makeGoals(path.join(root, "goals"), []),
      startResearch: async () => {
        throw new Error("not in this test")
      },
      workerState: () => undefined,
      removeDraft: async () => {},
      startRun: async () => "t",
      recordUsage: (d) => usage.push(d),
    })
    // The model call is recorded before enhance asks Jev; Jev's result (none without TYPESAFE_API_KEY, as in CI) does not matter here.
    await gp.handle(
      new Request("http://x/api/goal-page/enhance", { method: "POST", body: JSON.stringify({ doc }) }),
      "enhance",
    )
    expect(usage).toEqual([
      {
        model: "gpt-6.1-sol",
        inputTokens: 1000,
        outputTokens: 50,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        aiCreditsStatus: "unavailable",
      },
    ])
  } finally {
    globalThis.fetch = realFetch
  }
})
