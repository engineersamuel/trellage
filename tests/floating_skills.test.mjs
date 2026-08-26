import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, test } from "node:test"

import {
  ensureNative,
  parseCatalog,
  readCatalog,
  stageLatest,
  syncSnapshot,
  updateNative,
  verifyTarget,
} from "../scripts/floating-skills.mjs"

const execFilePromise = promisify(execFile)
const temporaryRoots = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((candidate) => rm(candidate, { recursive: true, force: true })))
})

const temporaryRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-floating-skills-test."))
  temporaryRoots.push(root)
  return root
}

const commit = async (repository, message) => {
  await execFilePromise("git", ["-C", repository, "add", "."])
  await execFilePromise("git", [
    "-C",
    repository,
    "-c",
    "user.name=Trellage Test",
    "-c",
    "user.email=trellage@example.invalid",
    "commit",
    "--quiet",
    "-m",
    message,
  ])
}

const writeSkill = async (repository, content) => {
  const directory = path.join(repository, ".omp", "skills", "fixture")
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: fixture\n---\n\n${content}\n`)
}

const initRepository = async (repository) => {
  await mkdir(repository, { recursive: true })
  await execFilePromise("git", ["-C", repository, "init", "--quiet", "--initial-branch=main"])
}

const createFixture = async () => {
  const root = await temporaryRoot()
  const repository = path.join(root, "repository")
  await initRepository(repository)
  await writeSkill(repository, "version one")
  await commit(repository, "initial skill")
  const catalog = {
    schema: 1,
    sources: {
      fixture: {
        id: "fixture",
        repository,
        select: ["fixture"],
        adapter: "omp-native",
        alwaysOn: false,
        allowExecutables: false,
      },
    },
    bundles: { test: ["fixture"] },
  }
  return {
    root,
    repository,
    catalog,
    cache: path.join(root, "cache"),
    target: path.join(root, "target"),
  }
}

test("the checked-in catalog contains policy but no fetched identity", async () => {
  const source = await readFile(new URL("../skills.json", import.meta.url), "utf8")
  const catalog = await readCatalog(new URL("../skills.json", import.meta.url))
  assert.equal(catalog.schema, 1)
  assert.ok(Object.hasOwn(catalog.bundles, "sandbox-common"))
  assert.deepEqual(catalog.bundles["omp-community"], ["dsebban-omp", "cursor-pstack"])
  const ompCommunityNames = catalog.bundles["omp-community"].flatMap(
    (sourceId) => catalog.sources[sourceId].select,
  )
  assert.equal(ompCommunityNames.length, 49)
  assert.equal(new Set(ompCommunityNames).size, 49)
  assert.ok(catalog.sources["dsebban-omp"].select.includes("poteto-mode"))
  assert.ok(!catalog.sources["cursor-pstack"].select.includes("poteto-mode"))
  assert.deepEqual(catalog.sources.engineersamuel.exclude, ["deja-history"])
  assert.doesNotMatch(source, /"(?:ref|commit|integrity|digest|fetchedAt)"\s*:/)
  assert.throws(
    () =>
      parseCatalog(
        JSON.stringify({
          schema: 1,
          sources: {
            unsafe: {
              repository: "https://github.com/example/skills.git",
              select: ["fixture"],
              ref: "main",
            },
          },
          bundles: { test: ["unsafe"] },
        }),
      ),
    /unknown skill source policy ref/,
  )
})

test("wildcard exclusions do not enter a generated snapshot", async () => {
  const root = await temporaryRoot()
  const repository = path.join(root, "repository")
  await initRepository(repository)
  for (const name of ["deja-history", "keep-me"]) {
    const directory = path.join(repository, ".omp", "skills", name)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\n---\n\nfixture\n`)
  }
  await commit(repository, "add wildcard skills")

  const output = path.join(root, "snapshot")
  await stageLatest({
    catalog: {
      schema: 1,
      sources: {
        fixture: {
          id: "fixture",
          repository,
          select: ["*"],
          exclude: ["deja-history"],
          adapter: "omp-native",
          alwaysOn: false,
          allowExecutables: false,
        },
      },
      bundles: { test: ["fixture"] },
    },
    bundleIds: ["test"],
    destination: output,
  })

  assert.deepEqual((await readFile(path.join(output, "managed-skills.txt"), "utf8")).trim().split("\n"), ["keep-me"])
  assert.equal(await lstat(path.join(output, "skills", "deja-history")).catch(() => undefined), undefined)
})

