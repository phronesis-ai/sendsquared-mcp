import {
  CampaignReportType,
  CAMPAIGN_EMAIL_STATS,
  CampaignType,
  CampaignStatus,
  CAMPAIGN_TYPES,
  utmNameFrom,
  campaignActionBody,
  parseSendAt,
  scheduleBody,
  campaignPreflight,
  describeSchedule,
  EmailAttachMode,
  attachCampaignTemplate,
  assertCampaignSender,
} from "@sendsquared/client"
import { apiForRequest, envelope, asString, asOptString, asOptNumber, asOptBoolean } from "./shared.js"
import type { ToolDefinition } from "./types.js"

type Campaign = Record<string, unknown>

function actionOf(campaign: Campaign): Record<string, unknown> | undefined {
  return (campaign["action"] ?? undefined) as Record<string, unknown> | undefined
}

function idList(value: unknown, name: string): number[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.some((v) => !Number.isInteger(v))) {
    throw new Error(`${name} must be an array of integer ids`)
  }
  return value as number[]
}

function campaignTypeOf(campaign: Campaign, flag: string | undefined): CampaignType {
  const value = flag ?? String(actionOf(campaign)?.["action_type"] ?? CampaignType.Email)
  if (!CAMPAIGN_TYPES.includes(value as CampaignType)) {
    throw new Error(`type must be one of: ${CAMPAIGN_TYPES.join(", ")}`)
  }
  return value as CampaignType
}

const CONFIGURE_PROPS = {
  utm_name: { type: "string", description: "UTM campaign name, letters/numbers/dashes (default: derived from the name)" },
  template_id: { type: "number", description: "Template to send: email template, SMS template or postcard template id depending on type" },
  attach_original: { type: "boolean", description: "Email only: point the campaign at the template itself instead of a hidden per-campaign copy (the original is then flagged as a campaign template and subject edits change it)." },
  from_address_id: { type: "number", description: "Email: verified from-address id (sendsquared_email_templates_from_addresses); SMS: phone number id (sendsquared_campaigns_from_numbers)" },
  from_display_name: { type: "string", description: "Email from display name (default: the from-address's name)" },
  reply_to_address: { type: "string" },
  reply_to_display_name: { type: "string" },
  smart_send: { type: "boolean", description: "true: send at each contact's preferred time; false: all at the send time" },
  group_ids: { type: "array", items: { type: "number" }, description: "Group/segment ids to send to (replaces the current list)" },
  exclude_group_ids: { type: "array", items: { type: "number" }, description: "Group/segment ids to exclude" },
  brand_id: { type: "number", description: "Brand id; the from-address must belong to the same brand" },
  send_at: { type: "string", description: "When to send: ISO 8601 or \"now\"" },
  resend_unopens_at: { type: "string", description: "Email: resend to non-openers at this time, 3-10 days after send_at; \"none\" clears it" },
  subject: { type: "string", description: "Email subject (3-70 chars), written to the attached template" },
  preview_line: { type: "string", description: "Email preview line, written to the attached template" },
}

function optNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function optString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value)
}

