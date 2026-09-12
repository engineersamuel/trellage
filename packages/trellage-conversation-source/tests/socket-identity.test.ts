import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { spyOn } from "bun:test"
import { conversationServerId } from "../src/conversation-capture.ts"
import { repositoryRoot } from "./fixtures.ts"

const socketFixture = async (t: Pick<TestContext, "after">) => {
  const parent = path.join(repositoryRoot, ".t")
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(path.join(parent, "cs-"))
  const socketPath = path.join(root, "h")
  const server = net.createServer((socket) => socket.end())
  t.after(async () => {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
    await rm(root, { recursive: true, force: true })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, resolve)
  })
  return { root, socketPath }
}

test("owned local socket identity is stable under Bun without following a link", async (t) => {
  const { socketPath } = await socketFixture(t)
  const env = { HERDR_SOCKET_PATH: socketPath }
  const identity = await conversationServerId(env)
  assert.match(identity, /^herdr-[a-f0-9]{64}$/u)
  assert.equal(await conversationServerId(env), identity)
})

test("a parent-directory alias retains the same verified socket identity", async (t) => {
  const { root, socketPath } = await socketFixture(t)
  const alias = path.join(root, "d")
  await symlink(root, alias)
  assert.equal(
    await conversationServerId({ HERDR_SOCKET_PATH: path.join(alias, "h") }),
    await conversationServerId({ HERDR_SOCKET_PATH: socketPath }),
  )
})

test("socket leaf links and regular files remain rejected", async (t) => {
  const { root, socketPath } = await socketFixture(t)
  const alias = path.join(root, "l")
  const regular = path.join(root, "f")
  await symlink(socketPath, alias)
  await writeFile(regular, "synthetic", { mode: 0o600 })
  for (const target of [alias, regular]) {
    await assert.rejects(conversationServerId({ HERDR_SOCKET_PATH: target }), /not an owned local socket/)
  }
})

test("a socket owned by a different user remains rejected", {
  skip: process.getuid === undefined,
}, async (t) => {
  const { socketPath } = await socketFixture(t)
  const uid = process.getuid?.()
  assert.ok(uid !== undefined)
  const getuid = spyOn(process, "getuid").mockReturnValue(uid + 1)
  try {
    await assert.rejects(
      conversationServerId({ HERDR_SOCKET_PATH: socketPath }),
      /not an owned local socket/,
    )
  } finally {
    getuid.mockRestore()
  }
})
