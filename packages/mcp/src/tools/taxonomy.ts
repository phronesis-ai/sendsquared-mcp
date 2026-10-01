import { apiForRequest, envelope, asString, asOptString, asOptNumber, asOptBoolean } from "./shared.js"
import type { ToolDefinition } from "./types.js"

/*
  Shared CRUD scaffolding for the flat SendSquared "taxonomy" resources —
  lead types, lead sources, lead source details, lead statuses, lead
  categories, task types, and lost reasons. They each expose the same
  list/get/create/update/delete shape over a collection endpoint and differ
  only in their field set, so each resource is described by a config and its
  five tools are generated from it.
*/

type FieldKind = "string" | "number" | "boolean" | "json"

export interface TaxonomyToolField {
  name: string
  apiKey: string
  kind: FieldKind
  description: string
  requiredOnCreate?: boolean
}

export interface TaxonomyToolResource {
  prefix: string
  label: string
  path: string
  fields: TaxonomyToolField[]
}

function schemaTypeFor(kind: FieldKind): string {
  if (kind === "number") return "number"
  if (kind === "boolean") return "boolean"
  if (kind === "json") return "array"
  return "string"
}

function fieldSchema(fields: TaxonomyToolField[]): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const f of fields) {
    props[f.name] = { type: schemaTypeFor(f.kind), description: f.description }
  }
  return props
}

function coerce(value: unknown, field: TaxonomyToolField): unknown {
  if (field.kind === "string") return asOptString(value)
  if (field.kind === "number") return asOptNumber(value)
  if (field.kind === "boolean") return asOptBoolean(value)
  if (typeof value === "string") return JSON.parse(value)
  return value
}

export function collectFields(fields: TaxonomyToolField[], args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const f of fields) {
    if (args[f.name] === undefined) continue
    const coerced = coerce(args[f.name], f)
    if (coerced !== undefined) payload[f.apiKey] = coerced
  }
  return payload
}

/*
  Pull only the resource's declared editable fields out of a fetched record.
  The update endpoints validate the whole submitted payload, and some records
  carry server-side fields (e.g. related_type) that the validator rejects when
  echoed back — so an update must re-send the editable fields and nothing else,
  exactly as the SendSquared web app's edit forms do.
*/
export function pickEditable(fields: TaxonomyToolField[], record: Record<string, unknown>): Record<string, unknown> {
  const editable: Record<string, unknown> = {}
  for (const f of fields) {
    if (f.apiKey in record) editable[f.apiKey] = record[f.apiKey]
  }
  return editable
}

export function buildTaxonomyTools(resource: TaxonomyToolResource): ToolDefinition[] {
  const { prefix, label, path, fields } = resource
  const createRequired = fields.filter((f) => f.requiredOnCreate).map((f) => f.name)

  const list: ToolDefinition = {
    name: `${prefix}_list`,
    description: `List all SendSquared ${label} entries for this company.`,
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const result = await apiForRequest().list(path)
      return envelope(
        { entries: result.data, total: result.total },
        `${result.total} ${label} entries`,
        [`${prefix}_get`, `${prefix}_create`],
      )
    },
  }

  const get: ToolDefinition = {
    name: `${prefix}_get`,
    description: `Fetch a single SendSquared ${label} entry by id.`,
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    handler: async (args) => {
      const id = asString(args["id"], "id")
      const data = await apiForRequest().get(`${path}/${encodeURIComponent(id)}`)
      return envelope(data, `${label} ${id}`, [`${prefix}_update`, `${prefix}_delete`])
    },
  }

  const create: ToolDefinition = {
    name: `${prefix}_create`,
    description: `Create a new SendSquared ${label} entry.`,
    inputSchema: {
      type: "object",
      required: createRequired,
      properties: fieldSchema(fields),
    },
    handler: async (args) => {
      for (const r of createRequired) {
        if (args[r] === undefined) throw new Error(`${r} is required`)
      }
      const data = await apiForRequest().post(path, collectFields(fields, args))
      return envelope(data, `${label} created`, [`${prefix}_list`])
    },
  }

  /*
    Fetch the current entry, carry forward its editable fields, overlay the
    supplied fields, and PUT. Only declared editable fields are re-sent — see
    pickEditable — so unspecified fields are preserved without echoing back
    server-side fields the update validator rejects.
  */
  const update: ToolDefinition = {
    name: `${prefix}_update`,
    description: `Update a SendSquared ${label} entry. Only the fields you supply are changed.`,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, ...fieldSchema(fields) },
    },
    handler: async (args) => {
      const id = asString(args["id"], "id")
      const current = (await apiForRequest().get(`${path}/${encodeURIComponent(id)}`)) as Record<string, unknown>
      const merged = { ...pickEditable(fields, current), ...collectFields(fields, args) }
      const data = await apiForRequest().put(`${path}/${encodeURIComponent(id)}`, merged)
      return envelope(data, `${label} ${id} updated`, [`${prefix}_get`])
    },
  }

  const del: ToolDefinition = {
    name: `${prefix}_delete`,
    description: `Delete a SendSquared ${label} entry. Destructive — there is no undo.`,
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    handler: async (args) => {
      const id = asString(args["id"], "id")
      await apiForRequest().delete(`${path}/${encodeURIComponent(id)}`)
      return envelope(null, `${label} ${id} deleted`, [`${prefix}_list`])
    },
  }

  return [list, get, create, update, del]
}

