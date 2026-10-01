import { apiForRequest, envelope, asString, asOptString, asOptNumber, asNumber } from "./shared.js"
import type { ToolDefinition } from "./types.js"

export const leadsList: ToolDefinition = {
  name: "sendsquared_leads_list",
  description: "List SendSquared leads with pagination and optional filtering by status or category.",
  inputSchema: {
    type: "object",
    properties: {
      page: { type: "number", default: 1 },
      limit: { type: "number", default: 25 },
      statusId: { type: "string", description: "Filter by lead status id" },
      categoryId: { type: "string", description: "Filter by lead category id" },
    },
  },
  handler: async (args) => {
    const page = asOptNumber(args["page"]) ?? 1
    const limit = asOptNumber(args["limit"]) ?? 25
    const query: Record<string, string | number | undefined> = { page, limit }
    const statusId = asOptString(args["statusId"])
    const categoryId = asOptString(args["categoryId"])
    if (statusId) query["lead_status_ids[]"] = statusId
    if (categoryId) query["categoryId"] = categoryId

    const result = await apiForRequest().list("/leads", query)
    return envelope(
      { leads: result.data, total: result.total, page, limit },
      `${result.total} leads found (page ${page})`,
      [
        "sendsquared_leads_get",
        "sendsquared_leads_create",
        "sendsquared_lead_categories_list",
        "sendsquared_lead_status_list",
        "sendsquared_lead_sources_list",
      ],
    )
  },
}

export const leadsGet: ToolDefinition = {
  name: "sendsquared_leads_get",
  description:
    "Fetch a single SendSquared lead by id. The response includes: status, category, source, value, " +
    "followup_at, won_at, lost_at, closed_at, reopened_at, completed_at, notes, custom_fields, " +
    "and the linked contact. Use sendsquared_notes_list with source='lead' to get the full note history.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/leads/${encodeURIComponent(id)}`)
    return envelope(data, `Lead ${id}`, [
      "sendsquared_leads_update",
      "sendsquared_leads_archive",
      "sendsquared_notes_list",
      "sendsquared_contacts_get",
    ])
  },
}

export const leadsCreate: ToolDefinition = {
  name: "sendsquared_leads_create",
  description: "Create a new SendSquared lead tied to an existing contact.",
  inputSchema: {
    type: "object",
    required: ["contact_id"],
    properties: {
      contact_id: { type: "number", description: "Contact id this lead is associated with" },
      lead_category_id: { type: "number", description: "Lead category id" },
      source_id: { type: "number", description: "Lead source id (valid values come from sendsquared_lead_sources_list)" },
      source_detail_id: {
        type: "number",
        description: "Lead source detail id — the specific detail under the source (valid values come from sendsquared_lead_source_details_list)",
      },
      lead_status_id: { type: "number", description: "Lead status id (valid values come from sendsquared_lead_status_list)" },
      lead_type_id: { type: "number", description: "Lead type id (valid values come from sendsquared_lead_types_list)" },
      estimated_value: { type: "number", description: "Estimated monetary value of the lead" },
    },
  },
  handler: async (args) => {
    const contactId = asNumber(args["contact_id"], "contact_id")
    const data = await apiForRequest().post("/leads", {
      contact_id: contactId,
      lead_category_id: asOptNumber(args["lead_category_id"]),
      source_id: asOptNumber(args["source_id"]),
      source_detail_id: asOptNumber(args["source_detail_id"]),
      lead_status_id: asOptNumber(args["lead_status_id"]),
      lead_type_id: asOptNumber(args["lead_type_id"]),
      estimated_value: asOptNumber(args["estimated_value"]),
    })
    return envelope(data, "Lead created", ["sendsquared_leads_get", "sendsquared_leads_list"])
  },
}

