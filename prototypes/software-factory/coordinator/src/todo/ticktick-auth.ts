import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js"
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js"
import { Context } from "effect"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const SERVICE = "trellage.factory"
const NAME = "ticktick"
const SCOPES = "tasks:read tasks:write"
const SERVER = "https://mcp.ticktick.com/"
const PENDING_TTL = 10 * 60 * 1000
const FILE_WARNING = "Bun secrets unavailable; credentials use the plain-text fallback file."

export type CredentialStore = "secrets" | "file" | "memory"
export interface TickTickCredentials {
  clientId: string
  redirectUri: string
  accessToken?: string
  expiresAt?: number
}
export interface SecretsAdapter {
  get(options: { service: string; name: string }): Promise<string | null>
  set(options: { service: string; name: string; value: string }): Promise<void>
  delete(options: { service: string; name: string }): Promise<boolean>
}
export interface TokenStoreService {
  get(): Promise<TickTickCredentials | undefined>
  set(value: TickTickCredentials): Promise<void>
  delete(): Promise<void>
  load(): Promise<TickTickCredentials | undefined>
  save(value: TickTickCredentials): Promise<void>
  remove(): Promise<void>
  store(): CredentialStore
  warn(): string | undefined
}
export class TokenStore extends Context.Service<TokenStore, TokenStoreService>()("TokenStore") {}

const bunSecrets = (): SecretsAdapter => ({
  get: (options) => Bun.secrets.get(options),
  set: (options) => Bun.secrets.set(options),
  delete: (options) => Bun.secrets.delete(options),
})

function decode(value: string | null): TickTickCredentials | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<TickTickCredentials>
    if (typeof parsed.clientId !== "string" || typeof parsed.redirectUri !== "string") return undefined
    if (parsed.accessToken !== undefined && typeof parsed.accessToken !== "string") return undefined
    if (parsed.expiresAt !== undefined && typeof parsed.expiresAt !== "number") return undefined
    return parsed as TickTickCredentials
  } catch {
    return undefined
  }
}

function fallbackPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config")
  return path.join(base, "trellage", "factory", "ticktick.json")
}

export function makeTokenStore(options: { secrets?: SecretsAdapter; file?: string } = {}): TokenStoreService {
  const secrets = options.secrets ?? bunSecrets()
  const file = options.file ?? fallbackPath()
  let store: "secrets" | "file" = "secrets"
  const fileRead = async () => {
    try {
      return decode(await readFile(file, "utf8"))
    } catch {
      return undefined
    }
  }
  const fileWrite = async (value: TickTickCredentials) => {
    const dir = path.dirname(file)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    const tmp = path.join(dir, `.ticktick-${process.pid}-${crypto.randomUUID()}.tmp`)
    try {
      await writeFile(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 })
      await chmod(tmp, 0o600)
      await rename(tmp, file)
      await chmod(file, 0o600)
    } finally {
      await rm(tmp, { force: true })
    }
  }
  const fallback = () => (store = "file")
  const get = async () => {
    if (store === "file") return fileRead()
    const disk = await fileRead()
    if (disk) {
      fallback()
      return disk
    }
    try {
      return decode(await secrets.get({ service: SERVICE, name: NAME }))
    } catch {
      fallback()
      return fileRead()
    }
  }
  const set = async (value: TickTickCredentials) => {
    if (store === "file") return fileWrite(value)
    try {
      await secrets.set({ service: SERVICE, name: NAME, value: JSON.stringify(value) })
      await rm(file, { force: true })
    } catch {
      fallback()
      await fileWrite(value)
    }
  }
  const remove = async () => {
    await secrets.delete({ service: SERVICE, name: NAME })
    await rm(file, { force: true })
  }
  const service = {
    get,
    set,
    delete: remove,
    load: get,
    save: set,
    remove,
    store: () => store,
    warn: () => (store === "file" ? FILE_WARNING : undefined),
  }
  return service
}

export function inMemoryTokenStore(): TokenStoreService {
  let value: TickTickCredentials | undefined
  const get = async () => value
  const set = async (next: TickTickCredentials) => void (value = { ...next })
  const remove = async () => void (value = undefined)
  return { get, set, delete: remove, load: get, save: set, remove, store: () => "memory", warn: () => undefined }
}

