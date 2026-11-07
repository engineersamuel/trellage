import { expect, test } from "bun:test"
import { discardLines, reviewIn, fromAnswers, parseFindings, pendingReview, pickModel, stopAll, toVerdict, triage, type SecurityReview } from "../src/security.ts"

const confirmed = {
  verdict: "confirmed",
  fingerprint: "sqli:api/users.ts:42",
  title: "SQL injection in user lookup",
  description: "The id parameter is concatenated into SQL.",
  trace: [{ kind: "entrypoint", file: "api/users.ts", line: 10, scope: "GET /users", description: "input" }],
  evidence: [{ file: "api/db.ts", line: 42, description: "string concat" }],
  severity: { overall_severity: "high" },
}
const needsValidation = {
  verdict: "needs_validation",
  fingerprint: "ssrf:fetch.ts:7",
  title: "Possible SSRF",
  description: "URL comes from the request.",
  trace: [{ kind: "sink", file: "fetch.ts", line: 7, scope: "fetch", description: "sink" }],
  evidence: [],
}
const rejected = { ...confirmed, verdict: "rejected", fingerprint: "x", title: "Refuted" }

test("parseFindings keeps confirmed and needs_validation, ignores rejected", () => {
  expect(parseFindings(JSON.stringify([confirmed, rejected, needsValidation]))).toEqual([
    { id: "sqli:api/users.ts:42", title: "SQL injection in user lookup", severity: "high", file: "api/db.ts:42", summary: "The id parameter is concatenated into SQL.", verdict: "confirmed" },
    { id: "ssrf:fetch.ts:7", title: "Possible SSRF", severity: "unknown", file: "fetch.ts:7", summary: "URL comes from the request.", verdict: "needs_validation" },
  ])
})

test("parseFindings locates a finding by evidence, then trace, else unknown", () => {
  const { evidence: _e, ...noEvidence } = needsValidation
  const { trace: _t, ...bare } = noEvidence
  const noLine = { ...bare, evidence: [{ file: "a.ts" }] }
  expect(parseFindings(JSON.stringify([noEvidence, bare, noLine])).map((x) => x.file)).toEqual(["fetch.ts:7", "unknown", "a.ts"])
})

test("parseFindings returns [] for malformed input", () => {
  expect(parseFindings("not json")).toEqual([])
  expect(parseFindings('{"verdict":"confirmed"}')).toEqual([])
  expect(parseFindings("[null, 3, {\"verdict\":\"confirmed\"}]")).toEqual([])
})

test("toVerdict maps Jev choices; unknown keys are kept", () => {
  expect(toVerdict("keep", 0.9)).toEqual({ verdict: "keep", reason: expect.stringContaining("real"), confidence: 0.9 })
  expect(toVerdict("discard_false_positive", 0.8)).toEqual({ verdict: "discard", reason: expect.stringContaining("false positive"), confidence: 0.8 })
  expect(toVerdict("discard_out_of_scope", 0.7).reason).toContain("scope")
  expect(toVerdict("discard_low_risk", 0.6).reason).toContain("low risk")
  expect(toVerdict("discard_out_of_scope", 0.7).verdict).toBe("discard")
  expect(toVerdict("discard_low_risk", 0.6).verdict).toBe("discard")
  expect(toVerdict("nonsense", 0.5)).toEqual({ verdict: "keep", reason: expect.stringContaining("fail safe"), confidence: 0.5 })
})

test("pendingReview finds an unfinished review for the scope only", () => {
  const r = (scopeId: string, status: SecurityReview["status"]) => ({ id: `${scopeId}-${status}`, scopeId, status }) as SecurityReview
  expect(pendingReview([r("a", "done"), r("a", "failed"), r("b", "fixing")], "a")).toBeUndefined()
  expect(pendingReview([r("a", "done"), r("a", "verifying")], "a")?.id).toBe("a-verifying")
})

test("triage without a Jev key keeps every finding", async () => {
  const saved = { ...process.env }
  process.env.TYPESAFE_API_KEY = ""
  process.env.XDG_CONFIG_HOME = "/nonexistent"
  try {
    const [f] = parseFindings(JSON.stringify([confirmed]))
    const out = await triage([f!])
    expect(out).toEqual([{ id: f!.id, title: f!.title, severity: "high", file: f!.file, summary: f!.summary, audit: "confirmed", verdict: "keep", reason: "Jev unavailable; kept (fail safe)", confidence: 0 }])
  } finally {
    process.env = saved
  }
})

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { securityReview } from "../src/security.ts"

