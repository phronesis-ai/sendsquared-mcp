export enum AutomationDetailStatus {
  Sent = "sent",
  Errored = "errored",
  Pending = "pending",
  All = "all",
}

export enum CampaignReportType {
  Email = "email",
  Sms = "sms",
  Postcard = "postcard",
}

/*
  The per-event routes return the contacts behind that event; "link" is the
  odd one out and returns click counts per URL instead.
*/
export const CAMPAIGN_EMAIL_STATS = ["open", "delivery", "send", "click", "bounce", "unsubscribe", "complaint", "error", "link"]

export interface ReportRunOptions {
  companyId?: number
  from?: string
  to?: string
  date?: string
  timezone?: string
  workflowId?: number
  actionId?: number
  campaignId?: number
  surveyId?: number
  contactId?: number
  triggerTaskId?: number
  customField?: string
  groupBy?: string
  status?: string
  statusFilter?: string
  resTypes?: number[]
  leadTypeIds?: number[]
  queueIds?: number[]
  brandIds?: number[]
  connectorIds?: number[]
  sourceIds?: number[]
  sourceDetailIds?: number[]
  filterTime?: string[]
  afterId?: number
  limit?: number
  afterContactId?: number
  pageSize?: number
  guidebookId?: number
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"
}

/*
  The web app sends filterDates as two Date objects: local midnight for the
  start and 23:59:59.999 for the end, so a plain YYYY-MM-DD `to` must widen to
  the end of that day or the last day drops out. Full timestamps pass through.
*/
export function reportDateRange(from: string, to: string): string[] {
  const start = DATE_ONLY.test(from) ? `${from}T00:00:00.000Z` : from
  const end = DATE_ONLY.test(to) ? `${to}T23:59:59.999Z` : to
  if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
    throw new Error("--from and --to must be YYYY-MM-DD or an ISO timestamp")
  }
  if (Date.parse(start) > Date.parse(end)) {
    throw new Error("--from must not be after --to")
  }
  return [start, end]
}

export function epochMs(date: string): number {
  const ms = Date.parse(DATE_ONLY.test(date) ? `${date}T00:00:00.000Z` : date)
  if (Number.isNaN(ms)) {
    throw new Error(`${date} is not a date`)
  }
  return ms
}

/*
  Several report bodies declare companyId as required, so the web app copies
  it off the saved report. The API queries by the logged-in company for all
  but two of them, but the body still has to carry it to pass validation.
*/
export function companyIdFromToken(jwt: string): number | undefined {
  const payload = jwt.split(".")[1]
  if (!payload) {
    return undefined
  }
  const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>
  const id = Number(decoded["company_id"])
  return Number.isInteger(id) && id > 0 ? id : undefined
}

export function reportRunBody(opts: ReportRunOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { timezone: opts.timezone ?? defaultTimezone() }
  if (opts.companyId !== undefined) {
    body["companyId"] = opts.companyId
  }
  if (opts.from !== undefined || opts.to !== undefined) {
    if (opts.from === undefined || opts.to === undefined) {
      throw new Error("--from and --to go together")
    }
    body["filterDates"] = reportDateRange(opts.from, opts.to)
  }
  if (opts.date !== undefined) {
    body["filterDate"] = DATE_ONLY.test(opts.date) ? `${opts.date}T12:00:00.000Z` : opts.date
  }
  const scalars: Array<[keyof ReportRunOptions, string]> = [
    ["workflowId", "workflow_id"],
    ["actionId", "action_id"],
    ["campaignId", "campaignId"],
    ["surveyId", "surveyId"],
    ["contactId", "contact_id"],
    ["triggerTaskId", "trigger_task_id"],
    ["customField", "customField"],
    ["groupBy", "groupBy"],
    ["status", "status"],
    ["statusFilter", "status_filter"],
    ["afterId", "afterId"],
    ["limit", "limit"],
    ["afterContactId", "after_contact_id"],
    ["pageSize", "page_size"],
    ["guidebookId", "guidebook_id"],
  ]
  for (const [key, apiKey] of scalars) {
    if (opts[key] !== undefined) {
      body[apiKey] = opts[key]
    }
  }
  const lists: Array<[keyof ReportRunOptions, string]> = [
    ["resTypes", "resTypes"],
    ["leadTypeIds", "leadTypeIds"],
    ["queueIds", "queueIds"],
    ["brandIds", "brandIds"],
    ["connectorIds", "connectorIds"],
    ["sourceIds", "sourceIds"],
    ["sourceDetailIds", "sourceDetailIds"],
    ["filterTime", "filterTime"],
  ]
  for (const [key, apiKey] of lists) {
    const value = opts[key] as unknown[] | undefined
    if (value !== undefined && value.length > 0) {
      body[apiKey] = value
    }
  }
  if (body["sourceDetailIds"] !== undefined && body["sourceIds"] === undefined) {
    delete body["sourceDetailIds"]
  }
  return body
}

export interface WorkflowSurveyStep {
  actionId: number
  label: string
}

/*
  A workflow's actions come back as a tree (each node may carry `children`).
  A survey step is action_type "survey" with the survey id in type_value.
*/
export function workflowSurveySteps(workflow: Record<string, unknown>, surveyId: number): WorkflowSurveyStep[] {
  const found: WorkflowSurveyStep[] = []
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) {
      return
    }
    for (const node of nodes as Array<Record<string, unknown>>) {
      if (node["action_type"] === "survey" && Number(node["type_value"]) === surveyId) {
        found.push({ actionId: Number(node["action_id"] ?? node["id"]), label: String(node["label"] ?? "") })
      }
      walk(node["children"])
    }
  }
  walk(workflow["actions"])
  return found
}

export interface SurveyFunnel {
  sent: number
  started: number
  completed: number
}

export function sumSurveyActivity(rows: Array<Record<string, unknown>>): SurveyFunnel {
  const total: SurveyFunnel = { sent: 0, started: 0, completed: 0 }
  for (const row of rows) {
    total.sent += Number(row["surveys_sent"] ?? 0)
    total.started += Number(row["surveys_started"] ?? 0)
    total.completed += Number(row["surveys_completed"] ?? 0)
  }
  return total
}

export function countByStatus(rows: Array<Record<string, unknown>>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    const status = String(row["status"] ?? "unknown")
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

export function parseIdList(value: string | undefined, name: string): number[] | undefined {
  if (value === undefined) {
    return undefined
  }
  const parts = value.split(",").map((v) => v.trim()).filter(Boolean)
  if (parts.length === 0 || parts.some((v) => !/^\d+$/.test(v))) {
    throw new Error(`${name} must be comma-separated numeric ids`)
  }
  return parts.map((v) => parseInt(v, 10))
}

export function parseOptionalInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be a whole number`)
  }
  return parseInt(value, 10)
}
