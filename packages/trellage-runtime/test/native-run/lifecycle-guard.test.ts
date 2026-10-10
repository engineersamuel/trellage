import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import path from "node:path"
import { acquireProfileGuard, profileGuardProfiles } from "../../src/native-run/lifecycle-guard.ts"
import { cleanupFixtures, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)
const database = (home: string) => new Database(path.join(home, ".local/share/trellage/profile-guards/profiles.sqlite"))

test("active presets reject another composition and maintenance, while other presets remain independent", async () => {
  const home = await tempRoot("profile-guard")
  const first = acquireProfileGuard("codex", ["pstack"], "run", home)
  try {
    expect(() => acquireProfileGuard("codex", ["pstack"], "run", home)).toThrow("profile busy")
    for (const operation of ["setup", "repair", "skills-update", "upgrade", "harness-update"])
      expect(() =>
        acquireProfileGuard("codex", profileGuardProfiles(operation, "codex", ["--all"]), operation, home),
      ).toThrow("finish that operation")
    const separate = acquireProfileGuard("codex", ["youtube"], "run", home)
    separate.release()
  } finally {
    first.release()
  }
  const next = acquireProfileGuard("codex", ["pstack"], "repair", home)
  next.release()
})

test("stale process identities recover atomically and old release cannot remove a replacement", async () => {
  const home = await tempRoot("profile-guard-stale")
  const first = acquireProfileGuard("codex", ["pstack"], "run", home)
  const db = database(home)
  db.query("UPDATE owners SET started = ?").run("previous process using the same PID")
  const replacement = acquireProfileGuard("codex", ["pstack"], "run", home)
  first.release()
  expect(() => acquireProfileGuard("codex", ["pstack"], "repair", home)).toThrow("profile busy")
  replacement.release()
  expect(db.query("SELECT * FROM owners").all()).toEqual([])
  db.close()
})

test("live maintenance child retains ownership after the supervising process disappears", async () => {
  const home = await tempRoot("profile-guard-child")
  const guard = acquireProfileGuard("codex", ["pstack"], "run", home)
  const child = spawn("sleep", ["30"])
  await once(child, "spawn")
  const db = database(home)
  try {
    guard.attachChild(child.pid!)
    db.query("UPDATE owners SET started = ?").run("dead supervisor identity")
    expect(() => acquireProfileGuard("codex", ["pstack"], "run", home)).toThrow("profile busy")
  } finally {
    child.kill()
    await once(child, "exit")
    guard.release()
    db.close()
  }
})

test("operation scope blocks global maintenance but permits shutdown and read-only probes", () => {
  expect(profileGuardProfiles("upgrade", "codex", ["pstack"])).toEqual(["pstack", "superpowers", "youtube"])
  expect(profileGuardProfiles("upgrade", "codex", ["pstack", "--skills-only"])).toEqual(["pstack"])
  expect(profileGuardProfiles("setup", "codex", ["--all"])).toEqual(["pstack", "superpowers", "youtube"])
  expect(profileGuardProfiles("shutdown", "prime", ["default"])).toEqual([])
  expect(profileGuardProfiles("skills-check", "codex", ["pstack"])).toEqual([])
  expect(profileGuardProfiles("upgrade", "codex", ["--check"])).toEqual([])
})

test("upgrade checks need no guard state and remain available during an active session", async () => {
  const home = await tempRoot("profile-guard-check")
  const scopes = profileGuardProfiles("upgrade", "codex", ["pstack", "--check"])
  acquireProfileGuard("codex", scopes, "upgrade", home).release()
  expect(existsSync(path.join(home, ".local"))).toBe(false)
  const active = acquireProfileGuard("codex", ["pstack"], "run", home)
  try {
    acquireProfileGuard("codex", scopes, "upgrade", home).release()
  } finally {
    active.release()
  }
})

test("failed all-profile maintenance releases every partially acquired preset", async () => {
  const home = await tempRoot("profile-guard-all")
  const active = acquireProfileGuard("codex", ["youtube"], "run", home)
  try {
    expect(() =>
      acquireProfileGuard("codex", profileGuardProfiles("repair", "codex", ["--all"]), "repair", home),
    ).toThrow("profile busy")
    const independent = acquireProfileGuard("codex", ["pstack"], "run", home)
    independent.release()
  } finally {
    active.release()
  }
})

test("process identities remain stable when timezone and locale change", async () => {
  const home = await tempRoot("profile-guard-timezone")
  const previous = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL }
  process.env.TZ = "America/New_York"
  process.env.LC_ALL = "C"
  const guard = acquireProfileGuard("codex", ["pstack"], "run", home)
  try {
    process.env.TZ = "Asia/Tokyo"
    process.env.LC_ALL = "en_US.UTF-8"
    expect(() => acquireProfileGuard("codex", ["pstack"], "repair", home)).toThrow("profile busy")
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
      profileGuardProfiles(operation, "firstmate", ["default", "--instance", "11111111-1111-4111-8111-111111111111"]),
    ).toEqual([])
})

test("surviving maintenance process group retains ownership after its leader exits", async () => {
  const home = await tempRoot("profile-guard-group")
  const guard = acquireProfileGuard("codex", ["pstack"], "setup", home)
  const child = spawn("sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" })
  await once(child, "spawn")
  guard.attachChild(child.pid!, true)
  // Let the shell start its worker before terminating only the leader.
  await new Promise((resolve) => setTimeout(resolve, 100))
  child.kill("SIGTERM")
  await once(child, "exit")
  try {
    guard.release()
    expect(() => acquireProfileGuard("codex", ["pstack"], "run", home)).toThrow("profile busy")
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {}
    guard.release()
  }
})

test("attached cancellation retains ownership when a descendant ignores TERM", async () => {
  const home = await tempRoot("profile-guard-survivor")
  const guard = acquireProfileGuard("codex", ["pstack"], "run", home)
  const child = spawn("sh", ["-c", "sh -c 'trap \"\" TERM; sleep 30' & wait"], { stdio: "ignore" })
  await once(child, "spawn")
  guard.attachChild(child.pid!)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const db = database(home)
  try {
    guard.signalTree(child.pid!, "SIGTERM")
    await once(child, "exit")
    guard.release()
    expect(() => acquireProfileGuard("codex", ["pstack"], "repair", home)).toThrow("profile busy")
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
