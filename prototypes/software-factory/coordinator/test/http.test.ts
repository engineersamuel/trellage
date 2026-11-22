import { expect, test } from "bun:test"
import { makeHttpHandler } from "../src/http.ts"

test("HTTP dispatcher preserves routing and CORS outside the protected Todo routes", async () => {
  const handle = makeHttpHandler(
    [
      ["GET", /^\/api\/info$/, () => Response.json({ ready: true })],
      ["POST", /^\/api\/draftsmanship\/([^/]+)$/, (_req, _url, [id]) => Response.json({ id })],
    ],
    "http://localhost:5174/",
    "127.0.0.1:7700",
  )
  const request = (pathname: string, method = "GET") =>
    handle(
      new Request(`http://127.0.0.1:7700${pathname}`, {
        method,
        headers: { Origin: "https://other.test" },
      }),
    )
  const info = await request("/api/info")
  expect(await info.json()).toEqual({ ready: true })
  expect(info.headers.get("access-control-allow-origin")).toBe("*")
  const decoded = await request("/api/draftsmanship/a%20b", "POST")
  expect(await decoded.json()).toEqual({ id: "a b" })
  const preflight = await request("/api/info", "OPTIONS")
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get("access-control-allow-methods")).toBe("*")
  expect((await request("/api/info", "POST")).status).toBe(404)
  expect((await request("/unknown")).status).toBe(404)
})

test("HTTP dispatcher keeps Todo reads guarded and permits the OAuth return navigation", async () => {
  let calls = 0
  const handle = makeHttpHandler(
    [
      [
        "GET",
        /^\/api\/todo\/.*$/,
        () => {
          calls++
          return Response.json({ ok: true })
        },
      ],
    ],
    "http://localhost:5174/",
    "127.0.0.1:7700",
  )
  for (const pathname of ["/api/todo", "/api/todo/status", "/api/todo/ticktick/callback?code=c&state=s"]) {
    const denied = await handle(
      new Request(`http://127.0.0.1:7700${pathname}`, {
        headers: { Origin: "https://foreign.test" },
      }),
    )
    expect(denied.status).toBe(403)
  }
  expect(calls).toBe(0)
  const callback = await handle(
    new Request("http://127.0.0.1:7700/api/todo/ticktick/callback?code=c&state=s", {
      headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" },
    }),
  )
  expect(await callback.json()).toEqual({ ok: true })
  expect(callback.headers.has("access-control-allow-origin")).toBe(false)
  expect(calls).toBe(1)
})
