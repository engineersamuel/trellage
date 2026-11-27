import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as cfg from "../src/config.ts"
import { Factory, profileEffort, profileWorker } from "../src/factory.ts"
import { familyOf, reviewModels } from "../src/review.ts"
import { decodeGoal, goalProblems } from "../../shared/goal.ts"
import { Exit } from "effect"

const as = <T>(x: unknown) => x as T
const dir = () => mkdtempSync(path.join(tmpdir(), "sf-prof-"))
const stores: cfg.ConfigStore[] = []
afterEach(() => {
  cfg.resetConfigStore()
  for (const s of stores.splice(0)) s.close()
})
const useConfig = (toml = "") => {
  const f = path.join(dir(), "config.toml")
  writeFileSync(f, toml)
  const s = new cfg.ConfigStore(f)
  stores.push(s)
  cfg.setConfigStore(s)
  return s
}

test("shipped budget profile: agreed models, Claude-only claude_worker, low efforts", () => {
  const c = cfg.loadFactoryConfig("/nonexistent/config.toml")
  expect(c.models.profile).toBe("")
  expect(c.profiles.budget).toEqual({
    sub_coordinator: "claude-opus-5.5",
    sub_coordinator_effort: "low",
    workers: ["mai-code-2", "mai-code-2-flash", "gpt-6-luna"],
    small_model: "gpt-6-luna",
    claude_worker: "claude-haiku-5.5",
    review_effort: "low",
  })
})

test("config refuses a non-Claude claude_worker and a models.profile with no table", () => {
  const f = path.join(dir(), "config.toml")
  writeFileSync(f, '[profiles.budget]\nclaude_worker = "mai-code-2"\n')
  expect(() => cfg.loadFactoryConfig(f)).toThrow()
  writeFileSync(f, '[models]\nprofile = "nope"\n')
  expect(() => cfg.loadFactoryConfig(f)).toThrow("no [profiles.nope]")
  writeFileSync(f, '[models]\nprofile = "budget"\n')
  expect(cfg.loadFactoryConfig(f).models.profile).toBe("budget")
})

test("profileWorker: the router's first pick in the list, else the list's first", () => {
  const p = cfg.loadFactoryConfig("/nonexistent/config.toml").profiles.budget!
  expect(profileWorker(["claude-opus-5.5", "gpt-6-luna", "mai-code-2"], p)).toBe("gpt-6-luna")
  expect(profileWorker(["claude-opus-5.5"], p)).toBe("mai-code-2")
  expect(profileWorker([], p)).toBe("mai-code-2")
})

test("profileEffort: only review-type steps, only under a profile", () => {
  const p = cfg.loadFactoryConfig("/nonexistent/config.toml").profiles.budget!
  for (const s of ["review", "synthesis", "security", "evaluate"]) expect(profileEffort(p, s)).toBe("low")
  for (const s of ["implement", "verify", undefined]) expect(profileEffort(p, s)).toBeUndefined()
  expect(profileEffort(null, "review")).toBeUndefined()
  expect(profileEffort({ ...p, review_effort: "default" }, "review")).toBeUndefined()
})

test("mai is its own family: a mai implementer gets all three frontier reviewers", () => {
  expect(familyOf("mai-code-2")).toBe("mai")
  expect(familyOf("mai-code-2-flash")).toBe("mai")
  expect(familyOf("grok-4.7")).toBeNull()
  expect(reviewModels("mai-code-2")).toEqual(["gpt-6-astra", "claude-opus-5.5", "gemini-4-argon"])
  expect(reviewModels("gpt-6-luna")).toEqual(["claude-opus-5.5", "gemini-4-argon"])
})

type Spy = {
  publish: (...a: unknown[]) => void
  routeModel: () => Promise<{ id: string; confidence: number; routedBy: string; ranked: string[] } | null>
  lowComplexity: () => Promise<{ p: number; ui: boolean } | null>
  spawnModel: (spec: object, profile?: unknown) => Promise<{ model: string; source: { by?: string } }>
  profileName: (id: string) => string
  profileFor: (id: string) => cfg.Profile | null
  coordinatorModel: (id: string) => { model: string; reasoningEffort: string }
}

test("worker routing under the budget profile; no profile keeps today's routing", async () => {
  useConfig('[routing]\nimplement_model = "impl-sentinel"\n')
  const f = as<Spy>(new Factory({ SF_STATE_DIR: dir(), SF_MODEL: "dflt" }))
  const events: unknown[] = []
  f.publish = (...a) => void events.push(a[4])
  f.routeModel = async () => ({
    id: "claude-opus-5.5",
    confidence: 0.6,
    routedBy: "jev",
    ranked: ["claude-opus-5.5", "mai-code-2-flash"],
  })
  f.profileName = (id) => (id === "sub-budget" ? "budget" : "")
  const p = f.profileFor("sub-budget")!
  const spec = { name: "i", role: "worker", task: "build the parser", step: "implement", owner: "sub-budget" }
  f.lowComplexity = async () => ({ p: 0.9, ui: false })
  expect((await f.spawnModel(spec, p)).model).toBe("gpt-6-luna")
  f.lowComplexity = async () => ({ p: 0.9, ui: true })
  expect((await f.spawnModel(spec, p)).model).toBe("mai-code-2-flash")
  f.lowComplexity = async () => ({ p: 0.1, ui: false })
  // implement_model does not apply under a profile.
  expect((await f.spawnModel(spec, p)).model).toBe("mai-code-2-flash")
  expect(events.at(-1)).toMatchObject({ id: "mai-code-2-flash", routedBy: "profile", profile: "budget" })
  f.routeModel = async () => null
  expect((await f.spawnModel(spec, p)).model).toBe("mai-code-2")
  // A pinned model (reviewers) wins over the profile.
  expect((await f.spawnModel({ ...spec, model: "gpt-6-astra" }, p)).model).toBe("gpt-6-astra")
  // No profile: the existing implement_model path.
  expect(f.profileFor("sub-other")).toBeNull()
  expect((await f.spawnModel({ ...spec, owner: "sub-other" })).model).toBe("impl-sentinel")
})

