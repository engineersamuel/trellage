import { describe, expect, it } from "vitest"

import { createInitialGuideRenderHandler } from "../src/guide-terminal.js"

describe("createInitialGuideRenderHandler", () => {
  it("clears and homes the alternate screen before the first frame only", () => {
    const writes: string[] = []
    const onRender = createInitialGuideRenderHandler((text) => writes.push(text), true)

    onRender()
    onRender()

    expect(writes).toEqual(["\u001B[2J\u001B[H"])
  })

  it("does not clear the terminal in screen-reader mode", () => {
    const writes: string[] = []
    const onRender = createInitialGuideRenderHandler((text) => writes.push(text), false)

    onRender()

    expect(writes).toEqual([])
  })
})