/*
  One PATCH carries everything the campaign record holds; the action is
  always sent whole (merged over the current one) because the API replaces
  it. Subject and preview live on the email template, so they go to the
  template routes afterwards.
*/
async function configure(campaign: Campaign, args: Record<string, unknown>, nameArg: string | undefined): Promise<Campaign> {
  const api = apiForRequest()
  const id = String(campaign["id"])
  const type = campaignTypeOf(campaign, asOptString(args["type"]))
  const current = actionOf(campaign)
  const name = nameArg ?? String(campaign["name"] ?? "")
  const body: Record<string, unknown> = {}
  const utm = asOptString(args["utm_name"])

  if (nameArg !== undefined) {
    body["name"] = nameArg
    body["utm_name"] = utm ?? utmNameFrom(nameArg)
  } else if (utm !== undefined) {
    body["utm_name"] = utm
  }
  if (args["brand_id"] !== undefined) {
    body["brand_id"] = asOptNumber(args["brand_id"]) ?? null
  }
  const groupIds = idList(args["group_ids"], "group_ids")
  const excludeIds = idList(args["exclude_group_ids"], "exclude_group_ids")
  if (groupIds !== undefined || excludeIds !== undefined) {
    const existing = (campaign["groups"] ?? {}) as { include?: number[]; exclude?: number[] }
    body["groups"] = { include: groupIds ?? existing.include ?? [], exclude: excludeIds ?? existing.exclude ?? [] }
  }
  const sendAt = asOptString(args["send_at"])
  if (sendAt !== undefined) {
    Object.assign(body, scheduleBody(parseSendAt(sendAt)))
  }
  const resend = asOptString(args["resend_unopens_at"])
  if (resend !== undefined) {
    body["resend_un_opens_at"] = resend.toLowerCase() === "none" ? null : parseSendAt(resend).toISOString()
  }

  const templateId = asOptNumber(args["template_id"])
  const touchesAction =
    templateId !== undefined ||
    args["from_address_id"] !== undefined ||
    args["from_display_name"] !== undefined ||
    args["reply_to_address"] !== undefined ||
    args["reply_to_display_name"] !== undefined ||
    args["smart_send"] !== undefined ||
    (nameArg !== undefined && current !== undefined)
  if (touchesAction) {
    if (current === undefined && templateId === undefined) {
      throw new Error("this campaign has no template yet; pass template_id with the sender options")
    }
    const attached =
      templateId !== undefined
        ? await attachCampaignTemplate(api, type, templateId, args["attach_original"] === true ? EmailAttachMode.Original : EmailAttachMode.SystemCopy)
        : Number(current?.["type_value"])
    const fromAddressId = args["from_address_id"] !== undefined ? asOptNumber(args["from_address_id"]) : optNumber(current?.["from_address_id"])
    if (args["from_address_id"] !== undefined && fromAddressId !== undefined) {
      await assertCampaignSender(api, type, fromAddressId)
    }
    body["action"] = campaignActionBody({
      id: optNumber(current?.["id"]),
      name,
      type,
      templateId: attached,
      fromAddressId,
      fromDisplayName: asOptString(args["from_display_name"]) ?? optString(current?.["from_display_name"]),
      smartSend: asOptBoolean(args["smart_send"]) ?? current?.["smart_send"] === true,
      replyToAddress: asOptString(args["reply_to_address"]) ?? optString(current?.["reply_to_address"]),
      replyToDisplayName: asOptString(args["reply_to_display_name"]) ?? optString(current?.["reply_to_display_name"]),
    })
  }

  /*
    Only GET returns the campaign's groups, so the record is re-read after
    every write; otherwise the checks would report an empty audience.
  */
  let updated = campaign
  if (Object.keys(body).length > 0) {
    await api.patch(`/campaigns/${id}`, body)
    updated = ((await api.get(`/campaigns/${id}`)) ?? campaign) as Campaign
  }
  const subject = asOptString(args["subject"])
  const preview = asOptString(args["preview_line"])
  if (subject !== undefined || preview !== undefined) {
    const template = (updated["emailTemplate"] ?? undefined) as Record<string, unknown> | undefined
    if (!template) {
      throw new Error("subject and preview_line need an email template on the campaign")
    }
    if (subject !== undefined) {
      await api.patch(`/email-templates/${template["id"]}/subject`, { subject })
    }
    if (preview !== undefined) {
      await api.patch(`/email-templates/${template["id"]}/preview`, { preview })
    }
    updated = ((await api.get(`/campaigns/${id}`)) ?? updated) as Campaign
  }
  return updated
}

async function compiledHtml(campaign: Campaign): Promise<string | undefined> {
  const template = (campaign["emailTemplate"] ?? undefined) as Record<string, unknown> | undefined
  if (!template) {
    return undefined
  }
  if (template["template_type"] === "legacy") {
    return String(template["legacy_rich_content"] ?? "")
  }
  const signed = ((await apiForRequest().get(`/email-templates/signed-url/${template["id"]}`)) ?? {}) as { url?: string }
  if (!signed.url) {
    return undefined
  }
  const res = await fetch(signed.url)
  if (!res.ok) {
    return undefined
  }
  const content = (await res.json()) as { compiled?: string }
  return content.compiled ?? ""
}

