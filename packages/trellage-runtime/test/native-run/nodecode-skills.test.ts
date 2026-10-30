import { afterEach, expect, test } from "bun:test"
import { mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CompositionPlan } from "../../src/native-run/compose.ts"
import { reconcileNodecodeSkills } from "../../src/native-run/nodecode-skills.ts"
import { digestDirectory } from "../../src/native-run/source.ts"
import { cleanupFixtures, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)
const fixture = async () => {
  const root = await tempRoot("nodecode-activation")
  const owner = path.join(root, "owner")
  const home = path.join(owner, "state", "home")
  const managed = path.join(owner, "managed", "nodecode-skills")
  const source = path.join(root, "source")
  await mkdir(source)
  await writeFile(path.join(source, "SKILL.md"), "---\nname: example\n---\nEXAMPLE SKILL\n")
  await mkdir(home, { recursive: true })
  const plan: CompositionPlan = {
    harness: "nodecode",
    compositionId: "nodecode-fixture",
    generationId: "fixture",
    profiles: ["example"],
    alwaysProfiles: [],
    skills: [
      {
        name: "example",
        sourceId: "fixture",
        commit: "a".repeat(40),
        digest: await digestDirectory(source),
        directory: source,
      },
    ],
    instructions: [{ id: "rules", text: "COMPOSED RULES" }],
    plugins: [],
    sources: [],
    warnings: [],
  }
  return { root, owner, home, managed, source, plan }
}
const agents = (home: string) => path.join(home, "AGENTS.md")
const link = (home: string) => path.join(home, "cells", "trellage-knowledge")

test("reconciliation preserves user rules, learning, settings and old assets; repeats are idempotent", async () => {
  const f = await fixture()
  const user = "# Operator rules\nPreserve these byte for byte.\n"
  await writeFile(agents(f.home), user)
  await writeFile(path.join(f.home, "layer.lisp"), "USER LEARNING")
  await writeFile(path.join(f.home, "config.jsonc"), '{"update":{"mode":"off"}}')
  await reconcileNodecodeSkills(f.owner, f.plan)
  const first = await readlink(link(f.home))
  const text = await readFile(agents(f.home), "utf8")
  expect(text.startsWith(user)).toBe(true)
  expect(text).toContain("COMPOSED RULES")
  expect(text).toContain("/index reload")
  await reconcileNodecodeSkills(f.owner, f.plan)
  expect(await readFile(agents(f.home), "utf8")).toBe(text)
  // User edits outside the owned block survive later removal.
  await writeFile(agents(f.home), `USER PREFIX\n${text}USER SUFFIX\n`)
  await reconcileNodecodeSkills(f.owner, { ...f.plan, skills: [], instructions: [] })
  expect(await readFile(agents(f.home), "utf8")).toBe(`USER PREFIX\n${user}USER SUFFIX\n`)
  expect(await readlink(link(f.home))).not.toBe(first)
  expect(await readFile(path.join(path.dirname(first), "ordinary", "example", "SKILL.md"), "utf8")).toContain(
    "EXAMPLE SKILL",
  )
  expect(await readFile(path.join(f.home, "layer.lisp"), "utf8")).toBe("USER LEARNING")
  expect(await readFile(path.join(f.home, "config.jsonc"), "utf8")).toBe('{"update":{"mode":"off"}}')
  expect(await readdir(path.join(f.managed, "snapshots"))).toHaveLength(2)
})

test("ownership collisions and edited managed blocks fail without replacing user content", async () => {
  const f = await fixture()
  await mkdir(link(f.home), { recursive: true })
  await writeFile(path.join(link(f.home), "user.txt"), "USER CELL")
  await expect(reconcileNodecodeSkills(f.owner, f.plan)).rejects.toThrow("unowned")
  await rm(link(f.home), { recursive: true })
  await reconcileNodecodeSkills(f.owner, f.plan)
  const target = await readlink(link(f.home))
  const edited = (await readFile(agents(f.home), "utf8")).replace("COMPOSED RULES", "USER EDIT")
  await writeFile(agents(f.home), edited)
  await expect(reconcileNodecodeSkills(f.owner, f.plan)).rejects.toThrow("was edited")
  expect(await readFile(agents(f.home), "utf8")).toBe(edited)
  expect(await readlink(link(f.home))).toBe(target)
})

