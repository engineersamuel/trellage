// Worker critters: a small animated figure per agent that shows what the agent does. Setting `inboxCritters`
// (Inbox conversation tree and canvas).
// Style "soft flat": body colour = model family, headgear = role, pose and prop = status and SDLC step.
// Plain DOM: each mounted critter redraws itself at 12 fps until its Mount ends.
import { Schema } from "effect"

const CritterState = Schema.Literals([
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
])
type CritterState = typeof CritterState.Type
const Hat = Schema.Literals(["hardhat", "headset", "flag", "bubble"])
type Hat = typeof Hat.Type
/** What one critter shows; also the args of the MountCritter Mount. */
export type { CritterState }
export const Critter = { state: CritterState, hat: Hat, body: Schema.String }
export type Critter = { readonly state: CritterState; readonly hat: Hat; readonly body: string }

const CUTE = 0.5
const FPS = 12
const INK = "#2b2b33"
const PROP = "#f3efe6"
const ACCENT = "#e8b84a"
const FAMILY_COLORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/claude|opus|sonnet|haiku/i, "#dba985"],
  [/gpt|o\d|codex/i, "#8fbfae"],
  [/gemini/i, "#9db2dc"],
]
const OTHER_COLOR = "#c4bcac"
const STEP_STATES: Readonly<Record<string, CritterState>> = {
  research: "research",
  hyperresearch: "research",
  "deep-research": "research",
  plan: "plan",
  council: "plan",
  "six-hats": "plan",
  synthesis: "plan",
  implement: "implement",
  verify: "verify",
  review: "review",
  security: "security",
  finish: "done",
}

/** The agent fields a critter reads. */
type CritterAgent = {
  readonly id: string
  readonly role: string
  readonly status: string
  readonly model: string
  readonly step?: string | null | undefined
}

const hatOf = (worker: CritterAgent): Hat =>
  worker.id === "coordinator"
    ? "headset"
    : worker.id.startsWith("gen-")
      ? "bubble"
      : worker.role === "coordinator"
        ? "flag"
        : "hardhat"

const stateOf = (worker: CritterAgent): CritterState => {
  if (worker.status === "error") return "error"
  if (worker.status !== "running") return "idle"
  if (worker.step) return STEP_STATES[worker.step] ?? "plan"
  return worker.role === "coordinator" ? "spawn" : "implement"
}

/** What the critter of `worker` shows now. */
export const critterOf = (worker: CritterAgent): Critter => ({
  state: stateOf(worker),
  hat: hatOf(worker),
  body: FAMILY_COLORS.find(([pattern]) => pattern.test(worker.model))?.[1] ?? OTHER_COLOR,
})

const TAU = Math.PI * 2
const wave = (t: number, hz: number, a = 1): number => Math.sin(t * hz * TAU) * a
const stepped = (t: number, hz: number): number => Math.floor(t * hz)

/** Where the eyes look instead of at the work: a direction (-1..1 per axis) and how much it wins (0..1). */
export type Gaze = { readonly x: number; readonly y: number; readonly weight: number }
const GAZE_REACH = 3.5
/** Only a working critter with open eyes looks up at the mouse; idle, waiting, error and done keep their pose. */
const WORKING: ReadonlySet<CritterState> = new Set([
  "research",
  "plan",
  "implement",
  "verify",
  "review",
  "security",
  "spawn",
])

