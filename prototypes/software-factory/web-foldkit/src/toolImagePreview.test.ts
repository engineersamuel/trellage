import { expect, test } from "vitest"
import { startToolDiffs } from "../../shared/diffview"

// A finished tool call's slot in the chat: a Read of a screenshot shows a preview of the image.
test("a chat tool slot previews an image the call read, and an edit still gets its diff", async () => {
  startToolDiffs()
  const slot = (name: string, args: unknown, result: string) => {
    const s = document.createElement("div")
    s.dataset.sfTool = JSON.stringify({ name, args: JSON.stringify(args), result })
    document.body.append(s)
    return s
  }
  const read = slot("Read", { file_path: "/tmp/canopy1-jsyk/cart-m.png" }, "")
  const text = slot("Read", { file_path: "/tmp/notes.md" }, "hello")
  await new Promise((r) => setTimeout(r, 0))
  const img = read.querySelector("img")!
  expect(img.getAttribute("src")).toBe("/api/files/image?path=%2Ftmp%2Fcanopy1-jsyk%2Fcart-m.png")
  expect(img.getAttribute("alt")).toBe("cart-m.png")
  expect(read.querySelector("a")!.getAttribute("target")).toBe("_blank")
  expect(text.querySelector("img")).toBeNull()
  // A path the server refuses drops its preview.
  img.dispatchEvent(new Event("error"))
  expect(read.querySelector("img")).toBeNull()
})
