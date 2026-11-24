import { lstatSync } from "node:fs"

const ffi = process.platform === "win32" ? await import("bun:ffi") : undefined
const security = ffi?.dlopen("advapi32.dll", {
  GetFileSecurityW: { args: ["ptr", "u32", "ptr", "u32", "ptr"], returns: "bool" },
  OpenProcessToken: { args: ["i64", "u32", "ptr"], returns: "bool" },
  GetTokenInformation: { args: ["i64", "u32", "ptr", "u32", "ptr"], returns: "bool" },
})
const kernel = ffi?.dlopen("kernel32.dll", {
  CloseHandle: { args: ["i64"], returns: "bool" },
})

let currentSid: string | undefined

const userSid = (): string => {
  if (currentSid !== undefined) return currentSid
  if (!ffi || !security || !kernel) throw new Error("Windows token inspection requires native Windows Bun")
  const token = new BigUint64Array(1)
  if (!security.symbols.OpenProcessToken(-1n, 8, ffi.ptr(token)))
    throw new Error("cannot open the Windows process token")
  try {
    const length = new Uint32Array(1)
    security.symbols.GetTokenInformation(token[0]!, 1, null, 0, ffi.ptr(length))
    if (length[0] === 0) throw new Error("cannot determine the Windows user SID")
    const bytes = new Uint8Array(length[0]!)
    const pointer = ffi.ptr(bytes)
    if (!security.symbols.GetTokenInformation(token[0]!, 1, pointer, bytes.length, ffi.ptr(length)))
      throw new Error("cannot read the Windows user SID")
    const sidPointer = Number(new DataView(bytes.buffer).getBigUint64(0, true))
    currentSid = sidAt(bytes, sidPointer - pointer, 0)
    return currentSid
  } finally {
    kernel.symbols.CloseHandle(token[0]!)
  }
}

const sidAt = (bytes: Uint8Array, offset: number, minimum = 20): string => {
  if (!Number.isInteger(offset) || offset < minimum || offset + 8 > bytes.length || bytes[offset] !== 1)
    throw new Error("invalid Windows security descriptor SID")
  const count = bytes[offset + 1]!
  if (offset + 8 + count * 4 > bytes.length) throw new Error("truncated Windows security descriptor SID")
  let authority = 0
  for (let index = offset + 2; index < offset + 8; index++) authority = authority * 256 + bytes[index]!
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const parts = Array.from({ length: count }, (_, index) => view.getUint32(offset + 8 + index * 4, true))
  return `S-1-${authority}-${parts.join("-")}`
}

/** Administrators and SYSTEM are already able to replace any user's files. */
export const assertWindowsDescriptor = (bytes: Uint8Array, sid: string, privateRead = false): void => {
  if (bytes.length < 20 || bytes[0] !== 1) throw new Error("invalid Windows security descriptor")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const control = view.getUint16(2, true)
  if ((control & 0x8004) !== 0x8004) throw new Error("Windows path must have an explicit DACL")
  const trusted = new Set([sid, "S-1-5-18", "S-1-5-32-544"])
  if (!trusted.has(sidAt(bytes, view.getUint32(4, true))))
    throw new Error("Windows path must be owned by this user, SYSTEM, or Administrators")
  const acl = view.getUint32(16, true)
  if (acl < 20 || acl + 8 > bytes.length) throw new Error("Windows path must not have a null DACL")
  const end = acl + view.getUint16(acl + 2, true)
  if (end < acl + 8 || end > bytes.length) throw new Error("truncated Windows DACL")
  let offset = acl + 8
  for (let index = 0; index < view.getUint16(acl + 4, true); index++) {
    if (offset + 8 > end) throw new Error("truncated Windows ACE")
    const type = bytes[offset]!
    const flags = bytes[offset + 1]!
    const size = view.getUint16(offset + 2, true)
    if (size < 8 || offset + size > end) throw new Error("invalid Windows ACE")
    // Inherit-only entries do not grant access to this object; every child is checked separately.
    if ((flags & 0x08) === 0 && type !== 1) {
      if (type !== 0) throw new Error(`unsupported Windows access ACE type: ${type}`)
      const principal = sidAt(bytes.subarray(0, offset + size), offset + 8)
      const mask = view.getUint32(offset + 4, true)
      const write = 0x500d0156
      const read = 0xa00200a9
      if (!trusted.has(principal) && (mask & (privateRead ? write | read : write)) !== 0)
        throw new Error(
          privateRead
            ? "Windows path must not be accessible by other users"
            : "Windows path must not be writable by other users",
        )
    }
    offset += size
  }
}

export const assertWindowsPermissions = (candidate: string, privateRead = false): void => {
  if (!ffi || !security) throw new Error("Windows ACL inspection requires native Windows Bun")
  if (lstatSync(candidate).isSymbolicLink()) throw new Error(`unsafe Windows reparse point: ${candidate}`)
  const name = new Uint16Array(
    [...candidate]
      .flatMap((character) => {
        const code = character.codePointAt(0)!
        return code > 0xffff ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)] : [code]
      })
      .concat(0),
  )
  const length = new Uint32Array(1)
  security.symbols.GetFileSecurityW(ffi.ptr(name), 5, null, 0, ffi.ptr(length))
  if (length[0] === 0) throw new Error(`cannot inspect Windows ACL: ${candidate}`)
  const bytes = new Uint8Array(length[0]!)
  if (!security.symbols.GetFileSecurityW(ffi.ptr(name), 5, ffi.ptr(bytes), bytes.length, ffi.ptr(length)))
    throw new Error(`cannot read Windows ACL: ${candidate}`)
  try {
    assertWindowsDescriptor(bytes, userSid(), privateRead)
  } catch (cause) {
    throw new Error(`${cause instanceof Error ? cause.message : String(cause)}: ${candidate}`, { cause })
  }
}
