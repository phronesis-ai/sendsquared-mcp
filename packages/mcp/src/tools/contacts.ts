import { apiForRequest, envelope, asString, asOptString, asOptNumber, asNumber } from "./shared.js"
import type { ToolDefinition } from "./types.js"

export const contactsList: ToolDefinition = {
  name: "sendsquared_contacts_list",
  description:
    "List SendSquared contacts (newest first), optionally filtered by group or tag. Pagination is " +
    "cursor-based: pass the `nextBefore` value from the previous response as `before` to get the next " +
    "page. A null `nextBefore` means there are no more pages.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Results per page (max 100)", default: 25 },
      before: { type: "number", description: "Pagination cursor: return contacts with id below this (use nextBefore from the previous response)" },
      groupId: { type: "string", description: "Restrict to contacts in this group or segment id" },
      tagId: { type: "string", description: "Restrict to contacts with this tag id" },
    },
  },
  handler: async (args) => {
    const limit = asOptNumber(args["limit"]) ?? 25
    const before = asOptNumber(args["before"])
    /*
      Contacts paginate the way the SendSquared web app does: sorted id:desc,
      and the next page is fetched with a filter id:lt:<lowest id seen>. There
      is no page-number parameter.
    */
    const query: Record<string, string | number | string[] | undefined> = {
      limit,
      sort: "id:desc",
      "groups[]": asOptString(args["groupId"]),
      "tags[]": asOptString(args["tagId"]),
    }
    if (before !== undefined) query["filter[]"] = `id:lt:${before}:and`
    const result = await apiForRequest().list("/contacts", query)
    const items = result.data
    const lastId =
      items.length > 0 ? (items[items.length - 1] as Record<string, unknown>)["id"] : undefined
    const nextBefore = items.length >= limit ? (lastId ?? null) : null
    return envelope(
      { contacts: items, total: result.total, limit, before: before ?? null, nextBefore },
      `${items.length} contacts returned${nextBefore !== null ? ` — pass before=${nextBefore} for the next page` : " (last page)"}`,
      ["sendsquared_contacts_get", "sendsquared_contacts_search", "sendsquared_tags_list", "sendsquared_groups_list"],
    )
  },
}

