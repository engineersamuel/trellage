// "♛ Leaderboard" pin of a tournament conversation: the live leaderboard, the running job and the spend, always in
// the header. It reloads on every factory.tournament feed event of its tournament; open by default.
import "./timeline.css"
import { Effect, Schema } from "effect"
import { markdown } from "../decisions"
import { onFeed, RESYNC } from "../feed"
import { fire, json, runOr, send } from "../http"
import { el } from "./core"

const TYPE = "factory.tournament"

const GalleryShot = Schema.Struct({
  variant: Schema.String,
  label: Schema.String,
  build: Schema.Number,
  file: Schema.String,
  viewport: Schema.String,
})
type GalleryShot = typeof GalleryShot.Type

const View = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  reason: Schema.NullOr(Schema.String),
  spentUsd: Schema.Number,
  limitUsd: Schema.Number,
  leaderboardMd: Schema.String,
  leaderboard: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      kind: Schema.String,
      rating: Schema.Number,
      vsBaseline: Schema.Number,
      games: Schema.Number,
      wins: Schema.Number,
      losses: Schema.Number,
      ties: Schema.Number,
      builds: Schema.Array(Schema.Struct({ n: Schema.Number, status: Schema.String })),
    }),
  ),
  // Optional: a coordinator from before assets still draws the table with build marks.
  asset: Schema.optional(Schema.Struct({ file: Schema.String, kind: Schema.String })),
  assets: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ build: Schema.Number, url: Schema.String, thumb: Schema.NullOr(Schema.String) })),
    ),
  ),
  jobs: Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String, status: Schema.String })),
  gallery: Schema.Struct({
    latest: Schema.NullOr(
      Schema.Struct({
        round: Schema.Number,
        scoreA: Schema.Number,
        reason: Schema.NullOr(Schema.String),
        a: Schema.Array(GalleryShot),
        b: Schema.Array(GalleryShot),
      }),
    ),
    best: Schema.Array(Schema.Struct({ rank: Schema.Number, rating: Schema.Number, shots: Schema.Array(GalleryShot) })),
  }),
})
type View = typeof View.Type

const usd = (n: number) => `$${n.toFixed(2)}`
const imageUrl = (file: string) => `/api/files/image?path=${encodeURIComponent(file)}`

/** One build's shots side by side; each opens full size. */
const shotRow = (caption: string, shots: readonly GalleryShot[]): HTMLElement => {
  const fig = el("figure", "p3-tour-fig")
  const row = el("div", "p3-tour-shots")
  for (const s of shots) {
    const a = el("a") as HTMLAnchorElement
    a.href = imageUrl(s.file)
    a.target = "_blank"
    const img = el("img") as HTMLImageElement
    img.src = imageUrl(s.file)
    img.alt = `${s.label}, build ${s.build}, ${s.viewport}`
    img.loading = "lazy"
    a.append(img)
    row.append(a)
  }
  fig.append(row, el("figcaption", "p3-why", caption))
  return fig
}

const MARK: Record<string, string> = { ok: "✓", dropped: "✗", failed: "✗", pending: "·", building: "…" }

/**
 * The leaderboard: one row per variant, best first, with each build's asset (the preset's file: a page that opens
 * live, or a file) as its screenshot thumbnail. A build with no asset yet shows its status mark.
 */
