// 16px stroke glyphs per tool name, as plain data (no DOM, no CSS), so the plain-DOM cards
// (toolcard.ts) and the React chat cards draw the same icons.

export type Shape = readonly [tag: string, attrs: Record<string, string>]
export const path = (d: string, extra: Record<string, string> = {}): Shape => ["path", { d, ...extra }]

/** 16px stroke glyphs for the tool tile. */
const ICONS = {
  wrench: [path("M10.2 2.4a3.5 3.5 0 0 0-4.3 4.6L2.6 10.3a1.4 1.4 0 0 0 2 2L7.9 9a3.5 3.5 0 0 0 4.6-4.3l-2 2-1.6-.4-.4-1.6 1.7-2.3Z")],
  search: [["circle", { cx: "7", cy: "7", r: "4.5" }], path("M10.5 10.5 14 14")],
  file: [path("M9 1.75H4.5A1.25 1.25 0 0 0 3.25 3v10a1.25 1.25 0 0 0 1.25 1.25h7A1.25 1.25 0 0 0 12.75 13V5.5L9 1.75Z"), path("M9 1.75V5.5h3.75"), path("M5.75 8.5h4.5M5.75 11h4.5")],
  folder: [path("M2 4.25A1.25 1.25 0 0 1 3.25 3h3l1.5 1.75h5A1.25 1.25 0 0 1 14 6v5.75A1.25 1.25 0 0 1 12.75 13h-9.5A1.25 1.25 0 0 1 2 11.75Z")],
  terminal: [path("M2.75 3h10.5a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-.75.75H2.75a.75.75 0 0 1-.75-.75v-8.5A.75.75 0 0 1 2.75 3Z"), path("M4.75 6.25 6.5 8l-1.75 1.75M8 10h3")],
  pencil: [path("M10.75 2.75l2.5 2.5L6 12.5l-3.25.75.75-3.25Z")],
  worker: [["circle", { cx: "8", cy: "5.5", r: "2.5" }], path("M3 13.5a5 5 0 0 1 10 0")],
  mail: [path("M2.5 4h11v8h-11Z"), path("M2.5 4.5 8 8.75l5.5-4.25")],
  ask: [["circle", { cx: "8", cy: "8", r: "6" }], path("M6.4 6.2a1.7 1.7 0 0 1 3.2.8c0 1.2-1.6 1.5-1.6 2.5M8 11.4v.1")],
  globe: [["circle", { cx: "8", cy: "8", r: "6" }], path("M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6s-.8 4.3-2.6 6c-1.8-1.7-2.6-3.7-2.6-6S6.2 3.7 8 2Z")],
} satisfies Record<string, readonly Shape[]>

const ICON_OF: Record<string, keyof typeof ICONS> = {
  read: "file", view: "file", read_file: "file",
  grep: "search", glob: "search", rg: "search", search: "search",
  ls: "folder", list_directory: "folder",
  bash: "terminal", read_bash: "terminal", stop_bash: "terminal", shell: "terminal",
  edit: "pencil", write: "pencil", create: "pencil", apply_patch: "pencil", str_replace_editor: "pencil",
  spawn_worker: "worker", read_worker: "worker", stop_worker: "worker", list_workers: "worker", agent: "worker", task: "worker",
  message_worker: "mail", message_conversation: "mail", report_up: "mail",
  request_approval: "ask", ask_user: "ask",
  web_fetch: "globe", fetch: "globe", web_search: "globe",
}

/** The 16px glyph shapes for a tool; unknown tools get a wrench, like affectUI. Framework-free, so React reuses it. */
export const toolGlyph = (name: string): readonly Shape[] => ICONS[ICON_OF[name.toLowerCase()] ?? "wrench"]