async function preflight(campaign: Campaign): Promise<string[]> {
  return campaignPreflight({ campaign, compiledHtml: await compiledHtml(campaign) })
}

function summary(campaign: Campaign): Record<string, unknown> {
  const action = actionOf(campaign)
  const groups = (campaign["groups"] ?? {}) as { include?: number[]; exclude?: number[] }
  return {
    id: campaign["id"],
    name: campaign["name"],
    status: campaign["campaign_status"],
    schedule: describeSchedule(campaign["fire_at"]),
    type: action?.["action_type"] ?? null,
    template_id: action?.["type_value"] ?? null,
    from_address_id: action?.["from_address_id"] ?? null,
    from_display_name: action?.["from_display_name"] ?? null,
    groups: groups.include ?? [],
    exclude_groups: groups.exclude ?? [],
    built: campaign["built_actions"] === true,
  }
}

export const campaignsList: ToolDefinition = {
  name: "sendsquared_campaigns_list",
  description: "List SendSquared campaigns (email, SMS, postcard). campaign_status is draft or send; a send with a future fire_at is scheduled.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", default: 25 },
      after_id: { type: "number", default: 0, description: "Pagination cursor" },
      archived: { type: "boolean", description: "Archived campaigns instead of live ones" },
      brand_id: { type: "number" },
    },
  },
  handler: async (args) => {
    const limit = asOptNumber(args["limit"]) ?? 25
    const brandId = asOptNumber(args["brand_id"])
    const result = await apiForRequest().list("/campaigns", {
      limit,
      after: asOptNumber(args["after_id"]) ?? 0,
      archived: args["archived"] === true ? "true" : undefined,
      filter: brandId !== undefined ? [`brand_id:eq:${brandId}`] : undefined,
    })
    return envelope({ campaigns: result.data, total: result.total }, `${result.total} campaigns`, [
      "sendsquared_campaigns_get",
      "sendsquared_campaigns_create",
      "sendsquared_campaigns_report",
    ])
  },
}

export const campaignsGet: ToolDefinition = {
  name: "sendsquared_campaigns_get",
  description: "Fetch a campaign with its action (type, template, sender), groups, schedule and send state.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Campaign id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = ((await apiForRequest().get(`/campaigns/${encodeURIComponent(id)}`)) ?? {}) as Campaign
    return envelope({ summary: summary(data), campaign: data }, `Campaign ${id}: ${String(data["name"])} (${String(data["campaign_status"])}, ${describeSchedule(data["fire_at"])})`, [
      "sendsquared_campaigns_check",
      "sendsquared_campaigns_send",
      "sendsquared_campaigns_report",
    ])
  },
}

export const campaignsCreate: ToolDefinition = {
  name: "sendsquared_campaigns_create",
  description:
    "Create a draft campaign and configure it in one call, the same steps the web app takes: name, type (email/sms/postcard), " +
    "template, sender, groups, optional schedule. Nothing is sent until sendsquared_campaigns_send. The result lists any " +
    "problems that would block the send.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: "Campaign name; avoid \"untitled\"" },
      type: { type: "string", enum: CAMPAIGN_TYPES, default: "email" },
      ...CONFIGURE_PROPS,
    },
  },
  handler: async (args) => {
    const name = asString(args["name"], "name")
    campaignTypeOf({}, asOptString(args["type"]))
    const created = ((await apiForRequest().post("/campaigns", { name, utm_name: asOptString(args["utm_name"]) ?? utmNameFrom(name) })) ?? {}) as Campaign
    const { name: _n, utm_name: _u, ...rest } = args
    const configured = await configure({ ...created, name: created["name"] ?? name }, rest, undefined)
    const problems = await preflight(configured)
    return envelope(
      { summary: summary(configured), problems, campaign: configured },
      `Campaign ${String(configured["id"])} created as draft` + (problems.length > 0 ? `; ${problems.length} thing(s) to fix before sending` : "; ready to send"),
      ["sendsquared_campaigns_test_send", "sendsquared_campaigns_send"],
    )
  },
}

