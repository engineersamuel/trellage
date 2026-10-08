import { afterEach, expect, test } from "bun:test"
import { createSourceResolver, gitSourceTransport, type SourceTransport } from "../../src/native-run/source.ts"
import {
  cleanupFixtures,
  createSourceRepo,
  fixturePaths,
  skillMarkdown,
  tempRoot,
} from "./fixtures.ts"

afterEach(cleanupFixtures)

const setup = async () => {
  const root = await tempRoot("source")
  const repo = await createSourceRepo(root, "office")
  const first = await repo.write({ "skills/powerpoint/SKILL.md": skillMarkdown("powerpoint", "v1") })
  const paths = await fixturePaths(root)
  const remote = gitSourceTransport(() => repo.directory)
  return { root, repo, first, paths, remote }
}

const offline: SourceTransport = {
  resolveRef: async () => {
    throw new Error("network unreachable")
  },
  fetchCommit: async () => {
    throw new Error("network unreachable")
  },
}

test("cold floating install fetches the default-branch commit", async () => {
  const { repo, first, paths, remote } = await setup()
  const resolver = createSourceResolver({ paths, transport: remote })
  const resolved = await resolver.resolve("office", { repository: "example/office" })
  expect(resolved.commit).toBe(first)
  expect(resolved.warning).toBeUndefined()
  expect(resolved.directory).toContain(first)
  expect(await Bun.file(`${resolved.directory}/skills/powerpoint/SKILL.md`).text()).toContain("v1")
  expect(repo.directory).toBeTruthy()
})

test("a floating source follows the advancing default branch on every resolve", async () => {
  const { repo, first, paths, remote } = await setup()
  const resolver = createSourceResolver({ paths, transport: remote })
  expect((await resolver.resolve("office", { repository: "example/office" })).commit).toBe(first)
  const second = await repo.write({ "skills/powerpoint/SKILL.md": skillMarkdown("powerpoint", "v2") })
  const resolved = await resolver.resolve("office", { repository: "example/office" })
  expect(resolved.commit).toBe(second)
  expect(await Bun.file(`${resolved.directory}/skills/powerpoint/SKILL.md`).text()).toContain("v2")
})

test("an offline floating source warns and reuses the last good cache", async () => {
  const { first, paths, remote } = await setup()
  const online = createSourceResolver({ paths, transport: remote })
  const good = await online.resolve("office", { repository: "example/office" })
  await online.markGood(good)
  const resolver = createSourceResolver({ paths, transport: offline })
  const resolved = await resolver.resolve("office", { repository: "example/office" })
  expect(resolved.commit).toBe(first)
  expect(resolved.warning).toContain("could not be refreshed")
})

test("offline with no cache stops with an actionable error", async () => {
  const { paths } = await setup()
  const resolver = createSourceResolver({ paths, transport: offline })
  await expect(resolver.resolve("office", { repository: "example/office" })).rejects.toThrow(/no cached content/)
})

test("a corrupted cache is not accepted as fallback", async () => {
  const { paths, remote } = await setup()
  const online = createSourceResolver({ paths, transport: remote })
  const good = await online.resolve("office", { repository: "example/office" })
  await online.markGood(good)
  await Bun.write(`${good.directory}/skills/powerpoint/SKILL.md`, "tampered")
  const resolver = createSourceResolver({ paths, transport: offline })
  await expect(resolver.resolve("office", { repository: "example/office" })).rejects.toThrow()
})

test("a tag is bound to its first commit and reused offline without a freshness request", async () => {
  const { repo, first, paths, remote } = await setup()
  const { git } = await import("./fixtures.ts")
  await git(repo.directory, "tag", "v1")
  const resolver = createSourceResolver({ paths, transport: remote })
  expect((await resolver.resolve("office", { repository: "example/office", tag: "v1" })).commit).toBe(first)
  const offlineResolver = createSourceResolver({ paths, transport: offline })
  const reused = await offlineResolver.resolve("office", { repository: "example/office", tag: "v1" })
  expect(reused.commit).toBe(first)
  expect(reused.warning).toBeUndefined()
})

test("a moved tag does not change an existing binding", async () => {
  const { repo, first, paths, remote } = await setup()
  const { git } = await import("./fixtures.ts")
  await git(repo.directory, "tag", "v1")
  const resolver = createSourceResolver({ paths, transport: remote })
  await resolver.resolve("office", { repository: "example/office", tag: "v1" })
  await repo.write({ "skills/powerpoint/SKILL.md": skillMarkdown("powerpoint", "v2") })
  await git(repo.directory, "tag", "-f", "v1")
  expect((await resolver.resolve("office", { repository: "example/office", tag: "v1" })).commit).toBe(first)
})

test("an exact commit pin refetches the same commit after a cache purge", async () => {
  const { repo, first, paths, remote } = await setup()
  await repo.write({ "skills/powerpoint/SKILL.md": skillMarkdown("powerpoint", "v2") })
  const resolver = createSourceResolver({ paths, transport: remote })
  const resolved = await resolver.resolve("office", { repository: "example/office", commit: first })
  expect(await Bun.file(`${resolved.directory}/skills/powerpoint/SKILL.md`).text()).toContain("v1")
  const { rm } = await import("node:fs/promises")
  await rm(paths.cache, { recursive: true })
  const again = await resolver.resolve("office", { repository: "example/office", commit: first })
  expect(again.commit).toBe(first)
  expect(await Bun.file(`${again.directory}/skills/powerpoint/SKILL.md`).text()).toContain("v1")
})

test("concurrent resolves of one commit publish a single valid cache entry", async () => {
  const { first, paths, remote } = await setup()
  const resolver = createSourceResolver({ paths, transport: remote })
  const results = await Promise.all(
    [1, 2, 3, 4].map(() => resolver.resolve("office", { repository: "example/office" })),
  )
  expect(new Set(results.map((result) => result.commit))).toEqual(new Set([first]))
  expect(new Set(results.map((result) => result.digest)).size).toBe(1)
})

test("profile loads refresh floating revisions even when an old TTL setting is passed", async () => {
  const { repo, paths, remote } = await setup()
  const resolver = createSourceResolver({ paths, transport: remote, ttlSeconds: 300 })
  const first = await resolver.resolve("office", { repository: "example/office" })
  await resolver.markGood(first)
  const second = await repo.write({ "skills/powerpoint/SKILL.md": skillMarkdown("powerpoint", "v2") })
  expect((await resolver.resolve("office", { repository: "example/office" })).commit).toBe(second)
})

test("parallel profiles sharing one repository resolve its floating HEAD once", async () => {
  const { paths, remote } = await setup()
  let requests = 0
  const resolver = createSourceResolver({ paths, transport: { ...remote, resolveRef: async (...args) => { requests++; return remote.resolveRef(...args) } } })
  await Promise.all([resolver.resolve("office", { repository: "example/office" }), resolver.resolve("slides", { repository: "example/office" })])
  expect(requests).toBe(1)
})

test("concurrent resolver instances retain every tag binding for offline reuse", async () => {
  const { repo, paths, remote, first } = await setup()
  const { git } = await import("./fixtures.ts")
  const tags = ["v1", "v2", "v3", "v4"]
  for (const tag of tags) await git(repo.directory, "tag", tag)
  await Promise.all(tags.map((tag) => createSourceResolver({ paths, transport: remote }).resolve(tag, { repository: "example/office", tag })))
  for (const tag of tags) {
    expect((await createSourceResolver({ paths, transport: offline }).resolve(tag, { repository: "example/office", tag })).commit).toBe(first)
  }
})
