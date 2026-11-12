import { startFinalSecurity } from "../src/gates.ts"
import { artifact, ensureFactoryDir, newSdlc } from "../src/sdlc.ts"
import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, type SpawnSpec } from "../src/factory.ts"
import { Approvals } from "../src/approvals.ts"
import { freshTurn } from "../src/report.ts"
import { defaultSettings } from "../src/settings.ts"
import { coordinatorTools, fanout, globalTools, synthesisBlocked, type Scope } from "../src/tools.ts"
import type { FanoutSelection } from "../src/workflows.ts"

const fakeFactory = () => {
  const f = Object.create(Factory.prototype)
  Object.assign(f, {
    workers: new Map(),
    securityReviews: new Map(),
    codeReviews: new Map(),
    evaluations: new Map(),
    sdlc: new Map(),
    researchBatches: new Map(),
    turns: new Map(),
    lastReports: new Map(),
    run: null,
    stored: defaultSettings(),
    published: [] as unknown[],
    spawned: [] as unknown[],
  })
  f.publish = (_w: string, type: string, _a: null, _t: string, data: unknown) => f.published.push({ type, data })
  f.spawn = async (spec: SpawnSpec) => (f.spawned.push(spec), { id: "w-1", summary: () => ({ id: "w-1" }) })
  return f
}
const tool = (tools: { name: string; handler?: unknown }[], name: string) =>
  tools.find((t) => t.name === name)!.handler as (args: Record<string, unknown>) => string

test("research fans out all Jev selections in the conversation worktree and retains partial failures", async () => {
  const f = fakeFactory()
  const request = "Compare two agent UI frameworks"
  const route = async (input: string): Promise<FanoutSelection> => {
    expect(input).toBe(request)
    return {
      selected: ["council", "six-hats", "hyperresearch"],
      probabilities: { council: 0.9, "six-hats": 0.8, hyperresearch: 0.95 },
    }
  }
  f.spawn = async (spec: SpawnSpec) => {
    f.spawned.push(spec)
    if (spec.step === "six-hats") throw new Error("Native profile unavailable")
    return { id: spec.step, summary: () => ({ id: spec.step }) }
  }
  const result = await fanout(f, { id: "sub-r", threadId: "r", workdir: "/research-wt" }, request, route)
  expect(f.spawned.map((s: SpawnSpec) => [s.step, s.workdir, s.owner])).toEqual([
    ["council", "/research-wt", "sub-r"],
    ["six-hats", "/research-wt", "sub-r"],
    ["hyperresearch", "/research-wt", "sub-r"],
  ])
  expect(result.workers.map((w) => w.id)).toEqual(["council", "hyperresearch"])
  expect(result.errors).toEqual([{ workflow: "six-hats", error: "Native profile unavailable" }])
  expect(f.published[0].type).toBe("factory.workflows_selected")
})

test("synthesis waits for all collected workers and nonempty saved reports", async () => {
  const f = fakeFactory()
  const workdir = mkdtempSync(path.join(tmpdir(), "sf-synthesis-"))
  const scope = { id: "sub-r", threadId: "r", workdir }
  expect(synthesisBlocked(f, scope)).toContain("Run fanout")
  f.researchBatches.set(scope.id, { workers: [{ id: "w-r", workflow: "council" }], errors: [] })
  f.workers.set("w-r", { status: "running", collected: false })
  const spawn = tool(coordinatorTools(f, scope), "spawn_worker")
  expect(JSON.parse(await spawn({ name: "s", task: "x", step: "synthesis" })).error).toContain("Collect")
  f.workers.set("w-r", { status: "idle", collected: true })
  expect(synthesisBlocked(f, scope)).toContain("Cannot read")
  mkdirSync(path.join(workdir, "reports"))
  writeFileSync(path.join(workdir, "reports/council.md"), "")
  expect(synthesisBlocked(f, scope)).toContain("empty")
  writeFileSync(path.join(workdir, "reports/council.md"), "# Findings\nEvidence")
  expect(synthesisBlocked(f, scope)).toBeNull()
  f.researchBatches.get(scope.id).errors.push("launch failed")
  expect(synthesisBlocked(f, scope)).toContain("launch failed")
  expect(f.spawned).toEqual([])
})

