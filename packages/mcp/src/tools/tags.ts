import { apiForRequest, envelope, asString } from "./shared.js"
import type { ToolDefinition } from "./types.js"

export const tagsList: ToolDefinition = {
  name: "sendsquared_tags_list",
  description: "List all SendSquared tags for this company.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const result = await apiForRequest().list("/tags")
    return envelope(
      { tags: result.data, total: result.total },
      `${result.total} tags`,
      ["sendsquared_tags_create", "sendsquared_contacts_list"],
    )
  },
}

export const tagsGet: ToolDefinition = {
  name: "sendsquared_tags_get",
  description: "Fetch a single SendSquared tag by id.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/tags/${encodeURIComponent(id)}`)
    return envelope(data, `Tag ${id}`, [
      "sendsquared_contacts_list",
      "sendsquared_tags_update",
      "sendsquared_tags_delete",
    ])
  },
}

export const tagsCreate: ToolDefinition = {
  name: "sendsquared_tags_create",
  description: "Create a new SendSquared tag.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string", description: "Tag name / label" } },
  },
  handler: async (args) => {
    const name = asString(args["name"], "name")
    const data = await apiForRequest().post("/tags", { label: name, active: true })
    return envelope(data, `Tag created: ${name}`, ["sendsquared_tags_list"])
  },
}

export const tagsUpdate: ToolDefinition = {
  name: "sendsquared_tags_update",
  description: "Rename an existing SendSquared tag.",
  inputSchema: {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "string" },
      name: { type: "string", description: "New tag name" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const name = asString(args["name"], "name")
    const data = await apiForRequest().put(`/tags/${encodeURIComponent(id)}`, { name })
    return envelope(data, `Tag ${id} updated`, ["sendsquared_tags_get"])
  },
}

export const tagsDelete: ToolDefinition = {
  name: "sendsquared_tags_delete",
  description: "Delete a SendSquared tag. Destructive — confirm with the user first.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    await apiForRequest().delete(`/tags/${encodeURIComponent(id)}`)
    return envelope(null, `Tag ${id} deleted`, ["sendsquared_tags_list"])
  },
}

export const tagsTools: ToolDefinition[] = [tagsList, tagsGet, tagsCreate, tagsUpdate, tagsDelete]
