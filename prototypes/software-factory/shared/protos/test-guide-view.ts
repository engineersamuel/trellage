// "How to test" pin of one sub-coordinator: the manual test guide (coordinator/src/testGuide.ts), always in the
// header. Buttons: open the setup in a herdr tab in the worktree, and write the guide again.
import "./timeline.css"
import { Effect } from "effect"
import { markdown } from "../decisions"
import { onFeed, RESYNC } from "../feed"
import { fire, json, runOr, send } from "../http"
import { guideMarkdown, TestGuideView } from "../testGuide"
import { el } from "./core"

const TYPE = "factory.test_guide"

export const mountTestGuide = (box: HTMLElement, agentId: string, threadId: string): (() => void) => {
  box.classList.add("p3-pins")
  box.dataset.testid = "test-guide"
  const url = `/api/threads/${encodeURIComponent(threadId)}/test-guide`
  let shown = ""
  let note = ""
  const button = (text: string, onClick: () => void) => {
    const b = el("button", "p3-pin-btn", text)
    // Inside <summary>: do not toggle the disclosure.
    b.onclick = (e) => (e.preventDefault(), e.stopPropagation(), onClick())
    return b
  }
  const render = (g: typeof TestGuideView.Type) => {
    const key = JSON.stringify([g, note])
    if (key === shown) return
    shown = key
    const d = el("details", "p3-pin")
    d.dataset.pin = "test"
    d.open = !!box.querySelector<HTMLDetailsElement>('[data-pin="test"]')?.open
    const state = !g
      ? "not written yet"
      : g.status === "writing"
        ? "writing…"
        : g.status === "failed"
          ? `failed: ${g.error ?? "unknown error"}`
          : g.stale
            ? `stale: written for ${g.commit.slice(0, 7)}`
            : `${g.steps.length} steps`
    const summary = el("summary", "p3-ell", `🧪 How to test · ${state}`)
    if (g?.status === "ready")
      summary.append(
        button("▶ Open in herdr", () => {
          note = "opening…"
          render(g)
          void runOr(
            send(`${url}/herdr`, "POST").pipe(
              Effect.map(() => "opened in herdr"),
              Effect.catch((e) => Effect.succeed(`herdr: ${e.reason}`)),
            ),
            "",
          ).then((n) => ((note = n), render(g)))
        }),
      )
    if (g?.status !== "writing") summary.append(button(g ? "↻ Rewrite" : "✎ Write", () => fire(send(url, "POST"))))
    if (note) summary.append(el("span", "p3-why", note))
    const doc = el("div", "p3-pin-doc sfd-summary")
    if (g?.status === "ready") doc.innerHTML = markdown(guideMarkdown(g))
    d.append(summary, ...(g?.status === "ready" ? [doc] : []))
    box.replaceChildren(d)
  }
  let gen = 0
  const load = () => {
    const mine = ++gen
    void runOr(json(url, TestGuideView).pipe(Effect.map((g) => mine === gen && render(g))), undefined)
  }
  const offFeed = onFeed((ev) => (ev.type === RESYNC || (ev.workerId === agentId && ev.type === TYPE)) && load())
  load()
  return () => (offFeed(), (gen = -1))
}
