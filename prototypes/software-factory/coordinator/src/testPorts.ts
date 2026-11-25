// Test ports of a worker: a block the OS reports free at spawn, given in the task, so two workers (of this factory or
// of a factory in another git worktree) never start servers on the same port, such as the 18080 a repo's docs name.
import { createServer } from "node:net"

export const TEST_PORT_BLOCK = 10
const LOW = 30_000
const HIGH = 60_000

const free = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createServer()
    s.once("error", () => resolve(false))
    s.listen({ port, host: "127.0.0.1", exclusive: true }, () => s.close(() => resolve(true)))
  })

/** First port of a block of `size` ports that are all free now; random start, so parallel spawns rarely meet. */
export const freePortBlock = async (size = TEST_PORT_BLOCK, random = Math.random): Promise<number> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = LOW + Math.floor(random() * ((HIGH - LOW) / size)) * size
    const ports = Array.from({ length: size }, (_, i) => base + i)
    if ((await Promise.all(ports.map(free))).every(Boolean)) return base
  }
  throw new Error("no free test port block")
}

export const testPortNote = (base: number, size = TEST_PORT_BLOCK): string =>
  `Test ports: ${base}-${base + size - 1} are yours. Start every server, proxy or test service you run on these ports ` +
  `(for example PORT=${base}), never on a port named in the repo's docs or the criteria (such as 18080): another ` +
  `worker may be using that one. Stop what you started.`
