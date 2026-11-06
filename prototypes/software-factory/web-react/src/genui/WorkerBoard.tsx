// Worker board: a typed card (rule 13). The layout is ours; OpenUI's React components draw it, so it looks like
// the agent's render_ui cards. The tool result is the snapshot at call time; the store's live workers win.
import { Card, CardHeader, MetricIndicatorInline, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tag } from "@openuidev/react-ui"
import type { Worker } from "../../../shared/schemas"
import { toBoard } from "../../../shared/cardviews"
import { patchSettings, useApp } from "../state/store"
import { OpenUiTheme } from "./OpenUi"

export { toBoard, type Board, type BoardRow } from "../../../shared/cardviews"

/** Tool result `{ workers }` → workers, or [] when it is missing or not JSON. */
export const snapshotOf = (result: string | undefined): Worker[] => {
  try {
    const r = JSON.parse(result ?? "") as { workers?: unknown }
    return Array.isArray(r.workers) ? (r.workers as Worker[]) : []
  } catch {
    return []
  }
}

export function WorkerBoard({ result }: { result: string | undefined }) {
  const live = useApp((s) => s.workers)
  const liveList = Object.values(live)
  // Live once the store has workers; the call-time snapshot before that (e.g. an old thread opened offline).
  const board = toBoard(liveList.length ? liveList : snapshotOf(result))
  if (result === undefined) return <p className="sf-board-wait">Loading worker board…</p>
  return (
    <OpenUiTheme>
      <Card variant="card" width="full" className="sf-board">
        <CardHeader title="Worker board" subtitle={liveList.length ? "Live" : "Snapshot"} />
        <div className="sf-board-metrics">
          <MetricIndicatorInline value={String(board.total)} subtext="agents" />
          <MetricIndicatorInline value={String(board.running)} subtext="running" />
          <MetricIndicatorInline value={String(board.errors)} subtext="errors" />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Model</TableHead>
              <TableHead align="right">Memory</TableHead>
              <TableHead align="right">Context</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {board.rows.map((r) => (
              <TableRow key={r.id} className="sf-board-row" onClick={() => patchSettings({ focus: r.id })} title="Show this agent in the panel">
                <TableCell>
                  {r.name} <small>{r.kind}</small>
                </TableCell>
                <TableCell>
                  <Tag text={r.status} variant={r.variant} size="sm" />
                </TableCell>
                <TableCell>{r.model}</TableCell>
                <TableCell align="right">{r.memory}</TableCell>
                <TableCell align="right">{r.context}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </OpenUiTheme>
  )
}
