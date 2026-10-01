import { createClient, companyIdFromToken, type Client } from "@sendsquared/client"
import { getRequestContext } from "../context.js"
import type { ToolResult } from "./types.js"

export function apiForRequest(): Client {
  const ctx = getRequestContext()
  return createClient({ baseUrl: ctx.baseUrl, token: ctx.token })
}

export function requestCompanyId(): number | undefined {
  return companyIdFromToken(getRequestContext().token)
}

export function envelope(
  data: unknown,
  summary: string,
  breadcrumbs: string[] = [],
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: true, data, summary, breadcrumbs }, null, 2),
      },
    ],
  }
}

export function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${field} is required and must be a non-empty string`)
  }
  return v
}

export function asOptString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

export function asOptNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export function asNumber(v: unknown, field: string, fallback?: number): number {
  const n = asOptNumber(v)
  if (n !== undefined) return n
  if (fallback !== undefined) return fallback
  throw new Error(`${field} is required and must be a number`)
}

export function asOptBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v
  if (v === "true" || v === "1") return true
  if (v === "false" || v === "0") return false
  return undefined
}
