import { refreshAuthToken } from "./auth.js"

const DEFAULT_BASE_URL = "https://api.sendsquared.com"

export interface ClientContext {
  baseUrl?: string
  token: string
  refreshToken?: string
  onTokenRefresh?: (newToken: string) => void | Promise<void>
}

export interface PageResult<T = unknown> {
  data: T[]
  total: number
}

export type QueryValue = string | number | string[] | number[] | undefined
export type QueryParams = Record<string, QueryValue>

export interface Client {
  get: <T = unknown>(path: string, query?: QueryParams) => Promise<T>
  list: <T = unknown>(path: string, query?: QueryParams) => Promise<PageResult<T>>
  post: <T = unknown>(path: string, body?: unknown) => Promise<T>
  put: <T = unknown>(path: string, body?: unknown) => Promise<T>
  patch: <T = unknown>(path: string, body?: unknown) => Promise<T>
  delete: <T = unknown>(path: string) => Promise<T>
  postForm: <T = unknown>(path: string, form: FormData) => Promise<T>
}

/*
  FormData bodies go out as multipart and fetch must set the Content-Type
  itself so the boundary is included; everything else is JSON.
*/
function requestInit(method: string, token: string, body: unknown): RequestInit {
  if (body instanceof FormData) {
    return { method, headers: { Authorization: `Bearer ${token}` }, body }
  }
  return {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  }
}

export async function request<T = unknown>(
  ctx: ClientContext,
  method: string,
  path: string,
  body?: unknown,
  query?: QueryParams,
): Promise<T> {
  const baseUrl = ctx.baseUrl ?? DEFAULT_BASE_URL
  const url = new URL(`/v1${path}`, baseUrl)

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined) url.searchParams.append(key, String(item))
        }
      } else {
        url.searchParams.append(key, String(value))
      }
    }
  }

  /*
    Fix URL-encoded brackets for array params (e.g. lead_status_ids[]).
    Node's URL encodes [] as %5B%5D but the SendSquared API expects literal brackets.
  */
  const urlString = url.toString().replace(/%5B/g, "[").replace(/%5D/g, "]")

  let res = await fetch(urlString, requestInit(method, ctx.token, body))

  if (res.status === 401 && ctx.refreshToken) {
    const newJwt = await refreshAuthToken(baseUrl, ctx.refreshToken)
    if (ctx.onTokenRefresh) await ctx.onTokenRefresh(newJwt)
    res = await fetch(urlString, requestInit(method, newJwt, body))
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After")
    throw new Error(`Rate limited. Retry after ${retryAfter ?? "a few"} seconds.`)
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "")
    const sanitized = errBody.length > 200 ? errBody.slice(0, 200) : errBody
    throw new Error(`API error ${res.status}: ${sanitized}`)
  }

  if (res.status === 204) return undefined as T

  /*
    A few legacy Express routes answer a successful mutation with a bare
    "OK" (sendStatus) rather than JSON. Treat any non-JSON success body as
    an empty result instead of failing the call after the server already
    applied the change.
  */
  const text = await res.text()
  if (text.length === 0) return undefined as T
  const contentType = res.headers.get("Content-Type") ?? ""
  if (!contentType.includes("json") && !/^\s*[[{"]/.test(text)) return undefined as T
  return JSON.parse(text) as T
}

/*
  Normalizes paginated API responses.
  The API may return either { data: [], total: N } or a raw array.
  This function ensures a consistent { data, total } shape regardless of source.
*/
function normalizePage<T>(raw: unknown): PageResult<T> {
  if (Array.isArray(raw)) {
    return { data: raw as T[], total: raw.length }
  }
  const obj = raw as Record<string, unknown>
  if (Array.isArray(obj["data"])) {
    return { data: obj["data"] as T[], total: (obj["total"] as number) ?? obj["data"].length }
  }
  if (Array.isArray(obj["rows"])) {
    return { data: obj["rows"] as T[], total: (obj["total"] as number) ?? obj["rows"].length }
  }
  return { data: [raw as T], total: 1 }
}

export function createClient(ctx: ClientContext): Client {
  return {
    get: <T = unknown>(path: string, query?: QueryParams) =>
      request<T>(ctx, "GET", path, undefined, query),

    list: async <T = unknown>(
      path: string,
      query?: QueryParams,
    ): Promise<PageResult<T>> => {
      const raw = await request<unknown>(ctx, "GET", path, undefined, query)
      return normalizePage<T>(raw)
    },

    post: <T = unknown>(path: string, body?: unknown) =>
      request<T>(ctx, "POST", path, body),

    put: <T = unknown>(path: string, body?: unknown) =>
      request<T>(ctx, "PUT", path, body),

    patch: <T = unknown>(path: string, body?: unknown) =>
      request<T>(ctx, "PATCH", path, body),

    delete: <T = unknown>(path: string) =>
      request<T>(ctx, "DELETE", path),

    postForm: <T = unknown>(path: string, form: FormData) =>
      request<T>(ctx, "POST", path, form),
  }
}