/** A Factory double: spawned workers finish at once; the reviewer writes `findings`. */
const fakeFactory = (findings: unknown[] | null, idle = true) => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-sec-"))
  const spawned: { step: string; task: string; workdir: string; model: string; auth: string }[] = []
  const waits: number[] = []
  const events: { status: string; findings: unknown[] }[] = []
  const stopped: string[] = []
  const f: any = {
    root,
    run: null,
    defaultModel: "default-model",
    workers: new Map([["sub-1", { auth: "proxy" }]]),
    securityReviews: new Map(), codeReviews: new Map(), sdlc: new Map(),
    publish: (_w: string, type: string, _a: null, _t: string, data: any) => type === "factory.security_review" && events.push(data),
    routeModel: async () => ({ id: "routed-model" }),
    stop: async (id: string) => void stopped.push(id),
    spawn: async (spec: any) => {
      spawned.push({ step: spec.step, task: spec.task, workdir: spec.workdir, model: spec.model, auth: spec.auth })
      const id = spec.id ?? `w-${spawned.length}`
      if (spec.step === "security" && findings) {
        mkdirSync(path.join(root, id, "security-audit"), { recursive: true })
        writeFileSync(path.join(root, id, "security-audit", "findings.json"), JSON.stringify(findings))
      }
      return { id, status: "idle", lastError: null, waitIdle: async (ms: number) => (waits.push(ms), idle) }
    },
  }
  return { f, spawned, events, stopped, waits }
}
const scope = { id: "sub-1", threadId: "t1", workdir: "/wt", base: "abc123" }

const noJev = async (fn: () => Promise<void>) => {
  const saved = { ...process.env }
  process.env.TYPESAFE_API_KEY = ""
  process.env.XDG_CONFIG_HOME = "/nonexistent"
  delete process.env.SF_SECURITY_MODEL
  try {
    await fn()
  } finally {
    process.env = saved
  }
}

test("securityReview audits the diff, then fixes and verifies kept findings", () =>
  noJev(async () => {
    const { f, spawned, events, stopped, waits } = fakeFactory([confirmed, rejected])
    const r = await securityReview(f, scope, "w-impl")
    expect(r).toMatchObject({ status: "done", model: "routed-model", implementWorkerId: "w-impl", threadId: "t1" })
    expect(r.findings.map((x) => [x.id, x.verdict])).toEqual([["sqli:api/users.ts:42", "keep"]])
    expect(spawned.map((s) => s.step)).toEqual(["security", "implement", "verify"])
    expect(spawned[0]!.task).toContain("git diff abc123")
    expect(spawned[1]!.task).toContain("SQL injection in user lookup")
    expect(spawned.every((s) => s.workdir === "/wt" && s.model === "routed-model" && s.auth === "proxy")).toBe(true)
    expect(waits).toEqual([1_200_000, 1_200_000, 1_200_000])
    expect(events[3]!.findings).toMatchObject([{ verdict: "keep", reason: "awaiting triage", confidence: 0 }])
    expect(new Set(stopped)).toEqual(new Set([stopped[0]!, "w-2", "w-3"]))
    expect(stopped[0]).toStartWith("w-")
    expect(r.workerId).toBe("w-3")
    expect(r.workdir).toBe("/wt")
    expect(events.map((e) => e.status)).toEqual(["started", "started", "started", "findings", "triaged", "fixing", "verifying", "done"])
    expect(f.securityReviews.get(r.id)).toBe(r)
  }))

test("securityReview with no findings spawns no fix worker; with both workers gone it uses the captured scope auth", () =>
  noJev(async () => {
    process.env.SF_SECURITY_TIMEOUT_MS = "5000"
    const { f, spawned, waits } = fakeFactory([])
    f.routeModel = async () => null
    f.workers = new Map()
    expect(await securityReview(f, scope, "w", "proxy")).toMatchObject({ status: "done", model: "default-model", auth: "proxy" })
    expect(waits).toEqual([5000])
    expect(spawned[0]!.auth).toBe("proxy")
    expect(spawned.map((s) => s.step)).toEqual(["security"])
  }))

