const wideRanges = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

const isWide = (codePoint) => {
  for (const [start, end] of wideRanges) {
    if (codePoint < start) return false
    if (codePoint <= end) return true
  }
  return false
}

export const characterWidth = (character) => {
  const codePoint = character.codePointAt(0)
  if (codePoint === undefined) return 0
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0
  if (codePoint >= 0x200b && codePoint <= 0x200f) return 0
  return isWide(codePoint) ? 2 : 1
}

export const stringWidth = (value) => {
  let width = 0
  for (const character of value) width += characterWidth(character)
  return width
}

export const truncateToWidth = (value, maximumWidth) => {
  let width = 0
  let output = ""
  for (const character of value) {
    const nextWidth = characterWidth(character)
    if (width + nextWidth > maximumWidth) break
    output += character
    width += nextWidth
  }
  return output
}

const wrapLine = (value, maximumWidth) => {
  const lines = []
  let line = ""
  let width = 0
  for (const character of value.replace(/\t/gu, "    ")) {
    const nextWidth = characterWidth(character)
    if (line.length > 0 && width + nextWidth > maximumWidth) {
      lines.push(line)
      line = ""
      width = 0
    }
    line += character
    width += nextWidth
  }
  lines.push(line)
  return lines
}

export const wrapText = (value, maximumWidth) =>
  value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .flatMap((line) => wrapLine(line, Math.max(1, maximumWidth)))
