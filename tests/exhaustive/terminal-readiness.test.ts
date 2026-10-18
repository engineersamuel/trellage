import { expect, test } from "bun:test"
import { spawnSourcePty, type SourcePtyExit } from "../../packages/trellage-launcher/test/helpers/source-pty.ts"

test("terminal readiness comes from kernel mode after rendering, before sending a closing key", async () => {
  const python = Bun.which("python3")!
  const child = spawnSourcePty(
    python,
    [
      "-c",
      [
        "import os,sys,tty",
        "print('RENDERED', flush=True)",
        "assert sys.stdin.readline() == 'activate\\n'",
        "tty.setraw(0)",
        "assert os.read(0,1) == b'q'",
        "print('ACCEPTED', flush=True)",
      ].join("\n"),
    ],
    {
      name: "xterm",
      cols: 80,
      rows: 25,
      cwd: process.cwd(),
      env: process.env,
    },
  )
  let output = "",
    exit: SourcePtyExit | undefined
  child.onData((data) => {
    output += data
  })
  child.onExit((value) => {
    exit = value
  })
  const wait = async (ready: () => boolean) => {
    const deadline = Date.now() + 5000
    while (!ready()) {
      if (Date.now() > deadline) throw Error(`Timed out: ${output}`)
      await Bun.sleep(10)
    }
  }
  try {
    await wait(() => output.includes("RENDERED"))
    expect(await child.rawMode()).toBe(false)
    child.write("activate\n")
    const deadline = Date.now() + 5000
    while (!(await child.rawMode())) {
      if (Date.now() > deadline) throw Error("Terminal did not enable raw input")
      await Bun.sleep(10)
    }
    child.write("q")
    await wait(() => exit !== undefined)
    expect(output).toContain("ACCEPTED")
    expect(exit).toEqual({ exitCode: 0, signal: 0 })
  } finally {
    if (!exit) {
      child.kill("SIGKILL")
      await wait(() => exit !== undefined)
    }
  }
}, 15000)