test("securityReview fails visibly on timeout, missing output, or missing base", () =>
  noJev(async () => {
    process.env.SF_SECURITY_MODEL = "pinned"
    const slow = await securityReview(fakeFactory([confirmed], false).f, scope, "w")
    expect(slow).toMatchObject({ status: "failed", model: "pinned", error: expect.stringContaining("timed out") })
    expect((await securityReview(fakeFactory(null).f, scope, "w")).error).toContain("findings.json")
    expect((await securityReview(fakeFactory([]).f, { id: "coordinator", threadId: null }, "w")).error).toContain("base commit")
    expect((await securityReview(fakeFactory([]).f, { id: "s", threadId: null, workdir: "/wt" }, "w")).error).toContain("base commit")
  }))

test("fromAnswers maps Jev answers per finding; a missing answer keeps it", () => {
  const fs = parseFindings(JSON.stringify([confirmed, needsValidation]))
  const out = fromAnswers(fs, { f0: { choice: "discard_low_risk", confidence: 0.7 } })
  expect(out.map((x) => [x.id, x.verdict, x.confidence])).toEqual([["sqli:api/users.ts:42", "discard", 0.7], ["ssrf:fetch.ts:7", "keep", 0]])
  expect(out[1]!.audit).toBe("needs_validation")
})

test("discardLines logs each discarded finding with its reason", () => {
  const out = fromAnswers(parseFindings(JSON.stringify([confirmed, needsValidation])), { f0: { choice: "discard_false_positive", confidence: 0.9 } })
  expect(discardLines("sr-1", out)).toEqual(['[security] sr-1 discarded sqli:api/users.ts:42 "SQL injection in user lookup": false positive (0.9)'])
})

test("pickModel: a blank SF_SECURITY_MODEL counts as unset", () => {
  expect(pickModel("  pinned ", "routed", "fb")).toBe("pinned")
  expect(pickModel("  ", "routed", "fb")).toBe("routed")
  expect(pickModel(undefined, undefined, "fb")).toBe("fb")
})

test("stopAll stops every worker and swallows failures", async () => {
  const stopped: string[] = []
  await stopAll(["a", "b", "c"], async (id) => {
    if (id === "b") throw new Error("gone")
    stopped.push(id)
  })
  expect(stopped).toEqual(["a", "c"])
})

test("reviewIn finds an unfinished review in that worktree only, comparing resolved paths", () => {
  const r = (id: string, status: SecurityReview["status"], workdir: string) => ({ id, status, workdir }) as SecurityReview
  const reviews = [r("a", "done", "/wt"), r("b", "fixing", "/other"), r("c", "verifying", "/wt/")]
  expect(reviewIn(reviews, "/wt")?.id).toBe("c")
  expect(reviewIn(reviews.slice(0, 2), "/wt")).toBeUndefined()
  expect(reviewIn([r("d", "started", "/x/../wt")], "/wt")?.id).toBe("d")
  expect(reviewIn([r("e", "failed", "/wt")], "/wt")).toBeUndefined()
})

test("securityReview records its worktree in the first, synchronous update", () =>
  noJev(async () => {
    const { f, events } = fakeFactory([])
    const done = securityReview(f, scope, "w-impl")
    expect([...f.securityReviews.values()]).toMatchObject([{ status: "started", workdir: "/wt" }])
    await done
    expect(events[0]).toMatchObject({ status: "started", workdir: "/wt" })
  }))

test("securityReview stops the timed-out worker and uses the implement worker's auth", () =>
  noJev(async () => {
    process.env.SF_SECURITY_MODEL = " "
    const { f, spawned, stopped } = fakeFactory([confirmed], false)
    f.workers.set("w-impl", { auth: "native" })
    const r = await securityReview(f, scope, "w-impl")
    expect(r).toMatchObject({ status: "failed", model: "routed-model" })
    expect(stopped).toEqual([r.workerId!])
    expect(spawned[0]!.auth).toBe("native")
  }))

test("securityReview fails without spawning when no auth can be determined", () =>
  noJev(async () => {
    const { f, spawned } = fakeFactory([])
    f.workers = new Map()
    const r = await securityReview(f, scope, "w-impl")
    expect(r).toMatchObject({ status: "failed", error: expect.stringContaining("no auth") })
    expect(spawned).toEqual([])
  }))

test("securityReview captures the implement worker's auth when it starts", () =>
  noJev(async () => {
    const { f, spawned } = fakeFactory([])
    f.workers.set("w-impl", { auth: "native" })
    const done = securityReview(f, scope, "w-impl", "proxy")
    expect(f.securityReviews.values().next().value).toMatchObject({ auth: "native" })
    f.workers.clear()
    expect(await done).toMatchObject({ status: "done", auth: "native" })
    expect(spawned[0]!.auth).toBe("native")
  }))
