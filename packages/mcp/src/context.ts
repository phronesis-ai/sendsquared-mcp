import { AsyncLocalStorage } from "node:async_hooks"

export interface RequestContext {
  token: string
  userId: string
  email: string
  companyId: number
  baseUrl: string
}

/*
  The MCP Server instance is long-lived across a session, but every tool call
  must execute with the bearer token from the current HTTP request. We use
  AsyncLocalStorage so the Express middleware can bind per-request context
  once, and any tool handler downstream — no matter how deep the call stack —
  can read it via getRequestContext(). This is the only clean way to thread
  per-request auth through a shared MCP Server without rebuilding it on every
  POST.
*/
export const requestContext = new AsyncLocalStorage<RequestContext>()

export function getRequestContext(): RequestContext {
  const ctx = requestContext.getStore()
  if (!ctx) {
    throw new Error("No request context — tool handler invoked outside an authenticated HTTP request")
  }
  return ctx
}
