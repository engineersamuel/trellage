import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { syncSnapshot, verifyTarget } from "../../../scripts/floating-skills.mjs"
import { manageManualSkill } from "../manual-skills.mjs"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
const managerPath = path.join(repository, "scripts/floating-skills.mjs")
const catalogPath = path.join(repository, "skills.json")
const skill = "i-have-adhd"
const policy = "policy:\n  allow_implicit_invocation: false\n"
const instructions = (version) =>
  `---\nname: ${skill}\ndisable-model-invocation: true\n---\n\nManual fixture ${version}.\n`

const write = async (file, content) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, content, { mode: 0o600 })
}

const seedSnapshot = async (cache, version = 1, includeManual = true) => {
  await rm(cache, { recursive: true, force: true })
  await write(path.join(cache, "skills/fixture/SKILL.md"), "# Ordinary fixture\n")
  const names = ["fixture"]
  if (includeManual) {
    names.push(skill)
    await write(path.join(cache, "skills", skill, "SKILL.md"), instructions(version))
    await write(path.join(cache, "skills", skill, "agents/openai.yaml"), policy)
  }
  await write(path.join(cache, "managed-skills.txt"), `${names.join("\n")}\n`)
  await write(path.join(cache, "always-on.md"), "")
}

const fixtureFor = async (context, includeManual = true) => {
  const root = path.join(repository, `.manual-skills-contract-${randomUUID()}`)
  await mkdir(path.join(root, "profile/home"), { recursive: true, mode: 0o700 })
  context.after(() => rm(root, { recursive: true, force: true }))
  const options = {
    managerPath,
    catalogPath,
    cache: path.join(root, "cache/skills"),
    library: path.join(root, "profile/skill-library"),
    target: path.join(root, "profile/home/skills"),
    skill,
  }
  await seedSnapshot(options.cache, 1, includeManual)
  return { root, options, run: (command) => manageManualSkill({ ...options, command }) }
}

test("manual skill stays outside discovery while ordinary skills and metadata remain intact", async (context) => {
  const { options, run } = await fixtureFor(context)
  await run("ensure")
  assert.deepEqual(await verifyTarget(options.cache, options.library), ["fixture", skill])
  assert.deepEqual(await verifyTarget(options.cache, options.target, [skill]), ["fixture"])
  await assert.rejects(lstat(path.join(options.target, skill)), { code: "ENOENT" })
  assert.equal(await readFile(path.join(options.library, skill, "agents/openai.yaml"), "utf8"), policy)
  assert.equal(await run("prompt"), instructions(1))
  await run("ensure")
  await run("verify")
  await assert.rejects(syncSnapshot(options.cache, options.target, ["../outside"]), /unsafe excluded/)
})

test("managed copies migrate out of discovery without changing custom skills or notes", async (context) => {
  const { options, run } = await fixtureFor(context)
  await syncSnapshot(options.cache, options.target)
  await write(path.join(options.target, "custom/SKILL.md"), "# User skill\n")
  await write(path.join(options.target, "notes.md"), "User notes\n")
  await run("ensure")
  await assert.rejects(lstat(path.join(options.target, skill)), { code: "ENOENT" })
  assert.equal(await readFile(path.join(options.target, "custom/SKILL.md"), "utf8"), "# User skill\n")
  assert.equal(await readFile(path.join(options.target, "notes.md"), "utf8"), "User notes\n")
})

test("unmanaged manual-skill collisions fail before changing either deployed copy", async (context) => {
  const { options, run } = await fixtureFor(context)
  await run("ensure")
  await seedSnapshot(options.cache, 2)
  await write(path.join(options.target, skill, "SKILL.md"), "User-owned skill\n")
  await assert.rejects(run("sync"), /excluded skill remains discoverable/)
  assert.equal(await readFile(path.join(options.library, skill, "SKILL.md"), "utf8"), instructions(1))
  assert.equal(await readFile(path.join(options.target, skill, "SKILL.md"), "utf8"), "User-owned skill\n")
  await assert.rejects(run("verify"), /managed skill differs|excluded skill remains discoverable/)
})

test("cache-only refresh adds and removes the manual skill without exposing it", async (context) => {
  const { options, run } = await fixtureFor(context, false)
  await run("ensure")
  await assert.rejects(run("prompt"), /not cached; run trx skills update/)
  await seedSnapshot(options.cache, 2)
  await run("sync")
  assert.equal(await run("prompt"), instructions(2))
  await assert.rejects(lstat(path.join(options.target, skill)), { code: "ENOENT" })
  await seedSnapshot(options.cache, 3, false)
  await run("sync")
  await assert.rejects(run("prompt"), /not cached; run trx skills update/)
  await assert.rejects(lstat(path.join(options.library, skill)), { code: "ENOENT" })
})

test("manual library rejects discovery-visible paths and symlinked destinations", async (context) => {
  const { root, options } = await fixtureFor(context)
  await assert.rejects(manageManualSkill({
    ...options, command: "ensure", library: path.join(root, "profile/home/library"),
  }), /outside the harness home/)
  const outside = path.join(root, "outside")
  await mkdir(outside, { mode: 0o700 })
  await write(path.join(outside, "sentinel"), "untouched\n")
  await symlink(outside, options.library)
  await assert.rejects(manageManualSkill({ ...options, command: "ensure" }), /symlink/)
  assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "untouched\n")
})

test("fresh checks detect manual-only updates without changing cache or deployed copies", async (context) => {
  const { root, options, run } = await fixtureFor(context)
  await run("ensure")
  const fresh = path.join(root, "fresh")
  await seedSnapshot(fresh)
  const fakeManager = path.join(root, "manager.mjs")
  await write(fakeManager, `
export * from ${JSON.stringify(pathToFileURL(managerPath).href)};
import { cp } from "node:fs/promises";
export const stageLatest = async ({ destination }) =>
  cp(${JSON.stringify(fresh)}, destination, { recursive: true });
`)
  const check = () => manageManualSkill({ ...options, managerPath: fakeManager, command: "fresh" })
  assert.deepEqual(await check(), { kind: "current" })
  await seedSnapshot(fresh, 2)
  assert.deepEqual(await check(), { kind: "available" })
  assert.equal(await readFile(path.join(options.cache, "skills", skill, "SKILL.md"), "utf8"), instructions(1))
  assert.equal(await run("prompt"), instructions(1))
  await assert.rejects(lstat(path.join(options.target, skill)), { code: "ENOENT" })
})

test("first-use cancellation is not swallowed by the fresh-check signal handler", async (context) => {
  const { root, options } = await fixtureFor(context)
  const fakeManager = path.join(root, "manager.mjs")
  await write(fakeManager, `
export * from ${JSON.stringify(pathToFileURL(managerPath).href)};
export const ensureNative = async () => {
  process.stdout.write("ensure-started\\n");
  await new Promise(() => setInterval(() => {}, 1000));
};
`)
  const child = spawn(process.execPath, [
    path.join(repository, "prototypes/trellage-claude-common/manual-skills.mjs"),
    fakeManager, "ensure", catalogPath, options.cache, options.library, options.target, skill,
  ], { stdio: ["ignore", "pipe", "pipe"] })
  const closed = once(child, "close")
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
  try {
    await Promise.race([
      once(child.stdout, "data"),
      closed.then(() => { throw new Error("Manual helper exited before starting") }),
    ])
    child.kill("SIGTERM")
    const [code, signal] = await closed
    assert.equal(code, null)
    assert.equal(signal, "SIGTERM")
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }
})
