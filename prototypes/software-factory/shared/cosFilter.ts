// Which event turns the Chief of Staff chat shows (coordinator/src/general.ts humanTurns). Default: none, only the
// human's own turns. The Inbox head sets it; the host chat loads the CoS conversation through cosMessagesUrl.

export const COS_KINDS = [
  { kind: "reports", label: "Reports" },
  { kind: "rules", label: "Rule actions" },
  { kind: "checks", label: "Worker checks" },
  { kind: "answers", label: "Decision answers" },
] as const
export type CosKind = (typeof COS_KINDS)[number]["kind"]

/** Window event the host listens to: reload the open conversation with the new filter. */
export const COS_FILTER_EVENT = "sf:cos-filter"

/** Messages one page loads; "Load earlier" adds a page. */
export const COS_PAGE = 300

const shown = new Set<CosKind>()
let limit = COS_PAGE
export const cosLimit = (): number => limit
/** Load one more page of older messages. */
export const showEarlier = (): void => {
  limit += COS_PAGE
  window.dispatchEvent(new CustomEvent(COS_FILTER_EVENT))
}
export const cosShows = (k: CosKind): boolean => shown.has(k)
export const setCosShown = (kinds: Iterable<CosKind>): void => {
  shown.clear()
  for (const k of kinds) shown.add(k)
  window.dispatchEvent(new CustomEvent(COS_FILTER_EVENT))
}

/** Messages of a conversation. The server applies the filter and limit only to the CoS conversation; others come back whole. */
export const cosMessagesUrl = (threadId: string): string =>
  `/api/threads/get/${encodeURIComponent(threadId)}?view=human&show=${[...shown].join(",")}&limit=${limit}`
