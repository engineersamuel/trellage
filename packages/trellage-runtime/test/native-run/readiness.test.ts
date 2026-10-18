import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm, readdir, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inspectHarnessReadiness, inspectProfileReadiness } from "../../src/native-run/readiness.ts"
import { resolveNamedRunProfile } from "../../src/native-run/selection.ts"
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "run-ready-"))
  roots.push(home)
  const bin = path.join(home, "bin")
  await mkdir(bin)
  const binary = path.join(bin, "pi")
  await writeFile(binary, "#!/bin/sh\necho CALLED >&2\nexit 99\n", { mode: 0o755 })
  await writeFile(path.join(bin, "git"), "#!/bin/sh\nexit 99\n", { mode: 0o755 })
  return { home, bin, binary, context: { environment: { HOME: home, PATH: bin }, cwd: home, shippedRoot: home } }
}
const catalog = (prerequisites: Array<{ command: string; install: string }> = []) => ({
  sources: {},
  instructions: {},
  profiles: {
    custom: {
      always: false,
      skills: [],
      instructions: [],
      plugins: [],
      prerequisites,
      repository: { url: "https://example.invalid/repo", branch: "main" },
      current_working_directory: "~/first-run",
    },
  },
})
test("binary inspection does not execute the agent or prepare first-run state", async () => {
  const f = await fixture()
  const before = await readdir(f.home)
  const ready = await inspectHarnessReadiness("pi", f.context)
  expect(ready.status).toBe("ready")
  expect(ready.unverified).toContain("service-reachability")
  const c = catalog()
  const profile = resolveNamedRunProfile(c, c, "pi", "custom")
  expect((await inspectProfileReadiness(profile, ready, f.context)).status).toBe("ready")
  expect(await readdir(f.home)).toEqual(before)
})
test("a missing/nonexecutable binary cannot be ready and an explicit override is authoritative", async () => {
  const f = await fixture()
  await chmod(f.binary, 0o644)
  expect((await inspectHarnessReadiness("pi", f.context)).status).toBe("unavailable")
  await chmod(f.binary, 0o755)
  const ready = await inspectHarnessReadiness("pi", {
    ...f.context,
    environment: { ...f.context.environment, TRELLAGE_PI_BIN: path.join(f.home, "absent") },
  })
  expect(ready.status).toBe("unavailable")
  expect(ready.reasons[0]?.code).toBe("missing-executable")
})
test("missing selected and always-on prerequisite commands exclude only that choice", async () => {
  const f = await fixture()
  const ready = await inspectHarnessReadiness("pi", f.context)
  const c = catalog([{ command: "needed", install: "DO NOT RUN" }])
  const result = await inspectProfileReadiness(resolveNamedRunProfile(c, c, "pi", "custom"), ready, f.context)
  expect(result.status).toBe("unavailable")
  expect(result.reasons).toContainEqual({
    code: "missing-executable",
    message: "Required executable is unavailable: needed",
    prerequisite: "needed",
  })
})
test("missing instruction files are reported before recommending a profile", async () => {
  const f = await fixture()
  const c = catalog()
  const configured = {
    ...c,
    instructions: { rules: { file: "missing.md" } },
    profiles: { custom: { ...c.profiles.custom, instructions: ["rules"] } },
  }
  const profile = resolveNamedRunProfile(configured, configured, "pi", "custom")
  const ready = await inspectHarnessReadiness("pi", f.context)
  expect(
    (await inspectProfileReadiness(profile, ready, f.context)).reasons.some(
      (reason) => reason.code === "missing-config",
    ),
  ).toBe(true)
})

test("Agency does not claim readiness when its required setup and worktree config are absent", async () => {
  const f = await fixture()
  await writeFile(path.join(f.bin, "agency"), "#!/bin/sh\nexit 99\n", { mode: 0o755 })
  const c = catalog()
  const profile = resolveNamedRunProfile(c, c, "agency", "custom")
  const ready = await inspectHarnessReadiness("agency", f.context)
  expect(ready.status).toBe("ready")
  expect(
    (await inspectProfileReadiness(profile, ready, f.context)).reasons.some(
      (reason) => reason.code === "missing-config",
    ),
  ).toBe(true)
})

test("required environment is checked by presence, never exposed", async () => {
  const f = await fixture()
  const c = catalog()
  const profile = {
    ...resolveNamedRunProfile(c, c, "pi", "custom"),
    definition: { ...c.profiles.custom, required_environment: ["PRIVATE_TOKEN"] },
  }
  const ready = await inspectHarnessReadiness("pi", f.context)
  expect(
    (await inspectProfileReadiness(profile, ready, f.context)).reasons.some((x) => x.code === "missing-environment"),
  ).toBe(true)
  const withSecret = { ...f.context, environment: { ...f.context.environment, PRIVATE_TOKEN: "secret-sentinel" } }
  const result = await inspectProfileReadiness(profile, ready, withSecret)
  expect(result.status).toBe("ready")
  expect(JSON.stringify(result)).not.toContain("secret-sentinel")
})
