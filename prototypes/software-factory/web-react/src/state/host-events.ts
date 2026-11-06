// The shared plain-DOM modules (canvas, folders, decisions, transcript) talk to their host through
// window events, because the Foldkit UI mounts them too. This is the one place where the React UI
// turns those events into store actions; components never listen to window events themselves.
import { onFeed, RESYNC } from "../../../shared/feed"
import { freshThread, openThread, refreshOpenThread } from "./chat"
import { Action } from "./model"
import { dispatch, patchSettings } from "./store"

const detail = <T>(e: Event): T => (e as CustomEvent<T>).detail

/** Listen once per page. Returns a stop function. */
export const startHostEvents = (): (() => void) => {
  const on: Record<string, (e: Event) => void> = {
    "sf:open-thread": (e) => openThread(detail<string>(e)),
    "sf:new-thread": () => freshThread(),
    "sf:select-worker": (e) => patchSettings({ focus: detail<string>(e) }),
    "sf:open-report": (e) => dispatch(Action.ReportOpened({ ref: detail<string>(e) })),
  }
  for (const [name, f] of Object.entries(on)) window.addEventListener(name, f)
  const offFeed = onFeed((ev) => {
    if (ev.type === RESYNC) refreshOpenThread(null)
    else if (ev.type === "factory.thread_updated") refreshOpenThread(ev.data?.threadId ?? null)
  })
  // The folder sidebar announces ?thread= on load, possibly before this listener exists: open it here too.
  const linked = new URL(window.location.href).searchParams.get("thread")
  if (linked) openThread(linked)
  return () => {
    for (const [name, f] of Object.entries(on)) window.removeEventListener(name, f)
    offFeed()
  }
}
