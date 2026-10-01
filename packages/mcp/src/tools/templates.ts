import { apiForRequest, envelope, asString, asOptString, asOptNumber, asNumber } from "./shared.js"
import type { ToolDefinition } from "./types.js"
import { emailTemplatePageQuery, nextAfterId } from "./transforms.js"

/*
  Stripo template creation is a 3-step flow matching EditorSave.vue in the SPA:

    1. POST /email-templates — creates the metadata record, returns a signed S3 URL
    2. PUT {signedUrl} — uploads { compiled, ampCompiled, ampErrors, html, css }
    3. PUT /email-templates/{id}/complete — finalize (thumbnail, token extraction)

  The HTML passed by Claude is used directly — no wrapping, no extra containers.
  Claude is responsible for generating a complete, self-contained, Stripo-compatible
  email HTML document with inline styles. The tool description instructs Claude on
  the format requirements.
*/

interface CreateTemplateResponse {
  id: number
  url: string
  name: string
  [key: string]: unknown
}

interface StripoContent {
  compiled?: string
  ampCompiled?: string
  ampErrors?: unknown[]
  html?: string
  css?: string
  [key: string]: unknown
}

async function uploadStripoHtml(signedUrl: string, html: string): Promise<void> {
  const s3Payload = JSON.stringify({
    compiled: html,
    ampCompiled: html,
    ampErrors: [],
    html,
    css: "",
  })

  const uploadRes = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: s3Payload,
  })

  if (!uploadRes.ok) {
    throw new Error(`S3 upload failed: ${uploadRes.status}`)
  }
}

async function createStripoTemplate(
  name: string,
  subject: string,
  preview: string,
  html: string,
): Promise<CreateTemplateResponse> {
  const api = apiForRequest()

  const record = await api.post<CreateTemplateResponse>("/email-templates", {
    template_type: "stripo",
    name,
    subject,
    preview,
    is_active: true,
    is_archive: false,
    is_reply: false,
  })

  if (!record.url) {
    throw new Error("SendSquared API did not return a signed upload URL for the new template")
  }

  try {
    await uploadStripoHtml(record.url, html)
  } catch (err) {
    await api.delete(`/email-templates/${record.id}`).catch(() => {})
    throw new Error(`${(err as Error).message}. Template metadata cleaned up.`)
  }

  await api.put(`/email-templates/${record.id}/complete`)
  return record
}

export const emailTemplatesList: ToolDefinition = {
  name: "sendsquared_email_templates_list",
  description:
    "List SendSquared email templates (active ones by default; archived=true for the archive). Paginates cursor-style in ascending id order: start with after_id=0, then pass the returned next_after_id until it is null. (page is also accepted and walked internally, but the cursor is cheaper.) The API does not report a grand total, so keep paging until next_after_id is null to see everything. Each record's 'folder' array holds the folder it lives in (empty when unfiled). Pass folder_id to list one folder's templates, or folder_id=0 for unfiled templates only; pair with sendsquared_folders_list to organize.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", default: 25, description: "Items per page (up to 200)" },
      after_id: { type: "number", default: 0, description: "Cursor — 0 for the first page, then next_after_id from the previous result" },
      page: { type: "number", description: "1-based page number; walks the cursor for you. Ignored when after_id is set." },
      folder_id: { type: "number", description: "Only templates in this folder; 0 = unfiled" },
      archived: { type: "boolean", default: false, description: "List archived templates instead of active ones" },
    },
  },
  handler: async (args) => {
    const limit = Math.min(asOptNumber(args["limit"]) ?? 25, 200)
    const folderId = asOptNumber(args["folder_id"])
    const archived = args["archived"] === true
    const page = asOptNumber(args["page"])
    let afterId = asOptNumber(args["after_id"]) ?? 0

    const client = apiForRequest()
    const fetchPage = async (cursor: number) =>
      (await client.list("/email-templates", emailTemplatePageQuery(limit, cursor, folderId, archived))).data

    /*
      page is a convenience over the cursor: walk forward page-1 times to
      find the cursor, then fetch the page the caller asked for.
    */
    if (afterId === 0 && page !== undefined && page > 1) {
      for (let i = 1; i < page; i++) {
        const cursor = nextAfterId(await fetchPage(afterId), limit)
        if (cursor === null) {
          return envelope(
            { templates: [], limit, after_id: afterId, next_after_id: null, page, folder_id: folderId },
            `Page ${page} is past the end`,
            ["sendsquared_email_templates_list"],
          )
        }
        afterId = cursor
      }
    }

    const items = await fetchPage(afterId)
    const next = nextAfterId(items, limit)
    const where = folderId === undefined ? "" : folderId === 0 ? " (unfiled)" : ` in folder ${folderId}`
    return envelope(
      { templates: items, limit, after_id: afterId, next_after_id: next, page, folder_id: folderId, archived },
      `${items.length} ${archived ? "archived " : ""}email templates${where}${next !== null ? ` — pass after_id=${next} for the next page` : " (last page)"}`,
      [
        "sendsquared_email_templates_get",
        "sendsquared_email_templates_create",
        "sendsquared_folders_list",
        "sendsquared_email_templates_set_folder",
        "sendsquared_campaigns_create",
      ],
    )
  },
}

