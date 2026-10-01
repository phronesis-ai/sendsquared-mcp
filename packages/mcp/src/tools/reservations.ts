import { apiForRequest, envelope, asString, asOptString, asOptNumber } from "./shared.js"
import type { ToolDefinition } from "./types.js"
import type { QueryParams } from "@sendsquared/client"

/*
  Reservation tools mirror /v1/reservations on the SendSquared API. Pagination
  is cursor-based (after_id), not page-based. Filters use the API's colon-
  delimited syntax: ?filter=arrival_date:gte:2024-01-01. Each filter string
  is "field:operator:value". Operators: eq, ne, gt, gte, lt, lte, like, ilike,
  in (comma-separated values), null, notNull, search. Multiple filters AND.
*/

export const reservationsList: ToolDefinition = {
  name: "sendsquared_reservations_list",
  description:
    "List SendSquared reservations with cursor-based pagination, flexible field filters, sort, and tag filtering. " +
    "Filters use COLON-DELIMITED syntax: 'field:operator:value'. " +
    "Operators: eq, ne, gt, gte, lt, lte, like, ilike, in (comma-separated), null, notNull, search. " +
    "Common fields: contact_id, status, arrival_date, departure_date, source, reservation_type, unit_type, total_revenue, nights. " +
    "Multiple filters are ANDed together. Example: filter=['arrival_date:gte:2024-01-01', 'arrival_date:lte:2024-12-31', 'status:eq:confirmed']. " +
    "Sort: ['arrival_date desc'] or ['-arrival_date']. " +
    "Pagination is via after_id (the id of the last reservation from the previous page) — pass 0 or omit for the first page.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Results per page (default 100, max 1000)", default: 100 },
      after_id: { type: "number", description: "Cursor: the id of the last reservation from the previous page. Omit or pass 0 for the first page.", default: 0 },
      filter: {
        type: "array",
        description: "Array of colon-delimited filter strings: 'field:operator:value'. E.g. ['contact_id:eq:5', 'arrival_date:gte:2024-01-01', 'status:eq:confirmed']. Operators: eq, ne, gt, gte, lt, lte, like, ilike, in, null, notNull, search.",
        items: { type: "string" },
      },
      sort: {
        type: "array",
        description: "Array of sort directives, e.g. ['arrival_date desc'] or ['-arrival_date'].",
        items: { type: "string" },
      },
      tags: {
        type: "array",
        description: "Filter to reservations carrying any of these tag ids.",
        items: { type: "number" },
      },
      include_units: { type: "boolean", description: "Include related units in the response", default: false },
      include_contact: { type: "boolean", description: "Include contact details (default true)", default: true },
      include_company: { type: "boolean", description: "Include company details", default: false },
    },
  },
  handler: async (args) => {
    const limit = asOptNumber(args["limit"]) ?? 100
    const after_id = asOptNumber(args["after_id"]) ?? 0
    const filter = Array.isArray(args["filter"]) ? (args["filter"] as string[]) : undefined
    const sort = Array.isArray(args["sort"]) ? (args["sort"] as string[]) : undefined
    const tags = Array.isArray(args["tags"]) ? (args["tags"] as number[]) : undefined
    const include_units = typeof args["include_units"] === "boolean" ? args["include_units"] : undefined
    const include_contact = typeof args["include_contact"] === "boolean" ? args["include_contact"] : undefined
    const include_company = typeof args["include_company"] === "boolean" ? args["include_company"] : undefined

    const query: QueryParams = {
      limit,
      after_id,
      filter,
      sort,
      tags,
    }
    if (include_units !== undefined) query["units"] = String(include_units)
    if (include_contact !== undefined) query["contact"] = String(include_contact)
    if (include_company !== undefined) query["company"] = String(include_company)

    const result = await apiForRequest().list("/reservations", query)
    return envelope(
      { reservations: result.data, total: result.total, limit, after_id },
      `${result.total} reservations matched (page after_id=${after_id}, limit ${limit})`,
      [
        "sendsquared_reservations_get",
        "sendsquared_reservations_by_contact",
        "sendsquared_contacts_get",
      ],
    )
  },
}

