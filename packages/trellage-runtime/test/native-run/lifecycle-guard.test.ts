import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireProfileGuard, profileGuardProfiles } from "../../src/native-run/lifecycle-guard.ts";
import { cleanupFixtures, tempRoot } from "./fixtures.ts";

afterEach(cleanupFixtures);

const database = (home: string) =>
  new Database(path.join(home, ".local/share/trellage/profile-guards/profiles.sqlite"));

const processStarted = (pid = process.pid) =>
  execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
  }).trim();

const legacyDatabase = (home: string) => {
  const file = path.join(home, ".local/share/trellage/profile-guards/profiles.sqlite");
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(
    "CREATE TABLE owners (scope TEXT PRIMARY KEY, operation TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL, child_pid INTEGER, child_started TEXT, token TEXT NOT NULL, descendants TEXT NOT NULL DEFAULT '[]')",
  );
  return db;
};

test("OMP admits concurrent runs for one canonical profile", async () => {
  const home = await tempRoot("profile-guard-omp-shared");
  const first = acquireProfileGuard("omp", ["default"], "run", home);
  const db = database(home);
  let second: ReturnType<typeof acquireProfileGuard> | undefined;
  try {
    second = acquireProfileGuard("omp", ["default"], "run", home);
    expect(
      db
        .query<{ scope: string; operation: string }, []>("SELECT scope, operation FROM owners")
        .all(),
    ).toEqual([
      { scope: "omp/copilot", operation: "run" },
      { scope: "omp/copilot", operation: "run" },
    ]);
  } finally {
    second?.release();
    first.release();
    db.close();
  }
});

test("a live OMP run blocks every mutating operation", async () => {
  const home = await tempRoot("profile-guard-omp-mutations");
  const active = acquireProfileGuard("omp", ["default"], "run", home);
  try {
    for (const operation of [
      "setup",
      "repair",
      "reap",
      "skills-update",
      "upgrade",
      "harness-update",
      "skill",
    ])
      expect(() => {
        const conflicting = acquireProfileGuard(
          "omp",
          profileGuardProfiles(operation, "omp", ["default", "--skills-only"]),
          operation,
          home,
        );
        conflicting.release();
      }).toThrow("finish that operation");
  } finally {
    active.release();
  }
});

test("releasing one OMP run leaves another run blocking mutation", async () => {
  const home = await tempRoot("profile-guard-omp-release");
  const first = acquireProfileGuard("omp", ["default"], "run", home);
  let second: ReturnType<typeof acquireProfileGuard> | undefined;
  try {
    second = acquireProfileGuard("omp", ["default"], "run", home);
    first.release();
    expect(() => acquireProfileGuard("omp", ["default"], "repair", home)).toThrow("profile busy");
    second.release();
    second = undefined;
    const mutation = acquireProfileGuard("omp", ["default"], "repair", home);
    mutation.release();
  } finally {
    second?.release();
    first.release();
  }
});

test("an OMP mutation blocks a later run for the same profile", async () => {
  const home = await tempRoot("profile-guard-omp-mutation-first");
  const mutation = acquireProfileGuard("omp", ["default"], "repair", home);
  try {
    expect(() => acquireProfileGuard("omp", ["default"], "run", home)).toThrow("profile busy");
  } finally {
    mutation.release();
  }
  const run = acquireProfileGuard("omp", ["default"], "run", home);
  run.release();
});

test("OMP profiles are independent while all-profile mutation sees both", async () => {
  const home = await tempRoot("profile-guard-omp-scopes");
  const defaultRun = acquireProfileGuard("omp", ["default"], "run", home);
  const localRun = acquireProfileGuard("omp", ["local"], "run", home);
  try {
    expect(() =>
      acquireProfileGuard("omp", profileGuardProfiles("repair", "omp", ["--all"]), "repair", home),
    ).toThrow("profile busy");

    defaultRun.release();
    const defaultMutation = acquireProfileGuard("omp", ["default"], "repair", home);
    defaultMutation.release();
    expect(() => acquireProfileGuard("omp", ["local"], "repair", home)).toThrow("profile busy");
  } finally {
    defaultRun.release();
    localRun.release();
  }
});

