import { Effect } from "effect"
import { expect, test, vi } from "vitest"
import type { FeedEvent } from "../../shared/feed"

const state = vi.hoisted(() => {
  const view: unknown = null
  return { subs: new Set<(event: FeedEvent) => void>(), posts: new Array<string>(), view }
})
vi.mock("../../shared/feed", async (original) => ({
  ...(await original<typeof import("../../shared/feed")>()),
  onFeed: (subscriber: (event: FeedEvent) => void) => (
    state.subs.add(subscriber),
    () => void state.subs.delete(subscriber)
  ),
}))
vi.mock("../../shared/http", async (original) => ({
  ...(await original<typeof import("../../shared/http")>()),
  json: () => Effect.sync(() => state.view),
  send: (url: string) => Effect.sync(() => void state.posts.push(url)),
}))

const { mountTournament } = await import("../../shared/protos/tournament-view")

const shot = (variant: string, build: number, viewport: string) => ({
  variant,
  label: variant === "a" ? "Skill A" : "Baseline",
  build,
  file: `/s/${variant}-${build}-${viewport}.png`,
  page: "index.html",
  viewport,
})
const view = (status: string) => ({
  id: "t-1",
  title: "UI skills",
  status,
  reason: null,
  spentUsd: 12.5,
  limitUsd: 400,
  leaderboardMd: "",
  leaderboard: [
    {
      id: "a",
      label: "Skill A",
      kind: "source",
      rating: 1120,
      vsBaseline: 0.66,
      games: 2,
      wins: 2,
      losses: 0,
      ties: 0,
      builds: [
        { n: 1, status: "ok" },
        { n: 2, status: "building" },
      ],
    },
  ],
  asset: { file: "index.html", kind: "html" },
  assets: {
    a: [{ build: 1, url: "/api/tournaments/t-1/builds/a/1/index.html", thumb: "/api/files/image?path=%2Fs%2Fa-1.png" }],
  },
  jobs: [{ id: "j2", kind: "round", status: status === "running" ? "running" : "done" }],
  gallery: {
    latest: {
      round: 2,
      scoreA: 0.75,
      reason: "gpt: A has calmer type",
      a: [shot("a", 1, "desktop"), shot("a", 1, "mobile")],
      b: [shot("baseline", 2, "desktop")],
    },
    best: [{ rank: 1, rating: 1120, shots: [shot("a", 1, "desktop")] }],
  },
})

// A tournament conversation pins its live leaderboard: the table, the newest judged pair, the best builds, Stop.
test("the leaderboard pin shows the table, the latest judged pair and the best builds, and updates live", async () => {
  state.view = view("running")
  const box = document.createElement("div")
  const stop = mountTournament(box, "t-1")
  await vi.waitFor(() =>
    expect(box.textContent).toContain("♛ Leaderboard · running · round running · $12.50 of $400.00"),
  )
  expect(box.querySelector("details")!.open).toBe(true)
  expect(box.querySelector("table")?.textContent).toContain("Skill A")
  // Each build's asset: its screenshot links to the live page; an unfinished build shows its mark.
  const asset = box.querySelector<HTMLAnchorElement>(".p3-tour-assets a")!
  expect(asset.getAttribute("href")).toBe("/api/tournaments/t-1/builds/a/1/index.html")
  expect(asset.querySelector("img")!.getAttribute("alt")).toBe("Skill A, build 1")
  expect(box.querySelector(".p3-tour-assets .p3-tour-mark")!.textContent).toBe("…")
  expect(box.textContent).toContain("Latest judged · round 2")
  expect(box.textContent).toContain("Skill A #1 · won 75% of aspects")
  expect(box.textContent).toContain("Baseline #2 · won 25% of aspects")
  expect(box.textContent).toContain("1. Skill A · 1120 · best build #1")
  expect([...box.querySelectorAll("img")].map((i) => i.getAttribute("alt"))).toContain("Skill A, build 1, mobile")
  expect(box.querySelector(".p3-tour-gallery img")!.getAttribute("src")).toBe(
    "/api/files/image?path=%2Fs%2Fa-1-desktop.png",
  )
  ;[...box.querySelectorAll("button")].find((b) => b.textContent === "■ Stop")!.click()
  expect(state.posts).toEqual(["/api/tournaments/t-1/stop"])
  state.view = view("done")
  state.subs.forEach((s) =>
    s({ seq: 2, workerId: "sub-x", type: "factory.tournament", agentId: null, timestamp: "", data: { id: "t-1" } }),
  )
  await vi.waitFor(() => expect(box.textContent).toContain("♛ Leaderboard · done · $12.50 of $400.00"))
  expect([...box.querySelectorAll("button")].some((b) => b.textContent === "■ Stop")).toBe(false)
  stop()
})
