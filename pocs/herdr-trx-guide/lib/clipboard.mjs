import { spawnSync } from "node:child_process"

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
