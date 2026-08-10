import type { LaunchEntry } from "./state.js"

export interface DetailRow {
  readonly label?:
    | "Alias"
    | "Arguments"
    | "Binary"
    | "Description"
    | "Harness"
    | "Model"
    | "Plugins"
    | "Skills"
    | "MCPs"
    | "Status"
  readonly text: string
}

type DetailLabel = NonNullable<DetailRow["label"]>
const wrapText = (value: string, width: number): ReadonlyArray<string> => {
  const words = value.trim().split(/\s+/u)
  const lines: Array<string> = []
  let line = ""

  for (const word of words) {
    let remaining = word
    while (remaining.length > width) {
      if (line.length > 0) {
        lines.push(line)
        line = ""
      }
      lines.push(remaining.slice(0, width))
      remaining = remaining.slice(width)
    }
    if (remaining.length === 0) continue
    if (line.length === 0) line = remaining
    else if (line.length + remaining.length + 1 <= width) line += ` ${remaining}`
    else {
      lines.push(line)
      line = remaining
    }
  }
  if (line.length > 0) lines.push(line)
  return lines.length === 0 ? [""] : lines
}

const fieldRows = (label: DetailLabel, value: string, width: number): ReadonlyArray<DetailRow> => {
  const contentWidth = Math.max(1, width - `${label}: `.length)
  return wrapText(value, contentWidth).map((text, index) => (index === 0 ? { label, text } : { text }))
}

const list = (values: ReadonlyArray<string> | undefined): string =>
  values === undefined || values.length === 0 ? "None" : values.join(", ")

export const detailRows = (
  entry: LaunchEntry,
  model: string | undefined,
  columns: number,
  forwardedModel?: string,
): ReadonlyArray<DetailRow> => {
  const width = Math.max(16, Math.floor(columns))
  const invocationArgs = [
    ...(entry.profileArgument === undefined ? [] : [entry.profileArgument]),
    ...(forwardedModel === undefined ? [] : ["--model", forwardedModel]),
    ...(entry.passthroughArgs ?? []),
  ]
  const invocation = [
    ...(entry.commandAlias === undefined ? [] : fieldRows("Alias", entry.commandAlias, width)),
    ...(entry.commandPath === undefined ? [] : fieldRows("Binary", entry.commandPath, width)),
    ...(entry.commandAlias === undefined && entry.commandPath === undefined
      ? []
      : fieldRows("Arguments", JSON.stringify(invocationArgs), width)),
  ]
  return [
    ...invocation,
    ...fieldRows("Description", entry.description, width),
    ...fieldRows(
      "Harness",
      `${entry.harness}${entry.harnessVersion === undefined ? "" : ` ${entry.harnessVersion}`}`,
      width,
    ),
    ...fieldRows("Model", model ?? "Not declared", width),
    ...fieldRows("Plugins", list(entry.plugins), width),
    ...fieldRows("Skills", list(entry.skills), width),
    ...fieldRows("MCPs", list(entry.mcps), width),
    ...(entry.details === undefined ? [] : fieldRows("Status", entry.details, width)),
  ]
}
