// Connector lines of the Inbox conversation tree, drawn in one SVG layer (setting `treeStyle`).
// Each elbow is measured from its number badge, and a trunk stops at its last elbow.
// Markup contract: a parent element has `data-tl="<id>"`; each child has `data-tl-parent="<parent id>"`,
// `data-tl-id` and `data-tl-status`. A line ends at the child's left edge, level with its header row (or the row itself).

export const TREE_STYLES = ["classic", "tree", "vine"] as const
export type TreeStyle = (typeof TREE_STYLES)[number]
export const TREE_STYLE_LABELS: Record<TreeStyle, string> = {
  classic: "Classic",
  tree: "Growing tree",
  vine: "Ivy vine",
}

let chosen: TreeStyle = "tree"
const listeners = new Set<() => void>()
export const treeStyle = (): TreeStyle => chosen
/** Hosts call this with `settings.treeStyle` whenever settings load or change; open trees redraw. */
export const setTreeStyle = (s: TreeStyle): void => {
  if (s === chosen) return
  chosen = s
  listeners.forEach((redraw) => redraw())
}
export const onTreeStyle = (redraw: () => void): (() => void) => (
  listeners.add(redraw),
  () => void listeners.delete(redraw)
)

type Kid = { id: string; x: number; y: number; status: string }
type Group = { id: string; x: number; y: number; kids: Kid[] }

const groups = (host: HTMLElement): Group[] => {
  // The layer scrolls with the content: measure from the content origin, not the visible top, so a redraw while scrolled stays aligned.
  const r = host.getBoundingClientRect()
  const H = { left: r.left - host.scrollLeft, top: r.top - host.scrollTop }
  return [...host.querySelectorAll<HTMLElement>("[data-tl]")].flatMap((parent) => {
    const id = parent.dataset.tl!
    const kidEls = [...host.querySelectorAll<HTMLElement>(`[data-tl-parent="${CSS.escape(id)}"]`)]
    if (!kidEls.length) return []
    const p = parent.getBoundingClientRect()
    const kids = kidEls.map((k) => {
      const b = (k.querySelector(":scope > .p3-row") ?? k).getBoundingClientRect()
      return {
        id: k.dataset.tlId ?? "",
        x: k.getBoundingClientRect().left - H.left - 1,
        y: (b.top + b.bottom) / 2 - H.top,
        status: k.dataset.tlStatus ?? "idle",
      }
    })
    // Children inside the parent (a sub-coordinator card): start just above the first child; else at the parent's bottom.
    const inside = parent.contains(kidEls[0]!)
    const y = inside ? kidEls[0]!.getBoundingClientRect().top - H.top - 4 : p.bottom - H.top
    return [{ id, x: p.left - H.left + (inside ? 12 : 14), y, kids }]
  })
}

/** Growth replays only for branches seen in the last GROW_S seconds, from where it was, so redraws do not restart it. */
const GROW_S = 2.2
const ease = (born: Map<string, number>, id: string, base: number, now: number): string => {
  const t0 = born.get(id) ?? (born.set(id, now), now)
  const age = (now - t0) / 1000
  return age < GROW_S ? `grow" style="--delay:${(base - age).toFixed(2)}s` : ""
}

const path = (d: string, attrs: string) => `<path d="${d}" pathLength="1" fill="none" ${attrs}/>`
const at = (x: number, y: number, inner: string) =>
  `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">${inner}</g>`
const last = (g: Group) => g.kids[g.kids.length - 1]!.y

const classic = (gs: Group[]): string =>
  gs
    .map((g) => {
      const s = `style="stroke:var(--p3-line)" stroke-width="1.25"`
      return (
        `<path d="M${g.x} ${g.y} V${last(g)}" fill="none" ${s}/>` +
        g.kids.map((k) => `<path d="M${g.x} ${k.y} H${k.x}" fill="none" ${s}/>`).join("")
      )
    })
    .join("")

