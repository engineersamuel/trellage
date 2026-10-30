import { afterEach, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { NativeCatalog } from "../../packages/trellage-runtime/src/native-config.ts"
import { compositionIdOf, planComposition } from "../../packages/trellage-runtime/src/native-run/compose.ts"
import { digestDirectory } from "../../packages/trellage-runtime/src/native-run/source.ts"
import { currentSnapshot, manifestFor, publishSnapshot, resolveAsset } from "./snapshot.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nodecode-snapshot-spike-"))
  roots.push(root)
  const source = path.join(root, "verified-source")
  const owner = path.join(root, "composition")
  for (const [name, manual] of [
    ["office", false],
    ["common", false],
    ["i-have-adhd", true],
    ["unselected", false],
  ] as const) {
    const directory = path.join(source, "skills", name)
    await mkdir(path.join(directory, "assets"), { recursive: true })
    await writeFile(
      path.join(directory, "SKILL.md"),
      `---\nname: ${name}\n${manual ? "disable-model-invocation: true\n" : ""}---\n${name} fixture. See assets/large.txt.\n`,
    )
    await writeFile(path.join(directory, "assets", "large.txt"), "asset fixture\n".repeat(9000))
    await writeFile(path.join(directory, "assets", "script.sh"), "#!/bin/sh\nexit 93\n")
    await chmod(path.join(directory, "assets", "script.sh"), 0o755)
  }
  const catalog: NativeCatalog = {
    sources: { fixture: { repository: "example/fixture" } },
    instructions: { rules: { file: "rules.md" } },
    profiles: {
      office: {
        always: false,
        instructions: ["rules"],
        plugins: [],
        skills: [{ source: "fixture", names: ["office"] }],
      },
      common: {
        always: true,
        instructions: [],
        plugins: [],
        skills: [{ source: "fixture", names: ["common", "i-have-adhd"] }],
      },
      wrongHarness: {
        always: true,
        harnesses: ["claude"],
        instructions: [],
        plugins: [],
        skills: [{ source: "fixture", names: ["unselected"] }],
      },
    },
  }
  const plan = (skipAlways = false) =>
    planComposition(
      {
        harness: "nodecode",
        profiles: ["office"],
        catalog,
        adapterPolicy: "spike-1",
        providerPolicy: "offline",
        instructionTexts: { rules: "COMPOSED-INSTRUCTION-FIXTURE" },
        skipAlways,
      },
      {
        resolver: {
          resolve: async (sourceId, policy) => ({
            sourceId,
            repository: policy.repository,
            selector: { kind: "default" },
            commit: "a".repeat(40),
            directory: source,
            digest: await digestDirectory(source),
          }),
          markGood: async () => {},
        },
      },
    )
  return { root, owner, source, plan }
}

test("canonical selection preserves policy/provenance and excludes manual and unselected skills from discovery", async () => {
  const f = await fixture()
  const plan = await f.plan()
  expect(plan.alwaysProfiles).toEqual(["common"])
  expect(plan.skills.find((skill) => skill.name === "i-have-adhd")?.manualOnly).toBe(true)
  const snapshot = await publishSnapshot(f.owner, plan)
  expect(snapshot.manifest.skills.map((skill) => skill.name)).toEqual(["common", "i-have-adhd", "office"])
  const index = await readFile(path.join(snapshot.directory, "ordinary.json"), "utf8")
  expect(JSON.parse(index).map((skill: { name: string }) => skill.name)).toEqual(["common", "office"])
  expect(index).not.toContain("i-have-adhd")
  expect(index).not.toContain("unselected")
  expect(snapshot.manifest.skills[0]!.sourceId).toBe("fixture")
  expect(snapshot.manifest.sources[0]!.selector).toEqual({ kind: "default" })
  expect(await readFile(await resolveAsset(snapshot.directory, "i-have-adhd", "SKILL.md"), "utf8")).toContain(
    "disable-model-invocation: true",
  )
  expect(await readFile(path.join(snapshot.directory, "instructions.md"), "utf8")).toContain(
    "COMPOSED-INSTRUCTION-FIXTURE",
  )
})

test("no-always reconciles the same home while retaining learning and pinned in-flight assets", async () => {
  const f = await fixture()
  const home = path.join(f.owner, "state", "home")
  await mkdir(home, { recursive: true })
  for (const name of ["user-knowledge.lisp", "layer.lisp", "conversation.db"])
    await writeFile(path.join(home, name), `untouched ${name}`)
  const before = await digestDirectory(home)
  const full = await f.plan()
  const first = await publishSnapshot(f.owner, full)
  const reduced = await f.plan(true)
  expect(reduced.compositionId).toBe(full.compositionId)
  const second = await publishSnapshot(f.owner, reduced)
  expect(second.id).not.toBe(first.id)
  expect(await currentSnapshot(f.owner)).toBe(second.directory)
  expect(second.manifest.skills.map((skill) => skill.name)).toEqual(["office"])
  expect(await digestDirectory(home)).toBe(before)
  await expect(resolveAsset(second.directory, "i-have-adhd", "SKILL.md")).rejects.toThrow("Unknown")
  expect(await readFile(await resolveAsset(first.directory, "common", "SKILL.md"), "utf8")).toContain("common fixture")
  const back = await publishSnapshot(f.owner, full)
  expect(back.directory).toBe(first.directory)
  expect(await readdir(path.dirname(first.directory))).toHaveLength(2)
})

