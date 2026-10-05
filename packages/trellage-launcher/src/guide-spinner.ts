import { isNoUnicode } from "./termcn/use-unicode.ts"

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
const asciiSpinnerFrames = ["-", "\\", "|", "/"] as const

export const spinnerFrameAt = (tick: number): string => {
  const frames = isNoUnicode() ? asciiSpinnerFrames : spinnerFrames
  return frames[tick % frames.length] ?? "•"
}
