import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CONTROLS, type Grade } from "../../shared/accountability.ts"
import { AccountabilityDb, accountabilityRoutes } from "../src/accountability.ts"
import { factoryConfig } from "../src/config.ts"
import { makeHttpHandler } from "../src/http.ts"

const at = (iso: string) => Date.parse(iso)

const grade = (worker: string, patch: Partial<Grade> = {}): Grade => ({
  worker,
  owner: `sub-${worker}`,
  thread: `thread-${worker}`,
  goal: "goal-a",
  folderId: "folder-a",
  repo: "/repo/a",
  step: "implement",
  model: "model-a",
  harness: "copilot",
  modelSource: "pinned",
  roleCardSha256: null,
  startedAt: at("2026-11-20T10:00:00.000Z"),
  stoppedAt: at("2026-11-20T11:00:00.000Z"),
  costUsd: 1,
  budgetUsd: 4,
  controls: Object.fromEntries(CONTROLS.map(({ id }) => [id, { result: "pass" }])) as Grade["controls"],
  score: 1,
  engine: "fake",
  graderVersion: "test",
  gradedAt: at("2026-11-20T11:05:00.000Z"),
  extract: "",
  ...patch,
})

const api = (db: AccountabilityDb) =>
  makeHttpHandler(
    accountabilityRoutes(db, () => factoryConfig()),
    "http://localhost:5174/",
    "127.0.0.1:7700",
  )

const call = async (handle: ReturnType<typeof api>, pathname: string, init?: RequestInit) =>
  handle(new Request(`http://127.0.0.1:7700${pathname}`, init))

test("accountability API persists validated labels and computes calibration thresholds", async () => {
  const db = new AccountabilityDb(path.join(mkdtempSync(path.join(tmpdir(), "sf-accountability-api-")), "db.sqlite"))
  for (let i = 0; i < 20; i++) db.put(grade(`w-${i}`))
  const handle = api(db)

  for (let i = 0; i < 19; i++) db.label(`w-${i}`, "3.1", "pass", i)
  for (let i = 0; i < 20; i++) db.label(`w-${i}`, "3.5", i < 15 ? "pass" : "fail", i)
  for (let i = 0; i < 20; i++) db.label(`w-${i}`, "4.6", i < 16 ? "pass" : "fail", i)

  const calibration = await (await call(handle, "/api/accountability/calibration")).json()
  expect(calibration).toEqual(
    expect.arrayContaining([
      { control: "3.1", labels: 19, agree: 19, agreement: 1, calibrated: false },
      { control: "3.5", labels: 20, agree: 15, agreement: 0.75, calibrated: false },
      { control: "4.6", labels: 20, agree: 16, agreement: 0.8, calibrated: true },
    ]),
  )

  const saved = await call(handle, "/api/accountability/labels", {
    method: "POST",
    body: JSON.stringify({ worker: "w-0", control: "4.7", label: "fail" }),
  })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toEqual({
    worker: "w-0",
    control: "4.7",
    label: "fail",
    at: expect.any(Number),
  })
  expect(db.labels()).toContainEqual(expect.objectContaining({ worker: "w-0", control: "4.7", label: "fail" }))

  for (const body of [
    { worker: "missing", control: "4.7", label: "pass" },
    { worker: "w-0", control: "9.9", label: "pass" },
    { worker: "w-0", control: "4.7", label: "unknown" },
  ]) {
    expect(
      (
        await call(handle, "/api/accountability/labels", {
          method: "POST",
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(400)
  }
})

test("accountability API aggregates every dimension by day and week, including control scores", async () => {
  const db = new AccountabilityDb(path.join(mkdtempSync(path.join(tmpdir(), "sf-accountability-series-")), "db.sqlite"))
  db.put(grade("a", { score: 0.5, controls: { ...grade("x").controls, "4.6": { result: "fail" } } }))
  db.put(
    grade("b", {
      goal: "goal-b",
      folderId: "folder-b",
      repo: "/repo/b",
      step: "verify",
      model: "model-b",
      harness: "claude",
      modelSource: "routed",
      stoppedAt: at("2026-11-23T11:00:00.000Z"),
    }),
  )
  const handle = api(db)
  for (const dimension of ["model", "harness", "step", "repo", "goal", "modelSource"])
    for (const bucket of ["day", "week"]) {
      const response = await call(handle, `/api/accountability/series?dimension=${dimension}&bucket=${bucket}`)
      expect(response.status).toBe(200)
      const rows = (await response.json()) as {
        bucket: string
        value: string
        score: number | null
        n: number
      }[]
      expect(rows).toHaveLength(2)
      expect(rows.every((row) => row.n > 0)).toBe(true)
      expect(rows.every((row) => row.score !== null)).toBe(true)
    }

  const daily = (await (
    await call(handle, "/api/accountability/series?dimension=model&bucket=day&control=4.6")
  ).json()) as { value: string; score: number }[]
  expect(daily.find((row) => row.value === "model-a")?.score).toBe(0)
  expect(daily.find((row) => row.value === "model-b")?.score).toBe(1)
  expect((await call(handle, "/api/accountability/series?dimension=unknown&bucket=day")).status).toBe(400)
})

test("accountability API filters and pages workers and returns one worker", async () => {
  const db = new AccountabilityDb(
    path.join(mkdtempSync(path.join(tmpdir(), "sf-accountability-workers-")), "db.sqlite"),
  )
  db.put(grade("old", { stoppedAt: at("2026-11-19T11:00:00.000Z") }))
  db.put(grade("new", { stoppedAt: at("2026-11-21T11:00:00.000Z") }))
  db.put(grade("other", { step: "verify", stoppedAt: at("2026-11-22T11:00:00.000Z") }))
  const handle = api(db)

  const first = await (await call(handle, "/api/accountability/workers?step=implement&limit=1&offset=0")).json()
  const second = await (await call(handle, "/api/accountability/workers?step=implement&limit=1&offset=1")).json()
  expect(first).toMatchObject({ total: 2, rows: [{ worker: "new" }] })
  expect(second).toMatchObject({ total: 2, rows: [{ worker: "old" }] })

  const filtered = await (
    await call(
      handle,
      "/api/accountability/workers?model=model-a&harness=copilot&repo=%2Frepo%2Fa&goal=goal-a&modelSource=pinned&control=3.1&result=pass",
    )
  ).json()
  expect(filtered.total).toBe(3)
  expect((await call(handle, "/api/accountability/workers/new")).status).toBe(200)
  expect((await call(handle, "/api/accountability/workers/missing")).status).toBe(404)
  expect((await call(handle, "/api/accountability/workers?limit=0")).status).toBe(400)
})
