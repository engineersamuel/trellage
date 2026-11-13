import { describe, expect, test } from "vitest"
import "./diffHighlight"

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("chat tool diffs", () => {
  test("a tool slot with an edit gets its diff; a read-only call stays empty", async () => {
    const slot = (tool: object) => {
      const e = document.createElement("div")
      e.className = "sf-tool-slot"
      e.dataset.sfTool = JSON.stringify(tool)
      document.body.append(e)
      return e
    }
    const edit = slot({
      name: "edit",
      args: JSON.stringify({ path: "a.ts", old_str: "x", new_str: "y" }),
      result: "ok",
    })
    const view = slot({ name: "view", args: "{}", result: "1. x" })
    await tick()
    expect(edit.className).toBe("sf-tool-slot")
    expect(edit.querySelectorAll(".dv-row.add, .dv-row.del").length).toBe(2)
    expect(view.children.length).toBe(0)
  })
})

describe("markdown preview", () => {
  test("a markdown diff has a Preview button that opens the rendered file", async () => {
    const { diffView } = await import("../../shared/diffview")
    const f = {
      path: "a/angles.md",
      op: "created" as const,
      added: 4,
      removed: 0,
      lines: [
        { kind: "add" as const, text: "# Angles", new: 1 },
        { kind: "add" as const, text: "| a | b |", new: 2 },
        { kind: "add" as const, text: "|---|---|", new: 3 },
        { kind: "add" as const, text: "| 1 | **x** |", new: 4 },
      ],
    }
    const view = diffView([f])
    document.body.append(view)
    view.querySelector<HTMLButtonElement>(".dv-preview-open")!.click()
    const dialog = document.querySelector("dialog.dv-preview")!
    expect(dialog.querySelector("h1")?.textContent).toBe("Angles")
    expect(dialog.querySelectorAll("td").length).toBe(2)
    expect(dialog.querySelector("strong")?.textContent).toBe("x")
    expect(diffView([{ ...f, path: "a.ts" }]).querySelector(".dv-preview-open")).toBeNull()
  })

  test("the preview escapes raw HTML and drops script links", async () => {
    const { openPreview } = await import("../../shared/diffview")
    const text = ["## Two", "", "<img src=x onerror=alert(1)>", "", "[l](javascript:alert(1))"]
    openPreview({
      path: "x.md",
      op: "created",
      added: 5,
      removed: 0,
      lines: text.map((t, i) => ({ kind: "add" as const, text: t, new: i + 1 })),
    })
    const body = [...document.querySelectorAll("dialog.dv-preview")].at(-1)!
    expect(body.querySelector("h2")?.textContent).toBe("Two")
    expect(body.querySelector("img")).toBeNull()
    expect(body.querySelector("a")?.getAttribute("href")).toBe("")
  })
})
