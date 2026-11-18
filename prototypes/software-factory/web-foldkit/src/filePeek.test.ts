import { afterEach, expect, test, vi } from "vitest"
import { looksLikePath, startFilePeek } from "../../shared/filepeek"

afterEach(() => vi.unstubAllGlobals())

test("looksLikePath: absolute and ~/ paths, not URLs, words or commands", () => {
  expect(looksLikePath("/Users/me/.trellage/worktrees/x/.factory/design.md")).toBe(true)
  expect(looksLikePath("~/notes.md")).toBe(true)
  expect(looksLikePath("/tmp/a.ts:12:3")).toBe(true)
  for (const s of ["ls", "parseContract", "//host/x", "/", "a/b.md", "/tmp/a b", "https://x.dev/a"])
    expect(looksLikePath(s)).toBe(false)
})

// A worker card names a file in inline code: the server confirms it, a 👁 button follows, and a click opens a modal.
test("a confirmed local path in a card gets a quick-look button that opens the file", async () => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
  const calls: string[] = []
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url)
    const file = new URL(url, "http://x").searchParams.get("path")
    if (file !== "/w/.factory/design.md") return new Response("{}", { status: 404 })
    const body = url.includes("content=1")
      ? { path: file, kind: "text", size: 8, text: "# Design", truncated: false }
      : { path: file, kind: "text", size: 8 }
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  })
  startFilePeek()
  const card = document.createElement("div")
  card.innerHTML =
    "<p>Now at <code>/w/.factory/design.md</code>, gone: <code>/w/missing</code>, <code>ls</code></p><pre><code>/w/.factory/design.md</code></pre>"
  document.body.append(card)
  await vi.waitFor(() => expect(card.querySelectorAll(".sf-peek")).toHaveLength(1))
  expect(card.querySelector("p code")!.nextElementSibling!.className).toBe("sf-peek")
  expect(card.querySelector("pre .sf-peek")).toBeNull()
  expect(calls.some((u) => u.includes("ls"))).toBe(false)
  card.querySelector<HTMLButtonElement>(".sf-peek")!.click()
  await vi.waitFor(() => expect(document.querySelector("dialog.dv-preview")).not.toBeNull())
  const d = document.querySelector("dialog.dv-preview")!
  expect(d.querySelector("b")!.textContent).toBe("design.md")
  expect(d.querySelector(".dv-preview-body")!.innerHTML).toContain("Design")
})