export const emailTemplatesGet: ToolDefinition = {
  name: "sendsquared_email_templates_get",
  description:
    "Fetch a single SendSquared email template's metadata record (name, subject, preview, flags, thumbnail) by id. " +
    "Does NOT include the HTML body — use `sendsquared_email_templates_read_content` for that.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/email-templates/${encodeURIComponent(id)}`)
    return envelope(data, `Email template ${id}`, [
      "sendsquared_email_templates_read_content",
      "sendsquared_email_templates_update",
      "sendsquared_email_templates_duplicate",
      "sendsquared_email_templates_preview",
      "sendsquared_email_templates_delete",
    ])
  },
}

export const emailTemplatesCreate: ToolDefinition = {
  name: "sendsquared_email_templates_create",
  description:
    "Create a SendSquared email template using Stripo-compatible HTML. " +
    "BEFORE calling this tool, read TWO resources: sendsquared://stripo-reference (the exact HTML markup " +
    "patterns — document skeleton, content sections, block types, padding classes, footer) and " +
    "sendsquared://merge-tokens (the ~180 available merge tokens and the five special URLs for guidebooks " +
    "on ssqgo.com, surveys on sndsq.com, unsubscribe, manage preferences, and campaign archive). " +
    "The `html` field must be a COMPLETE HTML document (<!DOCTYPE> through </html>) following the Stripo " +
    "nesting pattern: es-content > esd-stripe > es-content-body[600] > esd-structure > esd-container-frame > esd-block-*. " +
    "Each visual row must be a separate es-content section. All styles must be inline. " +
    "Include the es-footer section with the correct unsubscribe and manage-preferences URLs. " +
    "Do NOT add a SendSquared logo. This tool runs the full 3-step Stripo flow.",
  inputSchema: {
    type: "object",
    required: ["name", "subject", "html"],
    properties: {
      name: { type: "string", description: "Template name" },
      subject: { type: "string", description: "Email subject line" },
      preview: { type: "string", description: "Preview / preheader text", default: "" },
      html: {
        type: "string",
        description: "Complete Stripo-compatible email HTML document (<!DOCTYPE html> through </html>). Must use inline styles and table-based layout. Include footer with company merge tokens and unsubscribe link.",
      },
    },
  },
  handler: async (args) => {
    const name = asString(args["name"], "name")
    const subject = asString(args["subject"], "subject")
    const preview = asOptString(args["preview"]) ?? ""
    const html = asString(args["html"], "html")

    const data = await createStripoTemplate(name, subject, preview, html)
    return envelope(data, `Email template created: ${name} (id: ${data.id})`, [
      "sendsquared_email_templates_get",
      "sendsquared_email_templates_preview",
      "sendsquared_email_templates_update",
    ])
  },
}

