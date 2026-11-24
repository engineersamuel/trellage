import path from "node:path"

type Status = {
  worktree?: { name?: string; branch?: string }
  workspace?: { git_worktree?: string; branch?: string; current_dir?: string }
  cwd?: string
  cost?: { total_duration_ms?: number }
  context_window?: { used_percentage?: number }
  model?: { display_name?: string; id?: string }
  effort?: { level?: string }
  rate_limits?: { five_hour?: { used_percentage?: number }; seven_day?: { used_percentage?: number } }
}

const clean = (value: unknown, limit: number): string =>
  typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, limit) : ""
const percentage = (value: unknown, label: string): string =>
  typeof value === "number" && Number.isFinite(value) ? label.replaceAll("%", `${Math.floor(value)}%`) : ""

export const formatStatusline = (status: Status): string => {
  const name = clean(status.worktree?.name ?? status.workspace?.git_worktree, 1024)
  const worktree = clean(path.win32.basename(name.replace(/\\/g, "/")), 40)
  const branch = clean(status.worktree?.branch ?? status.workspace?.branch, 40)
  const cwd = clean(status.workspace?.current_dir ?? status.cwd, 1024)
  const location = clean(
    worktree && branch ? `${worktree}@${branch}` : worktree || branch || path.win32.basename(cwd),
    40,
  )
  const duration = status.cost?.total_duration_ms
  const minutes =
    typeof duration === "number" && Number.isFinite(duration) && duration >= 1000
      ? Math.floor(duration / 60000)
      : undefined
  const time =
    minutes === undefined ? "" : minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`
  const model = clean(status.model?.display_name ?? status.model?.id, 30)
  const effort = clean(status.effort?.level, 16)
  return [
    location,
    time,
    percentage(status.context_window?.used_percentage, "% ctx"),
    [model, effort].filter(Boolean).join(" "),
    percentage(status.rate_limits?.five_hour?.used_percentage, "5h %"),
    percentage(status.rate_limits?.seven_day?.used_percentage, "7d %"),
  ]
    .filter(Boolean)
    .join(" \u2502 ")
}

if (import.meta.main) {
  try {
    const input: unknown = JSON.parse(await Bun.stdin.text())
    if (input && typeof input === "object" && !Array.isArray(input)) console.log(formatStatusline(input))
  } catch (cause) {
    console.error(`trellage status line: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exitCode = 1
  }
}
