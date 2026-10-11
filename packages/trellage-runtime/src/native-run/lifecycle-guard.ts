import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lifecycleRuntime } from "./lifecycle-runtime.ts";
import { nativePresetProfiles } from "./presets.ts";
import { descendantsOf, processStart, signalIdentity, type ProcessIdentity } from "./process-tree.ts";

interface Owner {
  scope: string;
  operation: string;
  pid: number;
  started: string;
  child_pid: number | null;
  child_started: string | null;
  token: string;
  descendants: string;
}

type AttachedWork = Pick<Owner, "child_pid" | "child_started" | "descendants">;

const live = (pid: number, started: string): boolean => {
  if (pid === 0) return false;
  // A negative child ID records a detached maintenance process group. Its workers
  // can outlive the group leader, so retain ownership until the entire group exits.
  if (pid < 0) {
    const leader = processStart(-pid);
    if (leader !== null && leader !== started) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  const current = processStart(pid);
  if (current !== null) return current === started;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const childLive = (owner: AttachedWork): boolean =>
  owner.child_pid !== null &&
  owner.child_started !== null &&
  live(owner.child_pid, owner.child_started);

const descendantsLive = (owner: AttachedWork): boolean =>
  (JSON.parse(owner.descendants) as ProcessIdentity[]).some(({ pid, started }) =>
    live(pid, started),
  );

const ownerLive = (owner: Owner): boolean =>
  live(owner.pid, owner.started) || childLive(owner) || descendantsLive(owner);

const ownerHasAttachedLiveWork = (owner: AttachedWork): boolean =>
  childLive(owner) || descendantsLive(owner);

export const profileGuardProfiles = (
  operation: string,
  harness: string,
  args: readonly string[],
): string[] => {
  const runtime = lifecycleRuntime(harness);
  if (!runtime) throw new Error(`unknown managed profile harness: ${harness}`);
  const profiles = nativePresetProfiles(harness);
  // Firstmate's per-instance mutation gate and fleet session lock already protect
  // publication, including workers that outlive their captain. Shared writers use
  // its registry-wide maintenance lease; a preset guard would conflate UUID homes.
  if (harness === "firstmate") return [];
  if (operation === "upgrade" && args.includes("--check")) return [];
  if (
    ![
      "run",
      "setup",
      "repair",
      "reap",
      "doctor",
      "skills-update",
      "upgrade",
      "harness-update",
      "prepare",
      "submit",
      "skill",
    ].includes(operation)
  )
    return [];
  const selected = args.find((arg) => profiles.includes(arg as never));
  // Harness upgrades replace shared executables even when a profile argument is present.
  if (
    args.includes("--all") ||
    args.includes("all") ||
    !selected ||
    operation === "harness-update" ||
    (operation === "upgrade" && !args.includes("--skills-only"))
  )
    return [...profiles].sort();
  return [selected];
};

export interface ProfileGuard {
  readonly attachChild: (pid: number, processGroup?: boolean) => void;
  readonly signalTree: (pid: number, signal: NodeJS.Signals) => void;
  readonly waitForTree: (pid: number, timeout?: number) => Promise<boolean>;
  readonly release: () => void;
}

const ensureOwnersTable = (db: Database): void => {
  db.exec(
    "CREATE TABLE IF NOT EXISTS owners (scope TEXT NOT NULL, operation TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL, child_pid INTEGER, child_started TEXT, token TEXT NOT NULL, descendants TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (scope, token))",
  );
  let columns = db.query<{ name: string; pk: number }, []>("PRAGMA table_info(owners)").all();
  if (!columns.some((column) => column.name === "descendants")) {
    db.exec("ALTER TABLE owners ADD COLUMN descendants TEXT NOT NULL DEFAULT '[]'");
    columns = db.query<{ name: string; pk: number }, []>("PRAGMA table_info(owners)").all();
  }
  if (!columns.some((column) => column.name === "token")) {
    db.exec("ALTER TABLE owners ADD COLUMN token TEXT");
    for (const row of db.query<{ rowid: number }, []>("SELECT rowid FROM owners").all())
      db.query("UPDATE owners SET token = ? WHERE rowid = ?").run(randomUUID(), row.rowid);
    columns = db.query<{ name: string; pk: number }, []>("PRAGMA table_info(owners)").all();
  }
  const scope = columns.find((column) => column.name === "scope");
  const token = columns.find((column) => column.name === "token");
  if (scope?.pk === 1 && token?.pk !== 2) {
    db.exec(
      "CREATE TABLE owners_v2 (scope TEXT NOT NULL, operation TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL, child_pid INTEGER, child_started TEXT, token TEXT NOT NULL, descendants TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (scope, token))",
    );
    db.exec(
      "INSERT INTO owners_v2 (scope, operation, pid, started, child_pid, child_started, token, descendants) SELECT scope, operation, pid, started, child_pid, child_started, token, descendants FROM owners",
    );
    db.exec("DROP TABLE owners");
    db.exec("ALTER TABLE owners_v2 RENAME TO owners");
  }
};

const profileBusy = (harness: string, preset: string, owner: Owner): Error =>
  new Error(
    `profile busy: ${harness} ${preset} is owned by ${owner.operation} (pid ${Math.abs(owner.child_pid ?? owner.pid)}); finish that operation or shut down its session, then retry`,
  );

const acquireScope = (
  db: Database,
  harness: string,
  preset: string,
  runtimeProfile: string,
  operation: string,
  token: string,
  started: string,
  sharedOmpRun: boolean,
): void => {
  const scope = `${harness}/${runtimeProfile}`;
  const owners = db.query<Owner, [string]>("SELECT * FROM owners WHERE scope = ?").all(scope);
  const liveOwners: Owner[] = [];
  for (const owner of owners) {
    if (ownerLive(owner)) liveOwners.push(owner);
    else db.query("DELETE FROM owners WHERE scope = ? AND token = ?").run(scope, owner.token);
  }
  const blockingOwner = sharedOmpRun
    ? liveOwners.find((owner) => owner.operation !== "run")
    : liveOwners[0];
  if (blockingOwner) throw profileBusy(harness, preset, blockingOwner);
  db.query("INSERT INTO owners (scope, operation, pid, started, token) VALUES (?, ?, ?, ?, ?)").run(
    scope,
    operation,
    process.pid,
    started,
    token,
  );
};

const acquireOwners = (
  db: Database,
  harness: string,
  runtime: NonNullable<ReturnType<typeof lifecycleRuntime>>,
  presets: readonly string[],
  operation: string,
  token: string,
  started: string,
): void => {
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureOwnersTable(db);
    const sharedOmpRun = harness === "omp" && operation === "run";
    for (const preset of [...new Set(presets)].sort())
      acquireScope(
        db,
        harness,
        preset,
        runtime.profileName(preset),
        operation,
        token,
        started,
        sharedOmpRun,
      );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

const emptyProfileGuard = (): ProfileGuard => ({
  attachChild: () => {},
  signalTree: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  },
  waitForTree: async () => true,
  release: () => {},
});

const ensureSafeProfileGuardDirectory = (directory: string): void => {
  const status = lstatSync(directory);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o022) !== 0
  )
    throw new Error(`unsafe profile guard directory: ${directory}`);
};

