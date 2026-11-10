import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ConfigStore,
  loadFactoryConfig,
  missingProfiles,
  pinnedConfig,
  setConfigStore,
  snapshotConfig,
  userConfigPath,
} from "../src/config.ts"

const dir = () => mkdtempSync(path.join(tmpdir(), "sf-config-"))
const stores: ConfigStore[] = []
afterEach(() => stores.splice(0).forEach((s) => s.close()))

test("shipped defaults are valid and match the current code values", () => {
  const c = loadFactoryConfig("/nonexistent/config.toml")
  expect(c.review.rereview_lines).toBe(100)
  expect(c.review.lens_threshold).toBe(0.6)
  expect(c.sdlc.done_below).toBe(0.3)
  expect(c.sdlc.max_fix_rounds).toBe(5)
  expect(c.fanout.max_workers).toBe(4)
  expect(c.models.review).toEqual({ claude: "claude-opus-5.5", gpt: "gpt-6-astra", gemini: "gemini-4-argon" })
})

test("user file wins key by key; arrays replace", () => {
  const f = path.join(dir(), "config.toml")
  writeFileSync(f, '[review]\nlens_threshold = 0.5\nmin_severity = ["critical"]\n[models.review]\ngpt = "gpt-x"\n')
  const c = loadFactoryConfig(f)
  expect(c.review.lens_threshold).toBe(0.5)
  expect(c.review.max_lenses).toBe(3)
  expect(c.review.min_severity).toEqual(["critical"])
  expect(c.models.review.gpt).toBe("gpt-x")
  expect(c.models.review.claude).toBe("claude-opus-5.5")
})

test("invalid user files are rejected with the file name", () => {
  const f = path.join(dir(), "config.toml")
  for (const bad of [
    "[review\n",
    "[review]\nlens_threshold = 2\n",
    "[review]\nlens_treshold = 0.5\n",
    '[models]\nworker = ""\n',
    "[sdlc]\nmax_fix_rounds = 1.5\n",
  ]) {
    writeFileSync(f, bad)
    expect(() => loadFactoryConfig(f)).toThrow(f)
  }
})

test("store keeps the last good config on an invalid edit and recovers", () => {
  const f = path.join(dir(), "config.toml")
  writeFileSync(f, "[fanout]\nmax_workers = 2\n")
  const s = new ConfigStore(f)
  stores.push(s)
  expect(s.current.fanout.max_workers).toBe(2)
  writeFileSync(f, "[fanout]\nmax_workers = 0\n")
  expect(s.reload()).toBe(false)
  expect(s.current.fanout.max_workers).toBe(2)
  expect(s.error).toContain(f)
  writeFileSync(f, "[fanout]\nmax_workers = 3\n")
  expect(s.reload()).toBe(true)
  expect(s.current.fanout.max_workers).toBe(3)
  expect(s.error).toBeNull()
})

test("a bad user file at start falls back to the defaults and reports the error", () => {
  const f = path.join(dir(), "config.toml")
  writeFileSync(f, "nope = 1\n")
  const s = new ConfigStore(f)
  stores.push(s)
  expect(s.current.fanout.max_workers).toBe(4)
  expect(s.error).toContain("nope")
})

test("watch reloads after an atomic replace", async () => {
  const d = dir()
  const f = path.join(d, "config.toml")
  writeFileSync(f, "[fanout]\nmax_workers = 2\n")
  const s = new ConfigStore(f)
  stores.push(s)
  const changed = new Promise<ConfigStore>((resolve) =>
    s.watch((x) => x.current.fanout.max_workers === 7 && resolve(x), 20),
  )
  // macOS file events can miss a change made right after the watch starts: replace the file until one lands.
  for (let i = 0; i < 20 && s.current.fanout.max_workers !== 7; i++) {
    writeFileSync(path.join(d, "tmp"), "[fanout]\nmax_workers = 7\n")
    renameSync(path.join(d, "tmp"), f)
    await Bun.sleep(100)
  }
  expect((await changed).current.fanout.max_workers).toBe(7)
})

test("user path follows SF_CONFIG, then XDG_CONFIG_HOME, then HOME", () => {
  expect(userConfigPath({ SF_CONFIG: "/x/c.toml" })).toBe("/x/c.toml")
  expect(userConfigPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/trellage/factory/config.toml")
  expect(userConfigPath({ HOME: "/h" })).toBe("/h/.config/trellage/factory/config.toml")
})

test("catalog overrides: a lens, a gate threshold and a step description change without code", async () => {
  const f = path.join(dir(), "config.toml")
  writeFileSync(
    f,
    '[review.lenses.security-ux]\nfocus = "confusing security prompts"\n[gates.docs]\nthreshold = 0.9\nquestion = "Docs?"\n[steps.plan]\ndescription = "Plan it."\nbest_for = ["x"]\navoid_for = ["y"]\nskills = []\n',
  )
  const c = loadFactoryConfig(f)
  const { lenses } = await import("../src/review.ts")
  const { gateDefs } = await import("../src/sdlc.ts")
  const { stepById } = await import("../src/steps.ts")
  expect(lenses(c).map((l) => l.id)).toContain("security-ux")
  expect(gateDefs(c).find((g) => g.id === "docs")).toEqual({
    id: "docs",
    phase: "diff",
    threshold: 0.9,
    question: "Docs?",
  })
  expect(stepById("plan", c).description).toBe("Plan it.")
  expect(stepById("implement", c).skills).toEqual(["ub-mode"])
})

test("a research workflow needs a step of the same id", () => {
  const f = path.join(dir(), "config.toml")
  writeFileSync(f, '[research.debate]\ndescription = "Debate it."\n')
  expect(() => loadFactoryConfig(f)).toThrow("research.debate has no [steps.debate]")
})

test("a step whose trx profile does not exist is refused; presets and declared profiles pass", () => {
  const d = dir()
  const env = { HOME: d, TRELLAGE_CONFIG: path.join(d, "trellage.toml") }
  writeFileSync(env.TRELLAGE_CONFIG, '[native.profiles.mine]\nlabel = "x"\nharnesses = ["claude"]\n')
  const c = loadFactoryConfig("/nonexistent")
  for (const [id, s] of Object.entries(c.steps)) expect(missingProfiles(id, s.harness, env)).toEqual([])
  expect(missingProfiles("council", { kind: "claude", profiles: ["mine", "nope"] }, env)).toEqual([
    `step council: profile 'nope' is not a claude profile; add [native.profiles.nope] to ${env.TRELLAGE_CONFIG}`,
  ])
  expect(missingProfiles("council", { kind: "pi", profiles: ["mine"] }, env)).toHaveLength(1)
  writeFileSync(env.TRELLAGE_CONFIG, "[native\n")
  expect(missingProfiles("council", { kind: "claude", profiles: ["nope"] }, env)).toEqual([])
})

test("a run keeps its pinned config after the config changes", () => {
  const root = dir()
  const f = path.join(root, "config.toml")
  writeFileSync(f, "[sdlc]\nmax_fix_rounds = 2\n")
  const s = new ConfigStore(f)
  stores.push(s)
  setConfigStore(s)
  const id = snapshotConfig(root)
  writeFileSync(f, "[sdlc]\nmax_fix_rounds = 9\n")
  s.reload()
  expect(pinnedConfig(root, id).sdlc.max_fix_rounds).toBe(2)
  expect(pinnedConfig(root, undefined).sdlc.max_fix_rounds).toBe(9)
  expect(snapshotConfig(root, pinnedConfig(root, id))).toBe(id)
})
