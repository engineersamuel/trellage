import { closeSync, constants, openSync, readSync } from "node:fs"
import tty from "node:tty"

/** Bun's filesystem-backed TTY stream can leave a blocking read alive after Ink exits. */
export const openControllingTerminalInput = (): tty.ReadStream => {
  const descriptor = openSync("/dev/tty", constants.O_RDONLY | constants.O_NONBLOCK)
  let input: tty.ReadStream
  try {
    input = new tty.ReadStream(descriptor)
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
  let retry: ReturnType<typeof setTimeout> | undefined
  const readAvailable = () => {
    if (retry !== undefined || input.destroyed) return
    try {
      const buffer = Buffer.allocUnsafe(4096)
      const length = readSync(descriptor, buffer)
      input.push(length === 0 ? null : buffer.subarray(0, length))
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")) {
        retry = setTimeout(() => {
          retry = undefined
          readAvailable()
        }, 10)
      } else {
        input.destroy(error instanceof Error ? error : new Error(String(error), { cause: error }))
      }
    }
  }
  input._read = readAvailable
  input.once("close", () => {
    if (retry !== undefined) clearTimeout(retry)
  })
  return input
}
