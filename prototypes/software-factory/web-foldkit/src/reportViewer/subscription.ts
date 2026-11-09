// Report paths anywhere on the page open the viewer. Shared DOM modules (stream, transcripts, decisions) draw report
// paths too, so links are found in the page, not only in Foldkit output. This is the one Stream that watches the DOM.
import { Effect, Queue, Stream } from "effect";
import { refOf } from "./domain";

const LINK = "sf-report-link";

/** Mark every `<code>` and `<a>` that names a report, outside code blocks and the viewer itself. */
const tag = () => {
  for (const e of document.querySelectorAll(`code:not(.${LINK}), a:not(.${LINK})`))
    if (!e.closest("pre, .rv-modal") && refOf(e)) e.classList.add(LINK);
};

/** A click on a report path: the path, and the agent whose text it is (a relative path means that agent's worktree). */
export type ReportClick = { ref: string; agent: string | null };

export const reportClicks: Stream.Stream<ReportClick> = Stream.callback<ReportClick>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const onClick = (ev: MouseEvent) => {
        const target = ev.target instanceof Element ? ev.target.closest(`.${LINK}`) : null;
        const ref = target && refOf(target);
        if (!target || !ref) return;
        ev.preventDefault();
        ev.stopPropagation();
        const host = target.closest<HTMLElement>("[data-agent], [data-transcript]");
        Queue.offerUnsafe(queue, { ref, agent: host?.dataset.agent ?? host?.dataset.transcript ?? null });
      };
      // Streaming fires many mutations per second: scan at most once per frame. Report paths arrive as new nodes.
      let frame = 0;
      const observer = new MutationObserver(() => (frame ||= requestAnimationFrame(() => ((frame = 0), tag()))));
      observer.observe(document.body, { subtree: true, childList: true });
      tag();
      document.addEventListener("click", onClick, true);
      return () => (observer.disconnect(), cancelAnimationFrame(frame), document.removeEventListener("click", onClick, true));
    }),
    (stop) => Effect.sync(stop),
  ),
);