test("instruction overflow and symlink instruction ownership fail before activation", async () => {
  const f = await fixture()
  const text = "X".repeat(65_536)
  await writeFile(agents(f.home), text)
  await expect(reconcileNodecodeSkills(f.owner, f.plan)).rejects.toThrow("65,536")
  expect(await readFile(agents(f.home), "utf8")).toBe(text)
  expect(await readdir(path.join(f.home, "cells"))).toEqual([])
  await rm(agents(f.home))
  const outside = path.join(f.root, "outside")
  await writeFile(outside, "OUTSIDE")
  await symlink(outside, agents(f.home))
  await expect(reconcileNodecodeSkills(f.owner, f.plan)).rejects.toThrow("non-regular")
  expect(await readFile(outside, "utf8")).toBe("OUTSIDE")
})

test("every interrupted activation surface rolls back the prior registration and rules", async () => {
  const f = await fixture()
  await reconcileNodecodeSkills(f.owner, f.plan)
  const previous = await readlink(link(f.home))
  const rules = await readFile(agents(f.home), "utf8")
  const receipt = await readFile(path.join(f.managed, "activation.json"), "utf8")
  for (const surface of ["instructions", "trellage-knowledge", "nodecode-trellage-manual", "receipt"]) {
    await expect(
      reconcileNodecodeSkills(
        f.owner,
        { ...f.plan, skills: [], instructions: [] },
        {
          afterWrite: async (name) => {
            if (name === surface) throw new Error("injected activation failure")
          },
        },
      ),
    ).rejects.toThrow("injected")
    expect(await readlink(link(f.home))).toBe(previous)
    expect(await readFile(agents(f.home), "utf8")).toBe(rules)
    expect(await readFile(path.join(f.managed, "activation.json"), "utf8")).toBe(receipt)
    expect(await readdir(f.managed)).not.toContain("activation-journal.json")
  }
})

test("a persisted partial transaction recovers on next launch, but unknown user edits are never rolled back", async () => {
  const f = await fixture()
  await reconcileNodecodeSkills(f.owner, f.plan)
  let journal = ""
  await expect(
    reconcileNodecodeSkills(
      f.owner,
      { ...f.plan, skills: [], instructions: [] },
      {
        afterWrite: async () => {
          journal = await readFile(path.join(f.managed, "activation-journal.json"), "utf8")
          throw new Error("interrupt")
        },
      },
    ),
  ).rejects.toThrow("interrupt")
  const pending = JSON.parse(journal)
  // Emulate process death after the first atomic write, leaving its journal intact.
  await writeFile(agents(f.home), pending.after.agents)
  await writeFile(path.join(f.managed, "activation-journal.json"), journal)
  await reconcileNodecodeSkills(f.owner, f.plan)
  expect(await readFile(agents(f.home), "utf8")).toBe(pending.before.agents)
  await writeFile(path.join(f.managed, "activation-journal.json"), journal)
  await writeFile(agents(f.home), "NEW USER EDIT AFTER CRASH")
  await expect(reconcileNodecodeSkills(f.owner, f.plan)).rejects.toThrow("recovery conflict")
  expect(await readFile(agents(f.home), "utf8")).toBe("NEW USER EDIT AFTER CRASH")
})

test("first activation rolls back to absent managed state at every write boundary", async () => {
  const f = await fixture()
  for (const surface of ["instructions", "trellage-knowledge", "nodecode-trellage-manual", "receipt"]) {
    await expect(
      reconcileNodecodeSkills(f.owner, f.plan, {
        afterWrite: async (name) => {
          if (name === surface) throw new Error("first activation interrupted")
        },
      }),
    ).rejects.toThrow("first activation interrupted")
    expect(await Bun.file(agents(f.home)).exists()).toBe(false)
    expect(await readdir(path.join(f.home, "cells"))).toEqual([])
    expect(await readdir(f.managed)).toEqual(["snapshots"])
  }
  await reconcileNodecodeSkills(f.owner, f.plan)
  expect(await Bun.file(agents(f.home)).exists()).toBe(true)
})

test("redirected snapshot directories are rejected before publishing outside the owner", async () => {
  const f = await fixture()
  await mkdir(f.managed, { recursive: true })
  const outside = path.join(f.root, "outside")
  await mkdir(outside)
  await symlink(outside, path.join(f.managed, "snapshots"))
  await expect(reconcileNodecodeSkills(f.owner, f.plan)).rejects.toThrow("symlink directory")
  expect(await readdir(outside)).toEqual([])
  expect(await Bun.file(agents(f.home)).exists()).toBe(false)
})
