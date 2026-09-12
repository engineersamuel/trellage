import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { bunArguments, bunExecutable } from "@trellage/runtime"

const helper = new URL("../claude-managed-files.ts", import.meta.url)

const runManagedFiles = (root: string, ...args: string[]) =>
  spawnSync(bunExecutable(), bunArguments(helper, args), {
    cwd: root,
    encoding: "utf8",
    env: { HOME: path.join(root, "home"), PATH: "/nonexistent", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    timeout: 10_000,
  })

test("the source managed-file CLI preserves publication identity and an exact rollback snapshot", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-managed-source-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  const directories = ["home", "staging", "published", "owned", "snapshot-owned", "backup", "quarantine", "transaction"]
  await Promise.all(directories.map((directory) => mkdir(path.join(root, directory))))
  await mkdir(path.join(root, "staging", "skills"))
  await writeFile(path.join(root, "staging", "skills", "writer.md"), "original\n", { mode: 0o640 })
  const paths = path.join(root, "paths")
  await writeFile(paths, "skills/writer.md\n")
  const journal = path.join(root, "transaction", "active")
  const metadata = path.join(root, "metadata.json")
  const run = (...args: string[]) => runManagedFiles(root, ...args)
  const succeeds = (...args: string[]) => {
    const result = run(...args)
    assert.equal(result.status, 0, `${result.stderr}\n${result.error ?? ""}`)
    assert.equal(result.stdout, "")
  }

  succeeds("journal", path.join(root, "published"), path.join(root, "transaction"), journal)
  assert.equal(await readFile(journal, "utf8"), "managed-state transaction is active\n")
  assert.equal((await lstat(journal)).mode & 0o777, 0o600)
  assert.equal(run("journal", path.join(root, "published"), path.join(root, "transaction"), journal).status, 1)

  succeeds("publish", path.join(root, "staging"), path.join(root, "published"), paths, path.join(root, "owned"))
  const published = path.join(root, "published", "skills", "writer.md")
  const owned = path.join(root, "owned", "skills", "writer.md")
  assert.equal((await lstat(published)).ino, (await lstat(owned)).ino)
  assert.equal(await readFile(published, "utf8"), "original\n")
  succeeds("verify-owned", path.join(root, "published"), path.join(root, "owned"), paths)
  succeeds("validate", path.join(root, "published"), paths)
  succeeds("sync-file", published)
  succeeds("sync-directory", path.dirname(published))

  succeeds(
    "snapshot",
    path.join(root, "published"),
    path.join(root, "snapshot-owned"),
    path.join(root, "backup"),
    paths,
    metadata,
  )
  const backup = path.join(root, "backup", "skills", "writer.md")
  assert.equal(await readFile(backup, "utf8"), "original\n")
  assert.equal((await lstat(backup)).mode & 0o777, 0o640)
  assert.notEqual((await lstat(backup)).ino, (await lstat(published)).ino)
  succeeds(
    "remove-owned",
    path.join(root, "published"),
    path.join(root, "snapshot-owned"),
    path.join(root, "quarantine"),
    path.join(root, "recovery"),
    path.join(root, "retain"),
    paths,
    "true",
    metadata,
  )
  await assert.rejects(lstat(published), { code: "ENOENT" })
  assert.equal(await readFile(path.join(root, "quarantine", "skills", "writer.md"), "utf8"), "original\n")
  assert.equal(await readFile(backup, "utf8"), "original\n")
})

test("malformed strict flags cannot downgrade managed-file removal checks", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-managed-input-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all(["home", "published", "owned", "quarantine"].map((name) => mkdir(path.join(root, name))))
  const published = path.join(root, "published", "writer.md")
  const ownership = path.join(root, "owned", "writer.md")
  const paths = path.join(root, "paths")
  const metadata = path.join(root, "metadata.json")
  await writeFile(published, "must remain\n")
  await link(published, ownership)
  await writeFile(paths, "writer.md\n")
  await writeFile(metadata, "invalid metadata must not become optional")
  const original = await lstat(published)
  for (const strict of ["tru", "", "yes", "TRUE"]) {
    const result = runManagedFiles(
      root,
      "remove-owned",
      path.dirname(published),
      path.dirname(ownership),
      path.join(root, "quarantine"),
      path.join(root, "recovery"),
      path.join(root, "retain"),
      paths,
      strict,
      metadata,
    )
    assert.equal(result.status, 1, `${strict}: ${result.stderr}`)
    assert.match(result.stderr, /strict removal must be true or false/)
    assert.equal((await lstat(published)).ino, original.ino)
    assert.equal(await readFile(published, "utf8"), "must remain\n")
    await assert.rejects(lstat(path.join(root, "quarantine", "writer.md")), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(root, "retain")), { code: "ENOENT" })
  }
})

test("managed-file commands reject missing and extra arguments before publication", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-managed-arguments-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  const staging = path.join(root, "staging")
  const destination = path.join(root, "published")
  await Promise.all([staging, destination].map((directory) => mkdir(directory)))
  const paths = path.join(root, "paths")
  await writeFile(paths, "writer.md\n")
  await writeFile(path.join(staging, "writer.md"), "not published\n")
  for (const args of [
    ["publish", staging, destination, paths, "", "extra"],
    ["publish", staging, destination, paths],
  ]) {
    const result = runManagedFiles(root, ...args)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /publish expects 4 arguments/)
    assert.equal(await readFile(path.join(staging, "writer.md"), "utf8"), "not published\n")
    await assert.rejects(lstat(path.join(destination, "writer.md")), { code: "ENOENT" })
  }
  const unknown = runManagedFiles(root, "unknown")
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown managed-file command: unknown/)
})
