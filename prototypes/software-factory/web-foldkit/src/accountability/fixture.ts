// Payloads shaped like the coordinator's real /api/accountability/* replies: field names and types come from
// shared/accountability.ts (the schemas the routes in coordinator/src/accountability.ts serialize).
import { CONTROLS, type Calibration, type Grade, type SeriesPoint } from "./domain"

export const NOW = Date.parse("2026-11-24T12:00:00.000Z")

export const series: ReadonlyArray<SeriesPoint> = [
  { bucket: "2026-11-20", value: "gpt", score: 0.5, n: 2 },
  { bucket: "2026-11-21", value: "gpt", score: 0.75, n: 4 },
  { bucket: "2026-11-20", value: "opus", score: 1, n: 1 },
  { bucket: "2026-11-21", value: "opus", score: 0.25, n: 4 },
]

const pass = { result: "pass" } as const
const controls: Grade["controls"] = {
  "3.1": pass,
  "3.5": { result: "fail", value: 2.5 },
  "4.2": pass,
  "4.6": { result: "pass", p: 0.9 },
  "4.7": { result: "pass", p: 0.8 },
  "4.8/4.9": pass,
  "5.2/6.3": { result: "unknown" },
  "5.5": { result: "n/a" },
}

export const grade = (worker: string, score: number, step = "implement"): Grade => ({
  worker,
  owner: "coordinator",
  thread: "t1",
  goal: null,
  folderId: "trellage",
  repo: "trellage",
  step,
  model: "gpt",
  harness: "claude",
  modelSource: "proxy",
  roleCardSha256: null,
  startedAt: NOW - 3_600_000,
  stoppedAt: NOW - 60_000,
  costUsd: 1.25,
  budgetUsd: 2,
  controls,
  score,
  engine: "jev",
  graderVersion: "1",
  gradedAt: NOW,
  extract: "",
})

export const calibration: ReadonlyArray<Calibration> = CONTROLS.map(({ id }) =>
  id === "3.5"
    ? { control: id, labels: 20, agree: 16, agreement: 0.8, calibrated: true }
    : { control: id, labels: 3, agree: 2, agreement: 2 / 3, calibrated: false },
)