test("research requires a conversation worktree, respects review gates, and never hides Jev failures", async () => {
  const f = fakeFactory()
  const fail = async (): Promise<never> => {
    throw new Error("Jev timeout")
  }
  await expect(fanout(f, { id: "coordinator", threadId: null }, "x", fail)).rejects.toThrow("own worktree")
  f.securityReviews.set("sr", { id: "sr", status: "started", workdir: "/wt" })
  await expect(fanout(f, { id: "sub-r", threadId: "r", workdir: "/wt" }, "x", fail)).rejects.toThrow("security review")
  f.securityReviews.clear()
  await expect(fanout(f, { id: "sub-r", threadId: "r", workdir: "/wt" }, "x", fail)).rejects.toThrow("Jev timeout")
  expect(f.spawned).toEqual([])
})

test("a research no-match starts no workers and does not request synthesis", async () => {
  const f = fakeFactory()
  const result = await fanout(f, { id: "sub-r", threadId: "r", workdir: "/wt" }, "simple fact", async () => ({
    selected: [],
    probabilities: { council: 0.03, "six-hats": 0.05, hyperresearch: 0.08 },
  }))
  expect(f.spawned).toEqual([])
  expect(result.next).toContain("Do not run synthesis")
  expect(synthesisBlocked(f, { id: "sub-r", threadId: "r", workdir: "/wt" })).toContain("No research workflows")
})

test("spawn_worker refuses every step while a security review is unfinished in the same worktree", async () => {
  const f = fakeFactory()
  const spawn = tool(coordinatorTools(f, { id: "sub-1", threadId: "t", workdir: "/wt" }), "spawn_worker")
  f.securityReviews.set("sr", { id: "sr", status: "started", workdir: "/wt/" })
  for (const step of ["implement", "verify", undefined])
    expect(JSON.parse(await spawn({ name: "i", task: "x", step })).error).toContain("sr")
  f.securityReviews.get("sr").status = "fixing"
  f.securityReviews.get("sr").workerId = "w-fix"
  expect(JSON.parse(await spawn({ name: "i", task: "x" })).error).toContain("w-fix")
  expect(f.spawned).toEqual([])
  f.securityReviews.get("sr").status = "done"
  await spawn({ name: "i", task: "x", step: "implement" })
  expect(f.spawned.map((s: SpawnSpec) => s.step)).toEqual(["implement"])
})

test("the global coordinator's spawn gate uses the run worktree, and none without a run", async () => {
  const f = fakeFactory()
  f.securityReviews.set("sr", { id: "sr", status: "verifying", workdir: "/run", workerId: "w-v" })
  const spawn = tool(coordinatorTools(f), "spawn_worker")
  await spawn({ name: "i", task: "x", step: "implement" })
  f.run = { worktree: "/run" }
  expect(JSON.parse(await spawn({ name: "r", task: "x", step: "review" })).error).toContain("verifying")
  expect(f.spawned).toHaveLength(1)
})

const gitRepo = () => {
  const repo = mkdtempSync(path.join(tmpdir(), "sf-rep-"))
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim()
  git("init", "-q", "-b", "feat")
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x")
  return { repo, head: git("rev-parse", "HEAD") }
}

