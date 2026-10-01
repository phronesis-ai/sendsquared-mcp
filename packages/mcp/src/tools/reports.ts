import { reportRunBody, epochMs, defaultTimezone, type ReportRunOptions } from "@sendsquared/client"
import { apiForRequest, requestCompanyId, envelope, asString, asOptString, asOptNumber } from "./shared.js"
import type { ToolDefinition } from "./types.js"

function idList(value: unknown, name: string): number[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.some((v) => !Number.isInteger(v))) {
    throw new Error(`${name} must be an array of integer ids`)
  }
  return value as number[]
}

/*
  One params body serves every report type on POST /reports/run/{type}/{id};
  the web app's Reports screen sends the same keys. The snake/camel mix is the
  API's own naming.
*/
export function runOptionsFromArgs(args: Record<string, unknown>): ReportRunOptions {
  return {
    companyId: requestCompanyId(),
    from: asOptString(args["from"]),
    to: asOptString(args["to"]),
    date: asOptString(args["date"]),
    timezone: asOptString(args["timezone"]),
    workflowId: asOptNumber(args["workflow_id"]),
    actionId: asOptNumber(args["action_id"]),
    campaignId: asOptNumber(args["campaign_id"]),
    surveyId: asOptNumber(args["survey_id"]),
    contactId: asOptNumber(args["contact_id"]),
    triggerTaskId: asOptNumber(args["trigger_task_id"]),
    customField: asOptString(args["custom_field"]),
    groupBy: asOptString(args["group_by"]),
    status: asOptString(args["status"]),
    statusFilter: asOptString(args["status_filter"]),
    resTypes: idList(args["res_types"], "res_types"),
    leadTypeIds: idList(args["lead_type_ids"], "lead_type_ids"),
    queueIds: idList(args["queue_ids"], "queue_ids"),
    brandIds: idList(args["brand_ids"], "brand_ids"),
    connectorIds: idList(args["connector_ids"], "connector_ids"),
    sourceIds: idList(args["source_ids"], "source_ids"),
    sourceDetailIds: idList(args["source_detail_ids"], "source_detail_ids"),
    filterTime: Array.isArray(args["filter_time"]) ? (args["filter_time"] as unknown[]).map(String) : undefined,
    afterId: asOptNumber(args["after_id"]),
    limit: asOptNumber(args["limit"]),
    afterContactId: asOptNumber(args["after_contact_id"]),
    pageSize: asOptNumber(args["page_size"]),
    guidebookId: asOptNumber(args["guidebook_id"]),
  }
}

const DATE_PROPS = {
  from: { type: "string", description: "Start date YYYY-MM-DD (or ISO timestamp)" },
  to: { type: "string", description: "End date YYYY-MM-DD, inclusive (or ISO timestamp)" },
  timezone: { type: "string", description: "IANA timezone; defaults to the server's" },
}

const RUN_PROPS = {
  ...DATE_PROPS,
  report_id: { type: "number", description: "Saved report id from sendsquared_reports_saved_list; 0 (default) runs ad hoc" },
  date: { type: "string", description: "Single date YYYY-MM-DD for one-day reports (daily_snapshot, kpi_report)" },
  workflow_id: { type: "number", description: "Automation workflow id (automation_*, trigger_*, contact_journey)" },
  action_id: { type: "number", description: "One workflow step (automation_activity_detail)" },
  campaign_id: { type: "number" },
  survey_id: { type: "number", description: "survey_responses" },
  contact_id: { type: "number", description: "contact_journey" },
  trigger_task_id: { type: "number", description: "contact_journey" },
  custom_field: { type: "string", description: "lead_custom_field_count" },
  group_by: { type: "string" },
  status: { type: "string", description: "survey_responses: assignment status" },
  status_filter: { type: "string", enum: ["sent", "errored", "pending", "all"], description: "automation_activity_detail" },
  res_types: { type: "array", items: { type: "number" }, description: "Reservation type ids" },
  lead_type_ids: { type: "array", items: { type: "number" } },
  queue_ids: { type: "array", items: { type: "number" } },
  brand_ids: { type: "array", items: { type: "number" } },
  connector_ids: { type: "array", items: { type: "number" } },
  source_ids: { type: "array", items: { type: "number" } },
  source_detail_ids: { type: "array", items: { type: "number" }, description: "Only used together with source_ids" },
  filter_time: { type: "array", items: { type: "string" }, description: "Time-of-day window [\"HH:MM\",\"HH:MM\"]" },
  after_id: { type: "number", description: "Pagination cursor (abandonment_detail)" },
  limit: { type: "number", description: "Page size (abandonment_detail)" },
  after_contact_id: { type: "number", description: "Pagination cursor (automation_activity_detail)" },
  page_size: { type: "number", description: "Page size (automation_activity_detail)" },
  guidebook_id: { type: "number", description: "guidebook_*" },
}