test("stale shared OMP rows are replaced while live attached children block mutation", async () => {
  const home = await tempRoot("profile-guard-omp-stale");
  const stale = acquireProfileGuard("omp", ["default"], "run", home);
  const db = database(home);
  let replacement: ReturnType<typeof acquireProfileGuard> | undefined;
  let attached: ReturnType<typeof acquireProfileGuard> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    db.query("UPDATE owners SET started = ?").run("previous process using the same PID");
    replacement = acquireProfileGuard("omp", ["default"], "run", home);
    expect(db.query("SELECT scope FROM owners").all()).toHaveLength(1);
    replacement.release();
    replacement = undefined;

    attached = acquireProfileGuard("omp", ["default"], "run", home);
    child = spawn("sleep", ["30"]);
    await once(child, "spawn");
    attached.attachChild(child.pid!);
    db.query("UPDATE owners SET started = ?").run("dead supervisor identity");

    replacement = acquireProfileGuard("omp", ["default"], "run", home);
    replacement.release();
    replacement = undefined;
    expect(() => acquireProfileGuard("omp", ["default"], "repair", home)).toThrow("profile busy");
  } finally {
    child?.kill();
    if (child) await once(child, "exit");
    replacement?.release();
    attached?.release();
    stale.release();
    db.close();
  }
});

test("recorded OMP descendants continue blocking mutation after release", async () => {
  const home = await tempRoot("profile-guard-omp-descendants");
  const guard = acquireProfileGuard("omp", ["default"], "run", home);
  const child = spawn("sh", ["-c", "sh -c 'trap \"\" TERM; sleep 30' & wait"], { stdio: "ignore" });
  await once(child, "spawn");
  guard.attachChild(child.pid!);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const db = database(home);
  try {
    guard.signalTree(child.pid!, "SIGTERM");
    await once(child, "exit");
    guard.release();
    expect(() => acquireProfileGuard("omp", ["default"], "repair", home)).toThrow("profile busy");
  } finally {
    const rows = db.query<{ descendants: string }, []>("SELECT descendants FROM owners").all();
    for (const row of rows)
      for (const identity of JSON.parse(row.descendants) as { pid: number }[])
        try {
          process.kill(identity.pid, "SIGKILL");
        } catch {}
    child.kill("SIGKILL");
    guard.release();
    db.close();
  }
});

test("Codex same-profile runs remain exclusive", async () => {
  const home = await tempRoot("profile-guard-codex-exclusive");
  const first = acquireProfileGuard("codex", ["pstack"], "run", home);
  try {
    expect(() => acquireProfileGuard("codex", ["pstack"], "run", home)).toThrow("profile busy");
  } finally {
    first.release();
  }
});

