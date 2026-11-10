import { describe, expect, test } from "vitest"
import type { Worker } from "../domain"
import { critterOf, critterSvg } from "../../../shared/critter"

const worker: Worker = {
  id: "w1",
  name: "fix feed",
  role: "worker",
  status: "running",
  auth: "native",
  model: "claude-opus-5.5",
  pid: 1,
  rssKb: null,
}

describe("critterOf", () => {
  test("a running worker shows its SDLC step", () => {
    expect(critterOf({ ...worker, step: "verify" }).state).toBe("verify")
    expect(critterOf({ ...worker, step: "hyperresearch" }).state).toBe("research")
    expect(critterOf({ ...worker, step: "finish" }).state).toBe("done")
  })

  test("status wins over the step", () => {
    expect(critterOf({ ...worker, step: "verify", status: "error" }).state).toBe("error")
    expect(critterOf({ ...worker, step: "verify", status: "idle" }).state).toBe("idle")
  })

  test("headgear shows the role, colour the model family", () => {
    expect(critterOf({ ...worker, id: "coordinator", role: "coordinator" }).hat).toBe("headset")
    expect(critterOf({ ...worker, id: "sub-1", role: "coordinator" }).hat).toBe("flag")
    expect(critterOf({ ...worker, id: "gen-1" }).hat).toBe("bubble")
    expect(critterOf(worker)).toMatchObject({ hat: "hardhat", body: "#dba985" })
    expect(critterOf({ ...worker, model: "gpt-6" }).body).toBe("#8fbfae")
  })
})

describe("critterSvg", () => {
  test("every state draws valid SVG at any time", () => {
    const states = [
      "research",
      "plan",
      "implement",
      "verify",
      "review",
      "security",
      "spawn",
      "waiting",
      "idle",
      "error",
      "done",
    ] as const
    for (const state of states)
      for (const t of [0, 0.7, 3.31]) {
        const svg = new DOMParser().parseFromString(
          critterSvg({ state, hat: "hardhat", body: "#fff" }, t),
          "image/svg+xml",
        )
        expect(svg.querySelector("parsererror"), `${state} at ${t}`).toBeNull()
      }
  })

  test("the eyes follow a near mouse only while working with open eyes", () => {
    const toMouse = { x: 1, y: 0, weight: 1 }
    const pupils = (svg: string) => svg.match(/<circle cx="([\d.]+)" cy="[\d.]+" r="[\d.]+" fill="#2b2b33"\/>/)?.[1]
    // t = 1: eyes open (no blink).
    const work = { state: "implement", hat: "hardhat", body: "#fff" } as const
    expect(Number(pupils(critterSvg(work, 1, toMouse)))).toBeGreaterThan(Number(pupils(critterSvg(work, 1))))
    const idle = { ...work, state: "idle" } as const
    expect(critterSvg(idle, 1, toMouse)).toBe(critterSvg(idle, 1))
    const waiting = { ...work, state: "waiting" } as const
    expect(critterSvg(waiting, 1, toMouse)).toBe(critterSvg(waiting, 1))
    // t = 0: mid-blink, eyes closed.
    expect(critterSvg(work, 0, toMouse)).toBe(critterSvg(work, 0))
  })
})