test("first use installs, later use is offline, and update observes the latest commit", async () => {
  const fixture = await createFixture()
  await ensureNative({
    catalog: fixture.catalog,
    bundleIds: ["test"],
    cache: fixture.cache,
    target: fixture.target,
  })
  assert.match(await readFile(path.join(fixture.target, "fixture", "SKILL.md"), "utf8"), /version one/)

  const offlineRepository = `${fixture.repository}.offline`
  await rename(fixture.repository, offlineRepository)
  await rm(fixture.target, { recursive: true })
  await ensureNative({
    catalog: fixture.catalog,
    bundleIds: ["test"],
    cache: fixture.cache,
    target: fixture.target,
  })
  await verifyTarget(fixture.cache, fixture.target)

  await rename(offlineRepository, fixture.repository)
  await writeSkill(fixture.repository, "version two")
  await commit(fixture.repository, "update skill")
  await updateNative({
    catalog: fixture.catalog,
    bundleIds: ["test"],
    cache: fixture.cache,
  })
  await syncSnapshot(fixture.cache, fixture.target)
  assert.match(await readFile(path.join(fixture.target, "fixture", "SKILL.md"), "utf8"), /version two/)
})

test("a failed update preserves the cache and unmanaged skills", async () => {
  const fixture = await createFixture()
  await mkdir(path.join(fixture.target, "unmanaged"), { recursive: true })
  await writeFile(path.join(fixture.target, "unmanaged", "SKILL.md"), "keep\n")
  await ensureNative({
    catalog: fixture.catalog,
    bundleIds: ["test"],
    cache: fixture.cache,
    target: fixture.target,
  })
  const before = await readFile(path.join(fixture.cache, "skills", "fixture", "SKILL.md"), "utf8")
  await rename(fixture.repository, `${fixture.repository}.offline`)
  await assert.rejects(
    updateNative({
      catalog: fixture.catalog,
      bundleIds: ["test"],
      cache: fixture.cache,
    }),
    /command failed: git/,
  )
  assert.equal(await readFile(path.join(fixture.cache, "skills", "fixture", "SKILL.md"), "utf8"), before)
  assert.equal(await readFile(path.join(fixture.target, "unmanaged", "SKILL.md"), "utf8"), "keep\n")
})

test("a failed first install leaves no cache or target", async () => {
  const fixture = await createFixture()
  await rename(fixture.repository, `${fixture.repository}.offline`)
  await assert.rejects(
    ensureNative({
      catalog: fixture.catalog,
      bundleIds: ["test"],
      cache: fixture.cache,
      target: fixture.target,
    }),
    /command failed: git/,
  )
  assert.equal(await lstat(fixture.cache).catch(() => undefined), undefined)
  assert.equal(await lstat(fixture.target).catch(() => undefined), undefined)
})

test("refresh removes stale managed skills and preserves unmanaged skills", async () => {
  const fixture = await createFixture()
  await mkdir(path.join(fixture.target, "unmanaged"), { recursive: true })
  await writeFile(path.join(fixture.target, "unmanaged", "SKILL.md"), "keep\n")
  await ensureNative({
    catalog: fixture.catalog,
    bundleIds: ["test"],
    cache: fixture.cache,
    target: fixture.target,
  })

  await rm(path.join(fixture.repository, ".omp", "skills", "fixture"), { recursive: true })
  const replacement = path.join(fixture.repository, ".omp", "skills", "replacement")
  await mkdir(replacement)
  await writeFile(path.join(replacement, "SKILL.md"), "---\nname: replacement\n---\n\nnew\n")
  fixture.catalog.sources.fixture.select = ["replacement"]
  await commit(fixture.repository, "replace managed skill")
  await updateNative({
    catalog: fixture.catalog,
    bundleIds: ["test"],
    cache: fixture.cache,
  })
  await syncSnapshot(fixture.cache, fixture.target)

  assert.equal(await lstat(path.join(fixture.target, "fixture")).catch(() => undefined), undefined)
  assert.match(await readFile(path.join(fixture.target, "replacement", "SKILL.md"), "utf8"), /new/)
  assert.equal(await readFile(path.join(fixture.target, "unmanaged", "SKILL.md"), "utf8"), "keep\n")
})

test("publication rejects unmanaged collisions and source symlinks", async () => {
  const fixture = await createFixture()
  await updateNative({
    catalog: fixture.catalog,
    bundleIds: ["test"],
    cache: fixture.cache,
  })
  await mkdir(path.join(fixture.target, "fixture"), { recursive: true })
  await writeFile(path.join(fixture.target, "fixture", "SKILL.md"), "unmanaged\n")
  await assert.rejects(syncSnapshot(fixture.cache, fixture.target), /refusing to replace unmanaged skill/)

  await symlink("SKILL.md", path.join(fixture.repository, ".omp", "skills", "fixture", "alias.md"))
  await commit(fixture.repository, "unsafe symlink")
  const before = await readFile(path.join(fixture.cache, "skills", "fixture", "SKILL.md"), "utf8")
  await assert.rejects(
    updateNative({
      catalog: fixture.catalog,
      bundleIds: ["test"],
      cache: fixture.cache,
    }),
    /skill contains a symlink/,
  )
  assert.equal(await readFile(path.join(fixture.cache, "skills", "fixture", "SKILL.md"), "utf8"), before)
})

