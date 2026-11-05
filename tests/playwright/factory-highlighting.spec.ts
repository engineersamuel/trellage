import { expect, test } from "@playwright/test"
import "../bun-runtime.setup.ts"

const threadId = "factory-highlighting"
const code = `from typing import Any, Protocol, Sequence, TypeVar

class SupportsLessThan(Protocol):
    """Protocol for types that support the < operator."""
    def __lt__(self, other: Any, /) -> bool: ...

T = TypeVar("T", bound=SupportsLessThan)

def binary_search(arr: Sequence[T], target: T) -> int:
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] < target:
            lo = mid + 1
        elif target < arr[mid]:
            hi = mid - 1
        else:
            return mid
    return -1`

test.use({ channel: "chrome" })

test("Foldkit highlights saved OpenUI code automatically after reload", async ({ page }) => {
  const pageErrors: string[] = []
  const moduleFailures: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("response", (response) => {
    if (response.url().includes("/node_modules/") && response.status() >= 400) {
      moduleFailures.push(`${response.status()} ${response.url()}`)
    }
  })
  await page.route("**/api/threads/**", async (route) => {
    expect(route.request().method()).toBe("GET")
    const path = new URL(route.request().url()).pathname
    const json =
      path === "/api/threads/get"
        ? {
            threads: [{ id: threadId, title: "Highlighting regression", folderId: "general" }],
            folders: [{ id: "general", name: "General", kind: "general" }],
          }
        : [
            {
              id: "saved-code",
              role: "assistant",
              content: `root = Card([header, code])\nheader = InlineHeader("Selected: bs-typed", "Generic binary search")\ncode = CodeBlock("python", ${JSON.stringify(code)})`,
            },
          ]
    await route.fulfill({ json })
  })
  await page.route("**/api/agui**", () => {
    throw new Error("Highlighting must not start an agent run")
  })

  for (let load = 0; load < 2; load++) {
    if (load === 0) await page.goto("/")
    else await page.reload()
    await expect(page.locator(".fk-root")).toBeVisible()
    await page.evaluate((id) => {
      window.dispatchEvent(new CustomEvent("sf:open-thread", { detail: id }))
    }, threadId)
    const block = page.locator(".openui-code-block-wrapper").first()
    await expect(block.locator(".token").first()).toBeAttached()
    expect(await block.locator("code").textContent()).toBe(code)
    const colorsAndFonts = await block.evaluate((element) => {
      const codeElement = element.querySelector("code")!
      const tokens = [...element.querySelectorAll(".token")]
      return {
        codeColor: getComputedStyle(codeElement).color,
        tokenColors: [...new Set(tokens.map((token) => getComputedStyle(token).color))],
        codeFont: getComputedStyle(codeElement).fontFamily,
        tokenFonts: [...new Set(tokens.map((token) => getComputedStyle(token).fontFamily))],
      }
    })
    expect(colorsAndFonts.tokenColors.filter((color) => color !== colorsAndFonts.codeColor).length).toBeGreaterThan(1)
    expect(colorsAndFonts.tokenFonts).toEqual([colorsAndFonts.codeFont])
  }
  expect(pageErrors).toEqual([])
  expect(moduleFailures).toEqual([])
})