export const reportsTypes: ToolDefinition = {
  name: "sendsquared_reports_types",
  description: "List every report type the Reports screen can run, with category and description. Use the `type` value with sendsquared_reports_run.",
  inputSchema: {
    type: "object",
    properties: { category: { type: "string", description: "Only this category (call, sms, email, automation, survey, lead, guidebook, ...)" } },
  },
  handler: async (args) => {
    const meta = (await apiForRequest().get("/reports/metadata")) as Record<string, unknown>
    const definitions = Array.isArray(meta["definitions"]) ? (meta["definitions"] as Array<Record<string, unknown>>) : []
    const category = asOptString(args["category"])
    const shown = category ? definitions.filter((d) => d["category"] === category) : definitions
    return envelope({ categories: meta["categories"], reports: shown }, `${shown.length} report types`, ["sendsquared_reports_run"])
  },
}

export const reportsSavedList: ToolDefinition = {
  name: "sendsquared_reports_saved_list",
  description: "List saved reports; each carries report_type and the report_params the web app saved.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "number", default: 100 }, after_id: { type: "number", default: 0 } },
  },
  handler: async (args) => {
    const data = await apiForRequest().list("/reports", { limit: asOptNumber(args["limit"]) ?? 100, after: asOptNumber(args["after_id"]) ?? 0 })
    return envelope({ reports: data.data, total: data.total }, `${data.total} saved reports`, ["sendsquared_reports_run"])
  },
}

export const reportsRun: ToolDefinition = {
  name: "sendsquared_reports_run",
  description:
    "Run any report type with the filters the web app's Reports screen sends. Most types need from/to; " +
    "automation_* and trigger_* need workflow_id; survey_responses needs survey_id; contact_journey needs " +
    "workflow_id and contact_id. Call sendsquared_reports_types to see what exists.",
  inputSchema: {
    type: "object",
    required: ["type"],
    properties: { type: { type: "string", description: "Report type, e.g. automation_activity" }, ...RUN_PROPS },
  },
  handler: async (args) => {
    const type = asString(args["type"], "type")
    const reportId = asOptNumber(args["report_id"]) ?? 0
    const data = await apiForRequest().post(`/reports/run/${encodeURIComponent(type)}/${reportId}`, reportRunBody(runOptionsFromArgs(args)))
    return envelope(data, `Report ${type}`, ["sendsquared_reports_types"])
  },
}

function automationReport(name: string, type: string, description: string, extra: Record<string, unknown> = {}): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      required: ["workflow_id", "from", "to"],
      properties: { workflow_id: { type: "number", description: "Automation workflow id" }, ...DATE_PROPS, ...extra },
    },
    handler: async (args) => {
      const data = await apiForRequest().post(`/reports/run/${type}/0`, reportRunBody(runOptionsFromArgs(args)))
      return envelope(data, `Automation ${String(args["workflow_id"])} ${type}`, [
        "sendsquared_reports_automation_activity",
        "sendsquared_reports_automation_steps",
        "sendsquared_reports_automation_detail",
      ])
    },
  }
}