export const campaignsUpdate: ToolDefinition = {
  name: "sendsquared_campaigns_update",
  description: "Change a draft campaign; only the fields you pass change. Scheduled campaigns must be unscheduled first.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      type: { type: "string", enum: CAMPAIGN_TYPES, description: "Only needed with template_id on a campaign that has no template yet" },
      ...CONFIGURE_PROPS,
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const campaign = ((await apiForRequest().get(`/campaigns/${encodeURIComponent(id)}`)) ?? {}) as Campaign
    if (campaign["campaign_status"] !== CampaignStatus.Draft) {
      throw new Error(`Campaign ${id} is ${String(campaign["campaign_status"])}; call sendsquared_campaigns_unschedule first`)
    }
    const configured = await configure(campaign, args, asOptString(args["name"]))
    const problems = await preflight(configured)
    return envelope({ summary: summary(configured), problems, campaign: configured }, `Campaign ${id} updated` + (problems.length > 0 ? `; ${problems.length} thing(s) to fix before sending` : "; ready to send"), [
      "sendsquared_campaigns_send",
    ])
  },
}

export const campaignsCheck: ToolDefinition = {
  name: "sendsquared_campaigns_check",
  description: "Run the send checks the API enforces (groups, sender, template content, unsubscribe and address tokens, subject length, UTM name) and list everything that would block the send.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const campaign = ((await apiForRequest().get(`/campaigns/${encodeURIComponent(id)}`)) ?? {}) as Campaign
    const problems = await preflight(campaign)
    return envelope({ summary: summary(campaign), problems }, problems.length === 0 ? `Campaign ${id} passes every check` : `Campaign ${id}: ${problems.length} problem(s)`, [
      problems.length === 0 ? "sendsquared_campaigns_send" : "sendsquared_campaigns_update",
    ])
  },
}

export const campaignsSend: ToolDefinition = {
  name: "sendsquared_campaigns_send",
  description:
    "Send or schedule a campaign. High-impact: delivers real messages to every contact in the campaign's groups. " +
    "send_at is ISO 8601 or \"now\" (required unless a future send time is already set). The audience is built 30 minutes " +
    "before the send time; after that it cannot be pulled back.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      send_at: { type: "string", description: "ISO 8601 time or \"now\"" },
      force: { type: "boolean", description: "Skip the local checks and let the API decide" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const api = apiForRequest()
    let campaign = ((await api.get(`/campaigns/${encodeURIComponent(id)}`)) ?? {}) as Campaign
    if (campaign["campaign_status"] === CampaignStatus.Send) {
      throw new Error(`Campaign ${id} is already ${describeSchedule(campaign["fire_at"])}`)
    }
    const sendAt = asOptString(args["send_at"])
    if (sendAt !== undefined) {
      await api.patch(`/campaigns/${encodeURIComponent(id)}`, scheduleBody(parseSendAt(sendAt)))
      campaign = ((await api.get(`/campaigns/${encodeURIComponent(id)}`)) ?? campaign) as Campaign
    } else if (!campaign["fire_at"] || new Date(String(campaign["fire_at"])).getTime() < Date.now()) {
      throw new Error(`Campaign ${id} has no future send time; pass send_at`)
    }
    if (args["force"] !== true) {
      const problems = await preflight(campaign)
      if (problems.length > 0) {
        throw new Error(`not sent, ${problems.length} problem(s): ${problems.join("; ")}`)
      }
    }
    const data = ((await api.post(`/campaigns/status/${encodeURIComponent(id)}`, { campaign_status: CampaignStatus.Send })) ?? {}) as Campaign
    return envelope({ summary: summary(data), campaign: data }, `Campaign ${id} ${describeSchedule(data["fire_at"])}`, ["sendsquared_campaigns_report", "sendsquared_campaigns_unschedule"])
  },
}