test("sub-coordinator model: the profile's at its effort; others keep the settings", () => {
  useConfig()
  const f = as<Spy>(new Factory({ SF_STATE_DIR: dir() }))
  f.profileName = (id) => (id === "sub-budget" ? "budget" : id === "sub-gone" ? "gone" : "")
  expect(f.coordinatorModel("sub-budget")).toEqual({ model: "claude-opus-5.5", reasoningEffort: "low" })
  expect(f.coordinatorModel("sub-plain")).toEqual({ model: "claude-opus-5.5", reasoningEffort: "medium" })
  // A name the config no longer has falls back to no profile.
  expect(f.coordinatorModel("sub-gone")).toEqual({ model: "claude-opus-5.5", reasoningEffort: "medium" })
  expect(f.coordinatorModel("coordinator").model).toBe("gpt-6-astra")
})

test("spawn under a profile: Claude SDK gets claude_worker, reviewers keep their model at low effort", async () => {
  useConfig()
  type S = Spy & {
    prepareSpawn: () => unknown
    claudeSession: (spec: { model?: string; reasoningEffort?: string }) => Promise<unknown>
    acceptsThinking: (m: string) => Promise<boolean>
    register: (w: unknown) => Promise<unknown>
    spawn: (spec: object) => Promise<{ model: string }>
    uiTask: () => Promise<number>
  }
  const f = as<S>(new Factory({ SF_STATE_DIR: dir() }))
  const launched: { model?: string; effort?: string; sub?: string | null }[] = []
  f.publish = () => {}
  f.profileName = () => "budget"
  f.uiTask = async () => 0
  f.lowComplexity = async () => ({ p: 0.1, ui: false })
  f.routeModel = async () => ({ id: "claude-opus-5.5", confidence: 0.6, routedBy: "jev", ranked: ["claude-opus-5.5"] })
  f.acceptsThinking = async () => true
  f.prepareSpawn = () => ({
    workdir: "/tmp/wt",
    setup: { skillDirectories: [], extraPath: [], prefix: "" },
    skills: [],
  })
  f.claudeSession = async (spec, ...rest: unknown[]) => {
    launched.push({ model: spec.model, effort: spec.reasoningEffort, sub: rest[5] as string | null })
    return { session: { model: spec.model }, model: spec.model, loaded: "stub" }
  }
  f.register = async (w) => w
  // A forced Claude harness: the routed pick (mai-code-2) is not Claude, so claude_worker runs it.
  const claude = { kind: "claude", profiles: ["default"] }
  await f.spawn({ name: "c", role: "worker", task: "fix it", step: "implement", owner: "sub-x", harness: claude })
  // A reviewer pinned to a Claude frontier model keeps it, at the profile's review_effort.
  await f.spawn({
    name: "r",
    role: "worker",
    task: "review",
    step: "review",
    owner: "sub-x",
    model: "claude-opus-5.5",
    harness: claude,
  })
  expect(launched).toEqual([
    { model: "claude-haiku-5.5", effort: undefined, sub: "claude-haiku-5.5" },
    { model: "claude-opus-5.5", effort: "low", sub: "claude-haiku-5.5" },
  ])
})

test("goal spec: optional profile, checked against the known profiles", () => {
  const raw = { id: "g-1", repo: "/r", prompt: "p", profile: "budget" }
  const exit = decodeGoal(raw)
  expect(Exit.isSuccess(exit)).toBe(true)
  const g = (exit as Exit.Success<never, never>).value
  expect(goalProblems(g, undefined, ["budget"])).toEqual([])
  expect(goalProblems({ ...(g as object), profile: "nope" } as never, undefined, ["budget"])).toEqual([
    "unknown profile nope (known: budget)",
  ])
})

test("spawn_worker under a profile drops a model the profile does not list", async () => {
  useConfig()
  const { profileDrops } = await import("../src/tools.ts")
  const f = as<Spy>(new Factory({ SF_STATE_DIR: dir() }))
  f.profileName = (id) => (id === "sub-b" ? "budget" : "")
  const real = as<Factory>(f)
  expect(profileDrops(real, "sub-b", "claude-opus-5.5")).toContain("not in this conversation's model profile budget")
  expect(profileDrops(real, "sub-b", "mai-code-2")).toBeNull()
  expect(profileDrops(real, "sub-b", "claude-haiku-5.5")).toBeNull()
  expect(profileDrops(real, "sub-b", undefined)).toBeNull()
  expect(profileDrops(real, "sub-plain", "claude-opus-5.5")).toBeNull()
})