export type TickTickAuthStatus =
  | { status: "disconnected" }
  | { status: "expired" }
  | { status: "connected"; expiresAt: number; store: CredentialStore; warn: boolean }

type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>
interface Pending {
  verifier: string
  createdAt: number
  client: { client_id: string }
  redirectUri: string
  server: string
  metadata?: AuthorizationServerMetadata
  resource?: string
}
export interface TickTickAuthOptions {
  store?: TokenStoreService
  fetch?: FetchLike
  now?: () => number
  uiUrl?: () => string
}

export function redirectUri(uiUrl = process.env.SF_UI_URL || "http://localhost:5174/"): string {
  return new URL("api/todo/ticktick/callback", new URL(uiUrl, "http://localhost:5174/")).href
}

export class TickTickAuthError extends Error {
  constructor(message = "TickTick OAuth request failed") {
    super(message)
    this.name = "TickTickAuthError"
  }
}

export function makeTickTickAuth(options: TickTickAuthOptions = {}) {
  const store = options.store ?? makeTokenStore()
  const fetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const pending = new Map<string, Pending>()
  let unauthorized = false
  const safe = async <T>(action: () => Promise<T>, message?: string): Promise<T> => {
    try {
      return await action()
    } catch {
      throw new TickTickAuthError(message)
    }
  }
  const connect = async (): Promise<URL> => {
    const uri = redirectUri(options.uiUrl?.())
    const old = await store.get()
    const discovered = await safe(() => discoverOAuthServerInfo(SERVER, { fetchFn: fetch }))
    let client = old?.redirectUri === uri ? { client_id: old.clientId } : undefined
    if (!client) {
      const registered = await safe(() =>
        registerClient(discovered.authorizationServerUrl, {
          metadata: discovered.authorizationServerMetadata,
          scope: SCOPES,
          fetchFn: fetch,
          clientMetadata: {
            client_name: "Trellage Factory",
            redirect_uris: [uri],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code"],
            response_types: ["code"],
            scope: SCOPES,
          },
        }),
      )
      client = registered
      await store.set({ clientId: registered.client_id, redirectUri: uri })
    }
    const state = crypto.randomUUID()
    const started = await safe(() =>
      startAuthorization(discovered.authorizationServerUrl, {
        metadata: discovered.authorizationServerMetadata,
        clientInformation: client,
        redirectUrl: uri,
        scope: SCOPES,
        state,
        resource: discovered.resourceMetadata?.resource,
      }),
    )
    pending.set(state, {
      verifier: started.codeVerifier,
      createdAt: now(),
      client,
      redirectUri: uri,
      server: discovered.authorizationServerUrl,
      metadata: discovered.authorizationServerMetadata,
      resource: discovered.resourceMetadata?.resource,
    })
    return started.authorizationUrl
  }
  const callback = async (code: string, state: string): Promise<void> => {
    const request = pending.get(state)
    pending.delete(state)
    if (!request || now() - request.createdAt > PENDING_TTL)
      throw new TickTickAuthError("Invalid or expired OAuth state")
    const tokens = await safe(() =>
      exchangeAuthorization(request.server, {
        metadata: request.metadata,
        clientInformation: request.client,
        authorizationCode: code,
        codeVerifier: request.verifier,
        redirectUri: request.redirectUri,
        resource: request.resource,
        fetchFn: fetch,
      }),
    )
    await store.set({
      clientId: request.client.client_id,
      redirectUri: request.redirectUri,
      accessToken: tokens.access_token,
      expiresAt: tokens.expires_in === undefined ? undefined : now() + tokens.expires_in * 1000,
    })
    unauthorized = false
  }
  const status = async (): Promise<TickTickAuthStatus> => {
    const credential = await store.get()
    if (!credential?.accessToken) return { status: "disconnected" }
    if (unauthorized || !credential.expiresAt || credential.expiresAt <= now()) return { status: "expired" }
    return {
      status: "connected",
      expiresAt: credential.expiresAt,
      store: store.store(),
      warn: credential.expiresAt - now() < 14 * 24 * 60 * 60 * 1000,
    }
  }
  const markUnauthorized = () => void (unauthorized = true)
  const disconnect = async () => {
    unauthorized = false
    pending.clear()
    await store.delete()
  }
  const accessToken = async () => (await store.get())?.accessToken
  return { connect, callback, status, markUnauthorized, disconnect, accessToken, tokenStore: store }
}