export const contactsGet: ToolDefinition = {
  name: "sendsquared_contacts_get",
  description: "Fetch a single SendSquared contact by id, including custom fields.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "The contact id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/contacts/${encodeURIComponent(id)}`)
    return envelope(data, `Contact ${id}`, [
      "sendsquared_contacts_update",
      "sendsquared_contacts_timeline",
      "sendsquared_contacts_delete",
    ])
  },
}

export const contactsCreate: ToolDefinition = {
  name: "sendsquared_contacts_create",
  description: "Create a new SendSquared contact. Email is optional; pass at least one of email, name, company, or phone. Address fields are optional.",
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "Contact email" },
      firstName: { type: "string", description: "First name" },
      lastName: { type: "string", description: "Last name" },
      phone: { type: "string", description: "Mobile phone number" },
      homePhone: { type: "string", description: "Home phone number" },
      companyName: { type: "string", description: "Company name" },
      address1: { type: "string", description: "Address line 1" },
      address2: { type: "string", description: "Address line 2" },
      locality: { type: "string", description: "City" },
      region: { type: "string", description: "State / region" },
      postal: { type: "string", description: "Postal / ZIP code" },
    },
  },
  handler: async (args) => {
    /*
      POST /contacts takes the same snake_case ContactInputModel as PATCH and
      does not require an email, but something must identify the record.
    */
    const fields: Array<[string, string]> = [
      ["email", "primary_email"], ["firstName", "first_name"], ["lastName", "last_name"],
      ["phone", "mobile_phone"], ["homePhone", "home_phone"], ["companyName", "company_name"],
      ["address1", "address_1"], ["address2", "address_2"], ["locality", "locality"],
      ["region", "region"], ["postal", "postal"],
    ]
    const body: Record<string, unknown> = {}
    for (const [arg, api] of fields) {
      const v = asOptString(args[arg])
      if (v) body[api] = v
    }
    const identifying = ["primary_email", "first_name", "last_name", "company_name", "mobile_phone"]
    if (!identifying.some((k) => body[k] !== undefined)) {
      throw new Error("contacts create needs at least one of email, firstName, lastName, companyName, or phone")
    }
    const data = await apiForRequest().post("/contacts", body)
    const label = (body["primary_email"] ?? [body["first_name"], body["last_name"]].filter((x) => x).join(" ") ?? "") as string
    return envelope(data, `Contact created: ${label || body["company_name"] || ""}`, [
      "sendsquared_contacts_get",
      "sendsquared_tags_list",
    ])
  },
}

export const contactsUpdate: ToolDefinition = {
  name: "sendsquared_contacts_update",
  description: "Update one or more fields on an existing SendSquared contact. Only the fields you pass are changed.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", description: "Contact id" },
      email: { type: "string", description: "Primary email address" },
      firstName: { type: "string" },
      lastName: { type: "string" },
      phone: { type: "string", description: "Mobile phone number" },
      homePhone: { type: "string", description: "Home phone number" },
      companyName: { type: "string" },
      address1: { type: "string", description: "Address line 1" },
      address2: { type: "string", description: "Address line 2" },
      locality: { type: "string", description: "City" },
      region: { type: "string", description: "State / region" },
      postal: { type: "string", description: "Postal / ZIP code" },
    },
  },
  /*
    Contact updates are PATCH /contacts/{id} (PUT has no route). The display
    field "email" is patched as "primary_email"; setting it also clears any
    refused-email flag. Field names are the API's snake_case — see ad-base-spa
    ContactEditCard.
  */
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const body: Record<string, unknown> = {}
    const email = asOptString(args["email"])
    const firstName = asOptString(args["firstName"])
    const lastName = asOptString(args["lastName"])
    const phone = asOptString(args["phone"])
    const homePhone = asOptString(args["homePhone"])
    const companyName = asOptString(args["companyName"])
    const address1 = asOptString(args["address1"])
    const address2 = asOptString(args["address2"])
    const locality = asOptString(args["locality"])
    const region = asOptString(args["region"])
    const postal = asOptString(args["postal"])
    if (email) {
      body["primary_email"] = email
      body["refused_email_at"] = null
    }
    if (firstName) body["first_name"] = firstName
    if (lastName) body["last_name"] = lastName
    if (phone) body["mobile_phone"] = phone
    if (homePhone) body["home_phone"] = homePhone
    if (companyName) body["company_name"] = companyName
    if (address1) body["address_1"] = address1
    if (address2) body["address_2"] = address2
    if (locality) body["locality"] = locality
    if (region) body["region"] = region
    if (postal) body["postal"] = postal

    const data = await apiForRequest().patch(`/contacts/${encodeURIComponent(id)}`, body)
    return envelope(data, `Contact ${id} updated`, ["sendsquared_contacts_get"])
  },
}

export const contactsDelete: ToolDefinition = {
  name: "sendsquared_contacts_delete",
  description: "Delete a SendSquared contact by id. Destructive — there is no undo.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Contact id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    await apiForRequest().delete(`/contacts/${encodeURIComponent(id)}`)
    return envelope(null, `Contact ${id} deleted`, ["sendsquared_contacts_list"])
  },
}

/*
  Search is GET /search?query=... — the parameter is named `query`, not `q`,
  and the endpoint 422s ("'query' is required") if it is missing. The response
  is a bare { length, contacts } object rather than a paginated envelope, so
  it is fetched with get() and unwrapped here; `length` is only populated for
  name searches (the email and phone branches short-circuit and return 0), so
  the match count is taken from the array itself.
*/
export const contactsSearch: ToolDefinition = {
  name: "sendsquared_contacts_search",
  description:
    "Free-text search across SendSquared contacts by email, first name, last name, or phone. " +
    "An exact email address or a parseable phone number matches directly; anything else is a " +
    "fuzzy name search ranked by relevance.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Search query: email address, phone number, or name" },
      offset: { type: "number", description: "Number of results to skip (name searches only)", default: 0 },
    },
  },
  handler: async (args) => {
    const query = asString(args["query"], "query")
    const offset = asOptNumber(args["offset"])
    const result = (await apiForRequest().get("/search", {
      query,
      offset,
      length: "true",
    })) as { length?: number; contacts?: unknown[] }
    const matches = Array.isArray(result?.contacts) ? result.contacts : []
    const total = typeof result?.length === "number" && result.length > 0 ? result.length : matches.length
    return envelope(
      { matches, total, offset: offset ?? 0 },
      `${matches.length} contacts matching "${query}"`,
      ["sendsquared_contacts_get", "sendsquared_contacts_list"],
    )
  },
}

export const contactsTimeline: ToolDefinition = {
  name: "sendsquared_contacts_timeline",
  description: "Get the activity timeline for a SendSquared contact — opens, clicks, sends, workflow events, etc.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Contact id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/contact-timeline/contact/${encodeURIComponent(id)}`)
    return envelope(data, `Timeline for contact ${id}`, ["sendsquared_contacts_get"])
  },
}