export const reservationsGet: ToolDefinition = {
  name: "sendsquared_reservations_get",
  description: "Fetch a single SendSquared reservation by id, including dates, financials, source, and (if requested) related contact and units.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Reservation id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/reservations/${encodeURIComponent(id)}`)
    return envelope(data, `Reservation ${id}`, [
      "sendsquared_reservations_by_contact",
      "sendsquared_contacts_get",
    ])
  },
}

export const reservationsByContact: ToolDefinition = {
  name: "sendsquared_reservations_by_contact",
  description:
    "Get every reservation for a single SendSquared contact, ordered by date. " +
    "Use this for guest history queries — much faster than listing all reservations and filtering by contact_id. " +
    "Combined with sendsquared_reservations_list filtered by date, this is the building block for repeat-guest analysis (e.g. find guests who booked in both 2024 and 2025 but have no future reservation).",
  inputSchema: {
    type: "object",
    required: ["contactId"],
    properties: { contactId: { type: "string", description: "Contact id" } },
  },
  handler: async (args) => {
    const contactId = asString(args["contactId"], "contactId")
    const data = await apiForRequest().get(`/reservations/contact/${encodeURIComponent(contactId)}`)
    return envelope(data, `All reservations for contact ${contactId}`, [
      "sendsquared_reservations_get",
      "sendsquared_reservations_latest_for_contact",
      "sendsquared_contacts_timeline",
    ])
  },
}

export const reservationsLatestForContact: ToolDefinition = {
  name: "sendsquared_reservations_latest_for_contact",
  description:
    "Get the single most relevant reservation for a SendSquared contact. " +
    "Priority order: in-house now, then nearest upcoming, then most recent past. " +
    "Use this when you only need the contact's current state (are they checked in? do they have a future booking?) without paging through all of their history.",
  inputSchema: {
    type: "object",
    required: ["contactId"],
    properties: { contactId: { type: "string", description: "Contact id" } },
  },
  handler: async (args) => {
    const contactId = asString(args["contactId"], "contactId")
    const data = await apiForRequest().get(`/reservations/contact/${encodeURIComponent(contactId)}/latest`)
    return envelope(data, `Latest reservation for contact ${contactId}`, [
      "sendsquared_reservations_by_contact",
      "sendsquared_contacts_get",
    ])
  },
}

export const reservationsCount: ToolDefinition = {
  name: "sendsquared_reservations_count",
  description: "Get the total count of reservations for the current company. Cheap query — use it for sanity checks or top-level dashboards before diving into list filters.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await apiForRequest().get("/reservations/count")
    return envelope(data, "Total reservation count", ["sendsquared_reservations_list"])
  },
}

export const reservationsTypes: ToolDefinition = {
  name: "sendsquared_reservations_types",
  description: "List the reservation types configured for this company (e.g. nightly, monthly, owner stay, complimentary). Useful before constructing filter strings since reservation_type is a foreign-key field.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await apiForRequest().get("/reservations/reservation-types")
    return envelope(data, "Reservation types", ["sendsquared_reservations_list"])
  },
}

export const reservationsGapNights: ToolDefinition = {
  name: "sendsquared_reservations_gap_nights",
  description:
    "Find gap nights — short windows of future availability between two existing reservations on the same unit. " +
    "Useful for fill-the-gap marketing campaigns. Returns gaps within the next N days (default 14, max 30).",
  inputSchema: {
    type: "object",
    properties: {
      daysInFuture: { type: "number", description: "Lookahead window in days (default 14, max 30)", default: 14 },
    },
  },
  handler: async (args) => {
    const daysInFuture = asOptNumber(args["daysInFuture"]) ?? 14
    const data = await apiForRequest().get("/reservations/gap-night", { daysInFuture })
    return envelope(data, `Gap nights in the next ${daysInFuture} days`, [
      "sendsquared_reservations_list",
      "sendsquared_campaigns_create",
    ])
  },
}

export const reservationsTools: ToolDefinition[] = [
  reservationsList,
  reservationsGet,
  reservationsByContact,
  reservationsLatestForContact,
  reservationsCount,
  reservationsTypes,
  reservationsGapNights,
]
