export enum CampaignType {
  Email = "email",
  Sms = "sms",
  Postcard = "postcard",
}

export enum CampaignStatus {
  Draft = "draft",
  Send = "send",
}

export const CAMPAIGN_TYPES = [CampaignType.Email, CampaignType.Sms, CampaignType.Postcard]

export const CAMPAIGN_BUILD_LEAD_MS = 30 * 60 * 1000

export function utmNameFrom(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

export interface CampaignActionInput {
  id?: number
  name: string
  type: CampaignType
  templateId: number
  fromAddressId?: number
  fromDisplayName?: string
  smartSend?: boolean
  replyToAddress?: string
  replyToDisplayName?: string
}

/*
  The web app always PATCHes the whole action. priority 3 and send_to
  "contact" are what it hard-codes. Leaving from_address_id out (not 0) is
  what makes the API fall back to the company's primary verified sender for
  email; 0 is stored as-is and fails the send checks.
*/
export function campaignActionBody(input: CampaignActionInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: input.id ?? 0,
    name: input.name,
    action_type: input.type,
    type_value: input.templateId,
    from_display_name: input.type === CampaignType.Email ? input.fromDisplayName : "",
    smart_send: input.smartSend ?? false,
    priority: 3,
    send_to: ["contact"],
    other_emails: null,
    blind_others: null,
  }
  if (input.fromAddressId !== undefined && input.fromAddressId !== 0) {
    body["from_address_id"] = input.fromAddressId
  }
  if (input.type === CampaignType.Email) {
    if (input.replyToAddress !== undefined) {
      body["reply_to_address"] = input.replyToAddress
    }
    if (input.replyToDisplayName !== undefined) {
      body["reply_to_display_name"] = input.replyToDisplayName
    }
  }
  return body
}

export function parseSendAt(value: string): Date {
  const lowered = value.trim().toLowerCase()
  if (lowered === "now") {
    return new Date(Date.now() + 60 * 1000)
  }
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    throw new Error(`${value} is not a date; use ISO 8601 (2026-10-05T14:00:00-04:00) or "now"`)
  }
  return new Date(ms)
}

/*
  build_at is when the API expands the audience into per-contact sends, half
  an hour before fire_at just like the web app; after that the campaign can no
  longer be edited or pulled back to draft.
*/
export function scheduleBody(sendAt: Date): Record<string, unknown> {
  return { fire_at: sendAt.toISOString(), build_at: new Date(sendAt.getTime() - CAMPAIGN_BUILD_LEAD_MS).toISOString() }
}

export function resendWindowError(fireAt: Date, resendAt: Date): string | undefined {
  const min = new Date(fireAt)
  min.setDate(min.getDate() + 3)
  const max = new Date(fireAt)
  max.setDate(max.getDate() + 10)
  if (resendAt < min) {
    return "resend to un-opens must be at least 3 days after the send time"
  }
  if (resendAt > max) {
    return "resend to un-opens must be within 10 days of the send time"
  }
  return undefined
}

export interface CampaignPreflightInput {
  campaign: Record<string, unknown>
  compiledHtml?: string
  dailySendsLeft?: number
}

const UNSUBSCRIBE_TOKEN = /token=\{\{contact\.unsubscribe_token\}\}/
const UNSUBSCRIBE_CAMPAIGN = /unsub_type=.*unsub_id=/
const ADDRESS_TOKEN = /\{\{(?:company|brand)\.address_1\}\}/