export const reportsAutomationActivity = automationReport(
  "sendsquared_reports_automation_activity",
  "automation_activity",
  "Per-day counts for one automation: emails/SMS sent and delivered, email opens, surveys_sent, surveys_started, surveys_completed, webhooks, tasks, tags.",
)

export const reportsAutomationSteps = automationReport(
  "sendsquared_reports_automation_steps",
  "automation_step_performance",
  "Per-step totals for one automation over at most 31 days: total_sent, delivered, opened, clicked, survey_started, survey_completed, failed. Survey steps have channel 'survey'.",
)

export const reportsAutomationDetail = automationReport(
  "sendsquared_reports_automation_detail",
  "automation_activity_detail",
  "One row per message an automation sent: contact, step, channel, status (sent/errored/pending), error_message, delivered_at. Paginate with after_contact_id from next_after_id.",
  {
    action_id: { type: "number", description: "Only this step" },
    status_filter: { type: "string", enum: ["sent", "errored", "pending", "all"], default: "all" },
    after_contact_id: { type: "number" },
    page_size: { type: "number" },
  },
)

export const reportsContactJourney: ToolDefinition = {
  name: "sendsquared_reports_contact_journey",
  description: "One contact's path through an automation. Needs workflow_id and contact_id, plus either trigger_task_id or from/to.",
  inputSchema: {
    type: "object",
    required: ["workflow_id", "contact_id"],
    properties: {
      workflow_id: { type: "number" },
      contact_id: { type: "number" },
      trigger_task_id: { type: "number" },
      ...DATE_PROPS,
    },
  },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/run/contact_journey/0", reportRunBody(runOptionsFromArgs(args)))
    return envelope(data, `Contact ${String(args["contact_id"])} journey through automation ${String(args["workflow_id"])}`)
  },
}

function aliasReport(name: string, type: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: "object", required: ["from", "to"], properties: DATE_PROPS },
    handler: async (args) => {
      const data = await apiForRequest().post(`/reports/run/${type}/0`, reportRunBody(runOptionsFromArgs(args)))
      return envelope(data, `Report ${type}`, ["sendsquared_reports_run"])
    },
  }
}

export const reportsCampaigns = aliasReport("sendsquared_reports_campaigns", "email_campaign_overview", "Email campaign overview for a date range (report type email_campaign_overview).")
export const reportsEmail = aliasReport("sendsquared_reports_email", "email_campaign_revenue", "Email campaign revenue for a date range (report type email_campaign_revenue).")
export const reportsSms = aliasReport("sendsquared_reports_sms", "sms_volume_stats", "SMS volume for a date range (report type sms_volume_stats).")

export const reportsAnalytics: ToolDefinition = {
  name: "sendsquared_reports_analytics",
  description: "Call dashboard metrics (today's call volume and agent state).",
  inputSchema: { type: "object", properties: { timezone: { type: "string", description: "IANA timezone" } } },
  handler: async (args) => {
    const data = await apiForRequest().get("/analytics/dashboard/metrics", { timezone: asOptString(args["timezone"]) ?? defaultTimezone() })
    return envelope(data, "Dashboard metrics", ["sendsquared_reports_growth"])
  },
}

export const reportsGrowth: ToolDefinition = {
  name: "sendsquared_reports_growth",
  description: "Contact growth over the last N days.",
  inputSchema: {
    type: "object",
    properties: { days: { type: "number", default: 10 }, list: { type: "boolean", description: "Include the contacts" } },
  },
  handler: async (args) => {
    const days = asOptNumber(args["days"]) ?? 10
    const data = await apiForRequest().get(`/analytics/growth/${days}${args["list"] === true ? "/list" : ""}`)
    return envelope(data, `Contact growth, last ${days} days`)
  },
}

function analyticsList(name: string, path: string, description: string, detail: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", default: 30 }, after_id: { type: "number", default: 0 }, search: { type: "string" } },
    },
    handler: async (args) => {
      const data = await apiForRequest().list(path, {
        limit: asOptNumber(args["limit"]) ?? 30,
        after: asOptNumber(args["after_id"]) ?? 0,
        search: asOptString(args["search"]),
      })
      return envelope({ items: data.data, total: data.total }, `${data.total} results`, [detail])
    },
  }
}