export const campaignsUnschedule: ToolDefinition = {
  name: "sendsquared_campaigns_unschedule",
  description: "Pull a scheduled campaign back to draft. Only works before the audience is built (30 minutes before the send time).",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = ((await apiForRequest().post(`/campaigns/status/${encodeURIComponent(id)}`, { campaign_status: CampaignStatus.Draft })) ?? {}) as Campaign
    if (data["campaign_status"] !== CampaignStatus.Draft) {
      throw new Error(`Campaign ${id} is still ${String(data["campaign_status"])}`)
    }
    return envelope({ summary: summary(data) }, `Campaign ${id} back in draft`, ["sendsquared_campaigns_update"])
  },
}

export const campaignsTestSend: ToolDefinition = {
  name: "sendsquared_campaigns_test_send",
  description: "Send the campaign's message to test recipients using its sender and template. Email campaigns take email addresses, SMS campaigns take phone numbers.",
  inputSchema: {
    type: "object",
    required: ["id", "to"],
    properties: { id: { type: "string" }, to: { type: "array", items: { type: "string" }, description: "Email addresses or phone numbers" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const to = args["to"]
    if (!Array.isArray(to) || to.length === 0) {
      throw new Error("to must be a non-empty array")
    }
    const recipients = to.map(String)
    const api = apiForRequest()
    const campaign = ((await api.get(`/campaigns/${encodeURIComponent(id)}`)) ?? {}) as Campaign
    const action = actionOf(campaign)
    if (!action) {
      throw new Error("the campaign needs a template attached first")
    }
    switch (String(action["action_type"])) {
      case CampaignType.Email: {
        const template = (campaign["emailTemplate"] ?? {}) as Record<string, unknown>
        const data = await api.post(`/email-templates/demo/${template["id"]}`, {
          email: recipients,
          subject: template["subject"],
          previewLine: template["preview"],
          fromAddressId: action["from_address_id"],
        })
        return envelope(data, `Test email sent to ${recipients.join(", ")}`, ["sendsquared_campaigns_send"])
      }
      case CampaignType.Sms: {
        const template = (campaign["template"] ?? {}) as Record<string, unknown>
        const data = await api.post(`/templates/demo/${template["id"]}`, { phone: recipients })
        return envelope(data, `Test SMS sent to ${recipients.join(", ")}`, ["sendsquared_campaigns_send"])
      }
      default:
        throw new Error("test sends are only available for email and SMS campaigns")
    }
  },
}

export const campaignsDuplicate: ToolDefinition = {
  name: "sendsquared_campaigns_duplicate",
  description: "Copy a campaign (template, sender, groups, brand) into a new draft. The send time is not copied.",
  inputSchema: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string", description: "Name for the copy" } } },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const name = asString(args["name"], "name")
    const api = apiForRequest()
    const source = ((await api.get(`/campaigns/${encodeURIComponent(id)}`)) ?? {}) as Campaign
    const action = actionOf(source)
    const created = ((await api.post("/campaigns", { name, utm_name: utmNameFrom(name) })) ?? {}) as Campaign
    const groups = (source["groups"] ?? {}) as { include?: number[]; exclude?: number[] }
    const body: Record<string, unknown> = { groups: { include: groups.include ?? [], exclude: groups.exclude ?? [] }, brand_id: source["brand_id"] ?? null }
    if (action) {
      body["action"] = campaignActionBody({
        name,
        type: String(action["action_type"]) as CampaignType,
        templateId: Number(action["type_value"]),
        fromAddressId: optNumber(action["from_address_id"]),
        fromDisplayName: optString(action["from_display_name"]),
        smartSend: action["smart_send"] === true,
        replyToAddress: optString(action["reply_to_address"]),
        replyToDisplayName: optString(action["reply_to_display_name"]),
      })
    }
    const data = ((await api.patch(`/campaigns/${created["id"]}`, body)) ?? created) as Campaign
    return envelope({ summary: summary(data), campaign: data }, `Campaign ${id} copied to ${String(data["id"])}`, ["sendsquared_campaigns_send"])
  },
}

export const campaignsArchive: ToolDefinition = {
  name: "sendsquared_campaigns_archive",
  description: "Archive or unarchive a campaign.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" }, archived: { type: "boolean", default: true } } },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const archived = asOptBoolean(args["archived"]) ?? true
    const data = ((await apiForRequest().patch(`/campaigns/${encodeURIComponent(id)}`, { is_archive: archived })) ?? {}) as Campaign
    return envelope({ summary: summary(data) }, `Campaign ${id} ${archived ? "archived" : "unarchived"}`)
  },
}

