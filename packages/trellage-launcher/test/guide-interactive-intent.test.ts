import { execFileSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { GuideArgsError, guideIntentMaximumLength, parseGuideHeadlessArgv } from "../src/guide-api.js"
import {
  consumePopupGuideIntentFile,
  popupGuideIntentFileEnvironmentVariable,
  resolveInteractiveGuideIntent,
} from "../src/guide-interactive-intent.js"
import type { HerdrContext } from "../src/guide-launch.js"

const temporaryRoots: string[] = []
const popupContext: HerdrContext = {
  workspaceId: "w1",
  paneId: "w1:p1",
  surface: "popup",
  cwd: "/repo",
}

const createIntentFixture = async (content: string): Promise<{
  readonly root: string
  readonly intentPath: string
}> => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-guide-intent-"))
  temporaryRoots.push(root)
  const directory = path.join(root, "guide-intents")
  const intentPath = path.join(directory, "11111111-1111-4111-8111-111111111111.txt")
  await mkdir(directory, { mode: 0o700 })
  await writeFile(intentPath, content, { mode: 0o600 })
  return { root, intentPath }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("consumePopupGuideIntentFile", () => {
  it("consumes a private multiline Unicode intent at the character limit", async () => {
    const intent = `${"😀".repeat(guideIntentMaximumLength - 2)}\n😀`
    const { root, intentPath } = await createIntentFixture(intent)

    expect(await consumePopupGuideIntentFile(root, intentPath)).toBe(intent)
    await expect(readFile(intentPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects paths outside the private guide-intents directory", async () => {
    const { root } = await createIntentFixture("safe")
    const outsidePath = path.join(root, "outside.txt")
    await writeFile(outsidePath, "outside", { mode: 0o600 })

    await expect(consumePopupGuideIntentFile(root, outsidePath)).rejects.toThrow(/outside/u)
    expect(await readFile(outsidePath, "utf8")).toBe("outside")
  })

  it("rejects a symbolic-link intent without consuming its target", async () => {
    const { root, intentPath } = await createIntentFixture("target")
    const targetPath = path.join(root, "target.txt")
    await writeFile(targetPath, "target", { mode: 0o600 })
    await rm(intentPath)
    await symlink(targetPath, intentPath)

    await expect(consumePopupGuideIntentFile(root, intentPath)).rejects.toThrow(/cannot be opened safely/u)
    expect(await readFile(targetPath, "utf8")).toBe("target")
  })

  it("rejects a FIFO without waiting for a writer", async () => {
    const { root, intentPath } = await createIntentFixture("placeholder")
    await rm(intentPath)
    execFileSync("mkfifo", [intentPath])
    await chmod(intentPath, 0o600)

    await expect(consumePopupGuideIntentFile(root, intentPath)).rejects.toThrow(/regular file/u)
  })

  it("rejects a linked guide-intents directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "trellage-guide-intent-link-"))
    temporaryRoots.push(root)
    const target = path.join(root, "target")
    const filename = "11111111-1111-4111-8111-111111111111.txt"
    const intentPath = path.join(target, filename)
    await mkdir(target, { mode: 0o700 })
    await writeFile(intentPath, "target", { mode: 0o600 })
    await symlink(target, path.join(root, "guide-intents"))

    await expect(
      consumePopupGuideIntentFile(root, path.join(root, "guide-intents", filename)),
    ).rejects.toThrow(/directory/u)
  })

  it("rejects permissive intent files and directories", async () => {
    const fileFixture = await createIntentFixture("unsafe file")
    await chmod(fileFixture.intentPath, 0o644)
    await expect(consumePopupGuideIntentFile(fileFixture.root, fileFixture.intentPath)).rejects.toThrow(
      /mode-0600/u,
    )

    const directoryFixture = await createIntentFixture("unsafe directory")
    await chmod(path.dirname(directoryFixture.intentPath), 0o755)
    await expect(consumePopupGuideIntentFile(directoryFixture.root, directoryFixture.intentPath)).rejects.toThrow(
      /mode-0700/u,
    )
  })
})

describe("resolveInteractiveGuideIntent", () => {
  it("uses one popup intent source and removes its environment capability", async () => {
    const intent = "First line\n\nSecond line"
    const { root, intentPath } = await createIntentFixture(intent)
    const env = {
      HERDR_PLUGIN_STATE_DIR: root,
      [popupGuideIntentFileEnvironmentVariable]: intentPath,
    }

    await expect(
      resolveInteractiveGuideIntent({
        args: parseGuideHeadlessArgv([]),
        herdrContext: popupContext,
        env,
        readStdin: async () => {
          throw new Error("stdin must remain attached to the terminal")
        },
      }),
    ).resolves.toBe(intent)
    expect(env[popupGuideIntentFileEnvironmentVariable]).toBeUndefined()
  })

  it("rejects mixed explicit and popup intent sources", async () => {
    const { root, intentPath } = await createIntentFixture("popup")
    const env = {
      HERDR_PLUGIN_STATE_DIR: root,
      [popupGuideIntentFileEnvironmentVariable]: intentPath,
    }

    await expect(
      resolveInteractiveGuideIntent({
        args: parseGuideHeadlessArgv(["--intent", "explicit"]),
        herdrContext: popupContext,
        env,
        readStdin: async () => "",
      }),
    ).rejects.toBeInstanceOf(GuideArgsError)
    expect(await readFile(intentPath, "utf8")).toBe("popup")
  })

  it("rejects popup intent files outside a validated Herdr popup", async () => {
    const { root, intentPath } = await createIntentFixture("popup")

    await expect(
      resolveInteractiveGuideIntent({
        args: parseGuideHeadlessArgv([]),
        herdrContext: null,
        env: {
          HERDR_PLUGIN_STATE_DIR: root,
          [popupGuideIntentFileEnvironmentVariable]: intentPath,
        },
        readStdin: async () => "",
      }),
    ).rejects.toBeInstanceOf(GuideArgsError)
  })
})
