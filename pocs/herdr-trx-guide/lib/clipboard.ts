import { execFile, spawnSync } from "node:child_process"

interface AsyncClipboardOptions {
  readonly platform?: NodeJS.Platform
  readonly timeoutMs?: number
  readonly exec?: typeof execFile
}

const readCommands = (platform) => {
  if (platform === "darwin") return [{ command: "pbpaste", args: [] }]
  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
      },
    ]
  }
  return [
    { command: "wl-paste", args: ["--no-newline"] },
    { command: "xclip", args: ["-selection", "clipboard", "-out"] },
    { command: "xsel", args: ["--clipboard", "--output"] },
  ]
}

export const readClipboard = ({
  platform = process.platform,
  run = spawnSync,
} = {}) => {
  for (const candidate of readCommands(platform)) {
    const result = run(candidate.command, candidate.args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: platform === "win32",
    })
    if (result.status === 0 && typeof result.stdout === "string") {
      return { ok: true, value: result.stdout }
    }
  }
  return { ok: false, message: "No supported clipboard reader is available" }
}

/** Promise form used by popups so clipboard discovery never blocks first paint. */
export const readClipboardAsync = (options: AsyncClipboardOptions = {}) =>
  new Promise((resolve) => {
    const { platform = process.platform, timeoutMs = 2_000, exec = execFile } = options
    const candidates = readCommands(platform)
    const readNext = (index) => {
      const candidate = candidates[index]
      if (candidate === undefined) {
        resolve({ ok: false, message: "No supported clipboard reader is available" })
        return
      }
      exec(candidate.command, candidate.args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: platform === "win32",
      }, (error, stdout) => {
        if (error === null && typeof stdout === "string") {
          resolve({ ok: true, value: stdout })
          return
        }
        readNext(index + 1)
      })
    }
    readNext(0)
  })

export const copyToClipboard = (
  value,
  {
    platform = process.platform,
    run = spawnSync,
    read = readClipboard,
  } = {},
) => {
  const commands = platform === "darwin"
    ? [{ command: "pbcopy", args: [] }]
    : platform === "win32"
    ? [{ command: "clip.exe", args: [] }]
    : [
        { command: "wl-copy", args: [] },
        { command: "xclip", args: ["-selection", "clipboard"] },
        { command: "xsel", args: ["--clipboard", "--input"] },
      ]
  let wrote = false
  for (const candidate of commands) {
    const result = run(candidate.command, candidate.args, {
      input: value,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: platform === "win32",
    })
    if (result.status === 0) {
      wrote = true
      break
    }
  }
  if (!wrote) throw new Error("No supported clipboard writer is available")
  const copied = read({ platform })
  if (!copied.ok || copied.value !== value) throw new Error("Clipboard verification failed")
}