const ensureSafeProfileGuardDatabase = (file: string): void => {
  if (!existsSync(file)) return;
  const status = lstatSync(file);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o022) !== 0
  )
    throw new Error(`unsafe profile guard database: ${file}`);
};

const openProfileGuardDatabase = (home: string): Database => {
  let directory = realpathSync(home);
  for (const component of [".local", "share", "trellage", "profile-guards"]) {
    directory = path.join(directory, component);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    ensureSafeProfileGuardDirectory(directory);
  }
  const file = path.join(directory, "profiles.sqlite");
  ensureSafeProfileGuardDatabase(file);
  const db = new Database(file, { create: true });
  db.exec("PRAGMA busy_timeout = 5000");
  chmodSync(file, 0o600);
  return db;
};

const ownsRoot = (owner: AttachedWork | null, pid: number, started: string): boolean =>
  owner !== null &&
  owner.child_pid !== null &&
  Math.abs(owner.child_pid) === pid &&
  owner.child_started === started;

const rememberOwnedDescendants = (
  db: Database,
  token: string,
  identities: readonly ProcessIdentity[],
  fallback?: AttachedWork,
): void => {
  const descendants = JSON.stringify(identities);
  if (fallback) fallback.descendants = descendants;
  else db.query("UPDATE owners SET descendants = ? WHERE token = ?").run(descendants, token);
};

