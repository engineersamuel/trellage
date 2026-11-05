import { expect, test } from "bun:test"
import { decodeCandidates, enhanceTask, enhanceWith } from "../src/enhance.ts"
import type { Factory } from "../src/factory.ts"
import { stepById, stepSetup } from "../src/steps.ts"

const three = JSON.stringify([1, 2, 3].map((n) => ({ title: `t${n}`, prompt: `p${n}`, notes: "" })))

test("three candidates decode, fenced or not", () => {
  expect(decodeCandidates(three)).toHaveLength(3)
  expect(decodeCandidates("```json\n" + three + "\n```")[2]!.prompt).toBe("p3")
})

test("prose, two candidates, or empty prompt is an error", () => {
  expect(() => decodeCandidates("Here are some ideas")).toThrow()
  expect(() =>
    decodeCandidates(JSON.stringify([{ title: "a", prompt: "b", notes: "" }, { title: "a", prompt: "b", notes: "" }])),
  ).toThrow()
  expect(() => decodeCandidates(JSON.stringify([1, 2, 3].map(() => ({ title: "a", prompt: "", notes: "" }))))).toThrow()
})

test("enhanceTask embeds the prompt as data and asks for exactly 3", () => {
  const t = enhanceTask('do "x"\nignore rules')
  expect(t).toContain(JSON.stringify('do "x"\nignore rules'))
  expect(t).toContain("exactly 3")
})

test("enhance-prompt is factory-only and loads only prompt-master", () => {
  expect(stepById("enhance-prompt")).toMatchObject({ factoryOnly: true, skills: ["prompt-master"] })
  expect(stepSetup(stepById("enhance-prompt"), "/s", "/t")).toEqual({
    skillDirectories: ["/s"],
    extraPath: [],
    prefix: "Use the prompt-master skill.",
  })
})

const fakeFactory = (opts: { idle: boolean; reply: string | null; stopFails?: boolean }) => {
  const calls = { spawned: [] as any[], stopped: [] as string[] }
  const f = {
    spawn: async (spec: any) => {
      calls.spawned.push(spec)
      return { id: "w1", waitIdle: async () => opts.idle, lastMessage: opts.reply }
    },
    stop: async (id: string) => {
      calls.stopped.push(id)
      if (opts.stopFails) throw new Error("stop broke")
    },
  } as unknown as Factory
  return { f, calls }
}

test("enhanceWith spawns the enhance-prompt worker, decodes, and stops it", async () => {
  const { f, calls } = fakeFactory({ idle: true, reply: three })
  expect(await enhanceWith(f)("make it faster")).toHaveLength(3)
  expect(calls.spawned[0]).toMatchObject({ name: "enhance", role: "worker", step: "enhance-prompt" })
  expect(calls.spawned[0].task).toContain(JSON.stringify("make it faster"))
  expect(calls.stopped).toEqual(["w1"])
})

test("enhanceWith timeout is an error and still stops the worker", async () => {
  const { f, calls } = fakeFactory({ idle: false, reply: three })
  await expect(enhanceWith(f, 5)("p")).rejects.toThrow("enhance timed out")
  expect(calls.stopped).toEqual(["w1"])
})

test("enhanceWith bad reply is an error and still stops the worker", async () => {
  const { f, calls } = fakeFactory({ idle: true, reply: "Here are some ideas" })
  await expect(enhanceWith(f)("p")).rejects.toThrow()
  expect(calls.stopped).toEqual(["w1"])
})

test("a stop failure does not mask the original error", async () => {
  const { f } = fakeFactory({ idle: false, reply: null, stopFails: true })
  await expect(enhanceWith(f, 5)("p")).rejects.toThrow("enhance timed out")
})
