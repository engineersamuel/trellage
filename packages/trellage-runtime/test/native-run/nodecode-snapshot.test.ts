import { afterEach, expect, test } from "bun:test"
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { NativeCatalog } from "../../src/native-config.ts"
import { planComposition } from "../../src/native-run/compose.ts"
import { buildNodecodeSnapshot, nodecodeManifestFor } from "../../src/native-run/nodecode-snapshot.ts"
import { digestDirectory } from "../../src/native-run/source.ts"
import { cleanupFixtures, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)

const fixture = async () => {
  const root = await tempRoot("nodecode-snapshot")
  const source = path.join(root, "source")
  const owner = path.join(root, "owner")
  await mkdir(owner)
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
      `---\nname: ${name}\n${manual ? "disable-model-invocation: true\n" : ""}---\n${name} fixture. See assets/large.txt.\n#.(error "must not execute")\n`,
    )
    await writeFile(path.join(directory, "assets", "large.txt"), "asset fixture\n".repeat(9000))
    await writeFile(path.join(directory, "assets", "script.sh"), "#!/bin/sh\nexit 93\n")
    await chmod(path.join(directory, "assets", "script.sh"), 0o755)
  }
  const catalog: NativeCatalog = {
    sources: { fixture: { repository: "example/fixture" }, office: { repository: "example/fixture", alwaysOn: true } },
    instructions: { rules: { file: "rules.md" } },
    profiles: {
      office: {
        always: false,
        instructions: ["rules"],
        plugins: [],
        skills: [{ source: "office", names: ["office"] }],
      },
      common: {
        always: true,
        instructions: [],
        plugins: [],
        skills: [{ source: "fixture", names: ["common", "i-have-adhd"] }],
      },
      wrong: {
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
        adapterPolicy: "test",
        providerPolicy: "offline",
        instructionTexts: { rules: "COMPOSED_RULE" },
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

test("Nodecode snapshot consumes canonical policy, keeps manual prose private and includes alwaysOn instructions/assets", async () => {
  const f = await fixture()
  const plan = await f.plan()
  expect(plan.instructions.map(({ id }) => id)).toEqual(["rules", "skill-office"])
  const snapshot = await buildNodecodeSnapshot(f.owner, plan)
  expect(snapshot.manifest.skills.map(({ name }) => name)).toEqual(["common", "i-have-adhd", "office"])
  expect(snapshot.manifest.alwaysProfiles).toEqual(["common"])
  expect(snapshot.manifest.sources[0]).toMatchObject({
    repository: "example/fixture",
    selector: { kind: "default" },
    commit: "a".repeat(40),
  })
  expect(snapshot.manifest.generator).toMatch(/^[a-f0-9]{64}$/)
  expect((await readdir(path.join(snapshot.directory, "trellage-knowledge"))).sort()).toEqual([
    "common.lisp",
    "office.lisp",
    "trellage-knowledge.asd",
  ])
  const knowledge = await readFile(path.join(snapshot.directory, "trellage-knowledge", "office.lisp"), "utf8")
  expect(knowledge).toContain('#.(error \\"must not execute\\")')
  expect(knowledge).toContain(path.join(snapshot.directory, "ordinary", "office"))
  const manual = await readFile(path.join(snapshot.directory, "private", "i-have-adhd", "SKILL.md"), "utf8")
  expect(manual).toContain("disable-model-invocation: true")
  const instructions = await readFile(path.join(snapshot.directory, "instructions.md"), "utf8")
  expect(instructions).toContain("COMPOSED_RULE")
  expect(instructions).toContain("# Managed skill: office")
  expect(instructions).toContain(path.join(snapshot.directory, "ordinary", "office"))
  expect(instructions).not.toContain("i-have-adhd")
  const bridgePointer = await readFile(
    path.join(snapshot.directory, "nodecode-trellage-manual", "snapshot.lisp"),
    "utf8",
  )
  expect(bridgePointer).toContain(snapshot.directory)
  expect(bridgePointer).not.toContain("current")
  expect(await readdir(path.join(f.owner, "managed", "nodecode-skills"))).toEqual(["snapshots"])
})

test("Nodecode retains snapshots across no-always, provenance changes and source/generation removal", async () => {
  const f = await fixture()
  const plan = await f.plan()
  const first = await buildNodecodeSnapshot(f.owner, plan)
  expect((await buildNodecodeSnapshot(f.owner, plan)).id).toBe(first.id)
  const reduced = await buildNodecodeSnapshot(f.owner, await f.plan(true))
  expect(reduced.id).not.toBe(first.id)
  expect(reduced.manifest.skills.map(({ name }) => name)).toEqual(["office"])
  const commit = "b".repeat(40)
  const newer = await buildNodecodeSnapshot(f.owner, {
    ...plan,
    sources: plan.sources.map((source) => ({ ...source, commit })),
    skills: plan.skills.map((skill) => ({ ...skill, commit })),
  })
  expect(newer.id).not.toBe(first.id)
  await rm(f.source, { recursive: true })
  const asset = path.join(first.directory, "ordinary", "office", "assets", "large.txt")
  expect((await readFile(asset)).length).toBeGreaterThan(8192)
  expect((await lstat(path.join(first.directory, "ordinary", "office", "assets", "script.sh"))).mode & 0o111).not.toBe(
    0,
  )
  expect(await readdir(path.dirname(first.directory))).toHaveLength(3)
})

test("Nodecode detects source changes and modified existing snapshots without replacing prior content", async () => {
  const f = await fixture()
  const plan = await f.plan()
  const first = await buildNodecodeSnapshot(f.owner, plan)
  const file = path.join(first.directory, "ordinary", "office", "SKILL.md")
  await writeFile(file, "modified snapshot")
  await expect(buildNodecodeSnapshot(f.owner, plan)).rejects.toThrow("snapshot has been modified")
  expect(await readFile(file, "utf8")).toBe("modified snapshot")
  await writeFile(path.join(f.source, "skills", "office", "SKILL.md"), "modified source")
  await expect(buildNodecodeSnapshot(f.owner, plan)).rejects.toThrow("Source digest mismatch")
  expect(await readdir(path.join(f.owner, "managed", "nodecode-skills"))).toEqual(["snapshots"])
})

test("Nodecode rejects unsupported policy, reader-unsafe names, case collisions and asset symlinks", async () => {
  const f = await fixture()
  const plan = await f.plan()
  const skill = plan.skills[0]!
  expect(() => nodecodeManifestFor({ ...plan, harness: "claude" }, "test")).toThrow("Nodecode plans")
  expect(() => nodecodeManifestFor({ ...plan, skills: [{ ...skill, name: "../escape" }] }, "test")).toThrow("Unsafe")
  expect(() =>
    nodecodeManifestFor({ ...plan, skills: [skill, { ...skill, name: skill.name.toUpperCase() }] }, "test"),
  ).toThrow("case-insensitive")
  expect(() =>
    nodecodeManifestFor({ ...plan, skills: [{ ...skill, manualOnly: true, alwaysOn: true }] }, "test"),
  ).toThrow("Conflicting")
  expect(() =>
    nodecodeManifestFor(
      { ...plan, plugins: [{ ...skill, source: "fixture", harness: "nodecode", path: "plugin" }] },
      "test",
    ),
  ).toThrow("plugins")
  await symlink("/outside", path.join(f.source, "skills", "office", "assets", "link"))
  await expect(buildNodecodeSnapshot(f.owner, plan)).rejects.toThrow("symbolic link")
})

test("Nodecode honors arbitrary upstream manual metadata independently of the common special case", async () => {
  const f = await fixture()
  await writeFile(
    path.join(f.source, "skills", "office", "SKILL.md"),
    "---\nname: office\ndisable-model-invocation: true\n---\nManual office\n",
  )
  const plan = await f.plan()
  expect(plan.skills.find(({ name }) => name === "office")).toMatchObject({ manualOnly: true })
  const snapshot = await buildNodecodeSnapshot(f.owner, plan)
  expect(await readdir(path.join(snapshot.directory, "trellage-knowledge"))).not.toContain("office.lisp")
  expect(await readFile(path.join(snapshot.directory, "instructions.md"), "utf8")).not.toContain("Manual office")
})
