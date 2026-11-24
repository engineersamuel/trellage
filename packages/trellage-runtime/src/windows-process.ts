const ffi = process.platform === "win32" ? await import("bun:ffi") : undefined
const kernel = ffi?.dlopen("kernel32.dll", {
  OpenProcess: { args: ["u32", "bool", "u32"], returns: "ptr" },
  GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "bool" },
  CloseHandle: { args: ["ptr"], returns: "bool" },
})

export const windowsProcessStart = (pid: number): string | null => {
  if (!ffi || !kernel) throw new Error("Windows process inspection requires native Windows Bun")
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const handle = kernel.symbols.OpenProcess(0x1000, false, pid)
  if (handle === null) return null
  try {
    const times = Array.from({ length: 4 }, () => new Uint32Array(2))
    if (
      !kernel.symbols.GetProcessTimes(
        handle,
        ffi.ptr(times[0]!),
        ffi.ptr(times[1]!),
        ffi.ptr(times[2]!),
        ffi.ptr(times[3]!),
      )
    )
      throw new Error(`cannot determine Windows process start time: ${pid}`)
    return ((BigInt(times[0]![1]!) << 32n) | BigInt(times[0]![0]!)).toString()
  } finally {
    kernel.symbols.CloseHandle(handle)
  }
}
