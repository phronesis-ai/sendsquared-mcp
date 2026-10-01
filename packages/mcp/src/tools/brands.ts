import { apiForRequest, envelope, asString, asOptString, asOptNumber } from "./shared.js"
import type { ToolDefinition } from "./types.js"

const BRAND_FIELD_SCHEMA = {
  email: { type: "string", description: "Brand contact email" },
  phone: { type: "string", description: "Brand phone number" },
  address_1: { type: "string", description: "Address line 1" },
  address_2: { type: "string", description: "Address line 2" },
  locality: { type: "string", description: "City / locality" },
  region: { type: "string", description: "State / region" },
  postal: { type: "string", description: "Postal / ZIP code" },
  country: { type: "string", description: "ISO 3166-1 country code (e.g. US)" },
  locale: { type: "string", description: "ISO 639-1 language code (e.g. en)" },
  timezone: { type: "string", description: "IANA timezone (e.g. America/New_York)" },
  logo_asset_id: { type: "number", description: "Asset ID of the brand logo" },
} as const

const BRAND_API_KEYS = ["name", ...Object.keys(BRAND_FIELD_SCHEMA)]

/*
  Pull the optional brand fields out of a tool-call args object into an
  API payload. Only keys the caller actually supplied are included, so this
  serves both create (full payload) and update (partial overlay).
*/
function collectBrandFields(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const key of ["email", "phone", "address_1", "address_2", "locality", "region", "postal", "country", "locale", "timezone"]) {
    const v = asOptString(args[key])
    if (v !== undefined) payload[key] = v
  }
  const logo = asOptNumber(args["logo_asset_id"])
  if (logo !== undefined) payload["logo_asset_id"] = logo
  return payload
}

export const brandsList: ToolDefinition = {
  name: "sendsquared_brands_list",
  description: "List all SendSquared brands for this company.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const result = await apiForRequest().list("/brands")
    return envelope(
      { brands: result.data, total: result.total },
      `${result.total} brands`,
      ["sendsquared_brands_create", "sendsquared_brands_get"],
    )
  },
}

export const brandsGet: ToolDefinition = {
  name: "sendsquared_brands_get",
  description: "Fetch a single SendSquared brand by id.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/brands/${encodeURIComponent(id)}`)
    return envelope(data, `Brand ${id}`, [
      "sendsquared_brands_update",
      "sendsquared_brands_delete",
    ])
  },
}

export const brandsCreate: ToolDefinition = {
  name: "sendsquared_brands_create",
  description: "Create a new SendSquared brand. Only 'name' is required.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: "Brand name" },
      ...BRAND_FIELD_SCHEMA,
    },
  },
  handler: async (args) => {
    const name = asString(args["name"], "name")
    const data = await apiForRequest().post("/brands", { name, ...collectBrandFields(args) })
    return envelope(data, `Brand created: ${name}`, ["sendsquared_brands_list"])
  },
}

export const brandsUpdate: ToolDefinition = {
  name: "sendsquared_brands_update",
  description:
    "Update a SendSquared brand. Only the fields you supply are changed; the rest are preserved.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      name: { type: "string", description: "Brand name" },
      ...BRAND_FIELD_SCHEMA,
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    /*
      Fetch the current brand, carry forward only its editable fields, and
      overlay the supplied ones. Re-sending the whole fetched record would
      echo back server-side fields the update validator rejects.
    */
    const current = (await apiForRequest().get(`/brands/${encodeURIComponent(id)}`)) as Record<string, unknown>
    const carried: Record<string, unknown> = {}
    for (const k of BRAND_API_KEYS) {
      if (k in current) carried[k] = current[k]
    }
    const overlay = collectBrandFields(args)
    const name = asOptString(args["name"])
    if (name !== undefined) overlay["name"] = name
    const data = await apiForRequest().put(`/brands/${encodeURIComponent(id)}`, { ...carried, ...overlay })
    return envelope(data, `Brand ${id} updated`, ["sendsquared_brands_get"])
  },
}

export const brandsDelete: ToolDefinition = {
  name: "sendsquared_brands_delete",
  description: "Delete a SendSquared brand. Destructive — there is no undo.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    await apiForRequest().delete(`/brands/${encodeURIComponent(id)}`)
    return envelope(null, `Brand ${id} deleted`, ["sendsquared_brands_list"])
  },
}

export const brandsTools: ToolDefinition[] = [
  brandsList,
  brandsGet,
  brandsCreate,
  brandsUpdate,
  brandsDelete,
]