const RESOURCES: TaxonomyToolResource[] = [
  {
    prefix: "sendsquared_lead_types",
    label: "lead type",
    path: "/lead-types",
    fields: [
      { name: "name", apiKey: "name", kind: "string", description: "Lead type name", requiredOnCreate: true },
      { name: "is_default", apiKey: "is_default", kind: "boolean", description: "Mark as the default lead type" },
      { name: "lead_category_id", apiKey: "lead_category_id", kind: "number", description: "Lead category id this type belongs to" },
      { name: "lead_type_statuses", apiKey: "lead_type_statuses", kind: "json", description: "Array of {lead_status_id, pipeline_order, display_order} objects" },
      { name: "lead_type_profiles", apiKey: "lead_type_profiles", kind: "json", description: "Array of lead type profile objects" },
    ],
  },
  {
    prefix: "sendsquared_lead_sources",
    label: "lead source",
    path: "/lead-sources",
    fields: [
      { name: "label", apiKey: "label", kind: "string", description: "Lead source label", requiredOnCreate: true },
      { name: "is_active", apiKey: "is_active", kind: "boolean", description: "Whether the source is active" },
    ],
  },
  {
    prefix: "sendsquared_lead_source_details",
    label: "lead source detail",
    path: "/lead-source-details",
    fields: [
      { name: "label", apiKey: "label", kind: "string", description: "Lead source detail label", requiredOnCreate: true },
      { name: "lead_source_id", apiKey: "lead_source_id", kind: "number", description: "Parent lead source id", requiredOnCreate: true },
      { name: "is_active", apiKey: "is_active", kind: "boolean", description: "Whether the detail is active" },
    ],
  },
  {
    prefix: "sendsquared_lead_status",
    label: "lead status",
    path: "/lead-status",
    fields: [
      { name: "label", apiKey: "label", kind: "string", description: "Lead status label", requiredOnCreate: true },
      { name: "is_default", apiKey: "is_default", kind: "boolean", description: "Mark as the default status" },
      { name: "is_followup", apiKey: "is_followup", kind: "boolean", description: "Whether the status represents a follow-up" },
      { name: "is_closed", apiKey: "is_closed", kind: "boolean", description: "Whether the status closes the lead" },
      { name: "is_won", apiKey: "is_won", kind: "boolean", description: "Whether the status marks the lead won (only valid when closed)" },
      { name: "is_lost", apiKey: "is_lost", kind: "boolean", description: "Whether the status marks the lead lost (only valid when closed)" },
    ],
  },
  {
    prefix: "sendsquared_lead_categories",
    label: "lead category",
    path: "/lead-categories",
    fields: [
      { name: "label", apiKey: "label", kind: "string", description: "Lead category label", requiredOnCreate: true },
      { name: "is_active", apiKey: "is_active", kind: "boolean", description: "Whether the category is active" },
    ],
  },
  {
    prefix: "sendsquared_task_types",
    label: "task type",
    path: "/task-types",
    fields: [
      { name: "name", apiKey: "name", kind: "string", description: "Task type name", requiredOnCreate: true },
      { name: "is_default", apiKey: "is_default", kind: "boolean", description: "Mark as the default task type" },
    ],
  },
  {
    prefix: "sendsquared_lost_reasons",
    label: "lost reason",
    path: "/lost-reasons",
    fields: [
      { name: "label", apiKey: "label", kind: "string", description: "Lost reason label", requiredOnCreate: true },
      { name: "is_active", apiKey: "is_active", kind: "boolean", description: "Whether the lost reason is active" },
    ],
  },
  {
    prefix: "sendsquared_lost_reason_details",
    label: "lost reason detail",
    path: "/lost-reason-details",
    fields: [
      { name: "label", apiKey: "label", kind: "string", description: "Lost reason detail label", requiredOnCreate: true },
      { name: "lost_reason_id", apiKey: "lost_reason_id", kind: "number", description: "Parent lost reason id", requiredOnCreate: true },
      { name: "is_active", apiKey: "is_active", kind: "boolean", description: "Whether the detail is active" },
    ],
  },
]

export const taxonomyTools: ToolDefinition[] = RESOURCES.flatMap(buildTaxonomyTools)
