import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import path from "node:path"
import { acquireBackendGuard, backendGuardPresets } from "../../src/native-run/backend-guard.ts"
import { cleanupFixtures, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)
const database = (home: string) => new Database(path.join(home, ".local/share/trellage/backend-guards/profiles.sqlite"))

test("active presets reject another composition and maintenance, while other presets remain independent", async () => {
  const home = await tempRoot("backend-guard")
  const first = acquireBackendGuard("codex", ["pstack"], "run", home)
  try {
    expect(() => acquireBackendGuard("codex", ["pstack"], "run", home)).toThrow("profile busy")
    for (const operation of ["setup", "repair", "skills-update", "upgrade", "harness-update"])
      expect(() =>
        acquireBackendGuard("codex", backendGuardPresets(operation, "codex", ["--all"]), operation, home),
      ).toThrow("finish that operation")
    const separate = acquireBackendGuard("codex", ["youtube"], "run", home)
    separate.release()
  } finally {
    first.release()
  }
  const next = acquireBackendGuard("codex", ["pstack"], "repair", home)
  next.release()
})

test("stale process identities recover atomically and old release cannot remove a replacement", async () => {
  const home = await tempRoot("backend-guard-stale")
  const first = acquireBackendGuard("codex", ["pstack"], "run", home)
  const db = database(home)
  db.query("UPDATE owners SET started = ?").run("previous process using the same PID")
  const replacement = acquireBackendGuard("codex", ["pstack"], "run", home)
  first.release()
  expect(() => acquireBackendGuard("codex", ["pstack"], "repair", home)).toThrow("profile busy")
  replacement.release()
  expect(db.query("SELECT * FROM owners").all()).toEqual([])
  db.close()
})

test("live backend child retains ownership after the supervising process disappears", async () => {
  const home = await tempRoot("backend-guard-child")
  const guard = acquireBackendGuard("codex", ["pstack"], "run", home)
  const child = spawn("sleep", ["30"])
  await once(child, "spawn")
  const db = database(home)
  try {
    guard.attachChild(child.pid!)
    db.query("UPDATE owners SET started = ?").run("dead supervisor identity")
    expect(() => acquireBackendGuard("codex", ["pstack"], "run", home)).toThrow("profile busy")
  } finally {
    child.kill()
    await once(child, "exit")
    guard.release()
    db.close()
  }
})

test("operation scope blocks global maintenance but permits shutdown and read-only probes", () => {
  expect(backendGuardPresets("upgrade", "codex", ["pstack"])).toEqual(["pstack", "superpowers", "youtube"])
  expect(backendGuardPresets("upgrade", "codex", ["pstack", "--skills-only"])).toEqual(["pstack"])
  expect(backendGuardPresets("setup", "codex", ["--all"])).toEqual(["pstack", "superpowers", "youtube"])
  expect(backendGuardPresets("shutdown", "prime", ["default"])).toEqual([])
  expect(backendGuardPresets("skills-check", "codex", ["pstack"])).toEqual([])
  expect(backendGuardPresets("upgrade", "codex", ["--check"])).toEqual([])
})

test("upgrade checks need no guard state and remain available during an active session", async () => {
  const home = await tempRoot("backend-guard-check")
  const scopes = backendGuardPresets("upgrade", "codex", ["pstack", "--check"])
  acquireBackendGuard("codex", scopes, "upgrade", home).release()
  expect(existsSync(path.join(home, ".local"))).toBe(false)
  const active = acquireBackendGuard("codex", ["pstack"], "run", home)
  try {
    acquireBackendGuard("codex", scopes, "upgrade", home).release()
  } finally {
    active.release()
  }
})

test("failed all-profile maintenance releases every partially acquired preset", async () => {
  const home = await tempRoot("backend-guard-all")
  const active = acquireBackendGuard("codex", ["youtube"], "run", home)
  try {
    expect(() =>
      acquireBackendGuard("codex", backendGuardPresets("repair", "codex", ["--all"]), "repair", home),
    ).toThrow("profile busy")
    const independent = acquireBackendGuard("codex", ["pstack"], "run", home)
    independent.release()
  } finally {
    active.release()
  }
})

test("process identities remain stable when timezone and locale change", async () => {
  const home = await tempRoot("backend-guard-timezone")
  const previous = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL }
  process.env.TZ = "America/New_York"
  process.env.LC_ALL = "C"
  const guard = acquireBackendGuard("codex", ["pstack"], "run", home)
  try {
    process.env.TZ = "Asia/Tokyo"
    process.env.LC_ALL = "en_US.UTF-8"
    expect(() => acquireBackendGuard("codex", ["pstack"], "repair", home)).toThrow("profile busy")
  } finally {
    guard.release()
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test("Firstmate preserves independent instance admission and registry-aware maintenance", () => {
  for (const operation of ["run", "setup", "repair", "skills-update", "upgrade"])
    expect(
      backendGuardPresets(operation, "firstmate", ["default", "--instance", "11111111-1111-4111-8111-111111111111"]),
    ).toEqual([])
})

test("surviving maintenance process group retains ownership after its leader exits", async () => {
  const home = await tempRoot("backend-guard-group")
  const guard = acquireBackendGuard("codex", ["pstack"], "setup", home)
  const child = spawn("sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" })
  await once(child, "spawn")
  guard.attachChild(child.pid!, true)
  // Let the shell start its worker before terminating only the leader.
  await new Promise((resolve) => setTimeout(resolve, 100))
  child.kill("SIGTERM")
  await once(child, "exit")
  try {
    guard.release()
    expect(() => acquireBackendGuard("codex", ["pstack"], "run", home)).toThrow("profile busy")
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {}
    guard.release()
  }
})

test("attached cancellation retains ownership when a descendant ignores TERM", async () => {
  const home = await tempRoot("backend-guard-survivor")
  const guard = acquireBackendGuard("codex", ["pstack"], "run", home)
  const child = spawn("sh", ["-c", "sh -c 'trap \"\" TERM; sleep 30' & wait"], { stdio: "ignore" })
  await once(child, "spawn")
  guard.attachChild(child.pid!)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const db = database(home)
  try {
    guard.signalTree(child.pid!, "SIGTERM")
    await once(child, "exit")
    guard.release()
    expect(() => acquireBackendGuard("codex", ["pstack"], "repair", home)).toThrow("profile busy")
  } finally {
    const rows = db.query<{ descendants: string }, []>("SELECT descendants FROM owners").all()
    for (const row of rows)
      for (const identity of JSON.parse(row.descendants) as { pid: number }[]) {
        try {
          process.kill(identity.pid, "SIGKILL")
        } catch {}
      }
    child.kill("SIGKILL")
    guard.release()
    db.close()
  }
})
