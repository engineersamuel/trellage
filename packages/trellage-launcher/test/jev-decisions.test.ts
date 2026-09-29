import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  adoptPrivateJevApiKey,
  askJevChoice,
  askJevNoul,
  askJevNouls,
  jevPrivateApiKeyVariable,
  type JevSystemOneClient,
} from "../src/jev-decisions.ts"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe("Jev typed decisions", () => {
  it("batches independent noul questions into one request", async () => {
    let request: unknown
    const client: JevSystemOneClient = {
      systemOne: async (value) => {
        request = value
        return {
          answers: {
            first: { type: "noul", noul: 0.01 },
            second: { type: "noul", noul: 0.02 },
          },
        }
      },
    }
    const result = await askJevNouls(
      { cwd: "/tmp", client },
      { item: "example" },
      {
        first: { instructions: "Question one?", criteria: { true: "yes", false: "no" } },
        second: { instructions: "Question two?", criteria: { true: "yes", false: "no" } },
      },
    )
    expect(result).toEqual({ first: 0.01, second: 0.02 })
    expect(Object.keys((request as { questions: Record<string, unknown> }).questions)).toEqual(["first", "second"])
  })

  it("returns validated choice confidence and rejects values outside the candidate set", async () => {
    const client: JevSystemOneClient = {
      systemOne: async () => ({
        answers: {
          decision: {
            type: "choice",
            choice: "network",
            confidence: 0.97,
            probabilities: { network: 0.98, unknown: 0.02 },
          },
        },
      }),
    }
    await expect(
      askJevChoice({ cwd: "/tmp", client }, { output: "connection refused" }, "Pick the cause", {
        network: "network failure",
        unknown: "unknown",
      }),
    ).resolves.toEqual({ choice: "network", confidence: 0.97 })
    const malformed: JevSystemOneClient = {
      systemOne: async () => ({
        answers: {
          decision: { type: "choice", choice: "unexpected", confidence: 0.99, probabilities: { unexpected: 1 } },
        },
      }),
    }
    await expect(askJevChoice({ cwd: "/tmp", client: malformed }, {}, "Pick", { known: "known" })).rejects.toThrow(
      "Invalid Jev decision choice",
    )
  })

  it("loads only TYPESAFE_API_KEY from the worktree .env", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "jev-decisions-test-"))
    roots.push(cwd)
    await writeFile(path.join(cwd, ".env"), "OTHER=not-a-key\nTYPESAFE_API_KEY=from-dotenv\n")
    let received = ""
    const client: JevSystemOneClient = {
      systemOne: async () => ({ answers: { decision: { type: "noul", noul: 0.75 } } }),
    }
    await expect(
      askJevNoul(
        {
          cwd,
          env: {},
          clientFactory: (key) => {
            received = key
            return client
          },
        },
        { text: "test" },
        "Does it fit?",
        { true: "yes", false: "no" },
      ),
    ).resolves.toBe(0.75)
    expect(received).toBe("from-dotenv")
  })

  it("adopts the private trx key into memory and removes it from the environment", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "jev-decisions-test-"))
    roots.push(cwd)
    const inherited: Record<string, string | undefined> = { [jevPrivateApiKeyVariable]: "from-varlock" }
    const received: string[] = []
    const ask = (env: Record<string, string | undefined>) =>
      askJevNoul(
        {
          cwd,
          env,
          clientFactory: (key: string): JevSystemOneClient => {
            received.push(key)
            return { systemOne: async () => ({ answers: { decision: { type: "noul", noul: 0.5 } } }) }
          },
        },
        { text: "test" },
        "Does it fit?",
        { true: "yes", false: "no" },
      )
    try {
      adoptPrivateJevApiKey(inherited)
      expect(inherited).toEqual({})
      await ask({})
      await ask({ TYPESAFE_API_KEY: "from-process" })
      await writeFile(path.join(cwd, ".env"), "TYPESAFE_API_KEY=from-dotenv\n")
      await ask({})
    } finally {
      adoptPrivateJevApiKey({})
    }
    expect(received).toEqual(["from-varlock", "from-process", "from-dotenv"])
    await rm(path.join(cwd, ".env"))
    await expect(ask({})).rejects.toThrow("Jev credentials unavailable")
  })
})