/*
  The API only reports the first problem when a send is requested, so this
  runs the same checks ahead of time and lists all of them. Checks that need
  server state (send limits, brand/sender match, permissions) are left to the
  API.
*/
export function campaignPreflight(input: CampaignPreflightInput): string[] {
  const c = input.campaign
  const problems: string[] = []
  const action = (c["action"] ?? undefined) as Record<string, unknown> | undefined
  const groups = (c["groups"] ?? {}) as { include?: unknown[] }
  const name = String(c["name"] ?? "")
  const utm = String(c["utm_name"] ?? "")

  if (c["deleted_at"]) {
    problems.push("campaign is deleted")
  }
  if (c["built_actions"]) {
    problems.push("campaign is already built; it can no longer be changed or sent again")
  }
  if (name.toLowerCase().includes("untitled")) {
    problems.push('name contains "untitled" (rejected when the company blocks untitled campaigns)')
  }
  if (utm.length === 0) {
    problems.push("utm_name is empty")
  } else if (!/^[A-Za-z0-9-]+$/.test(utm)) {
    problems.push("utm_name may only contain letters, numbers and dashes")
  }
  if (!Array.isArray(groups.include) || groups.include.length === 0) {
    problems.push("no groups selected (groups.include is empty)")
  }
  if (!action) {
    problems.push("no action: attach a template with --template")
    return problems
  }
  if (action["disabled"] || action["deleted"]) {
    problems.push("action is disabled or deleted")
  }
  const type = String(action["action_type"] ?? "")
  switch (type) {
    case CampaignType.Email: {
      const template = (c["emailTemplate"] ?? undefined) as Record<string, unknown> | undefined
      if (!action["from_address_id"]) {
        problems.push("email from address not set")
      }
      if (!action["from_display_name"]) {
        problems.push("email from display name not set")
      }
      if (!template) {
        problems.push("no email template connected")
        break
      }
      const subject = String(template["subject"] ?? "")
      if (subject.length < 3) {
        problems.push("subject line is shorter than 3 characters")
      }
      if (subject.length > 70) {
        problems.push("subject line is longer than 70 characters")
      }
      if (input.compiledHtml !== undefined) {
        if (input.compiledHtml.length === 0) {
          problems.push("email template has no content")
        } else {
          if (!UNSUBSCRIBE_TOKEN.test(input.compiledHtml)) {
            problems.push("email template is missing the unsubscribe token (token={{contact.unsubscribe_token}})")
          }
          if (!UNSUBSCRIBE_CAMPAIGN.test(input.compiledHtml)) {
            problems.push("email template is missing the campaign unsubscribe link (unsub_type= and unsub_id=)")
          }
          if (!ADDRESS_TOKEN.test(input.compiledHtml)) {
            problems.push("email template is missing a physical address ({{company.address_1}} or {{brand.address_1}})")
          }
        }
      }
      if (c["resend_un_opens_at"] && c["fire_at"]) {
        const err = resendWindowError(new Date(String(c["fire_at"])), new Date(String(c["resend_un_opens_at"])))
        if (err) {
          problems.push(err)
        }
      }
      break
    }
    case CampaignType.Sms: {
      const template = (c["template"] ?? undefined) as Record<string, unknown> | undefined
      if (!template) {
        problems.push("no SMS template connected")
      } else if (String(template["plain_content"] ?? "").length === 0) {
        problems.push("SMS template has no content")
      }
      if (!action["from_address_id"]) {
        problems.push("SMS from number not set")
      }
      break
    }
    case CampaignType.Postcard: {
      if (!c["postcardTemplate"]) {
        problems.push("no postcard template connected")
      }
      break
    }
    default:
      problems.push(`unexpected action type ${type}`)
  }
  if (input.dailySendsLeft !== undefined && input.dailySendsLeft <= 0) {
    problems.push("daily email send limit reached")
  }
  return problems
}

export function describeSchedule(fireAt: unknown): string {
  if (!fireAt) {
    return "no send time set"
  }
  const at = new Date(String(fireAt))
  const delta = at.getTime() - Date.now()
  if (delta > 2 * 60 * 60 * 1000) {
    return `scheduled for ${at.toISOString()}`
  }
  if (delta > 0) {
    return `sends at ${at.toISOString()} (within 2 hours)`
  }
  return `send time ${at.toISOString()} is in the past`
}

export enum EmailAttachMode {
  SystemCopy = "copy",
  Original = "original",
}

interface TemplateApi {
  get: <T = unknown>(path: string) => Promise<T>
  post: <T = unknown>(path: string, body?: unknown) => Promise<T>
  put: <T = unknown>(path: string, body?: unknown) => Promise<T>
}

