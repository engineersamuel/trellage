import { todoOriginDenied } from "./todo/api.ts"

export type Handler = (req: Request, url: URL, params: string[]) => Response | Promise<Response>

type Routes = [string, RegExp, Handler][]

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "*",
  "access-control-allow-headers": "*",
}

const routeResponse = async (routes: Routes, req: Request, url: URL): Promise<Response | undefined> => {
  for (const [method, re, handler] of routes) {
    const m = method === req.method && url.pathname.match(re)
    if (m) return handler(req, url, m.slice(1).map(decodeURIComponent))
  }
  return undefined
}

export const makeHttpHandler =
  (routes: Routes, uiUrl: string, coordinatorAddress: string) =>
  async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const todoRequest = /^\/api\/(?:todo|drafts|threads\/delete)(?:\/|$)/.test(url.pathname)
    if (todoRequest) {
      const denied = todoOriginDenied(req, uiUrl, coordinatorAddress)
      if (denied) return denied
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: todoRequest ? undefined : cors })
    const res = await routeResponse(routes, req, url)
    if (!res) return new Response(null, { status: 404 })
    if (!todoRequest) for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
    return res
  }