export const emailTemplatesReadContent: ToolDefinition = {
  name: "sendsquared_email_templates_read_content",
  description:
    "Read the full Stripo HTML content of an email template. The standard `sendsquared_email_templates_get` " +
    "returns only the metadata record (name, subject, etc.); the HTML body lives in S3 and must be fetched " +
    "via a short-lived signed URL. Use this tool whenever you need to inspect or edit the actual markup — " +
    "for example, before calling `sendsquared_email_templates_update` to modify the HTML.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const api = apiForRequest()
    const signed = await api.get<{ url: string; template_id: number }>(
      `/email-templates/signed-url/${encodeURIComponent(id)}`,
    )
    if (!signed.url) {
      throw new Error("SendSquared API did not return a signed download URL for the template")
    }
    const res = await fetch(signed.url)
    if (!res.ok) {
      throw new Error(`S3 download failed: ${res.status}`)
    }
    const content = (await res.json()) as StripoContent
    return envelope(
      { template_id: signed.template_id, ...content },
      `Email template ${id} HTML (${(content.html ?? "").length} chars)`,
      ["sendsquared_email_templates_update", "sendsquared_email_templates_get"],
    )
  },
}

export const emailTemplatesUpdate: ToolDefinition = {
  name: "sendsquared_email_templates_update",
  description:
    "Update an existing SendSquared email template. Pass only the fields you want to change — name, subject, " +
    "preview, and/or html. The current record is fetched first and missing fields are preserved. " +
    "When `html` is provided, the tool runs the full Stripo 3-step update flow: PUT metadata → upload HTML to " +
    "the returned signed S3 URL → PUT /complete to regenerate the thumbnail and parse merge tokens. " +
    "If you're updating HTML, read BOTH sendsquared://stripo-reference (markup patterns) AND " +
    "sendsquared://merge-tokens (available tokens and the guidebook/survey/unsubscribe special URLs) first. " +
    "Use `sendsquared_email_templates_read_content` first to see the current HTML if you want to make a " +
    "targeted edit rather than replacing the whole body.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", description: "Template id to update" },
      name: { type: "string", description: "New template name (optional)" },
      subject: { type: "string", description: "New subject line (optional)" },
      preview: { type: "string", description: "New preview / preheader text (optional)" },
      html: {
        type: "string",
        description:
          "Complete Stripo-compatible email HTML (<!DOCTYPE html> through </html>). Optional — omit to update " +
          "metadata only. When provided, replaces the template's current HTML body in full.",
      },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const api = apiForRequest()

    const current = await api.get<Record<string, unknown>>(
      `/email-templates/${encodeURIComponent(id)}`,
    )

    const name = asOptString(args["name"]) ?? (current["name"] as string)
    const subject = asOptString(args["subject"]) ?? (current["subject"] as string)
    const preview = asOptString(args["preview"]) ?? ((current["preview"] as string) ?? "")
    const html = asOptString(args["html"])
    const templateType = (current["template_type"] as string) ?? "stripo"

    const payload: Record<string, unknown> = {
      template_type: templateType,
      name,
      subject,
      preview,
      is_active: current["is_active"] ?? true,
      is_archive: current["is_archive"] ?? false,
      is_reply: current["is_reply"] ?? false,
    }

    const updated = await api.put<CreateTemplateResponse>(
      `/email-templates/${encodeURIComponent(id)}`,
      payload,
    )

    if (html) {
      if (!updated.url) {
        throw new Error("SendSquared API did not return a signed upload URL for the template update")
      }
      await uploadStripoHtml(updated.url, html)
      await api.put(`/email-templates/${encodeURIComponent(id)}/complete`)
    }

    return envelope(updated, `Email template ${id} updated`, [
      "sendsquared_email_templates_get",
      "sendsquared_email_templates_read_content",
      "sendsquared_email_templates_preview",
    ])
  },
}