/** One frame of the critter as SVG markup (64x64 units) at time `t` seconds; `gaze` pulls the pupils toward the mouse. */
export const critterSvg = ({ state, hat, body }: Critter, t: number, gaze?: Gaze): string => {
  const sw = 2.2
  const st = `stroke="${INK}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"`
  const stw = (w: number): string => st.replace(/stroke-width="[^"]*"/, `stroke-width="${w}"`)
  const out: string[] = []

  let bx = 0
  let by = 0
  let sy = 1
  let rot = 0
  const blink = t % 3.3 < 0.13
  let eyes = blink ? "closed" : "open"
  let edx = 0
  let edy = 0
  switch (state) {
    case "research":
      edx = wave(t, 0.5, 2.2)
      by = wave(t, 1, 0.6)
      break
    case "plan":
      edx = 1.5
      edy = -2
      by = wave(t, 0.4, 0.8)
      break
    case "implement":
      by = (stepped(t, 6) % 2) * -1
      edy = 1.5
      break
    case "verify":
      by = (t % 4) / 4 > 0.8 ? -Math.abs(wave(t, 2.5, 4)) : 0
      edx = 2
      break
    case "review":
      edy = 1.5
      eyes = blink ? "closed" : t % 5 > 3.5 ? "squint" : "open"
      break
    case "security":
      edx = Math.sign(wave(t, 0.35)) * 2.2
      break
    case "spawn":
      edx = 2
      break
    case "waiting":
      edy = -2
      by = -Math.abs(wave(t, 1.1, 2.5))
      break
    case "idle":
      eyes = "closed"
      sy = 1 + wave(t, 0.25, 0.03)
      break
    case "error":
      eyes = "x"
      bx = t % 2.2 < 0.5 ? wave(t, 12, 1.4) : 0
      rot = -4
      break
    case "done":
      eyes = "happy"
      by = -Math.abs(wave(t, 1.3, 3))
      break
  }

  if (gaze && gaze.weight > 0 && eyes === "open" && WORKING.has(state)) {
    edx += (gaze.x * GAZE_REACH - edx) * gaze.weight
    edy += (gaze.y * GAZE_REACH - edy) * gaze.weight
  }

  out.push(`<ellipse cx="32" cy="57" rx="${14 + by * 0.6}" ry="2.2" fill="#0000001a"/>`)
  out.push(`<g transform="translate(${bx} ${by}) rotate(${rot} 32 54) translate(0 ${54 - 54 * sy}) scale(1 ${sy})">`)
  out.push(`<path d="M24 52v3M40 52v3" ${st} fill="none"/>`)
  const r = 5 + CUTE * 5
  const bw = 32 - CUTE * 1.5
  const bh = 30 + CUTE
  const x0 = 32 - bw / 2
  const y0 = 53 - bh
  out.push(`<rect x="${x0}" y="${y0}" width="${bw}" height="${bh}" rx="${r}" fill="${body}" ${st}/>`)
  out.push(
    `<rect x="${x0 + 5}" y="${y0 + 6}" width="${bw - 10}" height="${12 + CUTE}" rx="${2 + CUTE * 2}" fill="#ffffff99"/>`,
  )
  const ey = y0 + 12 + edy * 0.5
  const er = 1.6 + CUTE * 0.9
  const eye = (x: number): string => {
    switch (eyes) {
      case "closed":
        return `<path d="M${x - er} ${ey}h${er * 2}" ${st}/>`
      case "squint":
        return `<path d="M${x - er} ${ey - 0.6}h${er * 2}M${x - er + 0.5} ${ey + 0.8}h${er * 2 - 1}" ${stw(sw * 0.7)}/>`
      case "happy":
        return `<path d="M${x - er} ${ey + 1}q${er} ${-er * 2} ${er * 2} 0" ${st} fill="none"/>`
      case "x":
        return `<path d="M${x - er} ${ey - er}l${er * 2} ${er * 2}M${x + er} ${ey - er}l${-er * 2} ${er * 2}" ${st}/>`
      default:
        return `<circle cx="${x}" cy="${ey}" r="${er}" fill="${INK}"/>`
    }
  }
  out.push(eye(26 + edx * 0.6), eye(38 + edx * 0.6))
  if (state === "waiting") out.push(`<circle cx="32" cy="${ey + 6.5}" r="1.3" fill="${INK}"/>`)
  if (state === "error") out.push(`<path d="M30 ${ey + 7}q2 -2 4 0" ${st} fill="none"/>`)
  else if (state === "done") out.push(`<path d="M30 ${ey + 6}q2 2 4 0" ${st} fill="none"/>`)

  const top = y0
  switch (hat) {
    case "hardhat":
      out.push(
        `<path d="M${x0 + 4} ${top + 1}q12 -12 ${bw - 8} 0z" fill="${ACCENT}" ${st}/><path d="M${x0 + 1} ${top + 1}h${bw - 2}" ${st}/>`,
      )
      break
    case "headset":
      out.push(
        `<path d="M${x0 + 1} ${top + 12}q0 -16 ${bw / 2 - 1} -16q${bw / 2 - 1} 0 ${bw / 2 - 1} 16" ${st} fill="none"/>` +
          `<rect x="${x0 - 2}" y="${top + 9}" width="4" height="7" rx="1.5" fill="${INK}"/><rect x="${x0 + bw - 2}" y="${top + 9}" width="4" height="7" rx="1.5" fill="${INK}"/>` +
          `<path d="M${x0} ${top + 16}q2 6 8 6" ${st} fill="none"/>`,
      )
      break
    case "flag": {
      const f = stepped(t, 3) % 2
      out.push(
        `<path d="M32 ${top}v-10" ${st}/><path d="M32 ${top - 10}h${7 + f} l-2 2.5 l2 2.5h${-7 - f}" fill="${ACCENT}" ${st}/>`,
      )
      break
    }
    case "bubble": {
      const o = wave(t, 0.6, 1)
      out.push(
        `<path d="M32 ${top}v-6" ${st}/><rect x="${27 + o}" y="${top - 14}" width="11" height="8" rx="3" fill="${PROP}" ${st}/><path d="M${30 + o} ${top - 10}h1M${33 + o} ${top - 10}h1" ${st}/>`,
      )
      break
    }
  }
  out.push("</g>")

  switch (state) {
    case "research": {
      const mx = 32 + wave(t, 0.5, 9)
      const my = 44 + wave(t, 1, 1.5)
      out.push(
        `<path d="M${mx + 4} ${my + 4}l5 5" ${stw(sw * 1.4)}/><circle cx="${mx}" cy="${my}" r="5.5" fill="#ffffffcc" ${st}/>`,
      )
      break
    }
    case "plan": {
      const n = stepped(t, 1.2) % 4
      out.push(
        `<circle cx="49" cy="20" r="1.4" fill="${INK}"/><circle cx="52" cy="15" r="2" fill="${INK}"/><rect x="44" y="0.5" width="19" height="13" rx="5" fill="${PROP}" ${st}/>`,
      )
      if (n >= 1) out.push(`<path d="M48 7L53.5 4M48 7L53.5 10" ${stw(sw * 0.6)}/>`)
      if (n >= 2) out.push(`<path d="M53.5 4L59 7M53.5 10L59 7" ${stw(sw * 0.6)}/>`)
      ;[
        [48, 7],
        [53.5, 4],
        [53.5, 10],
        [59, 7],
      ]
        .slice(0, n + 1)
        .forEach(([x, y]) => out.push(`<circle cx="${x}" cy="${y}" r="1.5" fill="${INK}"/>`))
      break
    }
    case "implement": {
      out.push(
        `<path d="M18 50h28l3 5H15z" fill="#d8d4cb" ${st}/><rect x="20" y="38" width="24" height="13" rx="1.5" fill="#3a4048" ${st}/>`,
      )
      const k = stepped(t, 5) % 6
      for (let i = 0; i < 3; i++) {
        const w = Math.min(16, (i < k / 2 ? 16 : k % 2 ? 8 : 4) - i * 3)
        out.push(
          `<path d="M23 ${41.5 + i * 3}h${Math.max(2, w)}" stroke="#9fe0b8" stroke-width="1.6" stroke-linecap="round"/>`,
        )
      }
      const fy = (t * 0.9) % 1
      out.push(
        `<text x="50" y="${30 - fy * 14}" font-size="8" font-family="ui-monospace,monospace" font-weight="700" fill="${INK}" opacity="${1 - fy}">{}</text>`,
      )
      break
    }
    case "verify": {
      out.push(`<rect x="47" y="22" width="15" height="22" rx="2" fill="${PROP}" ${st}/>`)
      const n = Math.min(3, stepped(t, 1) % 5)
      for (let i = 0; i < 3; i++) {
        const y = 27 + i * 6
        out.push(
          i < n
            ? `<path d="M49.5 ${y}l1.6 1.6 3 -3" ${stw(sw * 0.8)} fill="none"/>`
            : `<rect x="49.5" y="${y - 1.5}" width="3" height="3" rx=".6" fill="none" ${stw(sw * 0.6)}/>`,
          `<path d="M55.5 ${y}h4" ${stw(sw * 0.6)}/>`,
        )
      }
      break
    }
    case "review": {
      out.push(
        `<circle cx="26" cy="33.8" r="4.4" fill="none" ${st}/><circle cx="38" cy="33.8" r="4.4" fill="none" ${st}/><path d="M30.4 33.5h3.2" ${st}/>`,
      )
      out.push(`<rect x="20" y="42" width="24" height="15" rx="1.5" fill="${PROP}" ${st}/>`)
      const sc = (t * 3) % 3
      for (let i = 0; i < 4; i++) {
        const y = 45 + i * 3 - sc
        if (y > 43.5 && y < 55)
          out.push(
            `<path d="M23 ${y}h${i % 2 ? 12 : 17}" stroke="${i === 2 ? "#d0574a" : INK}" stroke-width="1.4" stroke-linecap="round"/>`,
          )
      }
      break
    }
    case "security": {
      const p = 1 + Math.max(0, wave(t, 0.8, 0.06))
      out.push(
        `<g transform="translate(20 44) scale(${p}) translate(-20 -44)"><path d="M20 34l9 3v6c0 6-4 10-9 12c-5-2-9-6-9-12v-6z" fill="#7d93b0" ${st}/>` +
          `<path d="M16.5 44.5l2.5 2.5 4.5-5" ${st.replace(`stroke="${INK}"`, 'stroke="#fff"')} fill="none"/></g>`,
      )
      break
    }
    case "spawn": {
      const k = (t * 0.45) % 1
      const s = 0.2 + Math.min(1, k * 1.6) * 0.38
      out.push(
        `<g transform="translate(${46 + k * 10} 56) scale(${s}) translate(-32 -56)"><rect x="17" y="24" width="30" height="29" rx="${r}" fill="${body}" ${stw(sw / s)}/>` +
          `<circle cx="26" cy="36" r="${2 + CUTE}" fill="${INK}"/><circle cx="38" cy="36" r="${2 + CUTE}" fill="${INK}"/></g>`,
      )
      break
    }
    case "waiting": {
      const b = wave(t, 1.1, 1.5)
      out.push(
        `<path d="M48 40q4 -6 3 -12" ${st} fill="none"/><rect x="44" y="${4 + b}" width="15" height="13" rx="4" fill="#ffe7a3" ${st}/>` +
          `<text x="51.5" y="${14 + b}" text-anchor="middle" font-size="10" font-weight="800" font-family="system-ui" fill="${INK}">?</text>`,
      )
      break
    }
    case "idle":
      for (let i = 0; i < 3; i++) {
        const k = (t * 0.35 + i / 3) % 1
        out.push(
          `<text x="${44 + k * 10}" y="${22 - k * 16}" font-size="${5 + k * 5}" font-weight="700" font-family="system-ui" fill="${INK}" opacity="${Math.sin(k * Math.PI)}">z</text>`,
        )
      }
      break
    case "error": {
      const k = (t * 0.6) % 1
      out.push(
        `<g opacity="${1 - k}"><circle cx="${44 + k * 6}" cy="${18 - k * 10}" r="${3 + k * 3}" fill="#9a948c88"/><circle cx="${48 + k * 6}" cy="${14 - k * 10}" r="${2 + k * 2}" fill="#9a948c66"/></g>` +
          `<path d="M10 14l5 -9 5 9z" fill="#f0c24b" ${st}/><path d="M15 8.5v2" ${stw(sw * 0.8)}/>`,
      )
      break
    }
    case "done": {
      const k = (t * 0.7) % 1
      const colors = ["#e8b84a", "#d0574a", "#7d93b0", "#8fbfae", "#dba985"]
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU + 0.3
        const d = 6 + k * 16
        const x = 32 + Math.cos(a) * d * 1.3
        const y = 16 + Math.sin(a) * d * 0.6 + k * 10
        out.push(
          `<rect x="${x}" y="${y}" width="2.6" height="2.6" transform="rotate(${k * 300 + i * 40} ${x} ${y})" fill="${colors[i]}" opacity="${1 - k}"/>`,
        )
      }
      break
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">${out.join("")}</svg>`
}

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

/** Draw `critter` in `element` at 12 fps until the returned stop runs. One still frame when the user asks for reduced motion. */
// ---------- eyes follow the mouse when it is near ----------

/** Last pointer position on the page; one listener for every critter. */
/** `moves` counts pointer moves, so a critter reads its own layout only after the pointer moved. */
const pointer = { x: 0, y: 0, isKnown: false, moves: 0 }
let isPointerTracked = false
const trackPointer = (): void => {
  if (isPointerTracked || typeof window === "undefined") return
  isPointerTracked = true
  const onMove = (e: PointerEvent): void => {
    if (e.pointerType !== "mouse") return
    pointer.x = e.clientX
    pointer.y = e.clientY
    pointer.isKnown = true
    pointer.moves++
  }
  window.addEventListener("pointermove", onMove, { passive: true })
  // A scroll moves critters under a still pointer: read the layout again.
  window.addEventListener("scroll", () => void pointer.moves++, { passive: true, capture: true })
  document.addEventListener("pointerleave", () => {
    pointer.isKnown = false
    pointer.moves++
  })
}

/** The mouse within this distance (px) of a critter makes it look up from its work. */
const NEAR_PX = 200
/** Share of the way to the new gaze each frame: about half a second of lag at 12 fps. */
const EASE = 0.15

const gazeTarget = (element: Element): Gaze => {
  if (!pointer.isKnown) return { x: 0, y: 0, weight: 0 }
  const r = element.getBoundingClientRect()
  if (!r.width) return { x: 0, y: 0, weight: 0 }
  const dx = pointer.x - (r.left + r.width / 2)
  const dy = pointer.y - (r.top + r.height * 0.4)
  const d = Math.hypot(dx, dy)
  if (d > NEAR_PX) return { x: 0, y: 0, weight: 0 }
  // Close to the face: look less far to the side, so it does not go cross-eyed.
  const reach = Math.min(1, d / 24)
  return { x: d ? (dx / d) * reach : 0, y: d ? (dy / d) * reach : 0, weight: 1 }
}

/** Draw `critter` in `element` at 12 fps until the returned stop runs. One still frame when the user asks for reduced motion. */
export const mountCritter = (element: Element, critter: Critter): (() => void) => {
  element.innerHTML = critterSvg(critter, 0)
  if (reducedMotion() || typeof requestAnimationFrame !== "function") return () => {}
  trackPointer()
  let gaze: Gaze = { x: 0, y: 0, weight: 0 }
  let lastFrame = -1
  let frameId = 0
  // Reading the layout right after other critters wrote theirs forces a page layout each frame. While the pointer
  // stands still the gaze target does not change, so it is read again only after a move.
  let target: Gaze = { x: 0, y: 0, weight: 0 }
  let seenMoves = -1
  const tick = (now: number): void => {
    const frame = Math.floor((now / 1000) * FPS)
    if (frame !== lastFrame) {
      if (pointer.moves !== seenMoves) {
        seenMoves = pointer.moves
        target = gazeTarget(element)
      }
      // Far away the direction stays where it was, so the eyes drift back to the work without swinging.
      gaze = {
        x: target.weight ? gaze.x + (target.x - gaze.x) * EASE : gaze.x,
        y: target.weight ? gaze.y + (target.y - gaze.y) * EASE : gaze.y,
        weight: gaze.weight + (target.weight - gaze.weight) * EASE,
      }
      element.innerHTML = critterSvg(critter, frame / FPS, gaze)
    }
    lastFrame = frame
    frameId = requestAnimationFrame(tick)
  }
  frameId = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(frameId)
}

// ---------- layout settings (plain-DOM hosts) ----------

/** Plain-DOM layouts with their own critter setting: Inbox (`inboxCritters`). */
export type CritterLayout = "inbox"
const layoutCritters: Record<CritterLayout, boolean> = { inbox: false }
const layoutListeners = new Set<() => void>()

export const layoutCrittersOn = (layout: CritterLayout): boolean => layoutCritters[layout]

/** Hosts call this with the settings whenever they load or change; open layouts redraw. */
export const setLayoutCritters = (next: Readonly<Record<CritterLayout, boolean>>): void => {
  if (next.inbox === layoutCritters.inbox) return
  Object.assign(layoutCritters, next)
  layoutListeners.forEach((redraw) => redraw())
}

/** Call `redraw` when a layout setting changes, until the returned unsubscribe runs. */
export const onLayoutCritters = (redraw: () => void): (() => void) => {
  layoutListeners.add(redraw)
  return () => void layoutListeners.delete(redraw)
}
