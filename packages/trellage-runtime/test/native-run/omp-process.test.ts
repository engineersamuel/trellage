import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { ompAdapter } from "../../src/native-run/adapters.ts"
import { acquireProfileGuard } from "../../src/native-run/lifecycle-guard.ts"
import { prepareRun } from "../../src/native-run/run.ts"
import { cleanupFixtures, fixturePaths, git, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)

const waitForFile = async (file: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(10)
  }
  throw new Error(`fixture did not publish ${file}`)
}

const admissionFixture = async (mode: "orphan" | "cancel") => {
  const root = await tempRoot("omp-admission-process")
  const ready = path.join(root, "ready")
  const leafDone = path.join(root, "leaf.done")
  const late = path.join(root, "late")
  const lifecycle = path.join(root, "admission")
  await writeFile(lifecycle, `#!${process.execPath}
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
if (process.argv[2] === "leaf") {
  process.on("SIGTERM", () => {});
  writeFileSync(${JSON.stringify(ready)}, String(process.pid));
  setTimeout(() => {
    writeFileSync(${JSON.stringify(late)}, "late admission write");
    writeFileSync(${JSON.stringify(leafDone)}, "done");
    process.exit(0);
  }, 3_500);
} else {
  process.on("SIGTERM", () => process.exit(143));
  spawn(process.execPath, [import.meta.filename, "leaf"], { stdio: ${JSON.stringify(mode === "orphan" ? "ignore" : "inherit")} });
  while (!existsSync(${JSON.stringify(ready)})) await Bun.sleep(5);
  ${mode === "orphan" ? 'process.stdout.write("invalid admission JSON\\n"); process.exit(0);' : 'setTimeout(() => process.exit(0), 4_000);'}
}
`, { mode: 0o755 })
  const config = path.join(root, "config.toml")
  await writeFile(config, "schema_version = 1\n[native.sources]\n[native.profiles]\n")
  const environment = {
    HOME: root,
    PATH: process.env.PATH ?? "",
    TRELLAGE_CONFIG: config,
    TRELLAGE_OMP_LIFECYCLE_BIN: lifecycle,
  }
  const prepared = await prepareRun({
    harness: "omp", profiles: ["default"], forwardedArgs: [], dryRun: false,
    allowUnprovenIsolation: true, noAlways: true,
  }, { environment, paths: await fixturePaths(root), cwd: root })
  const guard = acquireProfileGuard("omp", ["default"], "run", root)
  let admissionPid: number | undefined
  const signals: NodeJS.Signals[] = []
  const admission = ompAdapter.resolveLaunch!({
    layout: prepared.layout, plan: prepared.plan, resumeArgs: [], forwardedArgs: [],
    environment, workspace: root,
    guard: {
      ...guard,
      attachChild: (pid, grouped) => {
        admissionPid = pid
        guard.attachChild(pid, grouped)
      },
      signalTree: (pid, signal) => {
        signals.push(signal)
        guard.signalTree(pid, signal)
      },
    },
  }, prepared.launch)
  const outcome = admission.then(() => "unexpected success", (error) => String(error))
  let released = false
  return {
    root, ready, late, guard, outcome, signals,
    release: () => { guard.release(); released = true },
    cleanup: async () => {
      if (!released && admissionPid !== undefined) {
        guard.signalTree(admissionPid, "SIGKILL")
        await guard.waitForTree(admissionPid, 1_000)
      }
      await outcome
      // Every leaf expires itself; failed regression runs never signal a saved PID.
      await Bun.sleep(3_600)
      if (!released) guard.release()
    },
  }
}

test("OMP admission settles a descendant whose root exited before the first cleanup signal", async () => {
  const fixture = await admissionFixture("orphan")
  try {
    await waitForFile(fixture.ready)
    expect(await fixture.outcome).toContain("invalid JSON")
    fixture.release()
    const mutation = acquireProfileGuard("omp", ["default"], "repair", fixture.root)
    mutation.release()
    await Bun.sleep(3_600)
    expect(await Bun.file(fixture.late).exists()).toBe(false)
  } finally {
    await fixture.cleanup()
  }
}, 12_000)

test("OMP cancellation escalates while a TERM-ignoring descendant holds admission stdout", async () => {
  const fixture = await admissionFixture("cancel")
  try {
    await waitForFile(fixture.ready)
    const started = Date.now()
    process.emit("SIGTERM")
    expect(await Promise.race([fixture.outcome, Bun.sleep(2_700).then(() => "still waiting")]))
      .toContain("OMP admission failed")
    expect(Date.now() - started).toBeLessThan(2_700)
    expect(await Bun.file(fixture.late).exists()).toBe(false)
  } finally {
    await fixture.cleanup()
  }
}, 12_000)