export const emailTemplatesDuplicate: ToolDefinition = {
  name: "sendsquared_email_templates_duplicate",
  description: "Duplicate a SendSquared email template.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" }, name: { type: "string", description: "Name for the copy (default: the original's name)" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const api = apiForRequest()
    const source = ((await api.get(`/email-templates/${encodeURIComponent(id)}`)) ?? {}) as Record<string, unknown>
    const data = await api.post(`/email-templates/duplicate/${encodeURIComponent(id)}`, { name: asOptString(args["name"]) ?? source["name"] })
    return envelope(data, `Email template ${id} duplicated`, ["sendsquared_email_templates_list"])
  },
}

export const emailTemplatesPreview: ToolDefinition = {
  name: "sendsquared_email_templates_preview",
  description: "Render a preview of a SendSquared email template. Returns the compiled HTML with merge tokens filled in from sample data.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/email-templates/${encodeURIComponent(id)}/preview`)
    return envelope(data, `Preview of email template ${id}`, ["sendsquared_email_templates_get"])
  },
}

export const emailTemplatesArchive: ToolDefinition = {
  name: "sendsquared_email_templates_archive",
  description: "Archive a SendSquared email template (hides it from default lists), or restore it with archived: false.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" }, archived: { type: "boolean", default: true } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const archived = args["archived"] !== false
    const data = await apiForRequest().patch(`/email-templates/${encodeURIComponent(id)}/archive`, { is_archive: archived })
    return envelope(data, `Email template ${id} ${archived ? "archived" : "unarchived"}`)
  },
}

export const emailTemplatesDelete: ToolDefinition = {
  name: "sendsquared_email_templates_delete",
  description: "Archive an email template. The API has no delete for email templates, so this is the same as sendsquared_email_templates_archive.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().patch(`/email-templates/${encodeURIComponent(id)}/archive`, { is_archive: true })
    return envelope(data, `Email template ${id} archived (email templates cannot be deleted)`, ["sendsquared_email_templates_list"])
  },
}

export const smsTemplatesList: ToolDefinition = {
  name: "sendsquared_sms_templates_list",
  description:
    "List SendSquared SMS templates. The endpoint has no working pagination, so this returns up to `limit` (default 200) templates in one call; raise the limit if you have more.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", default: 200 },
      archived: { type: "boolean", default: false, description: "List archived templates instead of active ones" },
    },
  },
  handler: async (args) => {
    const limit = asOptNumber(args["limit"]) ?? 200
    const archived = args["archived"] === true
    const result = await apiForRequest().list("/templates", { limit, template_type: "sms", archived: String(archived) })
    return envelope(
      { templates: result.data, total: result.total, limit, archived },
      `${result.total} SMS templates${result.total >= limit ? " (limit reached — raise limit to see more)" : ""}`,
      ["sendsquared_sms_templates_get"],
    )
  },
}

export const smsTemplatesGet: ToolDefinition = {
  name: "sendsquared_sms_templates_get",
  description: "Fetch a single SendSquared SMS template by id.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/templates/${encodeURIComponent(id)}`)
    return envelope(data, `SMS template ${id}`, ["sendsquared_sms_templates_list"])
  },
}

export const smsTemplatesCreate: ToolDefinition = {
  name: "sendsquared_sms_templates_create",
  description:
    "Create a new SendSquared SMS template. The content is the message text that will be sent. " +
    "Supports merge tokens like {{contact.first_name}}. Keep under 160 characters for single-segment messages.",
  inputSchema: {
    type: "object",
    required: ["name", "content"],
    properties: {
      name: { type: "string", description: "Template name (internal)" },
      content: { type: "string", description: "SMS message text. Supports merge tokens. Keep under 160 chars for single segment." },
      subject: { type: "string", description: "Optional subject/label for internal reference" },
    },
  },
  handler: async (args) => {
    const name = asString(args["name"], "name")
    const content = asString(args["content"], "content")
    const subject = asOptString(args["subject"])
    const data = await apiForRequest().post("/templates", {
      name,
      type: "sms",
      rich_content: content,
      plain_content: content,
      subject: subject ?? name,
      is_active: true,
    })
    return envelope(data, `SMS template created: ${name}`, [
      "sendsquared_sms_templates_get",
      "sendsquared_sms_templates_list",
    ])
  },
}

