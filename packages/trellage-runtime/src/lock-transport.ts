import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import path from "node:path"
import { safeDirectory, safePath } from "./workspace.ts"

export function registryTransportLock(contents: string, registry: string): string {
  const url = new URL(registry)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("source registry must be an HTTPS URL without credentials, query or fragment")
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return contents.replace(/^(\s*"[^"\\]+": \["([^"\\]+)", )""/gm, (line, prefix: string, specifier: string) => {
    const match = /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@([0-9][a-zA-Z0-9.+-]*)$/.exec(specifier)
    if (match === null) throw new Error("invalid registry package in source lock")
    const [, name, version] = match
    if (name === undefined || version === undefined) throw new Error("invalid source lock package identity")
    const basename = name.split("/").at(-1)
    const archive = new URL(`${name}/-/${basename}-${version}.tgz`, url)
    return `${prefix}${JSON.stringify(archive.href)}`
  })
}

export async function withRegistryTransport(
  root: string,
  registry: string | undefined,
  install: () => Promise<void>,
): Promise<void> {
  safeDirectory(root)
  const lockPath = path.join(root, "bun.lock")
  const guard = path.join(root, ".trellage-install-lock")
  mkdirSync(guard, { mode: 0o700 })
  let descriptor: number | undefined
  let preserveRecovery = false
  try {
    safePath(lockPath, "file")
    descriptor = openSync(lockPath, constants.O_RDWR | constants.O_NOFOLLOW)
    const originalStatus = fstatSync(descriptor)
    if (originalStatus.nlink !== 1) throw new Error("source lock must not be hard-linked")
    const canonical = readFileSync(descriptor)
    const transport =
      registry === undefined ? canonical : Buffer.from(registryTransportLock(canonical.toString("utf8"), registry))
    const backup = path.join(guard, "bun.lock")
    writeFileSync(backup, canonical, { flag: "wx", mode: 0o600, flush: true })
    const publish = (contents: Buffer) => {
      const current = lstatSync(lockPath)
      if (current.dev !== originalStatus.dev || current.ino !== originalStatus.ino || current.nlink !== 1) {
        throw new Error("source lock identity changed during installation")
      }
      if (descriptor === undefined) throw new Error("source lock descriptor is closed")
      let offset = 0
      while (offset < contents.length) {
        const written = writeSync(descriptor, contents, offset, contents.length - offset, offset)
        if (written === 0) throw new Error("source lock write made no progress")
        offset += written
      }
      ftruncateSync(descriptor, contents.length)
      fsyncSync(descriptor)
    }
    let installationError: unknown
    try {
      if (!transport.equals(canonical)) publish(transport)
      await install()
    } catch (error) {
      installationError = error
      throw error
    } finally {
      try {
        if (!transport.equals(canonical)) publish(canonical)
      } catch (error) {
        preserveRecovery = true
        throw new AggregateError(
          installationError === undefined ? [error] : [installationError, error],
          `source lock restoration failed; canonical backup retained at ${backup}`,
        )
      }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (!preserveRecovery) rmSync(guard, { recursive: true })
  }
}