export const leaderboardEl = (v: View): HTMLTableElement => {
  const table = el("table", "p3-tour-table") as HTMLTableElement
  const head = el("tr")
  for (const c of ["#", "Variant", "Rating", "Beats baseline", "W-L-T", "Builds"]) head.append(el("th", "", c))
  table.append(el("thead"), el("tbody"))
  table.tHead!.append(head)
  v.leaderboard.forEach((r, i) => {
    const tr = el("tr", r.kind === "baseline" ? "p3-tour-baseline" : "")
    const assets = v.assets?.[r.id] ?? []
    const cell = el("td", "p3-tour-assets")
    for (const b of r.builds) {
      const a = assets.find((x) => x.build === b.n)
      if (!a) {
        cell.append(el("span", "p3-tour-mark", MARK[b.status] ?? "?"))
        continue
      }
      const link = el("a") as HTMLAnchorElement
      link.href = a.url
      link.target = "_blank"
      link.rel = "noopener"
      link.title = `${r.label}, build ${b.n}: open ${v.asset?.file ?? "the asset"}${b.status === "dropped" ? " (dropped by the checks)" : ""}`
      if (v.asset?.kind === "file") link.download = ""
      if (a.thumb) {
        const img = el("img") as HTMLImageElement
        img.src = a.thumb
        img.alt = `${r.label}, build ${b.n}`
        img.loading = "lazy"
        link.append(img)
      } else link.textContent = `#${b.n} ↗`
      if (b.status === "dropped") link.classList.add("p3-tour-dropped")
      cell.append(link)
    }
    tr.append(
      el("td", "", String(i + 1)),
      el("td", "", r.label),
      el("td", "", r.games ? String(r.rating) : "-"),
      el("td", "", r.kind === "baseline" || !r.games ? "-" : `${Math.round(r.vsBaseline * 100)}%`),
      el("td", "", `${r.wins}-${r.losses}-${r.ties}`),
      cell,
    )
    table.tBodies[0]!.append(tr)
  })
  return table
}

/** The newest judged pair and the best builds so far. */
const galleryEl = (g: View["gallery"]): HTMLElement => {
  const box = el("div", "p3-tour-gallery")
  if (g.latest?.a.length && g.latest.b.length) {
    const a = g.latest.a[0]!
    const b = g.latest.b[0]!
    box.append(
      el("h4", "", `Latest judged · round ${g.latest.round}`),
      shotRow(`${a.label} #${a.build} · won ${Math.round(g.latest.scoreA * 100)}% of aspects`, g.latest.a),
      shotRow(`${b.label} #${b.build} · won ${Math.round((1 - g.latest.scoreA) * 100)}% of aspects`, g.latest.b),
      ...(g.latest.reason ? [el("p", "p3-why", g.latest.reason)] : []),
    )
  }
  if (g.best.length) {
    box.append(el("h4", "", "Best so far"))
    for (const x of g.best)
      if (x.shots[0])
        box.append(shotRow(`${x.rank}. ${x.shots[0].label} · ${x.rating} · best build #${x.shots[0].build}`, x.shots))
  }
  return box
}

/** One line under the title: status, the running job, spend of limit. */
export const tournamentLine = (v: View): string => {
  const job = [...v.jobs].reverse().find((j) => j.status === "running")
  return [v.status, job && `${job.kind} running`, `${usd(v.spentUsd)} of ${usd(v.limitUsd)}`]
    .filter(Boolean)
    .join(" · ")
}

export const mountTournament = (box: HTMLElement, tournamentId: string): (() => void) => {
  box.classList.add("p3-pins")
  box.dataset.testid = "tournament"
  const url = `/api/tournaments/${encodeURIComponent(tournamentId)}`
  let shown = ""
  const render = (v: View) => {
    const key = JSON.stringify(v)
    if (key === shown) return
    shown = key
    const prev = box.querySelector<HTMLDetailsElement>('[data-pin="tournament"]')
    const d = el("details", "p3-pin")
    d.dataset.pin = "tournament"
    d.open = prev ? prev.open : true
    const summary = el("summary", "p3-ell", `♛ Leaderboard · ${tournamentLine(v)}`)
    if (v.status === "running") {
      const stop = el("button", "p3-pin-btn", "■ Stop")
      // Inside <summary>: do not toggle the disclosure.
      stop.onclick = (e) => (e.preventDefault(), e.stopPropagation(), fire(send(`${url}/stop`, "POST", {})))
      summary.append(stop)
    }
    const doc = el("div", "p3-pin-doc sfd-summary")
    doc.append(leaderboardEl(v))
    if (v.reason) doc.append(Object.assign(el("div"), { innerHTML: markdown(v.reason) }))
    d.append(summary, doc, galleryEl(v.gallery))
    box.replaceChildren(d)
  }
  let gen = 0
  const load = () => {
    const mine = ++gen
    void runOr(json(url, View).pipe(Effect.map((v) => mine === gen && render(v))), undefined)
  }
  const offFeed = onFeed((ev) => {
    const id = (ev.data as { id?: unknown } | null)?.id
    if (ev.type === RESYNC || (ev.type === TYPE && id === tournamentId)) load()
  })
  load()
  return () => (offFeed(), (gen = -1))
}
