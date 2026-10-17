import { spawnSync } from "node:child_process"

interface ClipboardCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

const readCommands = (platform: NodeJS.Platform): ReadonlyArray<ClipboardCommand> => {
  if (platform === "darwin") return [{ command: "pbpaste", args: [] }]
  if (platform === "win32") {
    return [{ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"] }]
  }
  return [
    { command: "wl-paste", args: ["--no-newline"] },
    { command: "xclip", args: ["-selection", "clipboard", "-out"] },
    { command: "xsel", args: ["--clipboard", "--output"] },
  ]
}

const writeCommands = (platform: NodeJS.Platform): ReadonlyArray<ClipboardCommand> => {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }]
  if (platform === "win32") return [{ command: "clip.exe", args: [] }]
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ]
}

export interface ClipboardRunResult {
  readonly status: number | null
  readonly stdout?: string
}

export interface ClipboardIO {
  readonly platform?: NodeJS.Platform
  readonly run?: (command: string, args: ReadonlyArray<string>, input?: string) => ClipboardRunResult
  readonly read?: (platform: NodeJS.Platform) => { readonly ok: boolean; readonly value?: string }
}

const defaultRun = (command: string, args: ReadonlyArray<string>, input?: string): ClipboardRunResult => {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: process.platform === "win32",
  })
  return { status: result.status, ...(typeof result.stdout === "string" ? { stdout: result.stdout } : {}) }
}

const defaultRead = (platform: NodeJS.Platform): { readonly ok: boolean; readonly value?: string } => {
  for (const candidate of readCommands(platform)) {
    const result = defaultRun(candidate.command, candidate.args)
    if (result.status === 0 && result.stdout !== undefined) return { ok: true, value: result.stdout }
  }
  return { ok: false }
}

/** Copy text and read it back. A failed write or a different read-back throws. */
export const copyTextToClipboard = (value: string, io: ClipboardIO = {}): void => {
  const platform = io.platform ?? process.platform
  const run = io.run ?? defaultRun
  const read = io.read ?? defaultRead
  let wrote = false
  for (const candidate of writeCommands(platform)) {
    if (run(candidate.command, candidate.args, value).status === 0) {
      wrote = true
      break
    }
  }
  if (!wrote) throw new Error("No supported clipboard writer is available")
  const copied = read(platform)
  if (!copied.ok || copied.value !== value) throw new Error("Clipboard verification failed")
}