export const leadsUpdate: ToolDefinition = {
  name: "sendsquared_leads_update",
  description:
    "Update a lead's status, category, source, source detail, value, follow-up date, or assignment. " +
    "Changing the status to a 'won' or 'lost' status automatically sets won_at/lost_at timestamps. " +
    "When changing source_id and source_detail_id together, the source is written first, then the " +
    "detail — the detail is validated against the lead's source.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      lead_status_id: { type: "number", description: "Lead status id (valid values come from sendsquared_lead_status_list)" },
      lead_category_id: { type: "number", description: "Lead category id" },
      source_id: { type: "number", description: "Lead source id (valid values come from sendsquared_lead_sources_list)" },
      source_detail_id: {
        type: "number",
        description: "Lead source detail id — the specific detail under the source (valid values come from sendsquared_lead_source_details_list)",
      },
      estimated_value: { type: "number", description: "Estimated monetary value of the lead" },
      followup_at: { type: "string", description: "Next follow-up date/time, ISO format (YYYY-MM-DDTHH:mm:ss)" },
      user_id: { type: "number", description: "Assign the lead to a user/team member" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const body: Record<string, unknown> = {}
    const leadStatusId = asOptNumber(args["lead_status_id"])
    const leadCategoryId = asOptNumber(args["lead_category_id"])
    const sourceId = asOptNumber(args["source_id"])
    const sourceDetailId = asOptNumber(args["source_detail_id"])
    const followupAt = asOptString(args["followup_at"])
    const estimatedValue = asOptNumber(args["estimated_value"])
    const userId = asOptNumber(args["user_id"])
    if (leadStatusId !== undefined) body["lead_status_id"] = leadStatusId
    if (leadCategoryId !== undefined) body["lead_category_id"] = leadCategoryId
    if (sourceId !== undefined) body["source_id"] = sourceId
    if (followupAt) body["followup_at"] = followupAt
    if (estimatedValue !== undefined) body["estimated_value"] = estimatedValue
    if (userId !== undefined) body["user_id"] = userId

    const client = apiForRequest()
    /*
      The lead source detail is validated server-side against the lead's
      *current* source, so submitting source_id and source_detail_id in one
      request fails — the detail is checked against the old source. The
      SendSquared web app writes the source first and the detail in a second
      request; we do the same so the detail validates against the new source.
    */
    if (sourceId !== undefined && sourceDetailId !== undefined) {
      await client.put(`/leads/${encodeURIComponent(id)}`, body)
      const data = await client.put(`/leads/${encodeURIComponent(id)}`, { source_detail_id: sourceDetailId })
      return envelope(data, `Lead ${id} updated (source, then detail)`, ["sendsquared_leads_get", "sendsquared_notes_create"])
    }
    if (sourceDetailId !== undefined) body["source_detail_id"] = sourceDetailId

    const data = await client.put(`/leads/${encodeURIComponent(id)}`, body)
    return envelope(data, `Lead ${id} updated`, ["sendsquared_leads_get", "sendsquared_notes_create"])
  },
}

export const leadsArchive: ToolDefinition = {
  name: "sendsquared_leads_archive",
  description: "Archive a SendSquared lead (soft-hides without deleting).",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().put(`/leads/archive/${encodeURIComponent(id)}`)
    return envelope(data, `Lead ${id} archived`, ["sendsquared_leads_unarchive"])
  },
}

export const leadsUnarchive: ToolDefinition = {
  name: "sendsquared_leads_unarchive",
  description: "Restore an archived SendSquared lead.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().put(`/leads/unarchive/${encodeURIComponent(id)}`)
    return envelope(data, `Lead ${id} unarchived`, ["sendsquared_leads_get"])
  },
}

export const leadsDelete: ToolDefinition = {
  name: "sendsquared_leads_delete",
  description: "Delete a SendSquared lead permanently. Destructive — there is no undo.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    await apiForRequest().delete(`/leads/${encodeURIComponent(id)}`)
    return envelope(null, `Lead ${id} deleted`, ["sendsquared_leads_list"])
  },
}

export const leadsGetOpen: ToolDefinition = {
  name: "sendsquared_leads_get_open",
  description: "Get the currently open lead for a contact. Returns the active lead if one exists, useful for checking whether a contact already has an open lead before creating a new one.",
  inputSchema: {
    type: "object",
    required: ["contactId"],
    properties: { contactId: { type: "string" } },
  },
  handler: async (args) => {
    const contactId = asString(args["contactId"], "contactId")
    const data = await apiForRequest().get(`/leads/open/${encodeURIComponent(contactId)}`)
    return envelope(data, `Open lead for contact ${contactId}`, [
      "sendsquared_leads_update",
      "sendsquared_notes_list",
      "sendsquared_notes_create",
    ])
  },
}

export const leadsTools: ToolDefinition[] = [
  leadsList,
  leadsGet,
  leadsGetOpen,
  leadsCreate,
  leadsUpdate,
  leadsArchive,
  leadsUnarchive,
  leadsDelete,
]
