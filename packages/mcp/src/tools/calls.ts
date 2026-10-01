import { apiForRequest, envelope, asString, asOptString, asOptNumber } from "./shared.js"
import type { ToolDefinition } from "./types.js"

/*
  Mirrors the SendSquared call log (web app /admin/call-log). Each call carries
  an embedded recordings[] array with recording_url + recording_status, plus an
  optional voicemail object that has its own recording_url. The recording URLs
  are presigned and downloadable directly without an Authorization header — the
  CLI's download-recordings command pipes them straight to disk.
*/

export const callsList: ToolDefinition = {
  name: "sendsquared_calls_list",
  description:
    "List phone calls (newest first), with embedded recordings and voicemail info. " +
    "Filter by `since`/`until` (created_at, ISO date YYYY-MM-DD) or arbitrary filter strings. " +
    "Paginates cursor-style: pass `after_id=0` for page 1, then `after_id` = last id from the previous page.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Page size (max 1000)", default: 100 },
      after_id: { type: "number", description: "Cursor — pass 0 for first page, then last id from previous page", default: 0 },
      since: { type: "string", description: "Include calls created on/after this date (YYYY-MM-DD)" },
      until: { type: "string", description: "Include calls created on/before this date (YYYY-MM-DD)" },
      queue: { type: "string", description: "Restrict to a queue id" },
      contact_name: { type: "string", description: "Substring match on contact name" },
      filter: { type: "array", items: { type: "string" }, description: "Additional filter strings (field:op:value)" },
    },
  },
  handler: async (args) => {
    const limit = asOptNumber(args["limit"]) ?? 100
    const afterId = asOptNumber(args["after_id"]) ?? 0
    const since = asOptString(args["since"])
    const until = asOptString(args["until"])
    const queue = asOptString(args["queue"])
    const contactName = asOptString(args["contact_name"])

    const filters: string[] = []
    if (since) filters.push(`created_at:gte:${since}:and`)
    if (until) filters.push(`created_at:lte:${until}:and`)
    if (Array.isArray(args["filter"])) {
      for (const f of args["filter"] as unknown[]) {
        if (typeof f === "string" && f.length > 0) filters.push(f)
      }
    }

    const query: Record<string, string | number | string[] | undefined> = {
      limit,
      after_id: afterId,
      sort: "id:desc",
    }
    if (filters.length > 0) query["filter[]"] = filters as unknown as string[]
    if (queue) query["queue"] = queue
    if (contactName) query["contact_name"] = contactName

    const result = await apiForRequest().list("/calls", query)
    const items = result.data
    const lastId =
      items.length > 0 ? (items[items.length - 1] as Record<string, unknown>)["id"] : undefined
    const nextAfterId = items.length >= limit ? lastId : null

    return envelope(
      { calls: items, total: result.total, limit, after_id: afterId, nextAfterId },
      `${items.length} calls returned${nextAfterId !== null ? ` — pass after_id=${nextAfterId} for the next page` : " (last page)"}`,
      ["sendsquared_calls_get"],
    )
  },
}

export const callsGet: ToolDefinition = {
  name: "sendsquared_calls_get",
  description:
    "Fetch a single phone call by id, including its recordings (recording_url, recording_status) and any voicemail. " +
    "Recording URLs are presigned and downloadable directly.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Call id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/calls/${encodeURIComponent(id)}`)
    return envelope(data, `Call ${id}`, ["sendsquared_calls_list"])
  },
}

export const callsTools: ToolDefinition[] = [callsList, callsGet]
