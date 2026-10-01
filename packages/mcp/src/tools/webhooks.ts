import { apiForRequest, envelope, asString } from "./shared.js"
import type { ToolDefinition } from "./types.js"

export const webhooksList: ToolDefinition = {
  name: "sendsquared_webhooks_list",
  description: "List SendSquared webhooks configured for this company.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const result = await apiForRequest().list("/webhooks")
    return envelope(
      { webhooks: result.data, total: result.total },
      `${result.total} webhooks`,
      ["sendsquared_webhooks_create"],
    )
  },
}

export const webhooksGet: ToolDefinition = {
  name: "sendsquared_webhooks_get",
  description: "Fetch a single SendSquared webhook by id.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/webhooks/${encodeURIComponent(id)}`)
    return envelope(data, `Webhook ${id}`, ["sendsquared_webhooks_delete"])
  },
}

export const webhooksCreate: ToolDefinition = {
  name: "sendsquared_webhooks_create",
  description: "Create a new SendSquared webhook that fires on a specified event.",
  inputSchema: {
    type: "object",
    required: ["url", "event"],
    properties: {
      url: { type: "string", description: "Webhook destination URL (must be https)" },
      event: { type: "string", description: "Event name to subscribe to" },
    },
  },
  handler: async (args) => {
    const url = asString(args["url"], "url")
    const event = asString(args["event"], "event")
    const data = await apiForRequest().post("/webhooks", { url, event })
    return envelope(data, "Webhook created", ["sendsquared_webhooks_list"])
  },
}

export const webhooksDelete: ToolDefinition = {
  name: "sendsquared_webhooks_delete",
  description: "Delete a SendSquared webhook. Destructive — confirm with the user first.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    await apiForRequest().delete(`/webhooks/${encodeURIComponent(id)}`)
    return envelope(null, `Webhook ${id} deleted`, ["sendsquared_webhooks_list"])
  },
}

export const webhooksTools: ToolDefinition[] = [
  webhooksList,
  webhooksGet,
  webhooksCreate,
  webhooksDelete,
]