export const campaignsDelete: ToolDefinition = {
  name: "sendsquared_campaigns_delete",
  description: "Delete a draft campaign. Destructive — there is no undo.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Campaign id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    await apiForRequest().delete(`/campaigns/${encodeURIComponent(id)}`)
    return envelope(null, `Campaign ${id} deleted`, ["sendsquared_campaigns_list"])
  },
}

export const campaignsFromNumbers: ToolDefinition = {
  name: "sendsquared_campaigns_from_numbers",
  description: "Phone numbers that can send SMS campaigns; use the id as from_address_id on an SMS campaign.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const numbers = ((await apiForRequest().get("/phone-numbers/")) ?? []) as Array<Record<string, unknown>>
    const capable = numbers.filter((n) => n["is_sms"] === true || n["is_mms"] === true || n["whatsapp_id"])
    return envelope(
      capable.map((n) => ({ id: n["id"], number: n["number"] ?? n["phone_number"], brand_id: n["brand_id"], is_sms: n["is_sms"], is_mms: n["is_mms"], provider: n["provider"] })),
      `${capable.length} SMS-capable numbers`,
      ["sendsquared_campaigns_create"],
    )
  },
}

/*
  Campaign reports live on per-channel routes. The email report has overall
  counts, a per-event contact list (open, click, ...), and an errors list;
  SMS and postcard only have counts.
*/
export function campaignReportPath(id: string, type: string, stat: string | undefined, errors: boolean): string {
  switch (type) {
    case CampaignReportType.Email:
      if (errors) {
        return `/campaigns/email-errors/${encodeURIComponent(id)}`
      }
      if (stat !== undefined) {
        if (!CAMPAIGN_EMAIL_STATS.includes(stat)) {
          throw new Error(`stat must be one of: ${CAMPAIGN_EMAIL_STATS.join(", ")}`)
        }
        return `/campaigns/email-report/${encodeURIComponent(id)}/${stat}`
      }
      return `/campaigns/email-report/${encodeURIComponent(id)}`
    case CampaignReportType.Sms:
      return `/campaigns/sms-report/${encodeURIComponent(id)}`
    case CampaignReportType.Postcard:
      return `/campaigns/postcard-report/${encodeURIComponent(id)}`
    default:
      throw new Error("type must be email, sms, or postcard")
  }
}

export const campaignsReport: ToolDefinition = {
  name: "sendsquared_campaigns_report",
  description:
    "Delivery and engagement counts for a sent campaign. Email campaigns can also list the contacts behind one event " +
    "(stat: open, delivery, send, click, bounce, unsubscribe, complaint, error) or the delivery errors (errors: true).",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", description: "Campaign id" },
      type: {
        type: "string",
        enum: ["email", "sms", "postcard"],
        default: "email",
        description: "Report type — must match the campaign's channel",
      },
      stat: { type: "string", enum: CAMPAIGN_EMAIL_STATS, description: "Email only: contacts by event; link = clicks per URL" },
      errors: { type: "boolean", description: "Email only: delivery errors" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const type = asOptString(args["type"]) ?? CampaignReportType.Email
    const data = await apiForRequest().get(campaignReportPath(id, type, asOptString(args["stat"]), args["errors"] === true))
    return envelope(data, `${type} report for campaign ${id}`, ["sendsquared_campaigns_get"])
  },
}

export const campaignsTools: ToolDefinition[] = [
  campaignsList,
  campaignsGet,
  campaignsCreate,
  campaignsUpdate,
  campaignsCheck,
  campaignsSend,
  campaignsUnschedule,
  campaignsTestSend,
  campaignsDuplicate,
  campaignsArchive,
  campaignsDelete,
  campaignsFromNumbers,
  campaignsReport,
]