test("full assets and executable mode survive source and generation deletion; nothing executes", async () => {
  const f = await fixture()
  const snapshot = await publishSnapshot(f.owner, await f.plan())
  await mkdir(path.join(f.owner, "generations", "old"), { recursive: true })
  await rm(path.join(f.owner, "generations"), { recursive: true })
  await rm(f.source, { recursive: true })
  expect((await readFile(await resolveAsset(snapshot.directory, "office", "assets/large.txt"))).length).toBeGreaterThan(
    8192,
  )
  expect((await lstat(await resolveAsset(snapshot.directory, "office", "assets/script.sh"))).mode & 0o111).not.toBe(0)
})

test("failed validation or prepublication failure preserves the previous selection", async () => {
  const f = await fixture()
  const plan = await f.plan()
  const first = await publishSnapshot(f.owner, plan)
  await expect(
    publishSnapshot(f.owner, await f.plan(true), {
      beforePublish: async () => {
        throw new Error("injected failure")
      },
    }),
  ).rejects.toThrow("injected failure")
  expect(await currentSnapshot(f.owner)).toBe(first.directory)
  await writeFile(path.join(f.source, "skills", "office", "SKILL.md"), "changed after validation")
  await expect(publishSnapshot(f.owner, plan)).rejects.toThrow("digest mismatch")
  expect(await currentSnapshot(f.owner)).toBe(first.directory)
  const refreshed = await publishSnapshot(f.owner, await f.plan())
  expect(refreshed.id).not.toBe(first.id)
  expect(await readFile(await resolveAsset(refreshed.directory, "office", "SKILL.md"), "utf8")).toBe(
    "changed after validation",
  )
})

test("unsafe paths, symbolic links, duplicate names, plugins and conflicting invocation policies fail closed", async () => {
  const f = await fixture()
  const plan = await f.plan()
  const skill = plan.skills[0]!
  expect(() => manifestFor({ ...plan, skills: [{ ...skill, name: "../escape" }] })).toThrow("Unsafe")
  expect(() => manifestFor({ ...plan, skills: [skill, skill] })).toThrow("Duplicate")
  expect(() => manifestFor({ ...plan, skills: [{ ...skill, manualOnly: true, alwaysOn: true }] })).toThrow(
    "Conflicting",
  )
  expect(() =>
    manifestFor({
      ...plan,
      plugins: [{ ...skill, source: "fixture", harness: "nodecode", path: "plugin" }],
    }),
  ).toThrow("plugins")
  const snapshot = await publishSnapshot(f.owner, plan)
  await expect(resolveAsset(snapshot.directory, "office", "../common/SKILL.md")).rejects.toThrow("Unsafe")
  await expect(resolveAsset(snapshot.directory, "office", "/etc/passwd")).rejects.toThrow("Unsafe")
  const outside = path.join(f.root, "outside.txt")
  await writeFile(outside, "outside")
  await symlink(outside, path.join(snapshot.directory, "ordinary", "office", "assets", "escape"))
  await expect(resolveAsset(snapshot.directory, "office", "assets/escape")).rejects.toThrow("escapes")
  await expect(publishSnapshot(f.owner, plan)).rejects.toThrow("symbolic link")
  await symlink(outside, path.join(f.source, "skills", "office", "unsafe"))
  await expect(f.plan()).rejects.toThrow("symbolic link")
})

test("concurrent publication fails closed and leaves the winner coherent", async () => {
  const f = await fixture()
  const plan = await f.plan()
  const reduced = await f.plan(true)
  let entered!: () => void
  let release!: () => void
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = publishSnapshot(f.owner, plan, {
    beforePublish: async () => {
      entered()
      await releasePromise
    },
  })
  await enteredPromise
  try {
    await expect(publishSnapshot(f.owner, reduced)).rejects.toThrow("EEXIST")
  } finally {
    release()
  }
  const winner = await first
  expect(await currentSnapshot(f.owner)).toBe(winner.directory)
  expect(await readdir(path.dirname(path.dirname(winner.directory)))).toEqual(
    expect.arrayContaining(["snapshots", "current"]),
  )
  expect((await readdir(path.dirname(path.dirname(winner.directory)))).some((name) => name.startsWith("."))).toBe(false)
})

test("identity retains documented stack semantics, not workspace or model isolation", () => {
  expect(compositionIdOf("nodecode", ["office", "common", "office"])).toBe(
    compositionIdOf("nodecode", ["common", "office"]),
  )
  expect(compositionIdOf("nodecode", [])).not.toBe(compositionIdOf("nodecode", ["default"]))
})

test("canonical manual metadata applies to arbitrary names, not only the common special case", async () => {
  const f = await fixture()
  await writeFile(
    path.join(f.source, "skills", "office", "SKILL.md"),
    "---\nname: office\ndisable-model-invocation: true\n---\nManual office fixture.\n",
  )
  const plan = await f.plan()
  expect(plan.skills.find((skill) => skill.name === "office")?.manualOnly).toBe(true)
  const snapshot = await publishSnapshot(f.owner, plan)
  expect(snapshot.manifest.skills.find((skill) => skill.name === "office")?.directory).toBe("private/office")
  expect(await readdir(path.join(snapshot.directory, "trellage-knowledge"))).not.toContain("office.lisp")
})

test("provenance-only changes get a new snapshot even when skill bytes stay identical", async () => {
  const f = await fixture()
  const plan = await f.plan()
  const first = await publishSnapshot(f.owner, plan)
  const commit = "b".repeat(40)
  const changed = {
    ...plan,
    sources: plan.sources.map((source) => ({ ...source, commit })),
    skills: plan.skills.map((skill) => ({ ...skill, commit })),
  }
  const second = await publishSnapshot(f.owner, changed)
  expect(second.id).not.toBe(first.id)
  expect(second.manifest.skills[0]!.commit).toBe(commit)
  expect(await readFile(await resolveAsset(first.directory, "office", "SKILL.md"), "utf8")).toBe(
    await readFile(await resolveAsset(second.directory, "office", "SKILL.md"), "utf8"),
  )
})