test("report_up is for sub-coordinators; it takes branch and commit from git, reports once per commit and status", async () => {
  const { repo, head } = gitRepo()
  const f = fakeFactory()
  const sent: unknown[] = []
  expect(coordinatorTools(f).some((t) => t.name === "report_up")).toBe(false)
  const report = tool(
    coordinatorTools(f, { id: "sub-1", threadId: "t", workdir: repo, report: (r) => void sent.push(r) }),
    "report_up",
  )
  expect(JSON.parse(await report({ status: "maybe", summary: "x" })).error).toContain("status")
  expect(JSON.parse(await report({ status: "done", summary: "ok", branch: "main", commit: "f00" })).sent).toBe(true)
  expect(JSON.parse(await report({ status: "done", summary: "again" })).sent).toBe(false)
  expect(sent).toMatchObject([{ status: "done", branch: "feat", commit: head }])
  expect(f.turn("sub-1").reported).toBe(true)
  expect(f.published).toMatchObject([{ type: "factory.report_up", data: { threadId: "t", report: { summary: "ok" } } }])
  const bare = tool(coordinatorTools(f, { id: "sub-2", threadId: "u", workdir: repo }), "report_up")
  expect(JSON.parse(await bare({ status: "blocked", summary: "no callback" })).sent).toBe(true)
})

test("report_up sends the same report again in a later turn", async () => {
  const { repo } = gitRepo()
  const f = fakeFactory()
  const sent: unknown[] = []
  const report = tool(
    coordinatorTools(f, { id: "sub-1", threadId: "t", workdir: repo, report: (r) => void sent.push(r) }),
    "report_up",
  )
  await report({ status: "done", summary: "ok" })
  f.turns.set("sub-1", freshTurn(f.turn("sub-1").start + 1))
  expect(JSON.parse(await report({ status: "done", summary: "ok" })).sent).toBe(true)
  expect(sent).toHaveLength(2)
})

test("report_up marks branch and commit unknown outside git", async () => {
  const sent: unknown[] = []
  const dir = mkdtempSync(path.join(tmpdir(), "sf-nogit-"))
  const report = tool(
    coordinatorTools(fakeFactory(), { id: "sub-1", threadId: "t", workdir: dir, report: (r) => void sent.push(r) }),
    "report_up",
  )
  await report({ status: "blocked", summary: "x", branch: "main", commit: "f00" })
  expect(sent).toMatchObject([{ branch: "unknown", commit: "unknown" }])
})

test("a failed report_up leaves no trace, so a retry is sent", async () => {
  const { repo } = gitRepo()
  const f = fakeFactory()
  let fail = true
  const report = tool(
    coordinatorTools(f, {
      id: "sub-1",
      threadId: "t",
      workdir: repo,
      report: async () => {
        if (fail) throw new Error("delivery down")
      },
    }),
    "report_up",
  )
  expect(JSON.parse(await report({ status: "done", summary: "ok" }))).toEqual({ error: "delivery down" })
  expect(f.turn("sub-1").reported).toBe(false)
  expect(f.lastReports.size).toBe(0)
  expect(f.published).toEqual([])
  fail = false
  expect(JSON.parse(await report({ status: "done", summary: "ok" })).sent).toBe(true)
  expect(f.turn("sub-1").reported).toBe(true)
})

test("only the global coordinator's request_approval stores the report conversation to relay to", async () => {
  const opened: Record<string, unknown>[] = []
  const f = fakeFactory()
  f.approvals = { open: (a: Record<string, unknown>) => (opened.push(a), { id: "a1", ...a }) }
  const global = coordinatorTools(f, { id: "coordinator", threadId: null, knownThread: (id) => id === "t-7" })
  await tool(global, "request_approval")({ title: "Next?", summary: "s", options: ["Merge"], reportThreadId: "t-7" })
  await tool(global, "ask_user")({ title: "Q", summary: "s", options: [], reportThreadId: "t-7" })
  await tool(
    coordinatorTools(f, { id: "sub-1", threadId: "t", workdir: "/wt" }),
    "request_approval",
  )({ title: "Plan", summary: "s", options: ["Ok"], reportThreadId: "t-7" })
  expect(opened.map((a) => a.reportThreadId)).toEqual(["t-7", undefined, undefined])
})

