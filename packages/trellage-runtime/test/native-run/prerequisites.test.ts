import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { ensurePrerequisites, missingPrerequisites, type PrerequisiteIo } from "../../src/native-run/prerequisites.ts"
import { prepareRun } from "../../src/native-run/run.ts"
import { gitSourceTransport } from "../../src/native-run/source.ts"
import { cleanupFixtures, fixturePaths, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)

const tool = { command: "fixture-tool", install: "install fixture-tool" }

const setup = async () => {
  const root = await tempRoot("prereq")
  const bin = path.join(root, "bin")
  await mkdir(bin)
  const environment = { PATH: bin, HOME: root }
  const lines: string[] = []
  const installed: string[] = []
  const io = (answer: boolean | undefined, creates = true): PrerequisiteIo => ({
    write: (line) => lines.push(line),
    ...(answer === undefined ? {} : { confirm: async () => answer }),
    install: async (command) => {
      installed.push(command)
      if (creates) {
        await writeFile(path.join(bin, "fixture-tool"), "#!/bin/sh\n")
        await chmod(path.join(bin, "fixture-tool"), 0o755)
      }
      return 0
    },
  })
  return { root, bin, environment, lines, installed, io }
}

test("present prerequisites pass without asking", async () => {
  const { bin, environment, io, installed } = await setup()
  await writeFile(path.join(bin, "fixture-tool"), "#!/bin/sh\n", { mode: 0o755 })
  expect(missingPrerequisites([tool], environment)).toEqual([])
  await ensurePrerequisites("Profile fm", [tool], environment, io(false))
  expect(installed).toEqual([])
})

test("missing prerequisites are listed and refused without a terminal or a yes", async () => {
  const { environment, io, lines, installed } = await setup()
  await expect(ensurePrerequisites("Profile fm", [tool], environment, io(undefined))).rejects.toThrow(/missing fixture-tool/)
  expect(lines).toContain("  fixture-tool  install: install fixture-tool")
  await expect(ensurePrerequisites("Profile fm", [tool], environment, io(false))).rejects.toThrow(/missing fixture-tool/)
  expect(installed).toEqual([])
})

test("a confirmed install runs the command and checks PATH again", async () => {
  const { environment, io, installed } = await setup()
  await ensurePrerequisites("Profile fm", [tool], environment, io(true))
  expect(installed).toEqual(["install fixture-tool"])
  const other = await setup()
  await expect(ensurePrerequisites("Profile fm", [tool], other.environment, other.io(true, false))).rejects.toThrow(
    /still not on PATH/,
  )
})

test("prepareRun checks profile prerequisites before launch but not on dry run", async () => {
  const { root, environment, io, lines } = await setup()
  const configPath = path.join(root, "config.toml")
  await writeFile(
    configPath,
    `[native.profiles.fm]\nprerequisites = [{ command = "fixture-tool", install = "install fixture-tool" }]\n`,
    { mode: 0o600 },
  )
  const dependencies = {
    environment: { ...environment, TRELLAGE_CONFIG: configPath },
    paths: await fixturePaths(root),
    cwd: root,
    transport: gitSourceTransport(() => {
      throw new Error("no sources")
    }),
    write: () => undefined,
    prerequisiteIo: io(undefined),
  }
  const options = { harness: "pi", profiles: ["fm"], allowUnprovenIsolation: true, forwardedArgs: [] }
  const dry = await prepareRun({ ...options, dryRun: true }, dependencies)
  expect(dry.missing).toEqual(["fixture-tool"])
  await expect(prepareRun({ ...options, dryRun: false }, dependencies)).rejects.toThrow(/missing fixture-tool/)
  expect(lines[0]).toBe("Profile fm needs 1 missing tool:")
})
