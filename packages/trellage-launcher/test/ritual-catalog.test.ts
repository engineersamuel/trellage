import { mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  filterRituals,
  loadRitualCatalog,
  parseRitualFile,
  requireRitual,
  shippedRituals,
} from "../src/ritual-catalog.ts"
import { copyTextToClipboard } from "../src/ritual-clipboard.ts"

const ritualFile = (title: string, when: string, prompt: string): string => `title: ${title}\nwhen: ${when}\n\n${prompt}\n`

describe("ritual catalog", () => {
  it("ships the progress page when the user directory is missing", async () => {
    const catalog = await loadRitualCatalog({ directory: path.join(tmpdir(), "missing-trellage-rituals") })
    expect(catalog.problems).toEqual([])
    expect(catalog.rituals.map((ritual) => ritual.id)).toEqual(["progress-page"])
    expect(requireRitual(catalog, "progress-page").prompt).toContain(".dashboard/index.html")
    expect(() => requireRitual(catalog, "missing")).toThrow(/No ritual named missing/u)
  })

  it("replaces a shipped ritual and keeps a bad file from hiding the list", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rituals-"))
    await writeFile(directory + "/progress-page.md", ritualFile("My page", "When I ask", "Write my page."))
    await writeFile(directory + "/review-diff.md", ritualFile("Review the diff", "Before you call it done", "Review the diff."))
    await writeFile(directory + "/Bad Name.md", ritualFile("Bad", "When", "Nope."))
    await writeFile(directory + "/empty-prompt.md", "title: Empty\nwhen: When\n\n   \n")
    await symlink(path.join(directory, "review-diff.md"), path.join(directory, "linked.md"))
    const catalog = await loadRitualCatalog({ directory })
    expect(requireRitual(catalog, "progress-page")).toMatchObject({ title: "My page", source: "user" })
    expect(requireRitual(catalog, "review-diff").source).toBe("user")
    expect(catalog.problems.map((entry) => entry.id).sort()).toEqual(["Bad Name.md", "empty-prompt", "linked"])
    expect(catalog.rituals.some((ritual) => ritual.id === "progress-page")).toBe(true)
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