test("legacy single-key owners migrate without dropping a live owner or its token", async () => {
  const home = await tempRoot("profile-guard-legacy-live");
  const db = legacyDatabase(home);
  db.query(
    "INSERT INTO owners (scope, operation, pid, started, child_pid, child_started, token, descendants) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("omp/copilot", "run", process.pid, processStarted(), null, null, "legacy-live-token", "[]");
  db.close();

  const run = acquireProfileGuard("omp", ["default"], "run", home);
  const migrated = database(home);
  try {
    expect(
      migrated
        .query<{ name: string; pk: number }, []>("PRAGMA table_info(owners)")
        .all()
        .filter((column) => column.pk)
        .map(({ name, pk }) => ({ name, pk })),
    ).toEqual([
      { name: "scope", pk: 1 },
      { name: "token", pk: 2 },
    ]);
    const owners = migrated
      .query<{ token: string; operation: string }, []>("SELECT token, operation FROM owners")
      .all();
    expect(owners).toHaveLength(2);
    expect(owners).toContainEqual({ token: "legacy-live-token", operation: "run" });
    expect(owners.filter(({ token }) => token !== "legacy-live-token")).toEqual([
      { token: expect.any(String), operation: "run" },
    ]);
    expect(() => acquireProfileGuard("omp", ["default"], "repair", home)).toThrow("profile busy");
  } finally {
    run.release();
    migrated.close();
  }
});

test("legacy stale owners preserve attached children through migration and release", async () => {
  const home = await tempRoot("profile-guard-legacy-child");
  const child = spawn("sleep", ["30"]);
  await once(child, "spawn");
  const childPid = child.pid!;
  const childStarted = processStarted(childPid);
  let childExited = false;
  const db = legacyDatabase(home);
  db.query(
    "INSERT INTO owners (scope, operation, pid, started, child_pid, child_started, token, descendants) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "omp/copilot",
    "run",
    process.pid,
    "dead legacy supervisor",
    childPid,
    childStarted,
    "legacy-child-token",
    "[]",
  );
  db.close();

  let run: ReturnType<typeof acquireProfileGuard> | undefined;
  const migrated = database(home);
  try {
    run = acquireProfileGuard("omp", ["default"], "run", home);
    expect(
      migrated
        .query<{ token: string; child_pid: number; child_started: string }, [string]>(
          "SELECT token, child_pid, child_started FROM owners WHERE token = ?",
        )
        .get("legacy-child-token"),
    ).toEqual({ token: "legacy-child-token", child_pid: childPid, child_started: childStarted });
    run.release();
    run = undefined;
    expect(() => acquireProfileGuard("omp", ["default"], "repair", home)).toThrow("profile busy");

    child.kill();
    await once(child, "exit");
    childExited = true;
    const repair = acquireProfileGuard("omp", ["default"], "repair", home);
    repair.release();
    expect(migrated.query("SELECT * FROM owners").all()).toEqual([]);
  } finally {
    if (!childExited) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    }
    run?.release();
    migrated.close();
  }
});

test("active presets reject another composition and maintenance, while other presets remain independent", async () => {
  const home = await tempRoot("profile-guard");
  const first = acquireProfileGuard("codex", ["pstack"], "run", home);
  try {
    expect(() => acquireProfileGuard("codex", ["pstack"], "run", home)).toThrow("profile busy");
    for (const operation of ["setup", "repair", "skills-update", "upgrade", "harness-update"])
      expect(() =>
        acquireProfileGuard(
          "codex",
          profileGuardProfiles(operation, "codex", ["--all"]),
          operation,
          home,
        ),
      ).toThrow("finish that operation");
    const separate = acquireProfileGuard("codex", ["youtube"], "run", home);
    separate.release();
  } finally {
    first.release();
  }
  const next = acquireProfileGuard("codex", ["pstack"], "repair", home);
  next.release();
});

test("stale process identities recover atomically and old release cannot remove a replacement", async () => {
  const home = await tempRoot("profile-guard-stale");
  const first = acquireProfileGuard("codex", ["pstack"], "run", home);
  const db = database(home);
  db.query("UPDATE owners SET started = ?").run("previous process using the same PID");
  const replacement = acquireProfileGuard("codex", ["pstack"], "run", home);
  first.release();
  expect(() => acquireProfileGuard("codex", ["pstack"], "repair", home)).toThrow("profile busy");
  replacement.release();
  expect(db.query("SELECT * FROM owners").all()).toEqual([]);
  db.close();
});

test("live maintenance child retains ownership after the supervising process disappears", async () => {
  const home = await tempRoot("profile-guard-child");
  const guard = acquireProfileGuard("codex", ["pstack"], "run", home);
  const child = spawn("sleep", ["30"]);
  await once(child, "spawn");
  const db = database(home);
  try {
    guard.attachChild(child.pid!);
    db.query("UPDATE owners SET started = ?").run("dead supervisor identity");
    expect(() => acquireProfileGuard("codex", ["pstack"], "run", home)).toThrow("profile busy");
  } finally {
    child.kill();
    await once(child, "exit");
    guard.release();
    db.close();
  }
});

test("operation scope blocks global maintenance but permits shutdown and read-only probes", () => {
  expect(profileGuardProfiles("upgrade", "codex", ["pstack"])).toEqual([
    "pstack",
    "superpowers",
    "youtube",
  ]);
  expect(profileGuardProfiles("upgrade", "codex", ["pstack", "--skills-only"])).toEqual(["pstack"]);
  expect(profileGuardProfiles("setup", "codex", ["--all"])).toEqual([
    "pstack",
    "superpowers",
    "youtube",
  ]);
  expect(profileGuardProfiles("shutdown", "prime", ["default"])).toEqual([]);
  expect(profileGuardProfiles("skills-check", "codex", ["pstack"])).toEqual([]);
  expect(profileGuardProfiles("upgrade", "codex", ["--check"])).toEqual([]);
});

