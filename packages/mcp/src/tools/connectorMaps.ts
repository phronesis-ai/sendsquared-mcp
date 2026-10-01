import { apiForRequest, envelope, asString, asOptString, asOptNumber } from "./shared.js"
import type { ToolDefinition } from "./types.js"

/*
  Connector maps tie an external integration field (e.g. a PMS attribute named
  "a57") to a SendSquared column or a custom field. Mirrors the SendSquared
  web app at /admin/connector-map/list (services/connectorMapServices.js).

  Endpoint quirks worth knowing:
    - Update is POST /connector-map/{id} — there is no PUT/PATCH route.
    - The "Add Custom Field" checkbox in the UI maps to custom_field_id = 0
      on the wire (a sentinel meaning "create a new custom field for this
      mapping"). custom_field_id = null means "no custom field — use target
      instead". An existing number reuses that custom field.
*/

export const connectorMapsList: ToolDefinition = {
  name: "sendsquared_connector_maps_list",
  description:
    "List all SendSquared connector maps for this company. A connector map ties an external integration " +
    "field (e.g. a PMS attribute) to a SendSquared column or custom field — same surface as the web app's " +
    "/admin/connector-map/list page.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const result = await apiForRequest().list("/connector-map")
    return envelope(
      { connector_maps: result.data, total: result.total },
      `${result.total} connector maps`,
      ["sendsquared_connector_maps_get", "sendsquared_connector_maps_create"],
    )
  },
}

export const connectorMapsGet: ToolDefinition = {
  name: "sendsquared_connector_maps_get",
  description: "Fetch a single SendSquared connector map by id.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Connector map id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/connector-map/${encodeURIComponent(id)}`)
    return envelope(data, `Connector map ${id}`, [
      "sendsquared_connector_maps_update",
      "sendsquared_connector_maps_delete",
    ])
  },
}

/*
  Build the connector-map payload from tool args. Centralizes the
  add-custom-field semantics so create and update share one rule:
    - add_custom_field=true → custom_field_id=0 (create a new custom field),
      data_type must be supplied ("string" or "number").
    - custom_field_id passed explicitly → use it as-is.
    - neither → custom_field_id=null and target is used to point at a column.
*/
function buildConnectorMapPayload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  const connectorId = asOptNumber(args["connector_id"])
  const description = asOptString(args["description"])
  const objectType = asOptString(args["object_type"])
  const sourceAttribute = asOptString(args["source_attribute"])
  const target = asOptString(args["target"])
  const dataType = asOptString(args["data_type"])
  const explicitCustomField = asOptNumber(args["custom_field_id"])
  const addCustomField = typeof args["add_custom_field"] === "boolean" ? args["add_custom_field"] : undefined

  if (connectorId !== undefined) payload["connector_id"] = connectorId
  if (description !== undefined) payload["description"] = description
  if (objectType !== undefined) payload["object_type"] = objectType
  if (sourceAttribute !== undefined) payload["source_attribute"] = sourceAttribute
  if (target !== undefined) payload["target"] = target

  if (addCustomField === true) {
    payload["custom_field_id"] = 0
    if (dataType !== undefined) payload["data_type"] = dataType
  } else if (addCustomField === false) {
    payload["custom_field_id"] = null
  } else if (explicitCustomField !== undefined) {
    payload["custom_field_id"] = explicitCustomField
    if (dataType !== undefined) payload["data_type"] = dataType
  }
  return payload
}

const CREATE_REQUIRED = ["connector_id", "description", "object_type", "source_attribute", "target"]

const PAYLOAD_PROPERTIES = {
  connector_id: { type: "number", description: "Connector (integration) id this mapping belongs to" },
  description: { type: "string", description: "Label for the mapping" },
  object_type: { type: "string", enum: ["contact", "reservation", "unit"], description: "What kind of SendSquared record this maps onto" },
  source_attribute: { type: "string", description: "Source field name from the external system (e.g. 'a57')" },
  target: { type: "string", description: "Destination SendSquared column (e.g. 'contact.first_name'). Required on create even when add_custom_field=true — the API 500s without it." },
  add_custom_field: { type: "boolean", description: "If true, also mints a new custom field for this mapping (sends custom_field_id=0). Requires data_type. target is still required alongside it." },
  custom_field_id: { type: "number", description: "Use an existing custom field id. Mutually exclusive with add_custom_field." },
  data_type: { type: "string", enum: ["string", "number"], description: "Data type when add_custom_field=true." },
} as const

export const connectorMapsCreate: ToolDefinition = {
  name: "sendsquared_connector_maps_create",
  description:
    "Create a SendSquared connector map. target is always required (a SendSquared column path like " +
    "'contact.first_name'); pass add_custom_field=true + data_type alongside it to also mint a fresh " +
    "custom field for this mapping. The API 500s if target is omitted, even when add_custom_field is set.",
  inputSchema: {
    type: "object",
    required: CREATE_REQUIRED,
    properties: PAYLOAD_PROPERTIES,
  },
  handler: async (args) => {
    for (const f of CREATE_REQUIRED) {
      if (args[f] === undefined) throw new Error(`${f} is required`)
    }
    const data = await apiForRequest().post("/connector-map", buildConnectorMapPayload(args))
    return envelope(data, "Connector map created", ["sendsquared_connector_maps_list"])
  },
}

export const connectorMapsUpdate: ToolDefinition = {
  name: "sendsquared_connector_maps_update",
  description:
    "Update a SendSquared connector map. Update is POST /connector-map/{id} (the API has no PUT/PATCH " +
    "route for this resource). Only fields you supply are changed.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      ...PAYLOAD_PROPERTIES,
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().post(`/connector-map/${encodeURIComponent(id)}`, buildConnectorMapPayload(args))
    return envelope(data, `Connector map ${id} updated`, ["sendsquared_connector_maps_get"])
  },
}

export const connectorMapsDelete: ToolDefinition = {
  name: "sendsquared_connector_maps_delete",
  description: "Delete a SendSquared connector map. Destructive — there is no undo.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    await apiForRequest().delete(`/connector-map/${encodeURIComponent(id)}`)
    return envelope(null, `Connector map ${id} deleted`, ["sendsquared_connector_maps_list"])
  },
}

export const connectorMapsTools: ToolDefinition[] = [
  connectorMapsList,
  connectorMapsGet,
  connectorMapsCreate,
  connectorMapsUpdate,
  connectorMapsDelete,
]