test("request_approval rejects an unknown or cleaned-up report conversation", async () => {
  const opened: Record<string, unknown>[] = []
  const f = fakeFactory()
  f.approvals = { open: (a: Record<string, unknown>) => (opened.push(a), { id: "a1", ...a }) }
  const ask = (scope: Scope) =>
    tool(
      coordinatorTools(f, scope),
      "request_approval",
    )({ title: "Next?", summary: "s", options: ["Merge"], reportThreadId: "t-x" })
  expect(JSON.parse(await ask({ id: "coordinator", threadId: null, knownThread: () => false })).error).toContain("t-x")
  expect(JSON.parse(await ask({ id: "coordinator", threadId: null })).error).toContain("t-x")
  expect(opened).toEqual([])
})

test("optimize fans out one read-only worker per Jev-selected skill and gates synthesis on their reports", async () => {
  const f = fakeFactory()
  const workdir = mkdtempSync(path.join(tmpdir(), "sf-optimize-"))
  const scope = { id: "sub-o", threadId: "o", workdir }
  const result = await fanout(f, scope, "top 3 optimizations", async () => ({
    selected: ["first-principles", "improve-codebase-architecture"],
    probabilities: {
      "first-principles": 0.9,
      "behavior-preservation": 0.4,
      "improve-codebase-architecture": 0.8,
      "ui-css": 0.1,
    },
  }))
  expect(f.spawned.map((s: SpawnSpec) => [s.step, s.workdir, s.owner])).toEqual([
    ["optimize-first-principles", workdir, "sub-o"],
    ["optimize-improve-codebase-architecture", workdir, "sub-o"],
  ])
  expect(f.spawned[0].task).toContain("Do not edit, stage, commit, or push")
  expect(result.reports).toEqual([
    "reports/optimize-first-principles.md",
    "reports/optimize-improve-codebase-architecture.md",
  ])
  expect(f.published.map((e: { type: string }) => e.type)).toEqual(["factory.workflows_selected"])
  f.workers.set("w-1", { status: "idle", collected: true })
  expect(synthesisBlocked(f, scope)).toContain("optimize-first-principles")
  mkdirSync(path.join(workdir, "reports"))
  writeFileSync(path.join(workdir, "reports", "optimize-first-principles.md"), "x")
  writeFileSync(path.join(workdir, "reports", "optimize-improve-codebase-architecture.md"), "x")
  expect(synthesisBlocked(f, scope)).toBeNull()
})

test("fanout is offered to coordinators and rejects an empty request", async () => {
  const f = fakeFactory()
  const tools = coordinatorTools(f, { id: "sub-o", threadId: "o", workdir: "/wt" })
  expect(JSON.parse(await tool(tools, "fanout")({ request: " " })).error).toContain("nonempty")
  await expect(fanout(f, { id: "coordinator", threadId: null }, "x")).rejects.toThrow("own worktree")
})

test("optimize_repo always starts a new conversation that fans out and fans in", async () => {
  const started: [string, string][] = []
  const tools = globalTools({
    list: () => [],
    folders: () => [],
    start: async (folder, task) => (started.push([folder, task]), { id: "t" }),
    message: async () => {},
    read: async () => ({}),
    status: () => ({}),
  })
  await tool(tools, "optimize_repo")({ folder: "copilot-proxy-rs", request: "top 3 optimizations" })
  expect(started[0]![0]).toBe("copilot-proxy-rs")
  expect(started[0]![1]).toStartWith("Optimize: top 3 optimizations\n")
  expect(started[0]![1]).toContain('"top 3 optimizations"')
  expect(started[0]![1]).toContain("Call fanout")
  expect(started[0]![1]).toContain("step=synthesis")
})

test("spawn_worker passes a named harness and its trx profiles; copilot is the default", async () => {
  const f = fakeFactory()
  const spawn = tool(coordinatorTools(f, { id: "sub", threadId: "t", workdir: "/wt" }), "spawn_worker")
  await spawn({ name: "a", task: "x" })
  await spawn({ name: "b", task: "x", harness: "pi", profiles: ["research"] })
  await spawn({ name: "c", task: "x", harness: "copilot" })
  expect(f.spawned.map((s: SpawnSpec) => s.harness)).toEqual([
    undefined,
    { kind: "pi", profiles: ["research"] },
    undefined,
  ])
})

