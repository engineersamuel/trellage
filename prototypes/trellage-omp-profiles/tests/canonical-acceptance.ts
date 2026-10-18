import assert from "node:assert/strict"
import { Database } from "bun:sqlite"
import { readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { createProcessLifecycle, POSIX_ALARM_SCRIPT } from "../../../packages/trellage-runtime/test/native-run/process-lifecycle.ts"

const [fixture, executable] = process.argv.slice(2)
assert(fixture && executable, "canonical acceptance requires fixture and host executable paths")
const home = process.env.HOME!
const sourceRuntime = path.resolve(import.meta.dir, "..")
const sourceEntries = await readdir(sourceRuntime)
const router = path.resolve(import.meta.dir, "../../trellage-router/bin/trx")
const config = path.join(fixture, "canonical-config.toml")
const original = await readFile(executable, "utf8")
const publishVersion = (version: string) => writeFile(executable, original.replaceAll("18.0.11", version))
const catalog = await readFile(path.resolve(import.meta.dir, "../../../config.example.toml"), "utf8")
await writeFile(config, catalog.slice(0, catalog.indexOf("[native.")) + "[native.sources]\n[native.profiles]\n", { mode: 0o600 })
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  TRELLAGE_CONFIG: config,
  TRELLAGE_TRX_SOURCE_ROOT: path.dirname(path.dirname(router)),
  TRELLAGE_TRX_NATIVE_SOURCE: "1",
  HERDR_ENV: "0",
  COPILOT_GITHUB_TOKEN: "host-copilot-token",
  TRELLAGE_TEST_ALARM_SECONDS: "30",
}
delete environment.TRELLAGE_OMP_LIFECYCLE_BIN
const lifecycle = createProcessLifecycle({ settleDeadline: 35_000 })
const invoke = (args: string[], extra: NodeJS.ProcessEnv = {}) => lifecycle.spawn("perl", [
  "-e", POSIX_ALARM_SCRIPT, router, ...args,
], { env: { ...environment, ...extra }, stdio: ["ignore", "pipe", "pipe"] })
const waitFor = async (condition: () => Promise<boolean>, label: string) => {
  const deadline = Date.now() + 12_000
  while (!(await condition())) {
    assert(Date.now() < deadline, label)
    await Bun.sleep(10)
  }
}
const firstReady = path.join(fixture, "canonical-first.pid")
const secondReady = path.join(fixture, "canonical-second.pid")
const firstRelease = path.join(fixture, "canonical-first.release")
const secondRelease = path.join(fixture, "canonical-second.release")
let db: Database | undefined
try {
  await publishVersion("18.8.5")
  const first = invoke(["run", "omp", "default"], {
    FAKE_OMP_RUN_READY_FILE: firstReady, FAKE_OMP_RUN_RELEASE_FILE: firstRelease,
  })
  const second = invoke(["run", "omp"], {
    FAKE_OMP_RUN_READY_FILE: secondReady, FAKE_OMP_RUN_RELEASE_FILE: secondRelease,
  })
  await waitFor(async () => {
    for (const process of [first, second]) {
      if (process.closed) {
        const result = await process.settled
        assert.fail(`canonical run closed before release: ${result.code}\n${result.stdout}\n${result.stderr}`)
      }
    }
    return await Bun.file(firstReady).exists() && await Bun.file(secondReady).exists()
  },
    "two literal trx run omp default processes did not reach their host children")
  const pids = [Number(await readFile(firstReady, "utf8")), Number(await readFile(secondReady, "utf8"))].sort((a, b) => a - b)
  assert.notEqual(pids[0], pids[1], "two runs must have distinct host children")
  db = new Database(path.join(home, ".local/share/trellage/profile-guards/profiles.sqlite"))
  const owners = () => db!.query<{ child_pid: number }, []>(
    "SELECT child_pid FROM owners WHERE scope = 'omp/copilot' AND operation = 'run' ORDER BY child_pid",
  ).all().map(({ child_pid }) => child_pid)
  await waitFor(async () => JSON.stringify(owners()) === JSON.stringify(pids),
    "guard child_pid must equal each actual host executable PID")
  assert.equal(first.closed, false)
  assert.equal(second.closed, false)
  const blocked = await invoke(["repair", "omp", "default"]).settled
  assert.equal(blocked.code, 1)
  assert.match(blocked.stderr, /profile busy: omp default/)
  await writeFile(firstRelease, "release")
  assert.equal((await first.settled).code, 0)
  assert.deepEqual(owners(), [Number(await readFile(secondReady, "utf8"))])
  const stillBlocked = await invoke(["repair", "omp", "default"]).settled
  assert.equal(stillBlocked.code, 1)
  assert.match(stillBlocked.stderr, /profile busy: omp default/)
  await writeFile(secondRelease, "release")
  assert.equal((await second.settled).code, 0)
  assert.deepEqual(owners(), [])
  const repaired = await invoke(["repair", "omp", "default"]).settled
  assert.equal(repaired.code, 0, repaired.stderr)
  console.log("OMP literal canonical concurrency, exact child attachment, and mutation exclusion: PASS")

  const firstConfig = path.join(fixture, "canonical-first.yml")
  const secondConfig = path.join(fixture, "canonical-second.yml")
  const explicitConfig = path.join(fixture, "canonical-explicit.yml")
  const overlayLog = path.join(fixture, "canonical-overlays.jsonl")
  await writeFile(firstConfig, "modelRoles:\n  default: user/first\nask:\n  enabled: first\n")
  await writeFile(secondConfig, "modelRoles:\n  default: user/second\nask:\n  enabled: second\n")
  await writeFile(explicitConfig, "modelRoles:\n  default: user/explicit\ntools:\n  approvalMode: ask\n")
  const managed = path.join(home, ".local/share/trellage/omp/overlays/copilot.yml")
  const inherited = `${firstConfig}:${secondConfig}`
  const configured = await invoke(["run", "omp", "default", "--", "--config", explicitConfig], {
    PI_CONFIG_FILES: inherited, FAKE_OMP_OVERLAY_LOG: overlayLog,
  }).settled
  assert.equal(configured.code, 0, configured.stderr)
  const applied = JSON.parse((await readFile(overlayLog, "utf8")).trim())
  assert.equal(applied.configFiles, `${inherited}:${managed}`)
  assert.equal(applied.askEnabled, "second")
  assert.equal(applied.defaultModel, "user/explicit")
  assert.equal(applied.approvalModeYolo, false)
  console.log("OMP literal canonical inherited and explicit configuration precedence: PASS")

  for (const version of ["18.8.4", "18.8.6"]) {
    await publishVersion(version)
    const logBefore = await readFile(process.env.FAKE_OMP_LOG!, "utf8")
    const rejected = await invoke(["run", "omp", "default", "--", "--headless-policy", "no-user-input"]).settled
    assert.equal(rejected.code, 1, rejected.stderr)
    assert.match(rejected.stderr, new RegExp(`verified only for OMP 18\\.8\\.5; installed version is ${version.replaceAll(".", "\\.")}`))
    assert.equal(await readFile(process.env.FAKE_OMP_LOG!, "utf8"), logBefore,
      `unverified OMP ${version} launched a host child`)
  }
  console.log("OMP literal canonical headless rejection at 18.8.4 and 18.8.6: PASS")
  assert.deepEqual(await readdir(sourceRuntime), sourceEntries, "source launches wrote runtime files into the worktree")
} finally {
  await writeFile(firstRelease, "release")
  await writeFile(secondRelease, "release")
  await lifecycle.cleanup()
  db?.close()
  await writeFile(executable, original)
}
