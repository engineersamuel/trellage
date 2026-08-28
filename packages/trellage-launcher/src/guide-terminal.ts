const clearAndHome = "\u001B[2J\u001B[H"

export const createInitialGuideRenderHandler = (
  write: (text: string) => void,
  enabled: boolean,
): (() => void) => {
  let pending = enabled
  return () => {
    if (!pending) return
    pending = false
    write(clearAndHome)
  }
}
