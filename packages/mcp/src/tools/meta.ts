import { apiForRequest, envelope } from "./shared.js"
import { getRequestContext } from "../context.js"
import type { ToolDefinition } from "./types.js"

export const version: ToolDefinition = {
  name: "sendsquared_version",
  description: "Get the SendSquared API version info. Useful as a quick sanity check that the current token reaches the API.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await apiForRequest().get("/version")
    return envelope(data, "SendSquared API version")
  },
}

export const doctor: ToolDefinition = {
  name: "sendsquared_doctor",
  description: "Run connectivity diagnostics: verify the current token, report the authenticated user, and ping the API version endpoint. Use this when the user reports something isn't working, to narrow down the failure.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const ctx = getRequestContext()
    const checks: Array<{ check: string; status: string; detail: string }> = []

    checks.push({
      check: "authenticated_user",
      status: "ok",
      detail: `${ctx.email} (user id ${ctx.userId})`,
    })

    checks.push({
      check: "api_url",
      status: "ok",
      detail: ctx.baseUrl,
    })

    const res = await fetch(`${ctx.baseUrl}/v1/version`, {
      headers: { Authorization: `Bearer ${ctx.token}` },
    })
    checks.push({
      check: "api_connectivity",
      status: res.ok ? "ok" : "error",
      detail: res.ok ? "Connected" : `HTTP ${res.status}`,
    })

    const allOk = checks.every((c) => c.status === "ok")
    return envelope(
      checks,
      allOk ? "All checks passed" : "Some checks failed",
      ["sendsquared_version", "sendsquared_contacts_list"],
    )
  },
}

export const metaTools: ToolDefinition[] = [version, doctor]