const signalOwnedTree = (
  db: Database,
  token: string,
  pid: number,
  signal: NodeJS.Signals,
  fallback?: AttachedWork,
): void => {
  const owner =
    fallback ?? db.query<Owner, [string]>("SELECT * FROM owners WHERE token = ? LIMIT 1").get(token);
  const previous = owner ? (JSON.parse(owner.descendants) as ProcessIdentity[]) : [];
  const started = processStart(pid);
  if (started === null || !ownsRoot(owner, pid, started)) {
    for (const identity of [...previous].reverse()) signalIdentity(identity, signal);
    return;
  }
  const stopped = new Map<number, ProcessIdentity>([[pid, { pid, started }]]);
  try {
    signalIdentity({ pid, started }, "SIGSTOP");
    for (;;) {
      const children = descendantsOf(pid, owner!.child_pid! < 0).filter((identity) => !stopped.has(identity.pid));
      if (children.length === 0) break;
      for (const identity of children) {
        stopped.set(identity.pid, identity);
        signalIdentity(identity, "SIGSTOP");
      }
    }
    const identities = new Map(previous.map((identity) => [identity.pid, identity] as const));
    for (const identity of stopped.values()) identities.set(identity.pid, identity);
    rememberOwnedDescendants(db, token, [...identities.values()], fallback);
    for (const identity of [...identities.values()].reverse()) signalIdentity(identity, signal);
  } finally {
    for (const identity of stopped.values()) signalIdentity(identity, "SIGCONT");
  }
};

const waitForOwnedTree = async (
  db: Database,
  token: string,
  timeout?: number,
  fallback?: AttachedWork,
): Promise<boolean> => {
  const deadline = timeout === undefined ? undefined : Date.now() + timeout;
  for (;;) {
    const owners = fallback
      ? [fallback]
      : db.query<Owner, [string]>("SELECT * FROM owners WHERE token = ?").all(token);
    if (!owners.some(ownerHasAttachedLiveWork)) return true;
    if (deadline !== undefined && Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, deadline === undefined ? 10 : deadline - Date.now())));
  }
};

const captureOwnedChild = (
  pid: number,
  processGroup: boolean,
): AttachedWork | undefined => {
  const childStarted = processStart(pid);
  if (childStarted === null && !processGroup) return undefined;
  return {
    child_pid: processGroup ? -pid : pid,
    child_started: childStarted ?? "exited group leader",
    descendants: "[]",
  };
};

const releaseOwnedRows = (db: Database, token: string): void => {
  for (const owner of db
    .query<Owner, [string]>("SELECT * FROM owners WHERE token = ?")
    .all(token)) {
    if (ownerHasAttachedLiveWork(owner))
      db.query("UPDATE owners SET pid = 0, started = '' WHERE scope = ? AND token = ?").run(
        owner.scope,
        token,
      );
    else db.query("DELETE FROM owners WHERE scope = ? AND token = ?").run(owner.scope, token);
  }
};

const createOwnedProfileGuard = (db: Database, token: string): ProfileGuard => {
  let released = false;
  let fallback: AttachedWork | undefined;
  return {
    signalTree: (pid, signal) => signalOwnedTree(db, token, pid, signal, fallback),
    attachChild: (pid, processGroup = false) => {
      fallback = captureOwnedChild(pid, processGroup);
      if (!fallback) return;
      fallback.descendants = JSON.stringify(descendantsOf(pid, processGroup));
      db.query("UPDATE owners SET child_pid = ?, child_started = ?, descendants = ? WHERE token = ?").run(
        fallback.child_pid,
        fallback.child_started,
        fallback.descendants,
        token,
      );
      fallback = undefined;
    },
    waitForTree: async (_pid, timeout) => waitForOwnedTree(db, token, timeout, fallback),
    release: () => {
      if (released || (fallback && ownerHasAttachedLiveWork(fallback))) return;
      released = true;
      try {
        releaseOwnedRows(db, token);
      } finally {
        db.close();
      }
    },
  };
};

/** Lifecycle mutations publish into persistent homes; OMP steady-state runs are the shared exception. */
export const acquireProfileGuard = (
  harness: string,
  presets: readonly string[],
  operation: string,
  home = process.env.HOME ?? os.homedir(),
): ProfileGuard => {
  if (presets.length === 0) return emptyProfileGuard();
  const runtime = lifecycleRuntime(harness);
  const profiles = nativePresetProfiles(harness);
  if (!runtime || presets.some((preset) => !profiles.includes(preset as never)))
    throw new Error("invalid profile guard scope");
  const db = openProfileGuardDatabase(home);
  const token = randomUUID();
  const started = processStart(process.pid);
  try {
    if (started === null) throw new Error("cannot determine profile guard process identity");
    acquireOwners(db, harness, runtime, presets, operation, token, started);
    return createOwnedProfileGuard(db, token);
  } catch (error) {
    db.close();
    throw error;
  }
};
