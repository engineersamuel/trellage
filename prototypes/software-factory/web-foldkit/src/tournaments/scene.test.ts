import { Command, Mount, Subscription, click, expect, given, label, role, scene, submit, type } from "foldkit/scene"
import { Dialog } from "@foldkit/ui"
import { Option } from "effect"
import { assert, describe, test } from "vitest"
import { ControlTournament, CreateTournament, FetchTournament, FetchTournaments } from "./command"
import { type TournamentList, type TournamentView, parseSources } from "./domain"
import { Message } from "./message"
import { init, update } from "./update"
import { view } from "./view"

const shot = { page: "index.html", viewport: "desktop", file: "/s/t/shots/a-1-index-desktop.png" }
const tournament: TournamentView = {
  id: "t-1",
  title: "UI skills: 1 sources",
  threadId: "abcdef12-0000",
  status: "paused",
  reason: "cost limit reached",
  spentUsd: 12,
  limitUsd: 10,
  running: false,
  cards: { "https://github.com/o/a": { source: "https://github.com/o/a", status: "ok" } },
  checks: { renders: "Renders" },
  log: [{ at: 0, text: "scout a: ok" }],
  leaderboard: [
    {
      id: "a",
      label: "Skill A",
      kind: "source",
      generation: 0,
      rating: 1120,
      vsBaseline: 0.66,
      games: 2,
      wins: 2,
      losses: 0,
      ties: 0,
      rubric: { typography: 8 },
      builds: [{ n: 1, status: "ok", checks: { renders: 0.97 }, shots: [shot] }],
      skills: ["a-skill"],
      sources: ["https://github.com/o/a"],
      reasons: ["gpt: A has calmer type"],
    },
    {
      id: "baseline",
      label: "No skill (baseline)",
      kind: "baseline",
      generation: 0,
      rating: 1000,
      vsBaseline: 0.5,
      games: 2,
      wins: 0,
      losses: 2,
      ties: 0,
      rubric: {},
      builds: [{ n: 1, status: "failed", error: "pages missing", shots: [] }],
      skills: [],
      sources: [],
      reasons: [],
    },
  ],
}
const list: TournamentList = [
  {
    id: "t-1",
    title: "UI skills: 1 sources",
    threadId: "abcdef12-0000",
    createdAt: 0,
    status: "paused",
    reason: null,
    variants: 2,
    spentUsd: 12,
    limitUsd: 10,
    leader: "Skill A",
    running: false,
  },
]

const openDialog = [
  Subscription.emit(Message.ClickedOpenTournaments()),
  Command.resolve(FetchTournaments, Message.SucceededFetchTournaments({ tournaments: list })),
  Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
  Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
] as const

describe("tournaments dialog", () => {
  test("sources parse one per line without comments or bullets", () => {
    assert.deepEqual(parseSources("* https://a.dev/x\n# note\n- https://github.com/o/r  # why\n"), [
      "https://a.dev/x",
      "https://github.com/o/r",
    ])
  })

  test("starting a tournament needs a source, then opens its leaderboard", () => {
    scene(
      { update, view },
      given(init().model),
      ...openDialog,
      submit(role("form")),
      expect(role("alert")).toHaveText("Add at least one source URL."),
      type(label("Skill sources, one URL per line"), "https://github.com/o/a"),
      type(label("Cost limit (USD)"), "50"),
      submit(role("form")),
      Command.resolve(
        CreateTournament({
          preset: "ui-skills",
          sources: ["https://github.com/o/a"],
          idea: "https://github.com/o/a",
          maybeLimitUsd: Option.some(50),
        }),
        Message.SucceededCreateTournament({ tournament }),
      ),
      Command.resolveAll(
        [FetchTournament({ id: "t-1" }), Message.SucceededFetchTournament({ tournament })],
        [FetchTournaments, Message.SucceededFetchTournaments({ tournaments: list })],
      ),
      expect(role("heading", { name: "UI skills: 1 sources" })).toExist(),
      expect(role("link", { name: "Open conversation ↗" })).toHaveAttr("href", "/?thread=abcdef12-0000"),
      expect(role("cell", { name: "1120" })).toExist(),
      expect(role("cell", { name: "66%" })).toExist(),
    )
  })

  test("the prototypes kind takes an idea instead of source URLs", () => {
    scene(
      { update, view },
      given(init().model),
      ...openDialog,
      click(role("button", { name: "Prototypes of an idea" })),
      submit(role("form")),
      expect(role("alert")).toHaveText("Describe the idea."),
      type(label("The idea"), "A shared grocery list"),
      submit(role("form")),
      Command.resolve(
        CreateTournament({
          preset: "prototypes",
          sources: ["A shared grocery list"],
          idea: "A shared grocery list",
          maybeLimitUsd: Option.none(),
        }),
        Message.SucceededCreateTournament({ tournament: { ...tournament, title: "A shared grocery list" } }),
      ),
      Command.resolveAll(
        [
          FetchTournament({ id: "t-1" }),
          Message.SucceededFetchTournament({ tournament: { ...tournament, title: "A shared grocery list" } }),
        ],
        [FetchTournaments, Message.SucceededFetchTournaments({ tournaments: list })],
      ),
      expect(role("heading", { name: "A shared grocery list" })).toExist(),
    )
  })

  test("a row opens its builds and screenshots; a paused tournament resumes with a new limit", () => {
    scene(
      { update, view },
      given(init().model),
      ...openDialog,
      click(role("button", { name: "Open tournament t-1" })),
      Command.resolve(FetchTournament({ id: "t-1" }), Message.SucceededFetchTournament({ tournament })),
      click(role("button", { name: "Show builds of Skill A" })),
      expect(role("img", { name: "Skill A, build 1: index.html on desktop" })).toExist(),
      expect(role("heading", { name: "Build 1: ok · Renders 97%" })).toExist(),
      type(label("New limit (USD)"), "40"),
      click(role("button", { name: "Resume" })),
      Command.resolve(
        ControlTournament({ id: "t-1", action: "resume", maybeLimitUsd: Option.some(40) }),
        Message.SucceededControl({ tournament: { ...tournament, status: "building", running: true, limitUsd: 40 } }),
      ),
      Command.resolve(FetchTournaments, Message.SucceededFetchTournaments({ tournaments: list })),
      expect(role("button", { name: "Stop" })).toExist(),
    )
  })
})
