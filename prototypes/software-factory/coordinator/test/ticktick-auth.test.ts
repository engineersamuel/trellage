import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Threads } from "../src/threads.ts"
import { makeTodoApi } from "../src/todo/api.ts"
import { makeTickTickAuth, makeTokenStore, inMemoryTokenStore, type SecretsAdapter } from "../src/todo/ticktick-auth.ts"
import { TodoAuthError, makeTickTickTodoSource } from "../src/todo/ticktick.ts"

const roots: string[] = []
const originalXdg = process.env.XDG_CONFIG_HOME
afterEach(async () => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdg
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function fakeSecrets(): { adapter: SecretsAdapter; calls: unknown[]; value: string | null } {
  const calls: unknown[] = []
  const result = {
    value: null as string | null,
    calls,
    adapter: {
      get: async (options: { service: string; name: string }) => {
        calls.push(["get", options])
        return result.value
      },
      set: async (options: { service: string; name: string; value: string }) => {
        calls.push(["set", options])
        result.value = options.value
      },
      delete: async (options: { service: string; name: string }) => {
        calls.push(["delete", options])
        result.value = null
        return true
      },
    },
  }
  return result
}

function oauthFetch(log: { request?: URL; verifier?: string } = {}) {
  return async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (url.pathname.includes("oauth-protected-resource"))
      return Response.json({
        resource: "https://mcp.ticktick.com/",
        authorization_servers: ["https://ticktick.test/"],
        scopes_supported: ["tasks:read", "tasks:write"],
      })
    if (url.pathname.includes("oauth-authorization-server"))
      return Response.json({
        issuer: "https://ticktick.test/",
        authorization_endpoint: "https://ticktick.test/authorize",
        token_endpoint: "https://ticktick.test/token",
        registration_endpoint: "https://ticktick.test/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      })
    if (url.pathname === "/register") {
      const body = JSON.parse(String(init?.body))
      expect(body.redirect_uris[0]).toContain("callback")
      return Response.json({
        ...body,
        client_id: "client-one",
        token_endpoint_auth_method: "none",
      })
    }
    if (url.pathname === "/token") {
      log.verifier = new URLSearchParams(String(init?.body)).get("code_verifier") ?? undefined
      return Response.json({
        access_token: "secret-token",
        token_type: "bearer",
        expires_in: 60,
      })
    }
    throw new Error("unexpected OAuth request")
  }
}

test("secure store uses the TickTick service and never accepts another secret shape", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".ticktick-test-"))
  roots.push(root)
  const fake = fakeSecrets()
  const store = makeTokenStore({
    secrets: fake.adapter,
    file: path.join(root, "explicit-ticktick.json"),
  })
  await store.set({
    clientId: "client",
    redirectUri: "https://factory/callback",
    accessToken: "secret",
  })
  expect(fake.calls[0]).toEqual(["set", expect.objectContaining({ service: "trellage.factory", name: "ticktick" })])
  expect(await store.get()).toEqual({
    clientId: "client",
    redirectUri: "https://factory/callback",
    accessToken: "secret",
  })
  await store.delete()
  expect(fake.calls.at(-1)).toEqual([
    "delete",
    expect.objectContaining({ service: "trellage.factory", name: "ticktick" }),
  ])
})

test("fallback writes an atomic private file and round trips", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".ticktick-test-"))
  roots.push(root)
  process.env.XDG_CONFIG_HOME = root
  const broken = new Error("unavailable")
  const adapter: SecretsAdapter = {
    get: async () => {
      throw broken
    },
    set: async () => {
      throw broken
    },
    delete: async () => {
      throw broken
    },
  }
  const store = makeTokenStore({ secrets: adapter })
  const credential = {
    clientId: "client",
    redirectUri: "https://factory/callback",
    accessToken: "secret-token",
  }
  await store.set(credential)
  const dir = path.join(root, "trellage", "factory")
  const file = path.join(dir, "ticktick.json")
  expect((await stat(dir)).mode & 0o777).toBe(0o700)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(await store.get()).toEqual(credential)
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(credential)
  const firstInode = (await stat(file)).ino
  await store.set({ ...credential, accessToken: "replacement-token" })
  expect((await stat(file)).ino).not.toBe(firstInode)
  expect(await readdir(dir)).toEqual(["ticktick.json"])
  expect(store.store()).toBe("file")
  expect(store.warn()).toContain("plain-text")
})

test("a renewed fallback credential wins after the token store restarts", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".ticktick-test-"))
  roots.push(root)
  process.env.XDG_CONFIG_HOME = root
  const oldCredential = {
    clientId: "client",
    redirectUri: "https://factory/callback",
    accessToken: "stale-secret-token",
    expiresAt: 1,
  }
  const renewedCredential = { ...oldCredential, accessToken: "renewed-secret-token", expiresAt: Date.now() + 60_000 }
  const secrets: SecretsAdapter = {
    get: async () => JSON.stringify(oldCredential),
    set: async () => {
      throw new Error("secure store unavailable")
    },
    delete: async () => {
      throw new Error("secure store unavailable")
    },
  }

  await makeTokenStore({ secrets }).set(renewedCredential)
  const restarted = makeTokenStore({ secrets })

  expect(await restarted.get()).toEqual(renewedCredential)
  expect(restarted.store()).toBe("file")
})

