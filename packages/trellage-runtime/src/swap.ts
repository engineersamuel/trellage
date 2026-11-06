// Atomic directory swap: both paths exist before and after, so a reader never sees either one missing.
import { dlopen, FFIType, ptr } from "bun:ffi"

const cString = (value: string) => Buffer.from(`${value}\0`)

/** Exchange two existing paths in one rename. Throws when the platform or file system cannot. */
export function swapPaths(a: string, b: string): void {
  const from = cString(a)
  const to = cString(b)
  let status: number
  if (process.platform === "darwin") {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    })
    // RENAME_SWAP
    status = lib.symbols.renamex_np(ptr(from), ptr(to), 0x2)
    lib.close()
  } else if (process.platform === "linux") {
    const lib = dlopen("libc.so.6", {
      renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    })
    // AT_FDCWD, RENAME_EXCHANGE
    status = lib.symbols.renameat2(-100, ptr(from), -100, ptr(to), 0x2)
    lib.close()
  } else {
    throw new Error(`atomic swap is not supported on ${process.platform}`)
  }
  if (status !== 0) throw new Error(`atomic swap failed: ${a} <-> ${b}`)
}
