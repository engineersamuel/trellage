import { expect, test } from "bun:test"
import { workerEnv } from "../src/factory.ts"

test("a worker's env drops the factory's SF_* settings and keeps MCP headers, the budget file and the rest", () => {
  const env = workerEnv({
    PATH: "/bin",
    HOME: "/h",
    SF_URL: "http://127.0.0.1:20276",
    SF_UI_URL: "http://localhost:20277/",
    SF_ADDR: "127.0.0.1:20276",
    SF_STATE_DIR: "/s",
    SF_CONFIG: "/c",
    SF_MODEL: "m",
    PC_SOCKET_PATH: "/s/pc.sock",
    SF_MCP_PERPLEXITY_AUTHORIZATION: "Bearer x",
    SF_PERPLEXITY_BUDGET_FILE: "/b.json",
    EMPTY: undefined,
  })
  expect(env).toEqual({
    PATH: "/bin",
    HOME: "/h",
    SF_MCP_PERPLEXITY_AUTHORIZATION: "Bearer x",
    SF_PERPLEXITY_BUDGET_FILE: "/b.json",
  })
})
