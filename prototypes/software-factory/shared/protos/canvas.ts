// Canvas view of one conversation in the Inbox: its tree (chat → sub-coordinators → workers) as an org chart.
// The Inbox builds each card; this module places the cards, draws the edges, and fits the chart to the column.
import { el } from "./core"
import type { Model, Node } from "./p3-model"

const W = 210,
  H = 92,
  GX = 22,
  GY = 54,
  PAD = 20

type Box = { x: number; y: number }

/** Tidy tree: each subtree gets its width; a parent sits centred over its children. Returns the subtree width. */
const place = (m: Model, n: Node, x: number, depth: number, out: Map<string, Box>): number => {
  let w = W
  if (n.children.length) {
    let cx = x
    for (const id of n.children) cx += place(m, m.nodes.get(id)!, cx, depth + 1, out) + GX
    w = Math.max(W, cx - GX - x)
  }
  out.set(n.id, { x: x + (w - W) / 2, y: depth * (H + GY) })
  return w
}

/** Mount the canvas in `host`. `draw` replaces the chart; the chart is scaled down to fit the column width. */
export const mountCanvas = (host: HTMLElement) => {
  host.classList.add("p3-canvas")
  const world = el("div", "p3-world")
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.classList.add("p3-edges")
  host.replaceChildren(world)
  let size = { w: 0, h: 0 }
  const fit = () => {
    const k = size.w ? Math.min(1, (host.clientWidth - 4) / size.w) : 1
    world.style.zoom = String(k)
  }
  const ro = new ResizeObserver(fit)
  ro.observe(host)
  return {
    draw: (m: Model, rootId: string, card: (n: Node) => HTMLElement) => {
      const root = m.nodes.get(rootId)
      if (!root) return void world.replaceChildren()
      const boxes = new Map<string, Box>()
      const w = place(m, root, 0, 0, boxes)
      const h = Math.max(...[...boxes.values()].map((b) => b.y)) + H
      size = { w: w + PAD * 2, h: h + PAD * 2 }
      world.style.width = `${size.w}px`
      world.style.height = `${size.h}px`
      svg.setAttribute("width", String(size.w))
      svg.setAttribute("height", String(size.h))
      const paths: SVGPathElement[] = []
      const cards: HTMLElement[] = []
      for (const [id, b] of boxes) {
        const n = m.nodes.get(id)!
        const c = card(n)
        c.style.left = `${b.x + PAD}px`
        c.style.top = `${b.y + PAD}px`
        c.style.width = `${W}px`
        c.style.height = `${H}px`
        cards.push(c)
        const p = n.parent ? boxes.get(n.parent) : undefined
        if (!p) continue
        const x1 = p.x + PAD + W / 2,
          y1 = p.y + PAD + H,
          x2 = b.x + PAD + W / 2,
          y2 = b.y + PAD,
          my = (y1 + y2) / 2
        const e = document.createElementNS("http://www.w3.org/2000/svg", "path")
        e.setAttribute("d", `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`)
        e.setAttribute("class", `s-${n.status}`)
        paths.push(e)
      }
      svg.replaceChildren(...paths)
      // Reading order (top row first, left to right) for keyboard and screen readers.
      const order = [...boxes.entries()].sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x).map(([id]) => id)
      const byId = new Map(cards.map((c) => [c.dataset.id!, c]))
      world.replaceChildren(svg, ...order.map((id) => byId.get(id)!))
      fit()
    },
    stop: () => (ro.disconnect(), host.classList.remove("p3-canvas")),
  }
}