test("verification rejects modified targets and unsafe cached content", async () => {
  const fixture = await createFixture()
  await ensureNative({
    catalog: fixture.catalog,
    bundleIds: ["test"],
    cache: fixture.cache,
    target: fixture.target,
  })
  await writeFile(path.join(fixture.target, "fixture", "SKILL.md"), "modified\n")
  await assert.rejects(verifyTarget(fixture.cache, fixture.target), /managed skill differs/)

  await rm(path.join(fixture.cache, "skills", "fixture", "SKILL.md"))
  await symlink("outside", path.join(fixture.cache, "skills", "fixture", "SKILL.md"))
  await assert.rejects(syncSnapshot(fixture.cache, fixture.target), /skill contains a symlink/)
})

test("generic sources use the configured materializer", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-floating-skills-generic-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = path.join(root, "repository")
  const selected = path.join(repository, ".agents", "skills", "generic")
  await mkdir(selected, { recursive: true })
  await writeFile(path.join(selected, "SKILL.md"), "---\nname: generic\n---\n\nsource\n")
  await initRepository(repository)
  await commit(repository, "initial generic skill")

  const materializer = path.join(root, "fake-skills")
  await writeFile(
    materializer,
    `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const names = process.argv.flatMap((value, index, values) => value === "--skill" ? [values[index + 1]] : [])
for (const name of names) {
  const output = path.join(process.cwd(), ".agents", "skills", name)
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, "SKILL.md"), "---\\nname: " + name + "\\n---\\n\\ngenerated\\n")
}
`,
  )
  await chmod(materializer, 0o755)
  const output = path.join(root, "snapshot")
  await stageLatest({
    catalog: {
      sources: {
        generic: {
          id: "generic",
          repository,
          adapter: "generic",
          select: ["generic"],
          alwaysOn: false,
          allowExecutables: false,
          allowWildcard: false,
        },
      },
      bundles: { test: ["generic"] },
    },
    bundleIds: ["test"],
    destination: output,
    skillsCli: materializer,
  })

  assert.match(await readFile(path.join(output, "skills", "generic", "SKILL.md"), "utf8"), /generated/)
})

test("runtime publication restores the previous version when replacement fails", async () => {
  const root = await temporaryRoot()
  const home = path.join(root, "home")
  const destination = path.join(home, ".local", "share", "trellage", "common", "floating-skills-runtime")
  await mkdir(destination, { recursive: true })
  await writeFile(path.join(destination, "previous"), "preserve\n")

  const bin = path.join(root, "bin")
  const counter = path.join(root, "mv-count")
  const fakeMv = path.join(bin, "mv")
  await mkdir(bin)
  await writeFile(
    fakeMv,
    `#!/usr/bin/env bash
set -euo pipefail
count=0
[[ ! -f "$FLOATING_SKILLS_MV_COUNT" ]] || count="$(cat "$FLOATING_SKILLS_MV_COUNT")"
count=$((count + 1))
printf '%s\\n' "$count" > "$FLOATING_SKILLS_MV_COUNT"
[[ "$count" -ne 2 ]] || exit 73
exec /bin/mv "$@"
`,
  )
  await chmod(fakeMv, 0o755)

  await assert.rejects(
    execFilePromise("bash", [fileURLToPath(new URL("../scripts/install-floating-skills-runtime.sh", import.meta.url))], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        FLOATING_SKILLS_MV_COUNT: counter,
      },
    }),
  )
  assert.equal(await readFile(path.join(destination, "previous"), "utf8"), "preserve\n")
})

test("concurrent first use shares one cache and reclaims malformed locks", async () => {
  const fixture = await createFixture()
  await mkdir(`${fixture.cache}.lock`, { recursive: true })
  const secondTarget = path.join(fixture.root, "second-target")

  await Promise.all([
    ensureNative({
      catalog: fixture.catalog,
      bundleIds: ["test"],
      cache: fixture.cache,
      target: fixture.target,
    }),
    ensureNative({
      catalog: fixture.catalog,
      bundleIds: ["test"],
      cache: fixture.cache,
      target: secondTarget,
    }),
  ])

  assert.match(await readFile(path.join(fixture.target, "fixture", "SKILL.md"), "utf8"), /version one/)
  assert.match(await readFile(path.join(secondTarget, "fixture", "SKILL.md"), "utf8"), /version one/)
  assert.equal(await lstat(`${fixture.cache}.lock`).catch(() => undefined), undefined)
})