/*
  Attaching an email template directly flags the original as a campaign
  template, so by default the campaign gets its own hidden system copy the
  way the Stripo editor makes one: the system route duplicates the record
  (and rebuilds legacy content from the JSON), the Stripo body is copied
  through the signed URLs, and `complete` recomputes tokens and thumbnail.
*/
export async function attachEmailTemplate(api: TemplateApi, templateId: number, mode: EmailAttachMode): Promise<number> {
  if (mode === EmailAttachMode.Original) {
    return templateId
  }
  const source = (await api.get(`/email-templates/${templateId}`)) as Record<string, unknown>
  const copy = (await api.post(`/email-templates/system/${templateId}`, {
    name: source["name"],
    subject: source["subject"] ?? "",
    preview: source["preview"] ?? "",
    template_type: source["template_type"],
    is_active: source["is_active"] ?? true,
    is_archive: false,
    is_reply: source["is_reply"] ?? false,
    brand_id: source["brand_id"] ?? undefined,
    legacy_json_content: source["legacy_json_content"],
  })) as { id: number; url?: string }
  if (source["template_type"] === "stripo") {
    const signed = (await api.get(`/email-templates/signed-url/${templateId}`)) as { url?: string }
    if (!signed.url || !copy.url) {
      throw new Error("could not copy the Stripo template content (no signed URL)")
    }
    const download = await fetch(signed.url)
    if (!download.ok) {
      throw new Error(`could not read the Stripo template content (${download.status})`)
    }
    const content = await download.text()
    const upload = await fetch(copy.url, { method: "PUT", headers: { "Content-Type": "text/json" }, body: content })
    if (!upload.ok) {
      throw new Error(`could not write the Stripo template copy (${upload.status})`)
    }
    await api.put(`/email-templates/${copy.id}/complete`)
  }
  return copy.id
}

/*
  The web app never attaches a shared SMS or postcard template directly: it
  stores a system copy owned by the campaign and points the action at that.
*/
export async function attachCampaignTemplate(api: TemplateApi, type: CampaignType, templateId: number, emailMode: EmailAttachMode): Promise<number> {
  switch (type) {
    case CampaignType.Email:
      return attachEmailTemplate(api, templateId, emailMode)
    case CampaignType.Sms: {
      const source = (await api.get(`/templates/${templateId}`)) as Record<string, unknown>
      const created = (await api.post(`/templates/system-sms/${templateId}`, { text: source["plain_content"] ?? "", image: source["image"] ?? null })) as { id: number }
      return created.id
    }
    case CampaignType.Postcard: {
      const created = (await api.post(`/postcard-templates/${templateId}/system`, { archive: true })) as { id: number }
      return created.id
    }
  }
}

/*
  The API answers a sender id from another company with a 500 rather than a
  validation error, so the id is checked against the company's own verified
  senders (email) or SMS-capable numbers first.
*/
export async function assertCampaignSender(api: TemplateApi, type: CampaignType, fromAddressId: number): Promise<void> {
  switch (type) {
    case CampaignType.Email: {
      const senders = ((await api.get("/company/valid-domains/email")) ?? []) as Array<Record<string, unknown>>
      const match = senders.find((d) => Number(d["id"]) === fromAddressId)
      if (!match) {
        throw new Error(`from address ${fromAddressId} is not one of this company's email senders (see email-templates from-addresses)`)
      }
      if (!match["verified"]) {
        throw new Error(`from address ${fromAddressId} (${String(match["value"])}) is not verified`)
      }
      return
    }
    case CampaignType.Sms: {
      const numbers = ((await api.get("/phone-numbers/")) ?? []) as Array<Record<string, unknown>>
      const match = numbers.find((n) => Number(n["id"]) === fromAddressId)
      if (!match || !(match["is_sms"] === true || match["is_mms"] === true || match["whatsapp_id"])) {
        throw new Error(`from number ${fromAddressId} is not one of this company's SMS-capable numbers (see campaigns from-numbers)`)
      }
      return
    }
    case CampaignType.Postcard:
      return
  }
}