test("OAuth connect and callback use PKCE S256 and state once", async () => {
  const log: { verifier?: string } = {}
  const auth = makeTickTickAuth({
    store: inMemoryTokenStore(),
    fetch: oauthFetch(log),
    uiUrl: () => "http://localhost:5174/",
  })
  const url = await auth.connect()
  expect(url.searchParams.get("scope")).toBe("tasks:read tasks:write")
  expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const state = url.searchParams.get("state")!
  await auth.callback("code", state)
  const verifier = new TextEncoder().encode(log.verifier)
  const expected = Buffer.from(await crypto.subtle.digest("SHA-256", verifier)).toString("base64url")
  expect(expected).toBe(url.searchParams.get("code_challenge")!)
  await expect(auth.callback("code", state)).rejects.toThrow("state")
  expect(await auth.status()).toEqual({
    status: "connected",
    expiresAt: expect.any(Number),
    store: "memory",
    warn: true,
  })
})

test("state expires after ten minutes and status redacts tokens", async () => {
  let clock = 1_000
  const auth = makeTickTickAuth({
    store: inMemoryTokenStore(),
    fetch: oauthFetch(),
    now: () => clock,
    uiUrl: () => "http://localhost:5174/",
  })
  const url = await auth.connect()
  clock += 10 * 60 * 1000 + 1
  await expect(auth.callback("code", url.searchParams.get("state")!)).rejects.toThrow("state")
  await auth.tokenStore.set({
    clientId: "client",
    redirectUri: "https://factory/callback",
    accessToken: "do-not-leak",
    expiresAt: clock + 100,
  })
  expect(JSON.stringify(await auth.status())).not.toContain("do-not-leak")
  clock += 101
  expect(await auth.status()).toMatchObject({ status: "expired" })
  auth.markUnauthorized()
  expect(await auth.status()).toMatchObject({ status: "expired" })
  await auth.disconnect()
  expect(await auth.status()).toMatchObject({ status: "disconnected" })
})

test("upstream OAuth errors are sanitized", async () => {
  const auth = makeTickTickAuth({
    store: inMemoryTokenStore(),
    fetch: async () => {
      throw new Error("server echoed secret-token")
    },
  })
  let error = ""
  try {
    await auth.connect()
  } catch (caught) {
    error = String(caught)
  }
  expect(error).not.toContain("secret-token")
  expect(error).toContain("TickTick OAuth request failed")
})

test("the production TickTick HTTP transport turns an injected 401 into expired status", async () => {
  const token = "distinctive-transport-token"
  const root = await mkdtemp(path.join(process.cwd(), ".ticktick-auth-api-"))
  roots.push(root)
  const auth = makeTickTickAuth({ store: inMemoryTokenStore() })
  await auth.tokenStore.set({
    clientId: "client",
    redirectUri: "https://factory/callback",
    accessToken: token,
    expiresAt: Date.now() + 60_000,
  })
  const requests: Request[] = []
  const source = makeTickTickTodoSource({
    accessToken: async () => (await auth.accessToken()) ?? "",
    expired: auth.markUnauthorized,
    fetch: (async (input, init) => {
      requests.push(new Request(input, init))
      return new Response(`Unauthorized: Authorization: Bearer ${token}`, {
        status: 401,
        headers: { "content-type": "text/plain" },
      })
    }) as typeof globalThis.fetch,
  })

  let failure: unknown
  try {
    await Effect.runPromise(source.lists())
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(TodoAuthError)
  const status = await auth.status()
  expect(status).toEqual({ status: "expired" })
  const api = makeTodoApi({
    enabled: true,
    threads: new Threads(root),
    uiUrl: "http://factory.test/",
    auth: {
      ...auth,
      connect: async () => new URL("http://ticktick.test/connect"),
      callback: async () => undefined,
    },
    source: {
      lists: async () => [],
      tasks: async () => [],
      task: async () => {
        throw new Error("not used")
      },
    },
  })
  const response = await api.handle(
    new Request("http://factory.test/api/todo/status"),
    new URL("http://factory.test/api/todo/status"),
  )
  const body = await response.text()
  expect(response.status).toBe(200)
  expect(JSON.parse(body)).toEqual({ state: "expired" })
  for (const output of [String(failure), JSON.stringify(status), body]) {
    expect(output).not.toContain(token)
    expect(output.toLowerCase()).not.toContain("bearer")
  }
  expect(requests.length).toBeGreaterThan(0)
  expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${token}`)
})
