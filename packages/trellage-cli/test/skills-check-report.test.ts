import { randomUUID } from "node:crypto"
import { mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"

import { Deferred, Effect, Fiber } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { loadProfile } from "../src/application.js"
import type { DockerTargetRunner } from "../src/docker-target.js"
import { checkContainerSkills } from "../src/skills-check-report.js"

const roots: Array<string> = []
const image = `sha256:${"a".repeat(64)}`
const id = "b".repeat(64)
const target = { endpoint: "unix:///fixture/docker.sock", serverId: "fixture-server", platform: "linux/arm64" as const }
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async (
  profile = "claude-council",
  failure?: string,
  compare: Effect.Effect<string, unknown> = Effect.succeed('{"kind":"current"}'),
) => {
  const root = path.resolve(`.container-skills-test-${randomUUID()}`)
  await mkdir(root, { mode: 0o700 })
  roots.push(root)
  const document = await Effect.runPromise(loadProfile(path.resolve("../../profiles", profile, "profile.toml")))
  let name = ""
  let label = ""
  let exists = false
  const create = (args: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      name = args[args.indexOf("--name") + 1]!
      label = args[args.indexOf("--label") + 1]!.split("=")[1]!
      exists = true
      return failure === "create" ? Effect.fail(new Error("create response failed")) : Effect.succeed(id)
    })
  const inspect = () =>
    !exists
      ? Effect.fail(new Error("No such container"))
      : Effect.succeed(
          JSON.stringify({
            Id: id,
            Name: `/${name}`,
            Image: image,
            State: { Running: false },
            Config: { Labels: { "io.trellage.skills-check": failure === "ownership" ? "foreign" : label } },
          }),
        )
  const run = vi.fn<DockerTargetRunner>((command, args) =>
    Effect.gen(function* () {
      if (command !== "docker") {
        if (failure === "compare") return yield* Effect.fail(new Error("source fetch failed"))
        return yield* compare
      }
      const operation = args[2] === "info" ? "info" : args[3]
      if (operation === "info") return "fixture-server\nlinux/arm64"
      if (args[2] === "image") {
        return yield* failure === "image" ? Effect.fail(new Error("No such image")) : Effect.succeed(image)
      }
      if (operation === "create") return yield* create(args)
      if (operation === "inspect") return yield* inspect()
      if (failure === operation) return yield* Effect.fail(new Error(`${operation} failed`))
      if (operation === "rm") exists = false
      return ""
    }),
  )
  return { root, document, run, exists: () => exists }
}

describe("read-only installed Container skills", () => {
  it.each([
    ["claude-council", "/usr/local/share/trellage/claude-seed/skills"],
    ["copilot-hve", "/usr/local/share/trellage/copilot-seed/skills"],
    ["codex-superpowers", "/home/agent/.codex/skills"],
    ["pi-oh-my-pi", "/usr/local/share/trellage/pi-seed/skills"],
    ["prime-agent", "/usr/local/share/trellage/prime-seed/skills"],
    ["headlong", "/usr/local/share/trellage/headlong-skills/skills"],
  ])("extracts only %s's baked skills from an exact stopped image", async (profile, source) => {
    const f = await fixture(profile)
    expect(await Effect.runPromise(checkContainerSkills(f.document, target, f.run, f.root))).toEqual({
      kind: "current",
    })
    const commands = f.run.mock.calls.map(([, args]) => args)
    const create = commands.find((args) => args[3] === "create")!
    expect(create).toContain("--read-only")
    expect(create.slice(-1)).toEqual([image])
    expect(create).toContain("--entrypoint")
    expect(create).not.toContain("--mount")
    expect(create).not.toContain("--volume")
    expect(commands.find((args) => args[3] === "cp")?.[4]).toBe(`${id}:${source}/.`)
    expect(commands.find((args) => args[3] === "rm")?.slice(-2)).toEqual(["--volumes", id])
    expect(commands.flat()).not.toContain("start")
    expect(commands.flat()).not.toContain("build")
    expect(commands.flat()).not.toContain("pull")
    expect(f.exists()).toBe(false)
    expect(await readdir(f.root)).toEqual([])
  })

  it.each(["create", "cp", "compare"])(
    "removes only its owned container and staging after %s fails",
    async (failure) => {
      const f = await fixture("claude-council", failure)
      const report = await Effect.runPromise(checkContainerSkills(f.document, target, f.run, f.root))
      expect(report.kind).toBe("unknown")
      expect(report.diagnostic).toBeTruthy()
      expect(f.exists()).toBe(false)
      expect(await readdir(f.root)).toEqual([])
    },
  )

  it("does not create a container or call source tools when the image is missing", async () => {
    const f = await fixture("claude-council", "image")
    expect((await Effect.runPromise(checkContainerSkills(f.document, target, f.run, f.root))).kind).toBe("unknown")
    expect(f.run.mock.calls.some(([, args]) => args.includes("create"))).toBe(false)
    expect(await readdir(f.root)).toEqual([])
  })

  it("never removes a container with different ownership evidence", async () => {
    const f = await fixture("claude-council", "ownership")
    expect((await Effect.runPromise(checkContainerSkills(f.document, target, f.run, f.root))).kind).toBe("unknown")
    expect(f.run.mock.calls.some(([, args]) => args.includes("rm"))).toBe(false)
    expect(await readdir(f.root)).toEqual([])
  })

  it("removes the owned stopped container and staging when comparison is cancelled", async () => {
    const started = await Effect.runPromise(Deferred.make<void>())
    const compare = Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never))
    const f = await fixture("claude-council", undefined, compare)
    const fiber = Effect.runFork(checkContainerSkills(f.document, target, f.run, f.root))
    await Effect.runPromise(Deferred.await(started))
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(f.exists()).toBe(false)
    expect(await readdir(f.root)).toEqual([])
  })
})