test("step=finish needs an accepted ship approval for this conversation's factory branch; it gets the finish gate", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "sf-ship-"))
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" })
  git("init", "-q", "-b", "factory/x")
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x")
  const root = mkdtempSync(path.join(tmpdir(), "sf-ship-state-"))
  const f = fakeFactory()
  f.approvals = new Approvals(root)
  const tools = coordinatorTools(f, { id: "sub-1", threadId: "t", workdir: repo })
  // No SDLC plan yet: the ship request itself is refused.
  const refused = JSON.parse(
    await tool(tools, "request_approval")({ title: "Ship?", summary: "s", options: ["Ship", "Hold"], ship: true }),
  )
  expect(refused.error).toContain("no SDLC plan")
  // A conversation whose floors are met: criteria proven, verify after implement, security done; no optional gate on.
  ensureFactoryDir(repo)
  writeFileSync(artifact(repo, "evidence.md"), "AC-1: PASS — t — ok\n")
  f.sdlc.set("sub-1", { ...newSdlc("sub-1", "t"), criteria: ["works"], implementDoneAt: 1, verifyDoneAt: 2 })
  f.securityReviews.set("sr-1", {
    id: "sr-1",
    scopeId: "sub-1",
    threadId: "t",
    implementWorkerId: "w",
    status: "done",
    model: "",
    findings: [],
    at: 3,
  })
  // The independent evaluation of this implement finished (it never blocks shipping by its verdicts).
  f.evaluations.set("ev-1", {
    id: "ev-1",
    scopeId: "sub-1",
    threadId: "t",
    workdir: repo,
    status: "done",
    round: 1,
    model: "m",
    verdicts: [],
    workerIds: [],
    notes: [],
    at: 3,
  })
  const finish = () => tool(tools, "spawn_worker")({ name: "finish", task: "ship", step: "finish", harness: "claude" })
  expect(JSON.parse(await finish()).error).toContain("No accepted ship approval")
  const ask = async () =>
    JSON.parse(
      await tool(tools, "request_approval")({ title: "Ship?", summary: "s", options: ["Ship", "Hold"], ship: true }),
    ).id
  const held = await ask()
  expect(JSON.parse(await finish()).error).toContain("No accepted ship approval")
  f.approvals.answer(held, "Hold", null)
  expect(JSON.parse(await finish()).error).toContain("No accepted ship approval")
  const first = await ask()
  f.approvals.answer(first, "Ship", null)
  expect(JSON.parse(await finish()).error).toBeUndefined()
  expect(f.spawned).toHaveLength(1)
  expect(f.spawned[0].harness).toBeUndefined()
  const gate = f.spawned[0].permissions
  expect(gate({ kind: "shell", fullCommandText: "git push -u origin factory/x" }, {})).toEqual({ kind: "approve-once" })
  expect(gate({ kind: "shell", fullCommandText: "git push origin main" }, {}).kind).toBe("reject")
  expect(gate({ kind: "shell", fullCommandText: "git push --force-with-lease origin factory/x" }, {}).kind).toBe(
    "approve-once",
  )
  // The push count is saved; after a restart a new finish worker continues it, and once spent step=finish is refused.
  for (let i = 0; i < 5; i++) gate({ kind: "shell", fullCommandText: "git push origin factory/x" }, {})
  f.approvals = new Approvals(root)
  expect(f.approvals.acceptedShips("sub-1", "factory/x")[0]!.pushes).toBe(6)
  expect(JSON.parse(await finish()).error).toContain("limit")
  // A new accepted ship approval gives a fresh limit.
  const second = await ask()
  f.approvals.answer(second, "Ship", null)
  expect(JSON.parse(await finish()).error).toBeUndefined()
  // Another conversation's approval does not count; a non-factory branch cannot ask.
  const other = coordinatorTools(f, { id: "sub-2", threadId: "u", workdir: repo })
  expect(
    JSON.parse(await tool(other, "spawn_worker")({ name: "finish", task: "ship", step: "finish" })).error,
  ).toContain("No accepted ship approval")
  git("checkout", "-q", "-b", "main")
  expect(
    JSON.parse(await tool(tools, "request_approval")({ title: "Ship?", summary: "s", options: ["Ship"], ship: true }))
      .error,
  ).toContain("factory/*")
  expect(f.approvals.list()).toHaveLength(3)
})