const growingTree = (gs: Group[], born: Map<string, number>, now: number): string =>
  gs
    .map((g, gi) => {
      const { x, y: y0 } = g,
        y1 = last(g)
      const w0 = gi === 0 ? 6 : 4.5,
        w1 = 1.6
      const trunk = `<path d="M${x - w0 / 2} ${y0} C${x - w0 / 2 + 1} ${(y0 + y1) / 2} ${x - w1} ${y1 - 10} ${x - w1 / 2} ${y1} L${x + w1 / 2} ${y1} C${x + w1} ${y1 - 10} ${x + w0 / 2 - 1} ${(y0 + y1) / 2} ${x + w0 / 2} ${y0}Z" fill="#7a5c3e"/>`
      return (
        trunk +
        g.kids
          .map((k, i) => {
            const dl = 0.15 + i * 0.12
            const by = Math.max(y0 + 2, k.y - 7)
            const branch = path(
              `M${x} ${by} C${x} ${k.y - 1} ${x + 4} ${k.y} ${k.x} ${k.y}`,
              `stroke="#7a5c3e" stroke-width="2.4" stroke-linecap="round" class="${ease(born, k.id, dl, now)}"`,
            )
            const col =
              k.status === "error" ? "#a0682f" : k.status === "running" || k.status === "needs" ? "#6fcf73" : "#4f8a55"
            const leaf = (lx: number, ly: number, rot: number) =>
              `<path d="M0 0 Q5 -5 10 0 Q5 5 0 0Z" fill="${col}" transform="translate(${lx} ${ly}) rotate(${rot})"/>`
            const mx = (x + k.x) / 2 + 1
            const leaves =
              k.status === "error"
                ? at(mx, k.y + 3, `<g class="droop">${leaf(0, 0, 0)}</g>`)
                : at(
                    mx,
                    k.y - 3,
                    `<g class="${k.status === "running" ? "sway" : ""}">${leaf(0, 0, -50)}${leaf(4, 1, 20)}</g>`,
                  )
            return branch + leaves
          })
          .join("")
      )
    })
    .join("")

const ivyVine = (gs: Group[], born: Map<string, number>, now: number): string =>
  gs
    .map((g) => {
      const { x, y: y0 } = g,
        y1 = last(g)
      const wob = (y: number) => x + Math.sin((y - y0) / 9) * 3
      let d = `M${x} ${y0}`
      for (let y = y0 + 4; y <= y1; y += 4) d += ` L${wob(y).toFixed(1)} ${y}`
      const vine = path(
        d,
        `stroke="#4f9a5a" stroke-width="2" stroke-linecap="round" class="${ease(born, `vine:${g.id}`, 0, now)}" `,
      )
      const leaves: string[] = []
      for (let y = y0 + 12, i = 0; y < y1 - 6; y += 16, i++) {
        const side = i % 2 ? 1 : -1
        leaves.push(at(wob(y), y, `<path d="M0 0 Q${4 * side} -6 ${9 * side} -2 Q${4 * side} 2 0 0Z" fill="#5fb36a"/>`))
      }
      const tendrils = g.kids
        .map((k, i) => {
          const sx = wob(k.y)
          const t = path(
            `M${sx} ${k.y + 3} C${sx + 6} ${k.y + 8} ${k.x - 8} ${k.y + 6} ${k.x - 4} ${k.y} M${sx + 6} ${k.y + 6} c2 3 5 2 4 -1 c-1 -2 -3 -1 -2 1`,
            `stroke="#4f9a5a" stroke-width="1.5" stroke-linecap="round" class="${ease(born, k.id, 0.4 + i * 0.15, now)}"`,
          )
          const bud =
            k.status === "running"
              ? at(
                  k.x - 4,
                  k.y - 7,
                  `<g class="pulse">${[0, 72, 144, 216, 288].map((a) => `<ellipse cx="0" cy="-2.4" rx="1.4" ry="2.4" fill="#f9a8d4" transform="rotate(${a})"/>`).join("")}<circle r="1.3" fill="#fde68a"/></g>`,
                )
              : k.status === "error"
                ? `<circle cx="${k.x - 4}" cy="${k.y - 5}" r="1.8" fill="#8a5a3a"/>`
                : ""
          return t + bud
        })
        .join("")
      return vine + leaves.join("") + tendrils
    })
    .join("")

/** Draws the connector layer of one tree host. Call `draw()` after every render of the host and on resize. */
export const treeLines = (host: HTMLElement): { draw: () => void; stop: () => void } => {
  const born = new Map<string, number>()
  let svg: SVGSVGElement | null = null
  let markup = ""
  const draw = () => {
    if (!svg || !host.contains(svg)) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
      svg.setAttribute("class", "p3-lines")
      svg.setAttribute("aria-hidden", "true")
      host.prepend(svg)
      markup = ""
    }
    const gs = groups(host)
    const now = performance.now()
    const style = chosen
    const next =
      style === "classic" ? classic(gs) : style === "vine" ? ivyVine(gs, born, now) : growingTree(gs, born, now)
    // Same picture: keep the element, so running sway and pulse animations do not restart.
    if (next !== markup) {
      svg.innerHTML = next
      markup = next
    }
  }
  const ro = new ResizeObserver(() => draw())
  ro.observe(host)
  const unsub = onTreeStyle(draw)
  return { draw, stop: () => (ro.disconnect(), unsub(), svg?.remove()) }
}
