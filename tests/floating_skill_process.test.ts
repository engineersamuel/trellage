import { expect, spyOn, test } from "bun:test"
import { spawn, execFileSync } from "node:child_process"
import { once } from "node:events"
import { signalSkillChild } from "../scripts/floating-skills.ts"

test("skill cleanup tolerates a group containing only an unreaped child", async () => {
  const parent = spawn("python3", ["-c", `
import os, sys
pid = os.fork()
if pid == 0:
    os.setsid()
    os._exit(0)
print(pid, flush=True)
sys.stdin.readline()
os.waitpid(pid, 0)
`], { stdio: ["pipe", "pipe", "inherit"] })
  const closed = once(parent, "close")
  try {
    const [output] = await once(parent.stdout!, "data")
    const pid = Number(String(output).trim())
    expect(pid).toBeGreaterThan(1)
    let zombie = false
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim()
      if (state.startsWith("Z")) { zombie = true; break }
      await Bun.sleep(10)
    }
    expect(zombie).toBe(true)
    expect(() => signalSkillChild(pid, "SIGKILL")).not.toThrow()
  } finally {
    parent.stdin!.end("reap\n")
    await closed
  }
})

test("skill cleanup preserves permission failures for a live group", async () => {
  const child = spawn("python3", ["-c", "import os,sys; os.setsid(); print('ready',flush=True); sys.stdin.readline()"],
    { stdio: ["pipe", "pipe", "inherit"] })
  const closed = once(child, "close")
  try {
    await once(child.stdout!, "data")
    const denied = Object.assign(new Error("permission denied for live group"), { code: "EPERM" })
    const kill = spyOn(process, "kill").mockImplementation(() => { throw denied })
    try {
      expect(() => signalSkillChild(child.pid, "SIGKILL")).toThrow(denied)
    } finally {
      kill.mockRestore()
    }
  } finally {
    child.stdin!.end("exit\n")
    await closed
  }
})
