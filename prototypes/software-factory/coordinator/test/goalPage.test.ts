import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
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
  const hits: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const p = new URL(req.url).pathname
      hits.push(`${req.method} ${p}`)
      if (p === "/api/goals/g1")
        return Response.json({
          id: "g1",
          repo: root,
          base: "main",
          prompt: "p",
          expect: {},
          approvals: {},
          limits: { runs: 5, minutesPerRun: 720 },
        })
      if (p === "/api/goals/g1/runs") return Response.json([])
      if (p === "/api/folders") return Response.json({ id: "f" })
      if (p === "/api/threads/create") return Response.json({ id: "11111111-2222-3333-4444-555555555555" })
      if (p === "/api/agui") return new Response("", { headers: { "content-type": "text/event-stream" } })
      return new Response("gone", { status: 500 })
    },
  })
  const logs = path.join(root, "logs")
  try {
    expect(await startGoalRun(`http://127.0.0.1:${server.port}`, logs)("g1")).toBe(
      "11111111-2222-3333-4444-555555555555",
    )
    expect(hits).toContain("POST /api/threads/create")
  } finally {
    server.stop(true)
  }
  const [log] = require("node:fs").readdirSync(logs) as string[]
  expect(log).toStartWith("goal-g1-")
  expect(existsSync(path.join(logs, log!)) && readFileSync(path.join(logs, log!), "utf8")).toContain("thread 11111111")
})