export const contactsUnitsList: ToolDefinition = {
  name: "sendsquared_contacts_units_list",
  description:
    "List the units (properties) associated with a SendSquared contact, including each unit's address. " +
    "Use this to find where a contact's units are located.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Contact id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/units/contact/${encodeURIComponent(id)}`)
    return envelope(data, `Units for contact ${id}`, ["sendsquared_contacts_get"])
  },
}

/*
  Tagging a contact is a PATCH of the whole tags array — patching just the new
  tag would wipe the rest. We read the contact's current tag ids, add/remove
  one, and patch the full set back.
*/
function contactTagIds(contact: Record<string, unknown>): number[] {
  const tags = Array.isArray(contact["tags"]) ? contact["tags"] : []
  const ids: number[] = []
  for (const t of tags) {
    const n = Number((t as Record<string, unknown>)?.["id"])
    if (Number.isFinite(n)) ids.push(n)
  }
  return ids
}

export const contactsTagAdd: ToolDefinition = {
  name: "sendsquared_contacts_tag_add",
  description: "Add a tag to a SendSquared contact. The contact's existing tags are preserved.",
  inputSchema: {
    type: "object",
    required: ["id", "tagId"],
    properties: {
      id: { type: "string", description: "Contact id" },
      tagId: { type: "number", description: "Tag id to add (valid values come from sendsquared_tags_list)" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const tagId = asNumber(args["tagId"], "tagId")
    const client = apiForRequest()
    const contact = (await client.get(`/contacts/${encodeURIComponent(id)}`)) as Record<string, unknown>
    const ids = new Set(contactTagIds(contact))
    ids.add(tagId)
    const data = await client.patch(`/contacts/${encodeURIComponent(id)}`, {
      tags: [...ids].map((tid) => ({ id: tid })),
    })
    return envelope(data, `Tag ${tagId} added to contact ${id}`, ["sendsquared_contacts_get"])
  },
}

export const contactsTagRemove: ToolDefinition = {
  name: "sendsquared_contacts_tag_remove",
  description: "Remove a tag from a SendSquared contact. The contact's other tags are preserved.",
  inputSchema: {
    type: "object",
    required: ["id", "tagId"],
    properties: {
      id: { type: "string", description: "Contact id" },
      tagId: { type: "number", description: "Tag id to remove" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const tagId = asNumber(args["tagId"], "tagId")
    const client = apiForRequest()
    const contact = (await client.get(`/contacts/${encodeURIComponent(id)}`)) as Record<string, unknown>
    const ids = contactTagIds(contact).filter((tid) => tid !== tagId)
    const data = await client.patch(`/contacts/${encodeURIComponent(id)}`, {
      tags: ids.map((tid) => ({ id: tid })),
    })
    return envelope(data, `Tag ${tagId} removed from contact ${id}`, ["sendsquared_contacts_get"])
  },
}

const CONTACT_MERGE_FIELDS = [
  "first_name", "last_name", "email", "mobile_phone", "home_phone",
  "address_1", "address_2", "locality", "region", "postal",
]

/*
  Return the first value that is present and non-empty. Used to resolve each
  merged-contact field: prefer the primary's value, fall back to the
  secondary's. The merge endpoint rejects merged_contact.email unless it
  matches one of the two contacts' emails — so a blank primary must not
  blank out an email the secondary actually has. When neither contact has a
  value, an empty string is sent (the endpoint requires every field present).
*/
function firstNonEmpty(...values: unknown[]): unknown {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v
  }
  return ""
}

/*
  Extract a contact's primary email address. The contact GET response has no
  flat `email` field — the address lives in `primaryEmail.email_address`, with
  the `emails[]` array as a fallback. The merge endpoint requires
  merged_contact.email to be an address string from one of the two contacts.
*/
function contactEmail(contact: Record<string, unknown>): string {
  const primaryEmail = contact["primaryEmail"]
  if (primaryEmail && typeof primaryEmail === "object") {
    const addr = (primaryEmail as Record<string, unknown>)["email_address"]
    if (typeof addr === "string" && addr.length > 0) return addr
  }
  const emails = contact["emails"]
  if (Array.isArray(emails)) {
    const chosen = emails.find((e) => e && typeof e === "object" && (e as Record<string, unknown>)["is_primary"]) ?? emails[0]
    if (chosen && typeof chosen === "object") {
      const addr = (chosen as Record<string, unknown>)["email_address"]
      if (typeof addr === "string" && addr.length > 0) return addr
    }
  }
  return ""
}

export const contactsMerge: ToolDefinition = {
  name: "sendsquared_contacts_merge",
  description:
    "Merge two SendSquared contacts. The primary contact is kept and the secondary is removed; the " +
    "secondary's history folds into the primary. The surviving contact's field values default to the " +
    "primary contact's — pass any field below to override which value wins. " +
    "Destructive — there is no undo.",
  inputSchema: {
    type: "object",
    required: ["primaryId", "secondaryId"],
    properties: {
      primaryId: { type: "string", description: "Contact id to keep" },
      secondaryId: { type: "string", description: "Contact id to merge into primary (will be removed)" },
      first_name: { type: "string", description: "Override surviving first name (default: primary's)" },
      last_name: { type: "string", description: "Override surviving last name (default: primary's)" },
      email: { type: "string", description: "Override surviving email (default: primary's)" },
      mobile_phone: { type: "string", description: "Override surviving mobile phone (default: primary's)" },
      home_phone: { type: "string", description: "Override surviving home phone (default: primary's)" },
      address_1: { type: "string", description: "Override surviving address line 1 (default: primary's)" },
      address_2: { type: "string", description: "Override surviving address line 2 (default: primary's)" },
      locality: { type: "string", description: "Override surviving city (default: primary's)" },
      region: { type: "string", description: "Override surviving state/region (default: primary's)" },
      postal: { type: "string", description: "Override surviving postal code (default: primary's)" },
    },
  },
  handler: async (args) => {
    const primaryId = asString(args["primaryId"], "primaryId")
    const secondaryId = asString(args["secondaryId"], "secondaryId")
    const client = apiForRequest()
    /*
      The merge endpoint requires a fully-resolved merged_contact — the value
      the surviving record keeps for every field. Matching the SendSquared web
      app's merge screen, we fetch both contacts and resolve each field to the
      primary's value, falling back to the secondary's when the primary's is
      empty. The caller can override any individual field.
    */
    const primary = (await client.get(`/contacts/${encodeURIComponent(primaryId)}`)) as Record<string, unknown>
    const secondary = (await client.get(`/contacts/${encodeURIComponent(secondaryId)}`)) as Record<string, unknown>
    const mergedContact: Record<string, unknown> = {}
    for (const f of CONTACT_MERGE_FIELDS) {
      const override = asOptString(args[f])
      if (override !== undefined) {
        mergedContact[f] = override
      } else if (f === "email") {
        mergedContact[f] = firstNonEmpty(contactEmail(primary), contactEmail(secondary))
      } else {
        mergedContact[f] = firstNonEmpty(primary[f], secondary[f])
      }
    }
    const data = await client.post("/contacts/merge/", {
      contact_id1: Number(primaryId),
      contact_id2: Number(secondaryId),
      merged_contact: mergedContact,
    })
    return envelope(data, `Merged contact ${secondaryId} into ${primaryId}`, ["sendsquared_contacts_get"])
  },
}

/*
  The one-off "New Email" send from the contact profile page. There is a single
  route for this regardless of context — POST /contacts/{id}/messages/email —
  and reservation/lead awareness comes from merging the template first, not from
  a different endpoint. So when template_id is supplied we run the same two-step
  the SPA does: POST /email-templates/merge with whatever context ids we have,
  then send the resolved subject and rich_content.

  Two API details worth knowing. SendEmail.attachments is not optional in the
  interface, so an empty array has to go on the wire or the body is rejected.
  And the endpoint 422s on a contact whose primary email has never been
  validated, which reads as a confusing failure unless it is surfaced plainly —
  the check is validated_at on the primary email, not merely having an address.
*/
export const contactsSendEmail: ToolDefinition = {
  name: "sendsquared_contacts_send_email",
  description:
    "Send a single one-off email to one contact right now (or scheduled) — the equivalent of the " +
    "'New Email' tab on the contact profile. This is for individual correspondence such as an owner " +
    "follow-up; use sendsquared_campaigns_send for bulk sends. " +
    "Either supply subject + message directly, or supply template_id to render a saved template. " +
    "When template_id is given, the template is merged first: pass reservation_id (or " +
    "use_last_reservation) if it contains {{reservation.*}} tokens, and lead_id (or use_last_open_lead) " +
    "for {{lead.*}} tokens — an unsatisfiable token fails the merge with a 422. " +
    "sendsquared_email_templates_merge_preview renders the same merge without sending. " +
    "High-impact: this delivers real email to a real person and cannot be recalled. " +
    "The contact's primary email must be validated or " +
    "the API rejects the send.",
  inputSchema: {
    type: "object",
    required: ["contactId"],
    properties: {
      contactId: { type: "string", description: "Recipient contact id" },
      subject: { type: "string", description: "Subject line. Required unless template_id supplies one." },
      message: {
        type: "string",
        description:
          "Message body as HTML. Required unless template_id is given. Plain text is derived server-side. " +
          "Merge tokens in this field are NOT resolved — only templates are merged, so write literal copy here.",
      },
      template_id: { type: "number", description: "Saved email template to render and send instead of raw message html" },
      fromAddressId: { type: "number", description: "Verified from-address id. Defaults to the sending user's own email if omitted." },
      reservation_id: { type: "number", description: "Reservation context for {{reservation.*}} tokens when using template_id" },
      lead_id: { type: "number", description: "Lead context for {{lead.*}} tokens when using template_id" },
      use_last_reservation: { type: "boolean", description: "Resolve reservation tokens from the contact's latest reservation" },
      use_last_open_lead: { type: "boolean", description: "Resolve lead tokens from the contact's latest open lead" },
      ccRaw: { type: "string", description: "Comma-separated CC addresses. Max 10; each must be a valid mailbox." },
      bccRaw: { type: "string", description: "Comma-separated BCC addresses. Max 5." },
      sendTime: {
        type: "string",
        description: "ISO timestamp to schedule the send. Omit to send immediately.",
      },
    },
  },
  handler: async (args) => {
    const contactId = asString(args["contactId"], "contactId")
    const api = apiForRequest()
    const templateId = asOptNumber(args["template_id"])

    let subject = asOptString(args["subject"])
    let message = asOptString(args["message"])

    if (templateId !== undefined) {
      const mergeBody: Record<string, unknown> = {
        template_id: templateId,
        contact_id: Number(contactId),
      }
      for (const f of ["reservation_id", "lead_id"]) {
        const v = asOptNumber(args[f])
        if (v !== undefined) mergeBody[f] = v
      }
      for (const f of ["use_last_reservation", "use_last_open_lead"]) {
        if (typeof args[f] === "boolean") mergeBody[f] = args[f]
      }
      const merged = await api.post<{ subject?: string; rich_content?: string }>(
        "/email-templates/merge",
        mergeBody,
      )
      message = merged.rich_content ?? message
      subject = subject ?? merged.subject
    }

    if (!subject) {
      throw new Error("subject is required (supply it directly, or use a template_id whose template sets one)")
    }
    if (!message) {
      throw new Error("message is required (supply message html directly, or a template_id to render)")
    }

    const body: Record<string, unknown> = {
      subject,
      message,
      attachments: [],
    }
    const from = asOptNumber(args["fromAddressId"])
    const ccRaw = asOptString(args["ccRaw"])
    const bccRaw = asOptString(args["bccRaw"])
    const sendTime = asOptString(args["sendTime"])
    if (from !== undefined) body["from"] = from
    if (ccRaw) body["ccRaw"] = ccRaw
    if (bccRaw) body["bccRaw"] = bccRaw
    if (sendTime) body["sendTime"] = sendTime

    const data = await api.post(`/contacts/${encodeURIComponent(contactId)}/messages/email`, body)
    return envelope(
      data,
      sendTime
        ? `Email to contact ${contactId} scheduled for ${sendTime}`
        : `Email sent to contact ${contactId}`,
      ["sendsquared_contacts_timeline", "sendsquared_contacts_get"],
    )
  },
}

export const contactsTools: ToolDefinition[] = [
  contactsList,
  contactsGet,
  contactsCreate,
  contactsUpdate,
  contactsDelete,
  contactsSearch,
  contactsTimeline,
  contactsUnitsList,
  contactsTagAdd,
  contactsTagRemove,
  contactsMerge,
  contactsSendEmail,
]