test.each(["SIGINT", "SIGHUP"] as const)("OMP forwards %s before bounded cancellation cleanup", async (signal) => {
  const fixture = await admissionFixture("cancel")
  try {
    await waitForFile(fixture.ready)
    process.emit(signal)
    expect(await fixture.outcome).toContain("OMP admission failed")
    expect(fixture.signals[0]).toBe(signal)
  } finally {
    await fixture.cleanup()
  }
}, 12_000)

test.each([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const)(
  "OMP main preserves %s exit status after admission cleanup",
  async (signal, status) => {
    const root = await tempRoot("omp-cancellation-status")
    await git(root, "init", "-q")
    const ready = path.join(root, "ready")
    const lifecycle = path.join(root, "admission")
    const config = path.join(root, "config.toml")
    const driver = path.join(root, "driver.ts")
    await writeFile(config, "schema_version = 1\n[native.sources]\n[native.profiles]\n")
    await writeFile(lifecycle, `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(ready)}, "ready");
setTimeout(() => process.exit(0), 4_000);
`, { mode: 0o755 })
    const runModule = new URL("../../src/native-run/run.ts", import.meta.url).href
    await writeFile(driver, `
import { main } from ${JSON.stringify(runModule)};
const result = main(["omp", "default", "--no-always"]);
const deadline = Date.now() + 2_000;
while (!(await Bun.file(${JSON.stringify(ready)}).exists())) {
  if (Date.now() >= deadline) throw new Error("admission did not become ready");
  await Bun.sleep(10);
}
process.emit(${JSON.stringify(signal)});
process.exitCode = await result;
`)
    const child = spawn(process.execPath, [driver], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "", HOME: root, TRELLAGE_CONFIG: config,
        TRELLAGE_OMP_LIFECYCLE_BIN: lifecycle, XDG_STATE_HOME: path.join(root, "state"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout!.resume()
    let stderr = ""
    child.stderr!.on("data", (chunk) => { stderr += String(chunk) })
    const [code] = await once(child, "close")
    expect(stderr).toContain(`cancelled by ${signal}`)
    expect(code).toBe(status)
    const db = new Database(path.join(root, ".local/share/trellage/profile-guards/profiles.sqlite"))
    try {
      expect(db.query("SELECT * FROM owners").all()).toEqual([])
    } finally {
      db.close()
    }
    const leases = await readdir(path.join(root, "state/trellage/native-run/leases"), { recursive: true })
    expect(leases.filter((name) => name.endsWith(".json"))).toEqual([])
  },
  8_000,
)

test("final host-child attachment failure rejects only after the real child settles", async () => {
  const root = await tempRoot("omp-final-child-attachment")
  const result = path.join(root, "result.json")
  const driver = path.join(root, "driver.ts")
  const runModule = new URL("../../src/native-run/run.ts", import.meta.url).href
  const guardModule = new URL("../../src/native-run/lifecycle-guard.ts", import.meta.url).href
  await writeFile(driver, `
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { spawnInherited } from ${JSON.stringify(runModule)};
import { acquireProfileGuard } from ${JSON.stringify(guardModule)};
const guard = acquireProfileGuard("omp", ["default"], "run", ${JSON.stringify(root)});
const db = new Database(${JSON.stringify(path.join(root, ".local/share/trellage/profile-guards/profiles.sqlite"))});
db.exec("CREATE TRIGGER reject_attachment BEFORE UPDATE ON owners BEGIN SELECT RAISE(FAIL, 'final child attachment failed'); END");
try {
  await spawnInherited({ command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 3500)"], env: {} },
    process.env, ${JSON.stringify(root)}, (pid) => guard.attachChild(pid!), guard);
  throw new Error("unexpected launch success");
} catch (error) {
  const settled = await guard.waitForTree(0, 0);
  guard.release();
  writeFileSync(${JSON.stringify(result)}, JSON.stringify({ error: String(error), settled, rows: db.query("SELECT * FROM owners").all() }));
}
db.close();
`)
  const child = spawn(process.execPath, [driver], { stdio: ["ignore", "pipe", "pipe"] })
  let stderr = ""
  child.stderr!.on("data", (chunk) => { stderr += String(chunk) })
  const [code] = await once(child, "close")
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(await readFile(result, "utf8"))).toEqual({
    error: expect.stringContaining("final child attachment failed"), settled: true, rows: [],
  })
}, 8_000)