function analyticsDetail(name: string, path: string, description: string, idField: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      required: [idField],
      properties: { [idField]: { type: "number" }, from: DATE_PROPS.from, to: DATE_PROPS.to },
    },
    handler: async (args) => {
      const id = asOptNumber(args[idField])
      if (id === undefined) {
        throw new Error(`${idField} is required`)
      }
      const from = asOptString(args["from"])
      const to = asOptString(args["to"])
      const query: Record<string, number | undefined> = {}
      if (from !== undefined || to !== undefined) {
        if (from === undefined || to === undefined) {
          throw new Error("from and to go together")
        }
        query["startDate"] = epochMs(from)
        query["endDate"] = epochMs(`${to}T23:59:59.999Z`)
      }
      const data = await apiForRequest().get(`${path}/${id}`, query)
      return envelope(data, `${description} ${id}`)
    },
  }
}

export const reportsAnalyticsPopups = analyticsList("sendsquared_reports_analytics_popups_list", "/analytics/popups", "Popup analytics list.", "sendsquared_reports_analytics_popup_get")
export const reportsAnalyticsPopup = analyticsDetail("sendsquared_reports_analytics_popup_get", "/analytics/popups", "Popup analytics", "popup_id")
export const reportsAnalyticsAutomations = analyticsList("sendsquared_reports_analytics_automations_list", "/analytics/automations", "Automation analytics list.", "sendsquared_reports_analytics_automation_get")
export const reportsAnalyticsAutomation = analyticsDetail("sendsquared_reports_analytics_automation_get", "/analytics/automations", "Automation analytics", "automation_id")
export const reportsAnalyticsCalls = analyticsDetail("sendsquared_reports_analytics_calls_get", "/analytics/calls", "Call analytics for agent", "user_id")

export const reportsRollups: ToolDefinition = {
  name: "sendsquared_reports_rollups_list",
  description: "List report rollups.",
  inputSchema: { type: "object", properties: { limit: { type: "number", default: 100 }, after_id: { type: "number", default: 0 } } },
  handler: async (args) => {
    const data = await apiForRequest().list("/report-rollups", { limit: asOptNumber(args["limit"]) ?? 100, after: asOptNumber(args["after_id"]) ?? 0 })
    return envelope({ rollups: data.data, total: data.total }, `${data.total} report rollups`)
  },
}

export const reportsKpiGoals: ToolDefinition = {
  name: "sendsquared_reports_kpi_goals_get",
  description: "KPI goals for a month.",
  inputSchema: {
    type: "object",
    required: ["year", "month"],
    properties: { year: { type: "number" }, month: { type: "number", description: "1-12" }, brand_id: { type: "number" } },
  },
  handler: async (args) => {
    const year = asOptNumber(args["year"])
    const month = asOptNumber(args["month"])
    if (year === undefined || month === undefined) {
      throw new Error("year and month are required")
    }
    const data = await apiForRequest().get(`/kpi-goals/${year}/${month}`, { brandId: asOptNumber(args["brand_id"]) })
    return envelope(data, `KPI goals ${year}-${month}`, ["sendsquared_reports_run"])
  },
}

export const reportsTools: ToolDefinition[] = [
  reportsTypes,
  reportsSavedList,
  reportsRun,
  reportsAutomationActivity,
  reportsAutomationSteps,
  reportsAutomationDetail,
  reportsContactJourney,
  reportsCampaigns,
  reportsEmail,
  reportsSms,
  reportsAnalytics,
  reportsGrowth,
  reportsAnalyticsPopups,
  reportsAnalyticsPopup,
  reportsAnalyticsAutomations,
  reportsAnalyticsAutomation,
  reportsAnalyticsCalls,
  reportsRollups,
  reportsKpiGoals,
]
