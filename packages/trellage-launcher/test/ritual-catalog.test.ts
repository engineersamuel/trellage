import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

import {
  filterRituals,
  loadRitualCatalog,
  parseRitualFile,
  requireRitual,
  ritualLimits,
  shippedRituals,
} from "../src/ritual-catalog.ts"
import { copyTextToClipboard } from "../src/ritual-clipboard.ts"

const ritualFile = (title: string, when: string, prompt: string): string => `title: ${title}\nwhen: ${when}\n\n${prompt}\n`
const ritualConfig = (id: string, title: string, when: string, prompt: string): string =>
  `[prompts.${id}]\ntitle = ${JSON.stringify(title)}\nwhen = ${JSON.stringify(when)}\nprompt = ${JSON.stringify(prompt)}\n`
const roots: string[] = []
const execFilePromise = promisify(execFile)
const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "rituals-"))
  roots.push(directory)
  const config = path.join(directory, "config.toml")
  const env = { HOME: directory, TRELLAGE_CONFIG: config }
  return { directory, config, env }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("ritual catalog", () => {
  it("ships the default rituals when user configuration is missing", async () => {
    const { directory, env } = await fixture()
    const catalog = await loadRitualCatalog({ directory: path.join(directory, "missing"), env })
    expect(catalog.problems).toEqual([])
    expect(catalog.rituals.map((ritual) => ritual.id)).toEqual(["progress-page", "app-performance"])
    expect(requireRitual(catalog, "progress-page").prompt).toContain(".dashboard/index.html")
    expect(requireRitual(catalog, "app-performance")).toMatchObject({
      title: "App performance",
      prompt: "Your job is to make this app faster. Improve the startup time, how fast each screen opens, how fast its content loads, and the scrolling, so everything feels lighter and older content loads faster. Find where the real performance gap is, apply the fixes, and benchmark before and after each one to see if it actually works or not.",
      source: "shipped",
    })
    expect(() => requireRitual(catalog, "missing")).toThrow(/No prompt named missing/u)
  })

  it("replaces a shipped ritual and keeps a bad file from hiding the list", async () => {
    const { directory, env } = await fixture()
    await writeFile(directory + "/progress-page.md", ritualFile("My page", "When I ask", "Write my page."))
    await writeFile(directory + "/review-diff.md", ritualFile("Review the diff", "Before you call it done", "Review the diff."))
    await writeFile(directory + "/Bad Name.md", ritualFile("Bad", "When", "Nope."))
    await writeFile(directory + "/empty-prompt.md", "title: Empty\nwhen: When\n\n   \n")
    await symlink(path.join(directory, "review-diff.md"), path.join(directory, "linked.md"))
    const catalog = await loadRitualCatalog({ directory, env })
    expect(requireRitual(catalog, "progress-page")).toMatchObject({ title: "My page", source: "user" })
    expect(requireRitual(catalog, "review-diff").source).toBe("user")
    expect(catalog.problems.map((entry) => entry.id).sort()).toEqual(["Bad Name.md", "empty-prompt", "linked"])
    expect(catalog.rituals.some((ritual) => ritual.id === "progress-page")).toBe(true)
  })

  it("loads TOML rituals afresh and gives them priority over Markdown and shipped defaults", async () => {
    const { directory, config, env } = await fixture()
    await writeFile(path.join(directory, "progress-page.md"), ritualFile("Legacy page", "Legacy", "Legacy prompt"))
    await writeFile(path.join(directory, "review-diff.md"), ritualFile("Legacy review", "Legacy", "Legacy review prompt"))
    const source = ritualConfig("progress-page", "Custom page", "Now", "My page.\n\nKeep this whitespace.  \n") +
      ritualConfig("review-diff", "Custom review", "Before delivery", "Review these changes.") +
      ritualConfig("check-tests", "Check tests", "After a change", "Run tests.")
    await writeFile(config, source, { mode: 0o600 })
    const catalog = await loadRitualCatalog({ directory, env })
    expect(catalog.problems).toEqual([])
    expect(catalog.rituals.map((ritual) => ritual.id)).toEqual([
      "progress-page", "app-performance", "review-diff", "check-tests",
    ])
    expect(requireRitual(catalog, "progress-page")).toMatchObject({
      title: "Custom page", prompt: "My page.\n\nKeep this whitespace.  \n", source: "user",
    })
    expect(requireRitual(catalog, "review-diff").title).toBe("Custom review")
    await writeFile(config, ritualConfig("progress-page", "Updated page", "Now", "Updated prompt"))
    const updated = await loadRitualCatalog({ directory, env })
    expect(requireRitual(updated, "progress-page").prompt).toBe("Updated prompt")
    expect(requireRitual(updated, "review-diff").title).toBe("Legacy review")
    expect(() => requireRitual(updated, "check-tests")).toThrow(/No prompt named/u)
  })

  it.each([
    { name: "default", file: ".config/trellage/config.toml", extra: {} },
    { name: "XDG", file: "xdg/trellage/config.toml", extra: { XDG_CONFIG_HOME: "xdg" } },
    { name: "home-relative override", file: "custom.toml", extra: { TRELLAGE_CONFIG: "~/custom.toml" } },
  ])("resolves $name configuration without loading unrelated catalog sections", async ({ file, extra }) => {
    const { directory } = await fixture()
    const config = path.join(directory, file)
    await mkdir(path.dirname(config), { recursive: true })
    await writeFile(config, '[native]\nunrecognized = true\n' + ritualConfig("custom", "Custom", "Now", "My prompt."), { mode: 0o600 })
    const catalog = await loadRitualCatalog({
      directory,
      env: { HOME: directory, ...extra, ...(extra.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: path.join(directory, "xdg") } : {}) },
    })
    expect(catalog.problems).toEqual([])
    expect(requireRitual(catalog, "custom").prompt).toBe("My prompt.")
  })

  it.each([
    'title = "Good"\nwhen = "Now"',
    'title = ""\nwhen = "Now"\nprompt = "Prompt"',
    'title = "Good"\nwhen = 1\nprompt = "Prompt"',
    'title = "Good"\nwhen = "Now"\nprompt = "   "',
    'title = "Good"\nwhen = "Now"\nprompt = "Prompt"\nunknown = true',
    'title = "Good"\nwhen = "Now"\nprompt = "\\u001b[31m"',
    `title = "${"a".repeat(ritualLimits.title + 1)}"\nwhen = "Now"\nprompt = "Prompt"`,
    `title = "Good"\nwhen = "${"a".repeat(ritualLimits.when + 1)}"\nprompt = "Prompt"`,
    `title = "Good"\nwhen = "Now"\nprompt = "${"a".repeat(ritualLimits.prompt + 1)}"`,
  ])("reports an invalid TOML entry without hiding valid rituals: %s", async (fields) => {
    const { directory, config, env } = await fixture()
    await writeFile(config, `[prompts.broken]\n${fields}\n` + ritualConfig("custom", "Custom", "Now", "Prompt"), { mode: 0o600 })
    const catalog = await loadRitualCatalog({ directory, env })
    expect(catalog.problems).toHaveLength(1)
    expect(catalog.problems[0]?.id).toBe("broken")
    expect(requireRitual(catalog, "custom").prompt).toBe("Prompt")
    expect(requireRitual(catalog, "progress-page").source).toBe("shipped")
    expect(() => requireRitual(catalog, "broken")).toThrow(/No prompt named broken/u)
  })

  it.each(["Bad Name", "a".repeat(ritualLimits.id + 1)])("rejects an invalid configured id: %s", async (id) => {
    const { directory, config, env } = await fixture()
    await writeFile(config, ritualConfig(JSON.stringify(id), "Title", "Now", "Prompt"), { mode: 0o600 })
    const catalog = await loadRitualCatalog({ directory, env })
    expect(catalog.problems).toEqual([{ id, message: "id: must be lowercase kebab-case" }])
  })

  it.each(["prompts = []", "prompts = 1", "[prompts]\nbroken = false"])("rejects malformed prompt structures: %s", async (source) => {
    const { directory, config, env } = await fixture()
    await writeFile(config, source, { mode: 0o600 })
    const catalog = await loadRitualCatalog({ directory, env })
    expect(catalog.problems).toHaveLength(1)
    expect(catalog.rituals).toEqual(shippedRituals)
  })

  it("bounds the number of configured rituals", async () => {
    const { directory, config, env } = await fixture()
    await writeFile(config, Array.from({ length: ritualLimits.entries + 1 }, (_, index) =>
      ritualConfig(`ritual-${index}`, "Title", "Now", "Prompt")).join("\n"), { mode: 0o600 })
    const catalog = await loadRitualCatalog({ directory, env })
    expect(catalog.problems).toEqual([{ id: "prompts", message: "prompts: Use at most 64 configured prompts." }])
    expect(catalog.rituals).toEqual(shippedRituals)
  })

  it("reports invalid overrides and preserves shipped defaults", async () => {
    const { directory, config, env } = await fixture()
    await writeFile(config, ritualConfig("app-performance", "App performance", "Now", ""), { mode: 0o600 })
    const catalog = await loadRitualCatalog({ directory, env })
    expect(catalog.problems[0]?.id).toBe("app-performance")
    expect(requireRitual(catalog, "app-performance").source).toBe("shipped")
  })

  it("reports malformed TOML without echoing config contents", async () => {
    const { directory, config, env } = await fixture()
    await writeFile(config, 'private = "do-not-echo', { mode: 0o600 })
    const catalog = await loadRitualCatalog({ directory, env })
    expect(catalog.problems).toEqual([{ id: "config.toml", message: "invalid Trellage config: malformed TOML" }])
    expect(catalog.rituals).toEqual(shippedRituals)
  })

  it("refuses unsafe config files", async () => {
    const { directory, config, env } = await fixture()
    const target = path.join(directory, "target.toml")
    await writeFile(target, ritualConfig("custom", "Custom", "Now", "Prompt"), { mode: 0o600 })
    await symlink(target, config)
    expect((await loadRitualCatalog({ directory, env })).problems[0]?.message).toMatch(/cannot read Trellage config/u)
    await rm(config)
    await writeFile(config, "", { mode: 0o600 })
    await chmod(config, 0o622)
    expect((await loadRitualCatalog({ directory, env })).problems[0]?.message).toMatch(/must not be writable/u)
  })

  it("keeps the example config rituals in sync with shipped defaults", async () => {
    const { directory } = await fixture()
    const catalog = await loadRitualCatalog({
      directory,
      env: { HOME: directory, TRELLAGE_CONFIG: path.resolve(import.meta.dirname, "../../../config.example.toml") },
    })
    expect(catalog.problems).toEqual([])
    expect(catalog.rituals).toEqual(shippedRituals.map((ritual) => ({ ...ritual, source: "user" })))
  })

  it("prints configured prompts exactly and reports invalid entries on stderr", async () => {
    const { directory, config, env } = await fixture()
    const cli = path.resolve(import.meta.dirname, "../src/cli.tsx")
    const print = () => execFilePromise(process.execPath, [
      "--no-install", "--no-env-file", cli, "guide", directory, "", "--prompts", "custom", "--print",
    ], { cwd: directory, env: { ...env, TRELLAGE_ENVIRONMENT: "off" }, timeout: 10_000 })
    await writeFile(config, ritualConfig("custom", "Custom", "Now", "First prompt.\n\nNext line.  \n"), { mode: 0o600 })
    expect(await print()).toMatchObject({ stdout: "First prompt.\n\nNext line.  \n", stderr: "" })
    await writeFile(config, ritualConfig("custom", "Custom", "Now", "Changed prompt.") +
      ritualConfig("broken", "Broken", "Now", ""))
    expect(await print()).toMatchObject({
      stdout: "Changed prompt.\n",
      stderr: "trellage-launcher: broken: broken prompt: must not be empty\n",
    })
  })

  it("rejects a ritual file that skips the blank line", () => {
    expect(() => parseRitualFile("review-diff", "title: Review\nwhen: Before done\nReview the diff.\n")).toThrow(/line 3/u)
  })

  it("filters by the title and the when line", () => {
    expect(filterRituals(shippedRituals, "SUBAGENT").map((ritual) => ritual.id)).toEqual(["progress-page"])
    expect(filterRituals(shippedRituals, "missing")).toEqual([])
    expect(filterRituals(shippedRituals, "  ")).toEqual(shippedRituals)
  })

  it("copies only when the clipboard read-back matches", () => {
    const written: string[] = []
    copyTextToClipboard("hello", {
      platform: "darwin",
      run: (_command, _args, input) => {
        written.push(input ?? "")
        return { status: 0 }
      },
      read: () => ({ ok: true, value: "hello" }),
    })
    expect(written).toEqual(["hello"])
    expect(() => copyTextToClipboard("hello", {
      platform: "darwin",
      run: () => ({ status: 0 }),
      read: () => ({ ok: true, value: "other" }),
    })).toThrow(/Clipboard verification failed/u)
  })
})
