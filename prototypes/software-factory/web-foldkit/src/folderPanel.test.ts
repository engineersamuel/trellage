import { expect, test, vi } from "vitest"
import { startFolderSidebar } from "../../shared/folders"

// The ☰ Conversations panel closes on a click outside it, not on a click inside it.
test("the Conversations panel closes on an outside click", () => {
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
      addEventListener() {}
    },
  )
  vi.stubGlobal("fetch", async () => new Response("[]", { headers: { "content-type": "application/json" } }))
  startFolderSidebar()
  const panel = document.querySelector<HTMLElement>(".sff-panel")!
  document.querySelector<HTMLElement>(".sff-toggle")!.click()
  expect(panel.hidden).toBe(false)
  panel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
  expect(panel.hidden).toBe(false)
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
  expect(panel.hidden).toBe(true)
  vi.unstubAllGlobals()
})