test("the security review starts last: only when every other gate is ready, and once per implement", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "sf-last-"))
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "factory/x"])
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.email=a@b",
    "-c",
    "user.name=a",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "x",
  ])
  const f = fakeFactory()
  f.approvals = new Approvals(mkdtempSync(path.join(tmpdir(), "sf-last-state-")))
  const scope = { id: "sub-1", threadId: "t", workdir: repo }
  ensureFactoryDir(repo)
  f.sdlc.set("sub-1", { ...newSdlc("sub-1", "t"), criteria: ["works"], implementDoneAt: 1, verifyDoneAt: 2 })
  // Criteria not proven yet: no security review starts, the normal blockers come back.
  expect(startFinalSecurity(f, scope)).toBeNull()
  writeFileSync(artifact(repo, "evidence.md"), "AC-1: PASS — t — ok\n")
  // Everything else ready, the review running: wait note.
  f.securityReviews.set("sr-1", {
    id: "sr-1",
    scopeId: "sub-1",
    threadId: "t",
    implementWorkerId: "w",
    status: "started",
    model: "",
    findings: [],
    at: 3,
  })
  expect(startFinalSecurity(f, scope)).toContain("final security review sr-1 is started")
  // Done after the last implement: nothing more to start.
  f.securityReviews.set("sr-1", { ...f.securityReviews.get("sr-1")!, status: "done" })
  expect(startFinalSecurity(f, scope)).toBeNull()
})

test("UI tools tell every open UI what to show, and confirm_action opens a yes/no decision", async () => {
  const f = fakeFactory()
  f.workers.set("w-1", {})
  const patches: unknown[] = []
  f.updateSettings = async (p: unknown) => (patches.push(p), {})
  f.approvals = new Approvals(mkdtempSync(path.join(tmpdir(), "sf-ui-tools-")))
  f.currentThread = "t0"
  const tools = coordinatorTools(f, { id: "gen-1", threadId: "t1" })

  expect(JSON.parse(await tool(tools, "focus_agent")({ id: "w-1" }))).toEqual({ shown: "w-1" })
  expect(patches).toEqual([{ focus: "w-1" }])
  expect(JSON.parse(await tool(tools, "focus_agent")({ id: "w-404" })).error).toContain("unknown agent")

  expect(JSON.parse(tool(tools, "open_report")({ path: "reports/synthesis.md" }))).toEqual({
    opened: "reports/synthesis.md",
  })
  expect(JSON.parse(tool(tools, "open_report")({ path: "src/main.ts" })).error).toContain("reports/")

  const asked = JSON.parse(
    tool(
      tools,
      "confirm_action",
    )({ title: "Stop 3 workers?", detail: "They lose unsaved work.", confirmLabel: "Stop them" }),
  )
  const decision = f.approvals.get(asked.id)!
  expect([decision.options, decision.threadId, decision.status, decision.summary]).toEqual([
    ["Stop them", "Cancel"],
    "t1",
    "pending",
    "They lose unsaved work.",
  ])

  expect(
    f.published.map((e: { type: string; data?: { path?: string; title?: string } }) => [
      e.type,
      e.data?.path ?? e.data?.title,
    ]),
  ).toEqual([
    ["factory.ui_open_report", "reports/synthesis.md"],
    ["factory.approval_requested", "Stop 3 workers?"],
  ])
  expect(f.published[0].data).toEqual({ path: "reports/synthesis.md", agent: "gen-1", threadId: "t1" })
})