test("upgrade checks need no guard state and remain available during an active session", async () => {
  const home = await tempRoot("profile-guard-check");
  const scopes = profileGuardProfiles("upgrade", "codex", ["pstack", "--check"]);
  acquireProfileGuard("codex", scopes, "upgrade", home).release();
  expect(existsSync(path.join(home, ".local"))).toBe(false);
  const active = acquireProfileGuard("codex", ["pstack"], "run", home);
  try {
    acquireProfileGuard("codex", scopes, "upgrade", home).release();
  } finally {
    active.release();
  }
});

test("failed all-profile maintenance releases every partially acquired preset", async () => {
  const home = await tempRoot("profile-guard-all");
  const active = acquireProfileGuard("codex", ["youtube"], "run", home);
  try {
    expect(() =>
      acquireProfileGuard(
        "codex",
        profileGuardProfiles("repair", "codex", ["--all"]),
        "repair",
        home,
      ),
    ).toThrow("profile busy");
    const independent = acquireProfileGuard("codex", ["pstack"], "run", home);
    independent.release();
  } finally {
    active.release();
  }
});

test("process identities remain stable when timezone and locale change", async () => {
  const home = await tempRoot("profile-guard-timezone");
  const previous = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
  process.env.TZ = "America/New_York";
  process.env.LC_ALL = "C";
  const guard = acquireProfileGuard("codex", ["pstack"], "run", home);
  try {
    process.env.TZ = "Asia/Tokyo";
    process.env.LC_ALL = "en_US.UTF-8";
    expect(() => acquireProfileGuard("codex", ["pstack"], "repair", home)).toThrow("profile busy");
  } finally {
    guard.release();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("surviving maintenance process group retains ownership after its leader exits", async () => {
  const home = await tempRoot("profile-guard-group");
  const guard = acquireProfileGuard("codex", ["pstack"], "setup", home);
  const child = spawn("sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
  await once(child, "spawn");
  guard.attachChild(child.pid!, true);
  // Let the shell start its worker before terminating only the leader.
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.kill("SIGTERM");
  await once(child, "exit");
  try {
    guard.release();
    expect(() => acquireProfileGuard("codex", ["pstack"], "run", home)).toThrow("profile busy");
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
    guard.release();
  }
});

test("attached cancellation retains ownership when a descendant ignores TERM", async () => {
  const home = await tempRoot("profile-guard-survivor");
  const guard = acquireProfileGuard("codex", ["pstack"], "run", home);
  const child = spawn("sh", ["-c", "sh -c 'trap \"\" TERM; sleep 30' & wait"], { stdio: "ignore" });
  await once(child, "spawn");
  guard.attachChild(child.pid!);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const db = database(home);
  try {
    guard.signalTree(child.pid!, "SIGTERM");
    await once(child, "exit");
    guard.release();
    expect(() => acquireProfileGuard("codex", ["pstack"], "repair", home)).toThrow("profile busy");
  } finally {
    const rows = db.query<{ descendants: string }, []>("SELECT descendants FROM owners").all();
    for (const row of rows)
      for (const identity of JSON.parse(row.descendants) as { pid: number }[]) {
        try {
          process.kill(identity.pid, "SIGKILL");
        } catch {}
      }
    child.kill("SIGKILL");
    guard.release();
    db.close();
  }
});

test("escalation kills a recorded orphan after TERM removes its intermediate parent", async () => {
  const home = await tempRoot("profile-guard-orphan-escalation");
  const guard = acquireProfileGuard("omp", ["default"], "run", home);
  const script = path.join(home, "tree.ts");
  const leafFile = path.join(home, "leaf.pid");
  const intermediateExit = path.join(home, "intermediate.exited");
  writeFileSync(script, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const role = process.argv[2];
if (role !== "intermediate") process.on("SIGTERM", () => {});
if (role === "leaf") writeFileSync(${JSON.stringify(leafFile)}, String(process.pid));
else {
  const child = spawn(process.execPath, [import.meta.filename, role === "root" ? "intermediate" : "leaf"], { stdio: "ignore" });
  if (role === "root") child.on("exit", () => writeFileSync(${JSON.stringify(intermediateExit)}, "exited"));
}
setTimeout(() => process.exit(0), 30_000);
`);
  const child = spawn(process.execPath, [script, "root"], { stdio: "ignore" });
  const exited = once(child, "exit");
  let leaf: { pid: number; started: string } | undefined;
  try {
    await once(child, "spawn");
    for (let attempt = 0; attempt < 100 && !existsSync(leafFile); attempt += 1) await Bun.sleep(10);
    expect(existsSync(leafFile)).toBe(true);
    const leafPid = Number(readFileSync(leafFile, "utf8"));
    leaf = { pid: leafPid, started: processStarted(leafPid) };
    guard.attachChild(child.pid!);

    guard.signalTree(child.pid!, "SIGTERM");
    for (let attempt = 0; attempt < 100 && !existsSync(intermediateExit); attempt += 1) await Bun.sleep(10);
    expect(existsSync(intermediateExit)).toBe(true);
    expect(child.signalCode).toBeNull();
    expect(processStarted(leaf.pid)).toBe(leaf.started);
    expect(await guard.waitForTree(child.pid!, 0)).toBe(false);

    guard.signalTree(child.pid!, "SIGKILL");
    expect(await guard.waitForTree(child.pid!, 1_000)).toBe(true);
    await exited;
    guard.release();
    const repair = acquireProfileGuard("omp", ["default"], "repair", home);
    repair.release();
  } finally {
    if (leaf) {
      try {
        if (processStarted(leaf.pid) === leaf.started) process.kill(leaf.pid, "SIGKILL");
      } catch {}
    }
    child.kill("SIGKILL");
    await exited;
    guard.release();
  }
});

test("the first tree signal refuses a root whose stored child start time does not match", async () => {
  const home = await tempRoot("profile-guard-reused-root");
  const guard = acquireProfileGuard("omp", ["default"], "run", home);
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const exited = once(child, "exit");
  const db = database(home);
  try {
    await once(child, "spawn");
    guard.attachChild(child.pid!);
    db.query("UPDATE owners SET child_started = ?").run("previous process using the same PID");

    guard.signalTree(child.pid!, "SIGTERM");
    await Bun.sleep(100);
    expect(child.signalCode).toBeNull();
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    expect(await guard.waitForTree(child.pid!, 0)).toBe(true);
  } finally {
    child.kill("SIGKILL");
    await exited;
    guard.release();
    db.close();
  }
});

test("failed persistent attachment keeps mutation excluded until captured work settles", async () => {
  const home = await tempRoot("profile-guard-attachment-write-failure");
  const guard = acquireProfileGuard("omp", ["default"], "run", home);
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const exited = once(child, "exit");
  const db = database(home);
  db.exec("CREATE TRIGGER reject_owner_updates BEFORE UPDATE ON owners BEGIN SELECT RAISE(FAIL, 'guard attachment failed'); END");
  try {
    await once(child, "spawn");
    expect(() => guard.attachChild(child.pid!)).toThrow("guard attachment failed");
    expect(db.query("SELECT child_pid, child_started FROM owners").get()).toEqual({
      child_pid: null,
      child_started: null,
    });

    guard.release();
    expect(() => {
      const mutation = acquireProfileGuard("omp", ["default"], "repair", home);
      mutation.release();
    }).toThrow("profile busy");
    expect(await guard.waitForTree(child.pid!, 0)).toBe(false);

    guard.signalTree(child.pid!, "SIGTERM");
    expect(await guard.waitForTree(child.pid!, 1_000)).toBe(true);
    await exited;
    guard.release();
    const mutation = acquireProfileGuard("omp", ["default"], "repair", home);
    mutation.release();
    expect(db.query("SELECT * FROM owners").all()).toEqual([]);
  } finally {
    child.kill("SIGKILL");
    await exited;
    guard.release();
    db.close();
  }
});
