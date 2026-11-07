export enum ValidDomainType {
  Email = "email",
}

export interface ValidDomain {
  id: number
  value: string
  type: string
  from_display_name: string
  primary: boolean
  verified: string | null
}

export enum LeadEmailOutcome {
  Sent = "sent",
  Scheduled = "scheduled",
  Preview = "preview",
  Skipped = "skipped",
}

export interface LeadEmailResult {
  lead_id: number
  contact_id?: number
  to?: string
  outcome: LeadEmailOutcome
  subject?: string
  send_at?: string
  reason?: string
}

interface LeadEmailApi {
  get: <T = unknown>(path: string) => Promise<T>
  post: <T = unknown>(path: string, body?: unknown) => Promise<T>
}

interface LeadRecord {
  id: number
  contact_id: number
}

interface ContactRecord {
  id: number
  dont_send_email?: string | null
  primaryEmail?: { email_address?: string; validated_at?: string | null } | null
}

interface MergedTemplate {
  subject?: string
  rich_content?: string
}

/*
  Sender choice mirrors the SPA's send dialogs: a verified email-type valid
  domain, the primary one when no id is given. An explicit id must still be a
  verified address on this company, since a foreign or unverified id fails
  deep in the send path with an unhelpful error.
*/
export async function resolveEmailSender(api: LeadEmailApi, fromAddressId?: number): Promise<ValidDomain> {
  const domains = await api.get<ValidDomain[]>(`/company/valid-domains/${ValidDomainType.Email}`)
  const verified = domains.filter((d) => d.type === ValidDomainType.Email && d.verified !== null)
  if (fromAddressId === undefined) {
    const primary = verified.find((d) => d.primary)
    if (!primary) {
      throw new Error("No primary verified from-address; pass a from-address id (see email-templates from-addresses)")
    }
    return primary
  }
  const match = verified.find((d) => d.id === fromAddressId)
  if (!match) {
    throw new Error(`From-address ${fromAddressId} is not a verified email from-address (see email-templates from-addresses)`)
  }
  return match
}

export function findUnmergedToken(text: string): string | undefined {
  const match = text.match(/{{[^}]*}}/)
  return match ? match[0] : undefined
}

/*
  This is the lead screen's Send Email in two calls, exactly as the SPA does
  it: merge the template with the contact and lead ids (so {{lead.*}} and its
  custom fields resolve), then post the merged subject and HTML as a one-off
  contact email, which also files it on the contact's conversation.
  The contact email route only checks validation, so contacts flagged
  don't-send-email are skipped here instead of being emailed anyway.
  A sendAt is passed through as the route's sendTime, the same field the
  SPA's schedule picker sets: the message is queued with that send_at and
  goes out then, though it lands on the contact's timeline right away.
*/
export async function sendLeadEmail(
  api: LeadEmailApi,
  leadId: number,
  templateId: number,
  sender: ValidDomain,
  dryRun: boolean,
  sendAt?: string,
): Promise<LeadEmailResult> {
  const lead = await api.get<LeadRecord>(`/leads/${leadId}`)
  const contact = await api.get<ContactRecord>(`/contacts/${lead.contact_id}`)
  const to = contact.primaryEmail?.email_address
  const base = { lead_id: leadId, contact_id: lead.contact_id, to }

  if (contact.dont_send_email) {
    return { ...base, outcome: LeadEmailOutcome.Skipped, reason: "contact is flagged don't-send-email" }
  }
  if (!to || !contact.primaryEmail?.validated_at) {
    return { ...base, outcome: LeadEmailOutcome.Skipped, reason: "contact has no validated primary email" }
  }

  const merged = await api.post<MergedTemplate>("/email-templates/merge", {
    template_id: templateId,
    contact_id: lead.contact_id,
    lead_id: leadId,
  })
  const subject = merged.subject ?? ""
  const message = merged.rich_content ?? ""
  if (subject === "" || message === "") {
    return { ...base, outcome: LeadEmailOutcome.Skipped, reason: "template merged to an empty subject or body" }
  }
  const leftover = findUnmergedToken(subject) ?? findUnmergedToken(message)
  if (leftover !== undefined) {
    return { ...base, outcome: LeadEmailOutcome.Skipped, subject, reason: `unmerged token ${leftover}` }
  }

  const scheduled = sendAt === undefined ? {} : { send_at: sendAt }
  if (dryRun) {
    return { ...base, outcome: LeadEmailOutcome.Preview, subject, ...scheduled }
  }
  await api.post(`/contacts/${lead.contact_id}/messages/email`, {
    from: sender.id,
    subject,
    message,
    attachments: [],
    ...(sendAt === undefined ? {} : { sendTime: sendAt }),
  })
  if (sendAt !== undefined) {
    return { ...base, outcome: LeadEmailOutcome.Scheduled, subject, ...scheduled }
  }
  return { ...base, outcome: LeadEmailOutcome.Sent, subject }
}