/*
  sendsquared_email_templates_update is a read-modify-write: it GETs the record
  and PUTs every required field back, because the API's PUT validates the whole
  EmailTemplateInputModel. That is correct but racy — a concurrent edit between
  the GET and the PUT is silently overwritten, and the PUT also resends
  is_active/is_archive/is_reply. The API has single-field routes for the common
  metadata edits, so prefer these when changing just one thing; reach for
  _update only when replacing the HTML body.
*/
export const emailTemplatesRename: ToolDefinition = {
  name: "sendsquared_email_templates_rename",
  description:
    "Rename an email template. Safer than sendsquared_email_templates_update for a name-only change — " +
    "it touches one field instead of rewriting the whole record.",
  inputSchema: {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "string", description: "Template id" },
      name: { type: "string", description: "New template name" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const name = asString(args["name"], "name")
    const data = await apiForRequest().patch(`/email-templates/${encodeURIComponent(id)}/rename`, { name })
    return envelope(data, `Email template ${id} renamed to ${name}`, ["sendsquared_email_templates_get"])
  },
}

export const emailTemplatesSetSubject: ToolDefinition = {
  name: "sendsquared_email_templates_set_subject",
  description:
    "Set an email template's subject line. The API requires at least 3 characters and rejects newlines " +
    "or control characters.",
  inputSchema: {
    type: "object",
    required: ["id", "subject"],
    properties: {
      id: { type: "string", description: "Template id" },
      subject: { type: "string", description: "New subject line (min 3 chars, single line)" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const subject = asString(args["subject"], "subject")
    const data = await apiForRequest().patch(`/email-templates/${encodeURIComponent(id)}/subject`, { subject })
    return envelope(data, `Email template ${id} subject updated`, ["sendsquared_email_templates_get"])
  },
}

export const emailTemplatesSetPreview: ToolDefinition = {
  name: "sendsquared_email_templates_set_preview",
  description:
    "Set an email template's preview / preheader text — the snippet shown after the subject in the inbox. " +
    "Rejects newlines and control characters.",
  inputSchema: {
    type: "object",
    required: ["id", "preview"],
    properties: {
      id: { type: "string", description: "Template id" },
      preview: { type: "string", description: "New preview / preheader text (single line)" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const preview = asString(args["preview"], "preview")
    const data = await apiForRequest().patch(`/email-templates/${encodeURIComponent(id)}/preview`, { preview })
    return envelope(data, `Email template ${id} preview text updated`, ["sendsquared_email_templates_get"])
  },
}

export const emailTemplatesSetBrand: ToolDefinition = {
  name: "sendsquared_email_templates_set_brand",
  description:
    "Assign an email template to a brand, or pass brand_id omitted/null to clear it. " +
    "Call sendsquared_brands_list for valid brand ids.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", description: "Template id" },
      brand_id: { type: "number", description: "Brand id to assign. Omit to clear the brand." },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const brandId = asOptNumber(args["brand_id"])
    const data = await apiForRequest().put(`/email-templates/${encodeURIComponent(id)}/brand`, {
      brand_id: brandId ?? null,
    })
    return envelope(data, brandId === undefined ? `Brand cleared on template ${id}` : `Template ${id} assigned to brand ${brandId}`, [
      "sendsquared_email_templates_get",
      "sendsquared_brands_list",
    ])
  },
}

export const emailTemplatesSetFolder: ToolDefinition = {
  name: "sendsquared_email_templates_set_folder",
  description:
    "Move one or more email templates into a folder. Pass a single id or an ids array; each template is moved individually and any failures are reported without stopping the rest. Use sendsquared_folders_list / sendsquared_folders_create to find or make the destination.",
  inputSchema: {
    type: "object",
    required: ["folder_id"],
    properties: {
      id: { type: "string", description: "Template id (single move)" },
      ids: { type: "array", items: { type: "string" }, description: "Template ids (batch move)" },
      folder_id: { type: "number", description: "Destination folder id" },
    },
  },
  handler: async (args) => {
    const folderId = asNumber(args["folder_id"], "folder_id")
    const single = asOptString(args["id"])
    const batch = Array.isArray(args["ids"]) ? (args["ids"] as unknown[]).map(String) : []
    const ids = single ? [single, ...batch] : batch
    if (ids.length === 0) throw new Error("Pass id or a non-empty ids array")

    const client = apiForRequest()
    const moved: string[] = []
    const failed: Array<{ id: string; error: string }> = []
    for (const id of ids) {
      const error = await client
        .put(`/email-templates/${encodeURIComponent(id)}/folder`, { folder_id: folderId })
        .then(
          () => undefined,
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        )
      if (error === undefined) moved.push(id)
      else failed.push({ id, error })
    }
    const summary =
      failed.length === 0
        ? `${moved.length} template${moved.length === 1 ? "" : "s"} moved to folder ${folderId}`
        : `${moved.length} moved to folder ${folderId}, ${failed.length} failed`
    return envelope({ folder_id: folderId, moved, failed }, summary, [
      "sendsquared_email_templates_list",
      "sendsquared_folders_list",
    ])
  },
}

export const emailTemplatesSetReply: ToolDefinition = {
  name: "sendsquared_email_templates_set_reply",
  description: "Mark an email template as a reply template, or clear that flag.",
  inputSchema: {
    type: "object",
    required: ["id", "is_reply"],
    properties: {
      id: { type: "string", description: "Template id" },
      is_reply: { type: "boolean", description: "Whether this template is a reply template" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const isReply = args["is_reply"] === true
    const data = await apiForRequest().put(`/email-templates/${encodeURIComponent(id)}/reply`, { is_reply: isReply })
    return envelope(data, `Email template ${id} reply flag set to ${isReply}`, ["sendsquared_email_templates_get"])
  },
}

export const emailTemplatesSendTest: ToolDefinition = {
  name: "sendsquared_email_templates_send_test",
  description:
    "Send a TEST copy of an email template to one or more raw email addresses. The API duplicates the " +
    "template as a system template, prefixes the subject with '[TEST]', and creates a demo contact per " +
    "recipient — so this is a proofing tool, NOT a way to send real mail to a customer. High-impact: it " +
    "does deliver actual email. Confirm the recipient list with the user first.",
  inputSchema: {
    type: "object",
    required: ["id", "email", "fromAddressId"],
    properties: {
      id: { type: "string", description: "Template id to send a test of" },
      email: {
        type: "array",
        items: { type: "string" },
        description: "Recipient email addresses",
      },
      fromAddressId: { type: "number", description: "Verified from-address id (must be an email-type valid domain)" },
      subject: { type: "string", description: "Override subject. '[TEST] ' is prefixed regardless." },
      previewLine: { type: "string", description: "Override preview / preheader text" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const email = args["email"]
    if (!Array.isArray(email) || email.length === 0) {
      throw new Error("email must be a non-empty array of addresses")
    }
    const body: Record<string, unknown> = {
      email: email.map((e) => String(e)),
      fromAddressId: asOptNumber(args["fromAddressId"]),
    }
    const subject = asOptString(args["subject"])
    const previewLine = asOptString(args["previewLine"])
    if (subject) body["subject"] = subject
    if (previewLine) body["previewLine"] = previewLine
    const data = await apiForRequest().post(`/email-templates/demo/${encodeURIComponent(id)}`, body)
    return envelope(data, `Test send of template ${id} queued to ${email.length} address(es)`, [
      "sendsquared_email_templates_get",
    ])
  },
}

export const emailTemplatesPublicList: ToolDefinition = {
  name: "sendsquared_email_templates_public_list",
  description:
    "List SendSquared's public starter templates. Use as a starting point for a new template — read one " +
    "with sendsquared_email_templates_public_get, then create your own from its markup.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await apiForRequest().get("/email-templates/public-templates")
    return envelope(data, "Public email templates", ["sendsquared_email_templates_public_get"])
  },
}

export const emailTemplatesPublicGet: ToolDefinition = {
  name: "sendsquared_email_templates_public_get",
  description: "Get a single public starter template by id.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Public template id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/email-templates/public-template/${encodeURIComponent(id)}`)
    return envelope(data, `Public email template ${id}`, ["sendsquared_email_templates_create"])
  },
}

/*
  Merge resolves a template's {{...}} tokens against a specific context and
  returns the finished subject and html without sending anything. The context
  ids are what decide whether reservation or lead tokens can resolve — there is
  no separate reservation-send or lead-send route, it is this one merge call
  plus the single contact send. A template whose tokens cannot be satisfied
  comes back 422 with a friendly_error naming the offending line, which is why
  it is worth previewing before sending rather than after.
*/
export const emailTemplatesMergePreview: ToolDefinition = {
  name: "sendsquared_email_templates_merge_preview",
  description:
    "Resolve an email template's merge tokens against a real contact (and optionally a reservation or " +
    "lead) and return the finished subject and HTML WITHOUT sending. Use this to preview what a contact " +
    "would actually receive, and to check a template's tokens can be satisfied before calling " +
    "sendsquared_contacts_send_email. A template containing {{reservation.*}} tokens needs a " +
    "reservation_id (or use_last_reservation), and {{lead.*}} tokens need a lead_id (or " +
    "use_last_open_lead), or the merge fails with a 422 naming the line that broke.",
  inputSchema: {
    type: "object",
    required: ["template_id"],
    properties: {
      template_id: { type: "number", description: "Email template id to merge" },
      contact_id: { type: "number", description: "Contact whose data fills {{contact.*}} tokens" },
      reservation_id: { type: "number", description: "Reservation for {{reservation.*}} tokens" },
      lead_id: { type: "number", description: "Lead for {{lead.*}} tokens" },
      use_last_reservation: { type: "boolean", description: "Resolve {{reservation.*}} from the contact's most recent reservation instead of passing an id" },
      use_last_open_lead: { type: "boolean", description: "Resolve {{lead.*}} from the contact's most recent open lead instead of passing an id" },
      campaign_id: { type: "number", description: "Campaign context, if the template references campaign tokens" },
      survey_id: { type: "number", description: "Survey context, if the template references survey tokens" },
      cart_abandon_id: { type: "number", description: "Cart-abandon context" },
      brand_id: { type: "number", description: "Brand override. Defaults to the template's own brand." },
    },
  },
  handler: async (args) => {
    const body: Record<string, unknown> = { template_id: asNumber(args["template_id"], "template_id") }
    for (const f of ["contact_id", "reservation_id", "lead_id", "campaign_id", "survey_id", "cart_abandon_id", "brand_id"]) {
      const v = asOptNumber(args[f])
      if (v !== undefined) body[f] = v
    }
    for (const f of ["use_last_reservation", "use_last_open_lead"]) {
      if (typeof args[f] === "boolean") body[f] = args[f]
    }
    const data = await apiForRequest().post("/email-templates/merge", body)
    return envelope(data, `Merged preview of template ${body["template_id"]}`, [
      "sendsquared_contacts_send_email",
      "sendsquared_email_templates_read_content",
    ])
  },
}

export const templatesTools: ToolDefinition[] = [
  emailTemplatesList,
  emailTemplatesGet,
  emailTemplatesReadContent,
  emailTemplatesCreate,
  emailTemplatesUpdate,
  emailTemplatesDuplicate,
  emailTemplatesPreview,
  emailTemplatesArchive,
  emailTemplatesDelete,
  emailTemplatesRename,
  emailTemplatesSetSubject,
  emailTemplatesSetPreview,
  emailTemplatesSetBrand,
  emailTemplatesSetFolder,
  emailTemplatesSetReply,
  emailTemplatesSendTest,
  emailTemplatesPublicList,
  emailTemplatesPublicGet,
  emailTemplatesMergePreview,
  smsTemplatesList,
  smsTemplatesGet,
  smsTemplatesCreate,
]
